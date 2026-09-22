import type { ConnectRequest } from '@enbox/connect';
import type {
  AgentProcessChildApproveNoteWritePopupCommand,
  AgentProcessChildCommandFailure,
  AgentProcessChildNoteWritePopupApproved,
} from './agent-process-child-protocol.js';
import type {
  ConnectApprovalProgressPhase,
  ConnectApprovalResult,
  EnboxUserAgent as EnboxUserAgentType,
} from '@enbox/agent';

import { ConnectProvider } from '@enbox/connect';
import { fileURLToPath } from 'node:url';
import { getDwnEndpointStatus } from '@enbox/dids';
import { isDeepStrictEqual } from 'node:util';
import { stat } from 'node:fs/promises';

import {
  AGENT_PROCESS_ACTIVE_MAX_LINE_BYTES,
  AGENT_PROCESS_APPROVAL_PHASES,
  AGENT_PROCESS_CHILD_MAX_LINE_BYTES,
  AGENT_PROCESS_PACKAGE_NAME,
  AGENT_PROCESS_PACKAGE_VERSION,
  isDidDhtUri,
  parseAgentProcessChildActiveCommand,
  parseAgentProcessChildSecretCommand,
  parseAgentProcessChildStartCommand,
} from './agent-process-child-protocol.js';
import {
  assertLabNoteWritePopupRequest,
  cloneLabNoteWritePopupRequest,
  fingerprintLabNoteWritePopupRequest,
  LAB_NOTE_WRITE_APP_NAME,
  LAB_NOTE_WRITE_MAX_APPROVALS,
  LAB_NOTE_WRITE_PERMISSION_REQUEST,
  LAB_NOTE_WRITE_PROTOCOL_URI,
  LAB_NOTE_WRITE_SESSION_TTL_SECONDS,
} from './note-write-approval.js';
import { DwnInterfaceName, DwnMethodName, PermissionsProtocol } from '@enbox/dwn-sdk-js';
import { DwnPermissionGrant, EnboxUserAgent, executeConnectApproval } from '@enbox/agent';

const MAX_OUTPUT_LINE_BYTES = 1_024;

type InstalledPackageManifest = Readonly<{
  name?: unknown;
  version?: unknown;
}>;

type ShutdownSignal = Readonly<{ type: 'signal' }>;

type SecretFreeActivation = Readonly<{
  agentDid: string;
  firstLaunch: boolean;
  mode: 'initialized' | 'reopened';
}>;

function fixedError(message: string): Error {
  return new Error(`AgentProcessChild: ${message}`);
}

async function assertReleasedAgent(): Promise<void> {
  const packageJsonPath = fileURLToPath(import.meta.resolve(`${AGENT_PROCESS_PACKAGE_NAME}/package.json`));
  const packageFile = Bun.file(packageJsonPath);
  if (!await packageFile.exists()) {
    throw fixedError('released agent manifest is missing');
  }
  const manifest = await packageFile.json() as InstalledPackageManifest;
  if (manifest.name !== AGENT_PROCESS_PACKAGE_NAME || manifest.version !== AGENT_PROCESS_PACKAGE_VERSION) {
    throw fixedError('released agent version does not match the runtime contract');
  }
}

async function assertStorageDirectory(storageDirectory: string): Promise<void> {
  let storageStat;
  try {
    storageStat = await stat(storageDirectory);
  } catch {
    throw fixedError('storage directory is unavailable');
  }
  if (!storageStat.isDirectory()) {
    throw fixedError('storage path is not a directory');
  }
}

class BoundedInputLineReader {
  private readonly _bytes: number[] = [];
  private readonly _cancel: () => void;
  private readonly _reader = Bun.stdin.stream().getReader();
  private readonly _signal: AbortSignal;
  private _ended = false;

  public constructor(signal: AbortSignal) {
    this._signal = signal;
    this._cancel = (): void => { void this._reader.cancel().catch((): void => {}); };
    signal.addEventListener('abort', this._cancel, { once: true });
    if (signal.aborted) { this._cancel(); }
  }

  public async readLine(maximumBytes: number): Promise<string | undefined> {
    while (true) {
      const newlineIndex = this._bytes.indexOf(0x0a);
      if (newlineIndex !== -1) {
        if (newlineIndex > maximumBytes) { throw fixedError('input line exceeds the limit'); }
        const lineBytes = this._bytes.splice(0, newlineIndex + 1);
        lineBytes.pop();
        if (lineBytes.at(-1) === 0x0d) { lineBytes.pop(); }
        return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(lineBytes));
      }
      if (this._bytes.length > maximumBytes) { throw fixedError('input line exceeds the limit'); }
      if (this._ended) {
        if (this._bytes.length === 0) { return undefined; }
        const line = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(this._bytes));
        this._bytes.length = 0;
        return line;
      }
      const result = await this._reader.read();
      if (result.done) {
        this._ended = true;
        continue;
      }
      for (const byte of result.value) {
        this._bytes.push(byte);
        const firstNewline = this._bytes.indexOf(0x0a);
        if (firstNewline === -1 && this._bytes.length > maximumBytes) {
          throw fixedError('input line exceeds the limit');
        }
        if (firstNewline !== -1 && this._bytes.length - firstNewline - 1 > AGENT_PROCESS_ACTIVE_MAX_LINE_BYTES) {
          throw fixedError('buffered active input exceeds the limit');
        }
      }
    }
  }

  public async close(): Promise<void> {
    this._signal.removeEventListener('abort', this._cancel);
    await this._reader.cancel().catch((): void => {});
    this._reader.releaseLock();
  }
}

function writeRecord(record: Record<string, unknown>): void {
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_OUTPUT_LINE_BYTES) {
    throw fixedError('output record exceeds the limit');
  }
  process.stdout.write(line);
}

function writeActiveRecord(record: Record<string, unknown>): void {
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, 'utf8') > AGENT_PROCESS_ACTIVE_MAX_LINE_BYTES) {
    throw fixedError('active output record exceeds the limit');
  }
  process.stdout.write(line);
}

function commandFailure(
  id: string,
  code: AgentProcessChildCommandFailure['code'],
  needsReconciliation: boolean,
): AgentProcessChildCommandFailure {
  return { code, id, needsReconciliation, type: 'agent-command-failed' };
}

function createShutdownSignal(): Readonly<{
  dispose(): void;
  promise: Promise<ShutdownSignal>;
  signal: AbortSignal;
}> {
  const controller = new AbortController();
  let resolveSignal = (_signal: ShutdownSignal): void => {};
  const promise = new Promise<ShutdownSignal>((resolvePromise): void => { resolveSignal = resolvePromise; });
  const listener = (): void => {
    controller.abort();
    resolveSignal({ type: 'signal' });
  };
  process.once('SIGINT', listener);
  process.once('SIGTERM', listener);
  return {
    dispose: (): void => {
      process.off('SIGINT', listener);
      process.off('SIGTERM', listener);
    },
    promise,
    signal: controller.signal,
  };
}

async function shutdownAgent(agent: EnboxUserAgentType): Promise<void> {
  await agent.shutdown({ syncStopTimeoutMs: 1_000 });
  if (!agent.vault.isLocked()) {
    throw fixedError('agent vault remained unlocked after shutdown');
  }
}

async function activateWithOneUseSecret(
  agent: EnboxUserAgentType,
  input: BoundedInputLineReader,
  signal: Promise<ShutdownSignal>,
  firstLaunch: boolean,
  remoteDwnOrigin: string,
): Promise<SecretFreeActivation | undefined> {
  const outcome = await Promise.race([input.readLine(AGENT_PROCESS_CHILD_MAX_LINE_BYTES), signal]);
  if (typeof outcome !== 'string') { return undefined; }

  const command = parseAgentProcessChildSecretCommand(outcome);
  if ((command.type === 'initialize') !== firstLaunch) {
    throw fixedError('secret command does not match the durable vault state');
  }
  if (command.type === 'initialize') {
    await agent.initialize({
      dwnEndpoints : [remoteDwnOrigin],
      password     : command.password,
    });
  }
  await agent.start({ password: command.password });

  const agentDid = agent.agentDid;
  const endpoints = getDwnEndpointStatus(agentDid.uri, agentDid.document);
  if (!isDidDhtUri(agentDid.uri) || agentDid.metadata.published !== true || endpoints.status !== 'ready' ||
    endpoints.endpoints.length !== 1 || endpoints.endpoints[0] !== remoteDwnOrigin || agent.vault.isLocked()) {
    throw fixedError('released agent did not satisfy the private DID runtime contract');
  }
  return {
    agentDid : agentDid.uri,
    firstLaunch,
    mode     : firstLaunch ? 'initialized' : 'reopened',
  };
}

async function executeAndSealNoteWriteApproval(
  agent: EnboxUserAgentType,
  request: ConnectRequest,
): Promise<string> {
  const phases: ConnectApprovalProgressPhase[] = [];
  const result = await executeConnectApproval({
    agent,
    approvedProtocolOverrides : [],
    approvedSessionTtlSeconds : LAB_NOTE_WRITE_SESSION_TTL_SECONDS,
    onProgress                : ({ phase }): void => { phases.push(phase); },
    providerDid               : agent.agentDid.uri,
    request,
    transport                 : 'postMessage',
  });
  assertNoteWriteApprovalResult(result, request, phases, agent.agentDid.uri);
  const { responseSigner, ...approval } = result;
  return ConnectProvider.sealApprovedResponse({
    approval,
    providerDid : agent.agentDid.uri,
    request,
    signer      : responseSigner,
  });
}

function assertNoteWriteApprovalResult(
  result: ConnectApprovalResult,
  request: ConnectRequest,
  phases: readonly ConnectApprovalProgressPhase[],
  providerDid: string,
): void {
  if (result.delegateGrants.length !== 2 || result.sessionRevocations.length !== 1 ||
    result.delegatePortableDid?.uri !== result.delegateDid || result.responseSigner.uri !== result.delegateDid ||
    !isDeepStrictEqual(result.delegatePortableDid.privateKeys?.map((key) => key.crv).sort(), ['Ed25519', 'X25519']) ||
    phases.length !== AGENT_PROCESS_APPROVAL_PHASES.length ||
    phases.some((phase, index): boolean => phase !== AGENT_PROCESS_APPROVAL_PHASES[index])) {
    throw fixedError('approval result did not satisfy the fixed note-write contract');
  }

  const grants = result.delegateGrants.map((message) => DwnPermissionGrant.parse(message));
  const sessionGrant = grants.find((grant): boolean => grant.scope.protocol === LAB_NOTE_WRITE_PROTOCOL_URI);
  if (sessionGrant === undefined) {
    throw fixedError('approval result omitted the fixed note-write grant');
  }
  const revocationGrant = grants.find((grant): boolean => grant.id !== sessionGrant.id);
  const session = sessionGrant.connectSession;
  const metadata = request.clientMetadata;
  const createdAt = session === undefined ? Number.NaN : Date.parse(session.createdAt);
  const expiresAt = session === undefined ? Number.NaN : Date.parse(session.expiresAt);
  if (revocationGrant === undefined || session === undefined || metadata === undefined ||
    sessionGrant.grantor !== providerDid || sessionGrant.grantee !== result.delegateDid ||
    sessionGrant.delegated !== true ||
    !isDeepStrictEqual(sessionGrant.scope, LAB_NOTE_WRITE_PERMISSION_REQUEST.permissionScopes[0]) ||
    session.appName !== LAB_NOTE_WRITE_APP_NAME || session.origin !== metadata.origin ||
    session.transport !== 'postMessage' || session.expiresAt !== sessionGrant.dateExpires ||
    session.appIcon !== undefined || session.applicationId !== undefined ||
    session.userAgent !== metadata.userAgent || session.platform !== metadata.platform ||
    session.language !== metadata.language || !isDeepStrictEqual(session.languages, metadata.languages) ||
    session.timezone !== metadata.timezone || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt) ||
    expiresAt - createdAt !== LAB_NOTE_WRITE_SESSION_TTL_SECONDS * 1_000 ||
    revocationGrant.grantor !== providerDid || revocationGrant.grantee !== result.delegateDid ||
    revocationGrant.delegated !== true || revocationGrant.dateExpires !== sessionGrant.dateExpires ||
    revocationGrant.connectSession !== undefined ||
    !isDeepStrictEqual(revocationGrant.scope, {
      contextId : sessionGrant.id,
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Write,
      protocol  : PermissionsProtocol.uri,
    }) || !isDeepStrictEqual(result.sessionRevocations, [{
    grantId           : sessionGrant.id,
    revocationGrantId : revocationGrant.id,
  }])) {
    throw fixedError('approval grants did not satisfy the fixed note-write policy');
  }
}

async function approveNoteWritePopupRequest(
  command: AgentProcessChildApproveNoteWritePopupCommand,
  agent: EnboxUserAgentType,
  seen: Set<string>,
  reconciliationRequired: boolean,
): Promise<AgentProcessChildNoteWritePopupApproved | AgentProcessChildCommandFailure> {
  if (reconciliationRequired) {
    return commandFailure(command.id, 'reconciliation-required', true);
  }
  let request: ConnectRequest;
  try {
    request = cloneLabNoteWritePopupRequest(command.request);
    assertLabNoteWritePopupRequest(request, agent.agentDid.uri, command.dappOrigin);
  } catch {
    return commandFailure(command.id, 'invalid-request', false);
  }
  const fingerprint = await fingerprintLabNoteWritePopupRequest(request);
  if (seen.has(fingerprint)) {
    return commandFailure(command.id, 'replayed-request', false);
  }
  if (seen.size >= LAB_NOTE_WRITE_MAX_APPROVALS) {
    return commandFailure(command.id, 'capacity-exceeded', false);
  }

  // Consume before the first side effect. Every later failure is outcome-unknown and cannot be retried.
  seen.add(fingerprint);
  try {
    const idToken = await executeAndSealNoteWriteApproval(agent, request);
    return { id: command.id, idToken, type: 'note-write-popup-approved' };
  } catch {
    return commandFailure(command.id, 'outcome-unknown', true);
  }
}

async function runChild(): Promise<void> {
  // Keep stdout as an exact machine protocol even if a released dependency logs during startup.
  console.log = (): void => {};
  console.info = (): void => {};
  console.warn = (): void => {};
  console.error = (): void => {};

  const shutdownSignal = createShutdownSignal();
  const input = new BoundedInputLineReader(shutdownSignal.signal);
  let agent: EnboxUserAgentType | undefined;
  let cleanShutdown = false;
  try {
    const first = await input.readLine(AGENT_PROCESS_CHILD_MAX_LINE_BYTES);
    if (first === undefined) { throw fixedError('startup command is missing'); }
    const start = parseAgentProcessChildStartCommand(first);
    await Promise.all([assertReleasedAgent(), assertStorageDirectory(start.storageDirectory)]);

    // These defaults are process-global in the released SDK, so set them only inside this
    // one-wallet child after its immutable startup frame has been validated.
    process.env.DID_DHT_GATEWAY_URI = start.actorGatewayUri;
    process.env.DID_DHT_ALLOW_PRIVATE_GATEWAY = '1';

    agent = await EnboxUserAgent.create({
      dataPath         : start.storageDirectory,
      localDwnEndpoint : start.remoteDwnOrigin,
      localDwnStrategy : 'off',
    });
    const firstLaunch = await agent.firstLaunch();
    if (!agent.vault.isLocked()) {
      throw fixedError('newly opened vault is not locked');
    }
    writeRecord({
      firstLaunch,
      locked         : true,
      packageName    : AGENT_PROCESS_PACKAGE_NAME,
      packageVersion : AGENT_PROCESS_PACKAGE_VERSION,
      type           : 'awaiting-secret',
    });

    const activation = await activateWithOneUseSecret(
      agent,
      input,
      shutdownSignal.promise,
      firstLaunch,
      start.remoteDwnOrigin,
    );
    if (activation === undefined) {
      await shutdownAgent(agent);
      cleanShutdown = true;
      writeRecord({ locked: true, type: 'stopped' });
      return;
    }
    writeRecord({
      agentDid         : activation.agentDid,
      dwnEndpoints     : [start.remoteDwnOrigin],
      firstLaunch      : activation.firstLaunch,
      localDwnStrategy : 'off',
      locked           : false,
      mode             : activation.mode,
      packageName      : AGENT_PROCESS_PACKAGE_NAME,
      packageVersion   : AGENT_PROCESS_PACKAGE_VERSION,
      published        : true,
      type             : 'active',
    });

    const seen = new Set<string>();
    let reconciliationRequired = false;
    while (true) {
      const line = await input.readLine(AGENT_PROCESS_ACTIVE_MAX_LINE_BYTES);
      if (line === undefined) { break; }
      const command = parseAgentProcessChildActiveCommand(line);
      if (command.type === 'stop') { break; }

      const result = await approveNoteWritePopupRequest(command, agent, seen, reconciliationRequired);
      if (result.type === 'agent-command-failed' && result.needsReconciliation) {
        reconciliationRequired = true;
      }
      writeActiveRecord(result);
    }
    await shutdownAgent(agent);
    cleanShutdown = true;
    writeRecord({ locked: true, type: 'stopped' });
  } finally {
    shutdownSignal.dispose();
    await input.close().catch((): void => {});
    if (agent !== undefined && !cleanShutdown) {
      await shutdownAgent(agent).catch((): void => {});
    }
    delete process.env.DID_DHT_GATEWAY_URI;
    delete process.env.DID_DHT_ALLOW_PRIVATE_GATEWAY;
  }
}

if (import.meta.main) {
  runChild().catch((): void => {
    process.stderr.write('Enbox Lab agent child failed\n');
    process.exit(1);
  });
}
