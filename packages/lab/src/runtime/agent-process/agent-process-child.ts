import type { EnboxUserAgent as EnboxUserAgentType } from '@enbox/agent';

import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';

import { EnboxUserAgent } from '@enbox/agent';
import { getDwnEndpointStatus } from '@enbox/dids';

import {
  AGENT_PROCESS_CHILD_MAX_LINE_BYTES,
  AGENT_PROCESS_PACKAGE_NAME,
  AGENT_PROCESS_PACKAGE_VERSION,
  isDidDhtUri,
  parseAgentProcessChildSecretCommand,
  parseAgentProcessChildStartCommand,
  parseAgentProcessChildStopCommand,
} from './agent-process-child-protocol.js';

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

async function* readBoundedInputLines(signal: AbortSignal): AsyncGenerator<string> {
  const bytes: number[] = [];
  const reader = Bun.stdin.stream().getReader();
  const cancel = (): void => { void reader.cancel().catch((): void => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) { cancel(); }
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) { break; }
      for (const byte of result.value) {
        if (byte === 0x0a) {
          if (bytes.at(-1) === 0x0d) { bytes.pop(); }
          yield new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
          bytes.length = 0;
        } else {
          if (bytes.length >= AGENT_PROCESS_CHILD_MAX_LINE_BYTES) {
            throw fixedError('input line exceeds the limit');
          }
          bytes.push(byte);
        }
      }
    }
    if (bytes.length > 0) {
      yield new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function writeRecord(record: Record<string, unknown>): void {
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_OUTPUT_LINE_BYTES) {
    throw fixedError('output record exceeds the limit');
  }
  process.stdout.write(line);
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
  lines: AsyncGenerator<string>,
  signal: Promise<ShutdownSignal>,
  firstLaunch: boolean,
  remoteDwnOrigin: string,
): Promise<SecretFreeActivation | undefined> {
  const outcome = await Promise.race([lines.next(), signal]);
  if ('type' in outcome || outcome.done) { return undefined; }

  const command = parseAgentProcessChildSecretCommand(outcome.value);
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

async function runChild(): Promise<void> {
  // Keep stdout as an exact machine protocol even if a released dependency logs during startup.
  console.log = (): void => {};
  console.info = (): void => {};
  console.warn = (): void => {};
  console.error = (): void => {};

  const shutdownSignal = createShutdownSignal();
  const lines = readBoundedInputLines(shutdownSignal.signal);
  let agent: EnboxUserAgentType | undefined;
  let cleanShutdown = false;
  try {
    const first = await lines.next();
    if (first.done) { throw fixedError('startup command is missing'); }
    const start = parseAgentProcessChildStartCommand(first.value);
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
      lines,
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
    // Resume the input generator immediately so its yielded secret line is no longer retained.
    const stopInput = lines.next();
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

    const stopOutcome = await Promise.race([stopInput, shutdownSignal.promise]);
    if (!('type' in stopOutcome) && !stopOutcome.done) {
      parseAgentProcessChildStopCommand(stopOutcome.value);
    }
    await shutdownAgent(agent);
    cleanShutdown = true;
    writeRecord({ locked: true, type: 'stopped' });
  } finally {
    shutdownSignal.dispose();
    await lines.return(undefined).catch((): void => {});
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
