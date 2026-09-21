import type {
  AgentProcessChildActive,
  AgentProcessChildAwaitingSecret,
  AgentProcessChildStopped,
} from './agent-process-child-protocol.js';

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { dirname, extname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import {
  AGENT_PROCESS_CHILD_MAX_LINE_BYTES,
  AGENT_PROCESS_PACKAGE_NAME,
  AGENT_PROCESS_PACKAGE_VERSION,
  isDidDhtUri,
  parseAgentProcessChildSecretCommand,
  parseAgentProcessChildStartCommand,
} from './agent-process-child-protocol.js';

const CHILD_KILL_TIMEOUT_MS = 2_000;
const CHILD_STOP_TIMEOUT_MS = 5_000;
const CHILD_TERM_TIMEOUT_MS = 3_000;
const RECORD_MAX_LINE_BYTES = 1_024;
const START_TIMEOUT_MS = 30_000;

type AgentChildProcess = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

type InstalledPackageManifest = Readonly<{
  name?: unknown;
  version?: unknown;
}>;

type AgentChildEntry = Readonly<{
  kind: 'built-js' | 'source-ts';
  path: string;
}>;

export type AgentProcessRuntimeOptions = Readonly<{
  actorGatewayUri: string;
  remoteDwnOrigin: string;
}>;

export type AgentProcessRuntimeDependencies = Readonly<{
  beforeChildStart?: () => Promise<void>;
  beforeSecretSubmit?: () => Promise<void>;
  beforeStopComplete?: () => Promise<void>;
  removeStorage?: (directory: string) => Promise<void>;
}>;

export type AgentProcessStartParams = Readonly<{
  password: string;
}>;

export type AgentProcessRuntimeEvidence = Readonly<{
  actorGatewayUriTransport: 'stdin-ndjson';
  agentDid: string;
  childArgumentsContainActorGatewayUri: false;
  childEntryKind: AgentChildEntry['kind'];
  childEntryPath: string;
  childEnvironmentContainsActorGatewayUri: false;
  childEnvironmentKeys: readonly ['NO_COLOR', 'PATH'];
  childPid: number;
  dwnEndpoints: readonly [string];
  firstLaunch: boolean;
  localDwnStrategy: 'off';
  locked: false;
  lockedBeforeSecret: true;
  mode: 'initialized' | 'reopened';
  packageName: typeof AGENT_PROCESS_PACKAGE_NAME;
  packageVersion: typeof AGENT_PROCESS_PACKAGE_VERSION;
  passwordTransport: 'stdin-ndjson';
  protocolRecords: 2;
  published: true;
  remoteDwnOrigin: string;
  storageDirectory: string;
}>;

export type AgentProcessStopEvidence = Readonly<{
  agentDid?: string;
  locked: true;
  processExited: true;
  storageDirectory: string;
  storagePreserved: true;
  stopped: true;
}>;

export type AgentProcessDestroyEvidence = Readonly<{
  processExited: true;
  storageDirectory: string;
  storageRemoved: true;
  stopped: true;
}>;

type CancellationSignal = Readonly<{
  cancel(): void;
  cancelled(): boolean;
  promise: Promise<void>;
}>;

function childEnvironment(): Record<string, string> {
  return {
    NO_COLOR : '1',
    PATH     : process.env.PATH ?? '',
  };
}

function cancellationSignal(): CancellationSignal {
  let cancelled = false;
  let resolve = (): void => {};
  const promise = new Promise<void>((resolvePromise): void => { resolve = resolvePromise; });
  return {
    cancel(): void {
      if (!cancelled) {
        cancelled = true;
        resolve();
      }
    },
    cancelled: (): boolean => cancelled,
    promise,
  };
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index): boolean => key === expectedKeys[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(line: string, label: string): Record<string, unknown> {
  if (line.length === 0 || Buffer.byteLength(line, 'utf8') > RECORD_MAX_LINE_BYTES) {
    throw new Error(`AgentProcessRuntime: invalid child ${label} record`);
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`AgentProcessRuntime: invalid child ${label} record`);
  }
  if (!isRecord(value)) {
    throw new Error(`AgentProcessRuntime: invalid child ${label} record`);
  }
  return value;
}

function isCanonicalLoopbackOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const port = Number(url.port);
  return value === url.origin && url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
    Number.isInteger(port) && port >= 1 && port <= 65_535 && url.username.length === 0 &&
    url.password.length === 0 && url.pathname === '/' && url.search.length === 0 && url.hash.length === 0;
}

export function parseAgentProcessAwaitingSecret(line: string): AgentProcessChildAwaitingSecret {
  const value = parseRecord(line, 'awaiting-secret');
  if (!hasExactKeys(value, ['firstLaunch', 'locked', 'packageName', 'packageVersion', 'type']) ||
    value.type !== 'awaiting-secret' || typeof value.firstLaunch !== 'boolean' || value.locked !== true ||
    value.packageName !== AGENT_PROCESS_PACKAGE_NAME || value.packageVersion !== AGENT_PROCESS_PACKAGE_VERSION) {
    throw new Error('AgentProcessRuntime: invalid child awaiting-secret record');
  }
  return {
    firstLaunch    : value.firstLaunch,
    locked         : true,
    packageName    : AGENT_PROCESS_PACKAGE_NAME,
    packageVersion : AGENT_PROCESS_PACKAGE_VERSION,
    type           : 'awaiting-secret',
  };
}

export function parseAgentProcessActive(line: string): AgentProcessChildActive {
  const value = parseRecord(line, 'active');
  if (!hasExactKeys(value, [
    'agentDid', 'dwnEndpoints', 'firstLaunch', 'localDwnStrategy', 'locked', 'mode',
    'packageName', 'packageVersion', 'published', 'type',
  ]) || value.type !== 'active' || typeof value.agentDid !== 'string' || !isDidDhtUri(value.agentDid) ||
    !Array.isArray(value.dwnEndpoints) || value.dwnEndpoints.length !== 1 ||
    typeof value.dwnEndpoints[0] !== 'string' || !isCanonicalLoopbackOrigin(value.dwnEndpoints[0]) ||
    typeof value.firstLaunch !== 'boolean' || value.localDwnStrategy !== 'off' || value.locked !== false ||
    (value.mode !== 'initialized' && value.mode !== 'reopened') || value.packageName !== AGENT_PROCESS_PACKAGE_NAME ||
    value.packageVersion !== AGENT_PROCESS_PACKAGE_VERSION || value.published !== true) {
    throw new Error('AgentProcessRuntime: invalid child active record');
  }
  return {
    agentDid         : value.agentDid,
    dwnEndpoints     : [value.dwnEndpoints[0]],
    firstLaunch      : value.firstLaunch,
    localDwnStrategy : 'off',
    locked           : false,
    mode             : value.mode,
    packageName      : AGENT_PROCESS_PACKAGE_NAME,
    packageVersion   : AGENT_PROCESS_PACKAGE_VERSION,
    published        : true,
    type             : 'active',
  };
}

export function parseAgentProcessStopped(line: string): AgentProcessChildStopped {
  const value = parseRecord(line, 'stopped');
  if (!hasExactKeys(value, ['locked', 'type']) || value.type !== 'stopped' || value.locked !== true) {
    throw new Error('AgentProcessRuntime: invalid child stopped record');
  }
  return { locked: true, type: 'stopped' };
}

class BoundedLineReader {
  private readonly _bytes: number[] = [];
  private readonly _reader: ReadableStreamDefaultReader<Uint8Array>;
  private _ended = false;

  public constructor(stream: ReadableStream<Uint8Array>) {
    this._reader = stream.getReader();
  }

  public async readLine(timeoutMs: number): Promise<string> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject): void => {
      timeoutId = setTimeout((): void => {
        void this._reader.cancel().catch((): void => {});
        reject(new Error(`AgentProcessRuntime: child protocol timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.readLineUnbounded(), timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async readLineUnbounded(): Promise<string> {
    while (true) {
      const newlineIndex = this._bytes.indexOf(0x0a);
      if (newlineIndex !== -1) {
        const lineBytes = this._bytes.splice(0, newlineIndex + 1);
        lineBytes.pop();
        if (lineBytes.at(-1) === 0x0d) { lineBytes.pop(); }
        return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(lineBytes));
      }
      if (this._ended) {
        throw new Error('AgentProcessRuntime: child stdout ended before the next protocol record');
      }
      const result = await this._reader.read();
      if (result.done) {
        this._ended = true;
        if (this._bytes.length > 0) {
          const line = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(this._bytes));
          this._bytes.length = 0;
          return line;
        }
        continue;
      }
      if (this._bytes.length + result.value.byteLength > RECORD_MAX_LINE_BYTES) {
        throw new Error('AgentProcessRuntime: child protocol record exceeded the line limit');
      }
      this._bytes.push(...result.value);
    }
  }

  public async assertEnded(): Promise<void> {
    if (!this._ended) {
      const result = await this._reader.read();
      if (!result.done) {
        throw new Error('AgentProcessRuntime: child emitted an unexpected protocol record');
      }
      this._ended = true;
    }
    if (this._bytes.length > 0) {
      throw new Error('AgentProcessRuntime: child emitted an incomplete protocol record');
    }
  }

  public release(): void {
    this._reader.releaseLock();
  }
}

async function waitForExit(child: AgentChildProcess, timeoutMs: number): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolvePromise): void => {
    timeoutId = setTimeout((): void => { resolvePromise(false); }, timeoutMs);
  });
  try {
    return await Promise.race([child.exited.then((): true => true), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function resolveReleasedPackageManifest(): Promise<void> {
  const packageJsonPath = fileURLToPath(import.meta.resolve(`${AGENT_PROCESS_PACKAGE_NAME}/package.json`));
  const packageFile = Bun.file(packageJsonPath);
  if (!await packageFile.exists()) {
    throw new Error('AgentProcessRuntime: released agent manifest is missing');
  }
  const manifest = await packageFile.json() as InstalledPackageManifest;
  if (manifest.name !== AGENT_PROCESS_PACKAGE_NAME || manifest.version !== AGENT_PROCESS_PACKAGE_VERSION) {
    throw new Error(
      `AgentProcessRuntime: expected ${AGENT_PROCESS_PACKAGE_NAME}@${AGENT_PROCESS_PACKAGE_VERSION}, ` +
      `found ${String(manifest.name)}@${String(manifest.version)}`,
    );
  }
}

/** Resolves the colocated TypeScript child in source and JavaScript child after compilation. */
export async function resolveAgentProcessChildEntry(
  runtimeModulePath: string = fileURLToPath(import.meta.url),
): Promise<AgentChildEntry> {
  const kind = extname(runtimeModulePath) === '.ts' ? 'source-ts' : 'built-js';
  const childExtension = kind === 'source-ts' ? '.ts' : '.js';
  const path = join(dirname(runtimeModulePath), `agent-process-child${childExtension}`);
  if (!await Bun.file(path).exists()) {
    throw new Error(`AgentProcessRuntime: colocated ${kind} child entry is missing`);
  }
  return { kind, path };
}

/** Owns one durable agent data path while starting a fresh locked child for every unlock. */
export class AgentProcessRuntime {
  #actorGatewayUri: string;
  #sawStderr = false;

  private readonly _beforeChildStart: () => Promise<void>;
  private readonly _beforeSecretSubmit: () => Promise<void>;
  private readonly _beforeStopComplete: () => Promise<void>;
  private readonly _childEntry: AgentChildEntry;
  private readonly _remoteDwnOrigin: string;
  private readonly _removeStorage: (directory: string) => Promise<void>;
  private readonly _storageDirectory: string;
  private _active?: AgentProcessRuntimeEvidence;
  private _child?: AgentChildProcess;
  private _childExited = true;
  private _destroyPromise?: Promise<AgentProcessDestroyEvidence>;
  private _destroyRequested = false;
  private _storageRemoved = false;
  private _lastAgentDid?: string;
  private _lineReader?: BoundedLineReader;
  private _outputDrain?: Promise<void>;
  private _secretSubmitted = false;
  private _startCancellation?: CancellationSignal;
  private _startPromise?: Promise<AgentProcessRuntimeEvidence>;
  private _stopPromise?: Promise<AgentProcessStopEvidence>;
  private _stopping = false;
  private _terminationPromise?: Promise<void>;

  private constructor(
    options: AgentProcessRuntimeOptions,
    storageDirectory: string,
    childEntry: AgentChildEntry,
    dependencies: AgentProcessRuntimeDependencies,
  ) {
    this.#actorGatewayUri = options.actorGatewayUri;
    this._beforeChildStart = dependencies.beforeChildStart ?? (async (): Promise<void> => {});
    this._beforeSecretSubmit = dependencies.beforeSecretSubmit ?? (async (): Promise<void> => {});
    this._beforeStopComplete = dependencies.beforeStopComplete ?? (async (): Promise<void> => {});
    this._childEntry = childEntry;
    this._remoteDwnOrigin = options.remoteDwnOrigin;
    this._removeStorage = dependencies.removeStorage ?? (async (directory): Promise<void> => rm(directory, {
      force     : true,
      recursive : true,
    }));
    this._storageDirectory = storageDirectory;
  }

  /** Creates a unique persistent data path and validates the exact released agent dependency. */
  public static async create(
    options: AgentProcessRuntimeOptions,
    dependencies: AgentProcessRuntimeDependencies = {},
  ): Promise<AgentProcessRuntime> {
    await resolveReleasedPackageManifest();
    const childEntry = await resolveAgentProcessChildEntry();
    const storageDirectory = await mkdtemp(join(tmpdir(), 'enbox-lab-agent-'));
    try {
      const parsed = parseAgentProcessChildStartCommand(JSON.stringify({
        actorGatewayUri : options.actorGatewayUri,
        remoteDwnOrigin : options.remoteDwnOrigin,
        storageDirectory,
        type            : 'start',
      }));
      return new AgentProcessRuntime(parsed, storageDirectory, childEntry, dependencies);
    } catch (error: unknown) {
      await rm(storageDirectory, { force: true, recursive: true }).catch((): void => {});
      throw error;
    }
  }

  public get active(): boolean {
    return this._active !== undefined && this._child !== undefined && !this._childExited && this._child.exitCode === null;
  }

  public get pid(): number | undefined {
    return this._child !== undefined && !this._childExited && this._child.exitCode === null
      ? this._child.pid
      : undefined;
  }
  public get storageDirectory(): string { return this._storageDirectory; }

  /** Prevents serialization from traversing native process handles or private gateway configuration. */
  public toJSON(): Readonly<{ active: boolean; pid?: number; storageDirectory: string }> {
    const pid = this.pid;
    return {
      active           : this.active,
      ...(pid === undefined ? {} : { pid }),
      storageDirectory : this._storageDirectory,
    };
  }

  /** Starts a fresh child, observes its locked vault, then sends one ephemeral password command. */
  public start(params: AgentProcessStartParams): Promise<AgentProcessRuntimeEvidence> {
    if (this._startPromise !== undefined) {
      return Promise.reject(new Error('AgentProcessRuntime: start is already in progress'));
    }
    if (this._destroyRequested) {
      return Promise.reject(new Error('AgentProcessRuntime: cannot start after destroy()'));
    }
    if (this._stopping) {
      return Promise.reject(new Error('AgentProcessRuntime: stop is still in progress'));
    }
    if (this._child !== undefined) {
      return Promise.reject(new Error('AgentProcessRuntime: agent child is already running'));
    }
    this._stopPromise = undefined;
    this._terminationPromise = undefined;
    this._secretSubmitted = false;
    const cancellation = cancellationSignal();
    this._startCancellation = cancellation;
    const starting = this.performStart(params, cancellation);
    const tracked = starting.finally((): void => {
      if (this._startPromise === tracked) { this._startPromise = undefined; }
      if (this._startCancellation === cancellation) { this._startCancellation = undefined; }
    });
    this._startPromise = tracked;
    return tracked;
  }

  private async performStart(
    params: AgentProcessStartParams,
    cancellation: CancellationSignal,
  ): Promise<AgentProcessRuntimeEvidence> {
    parseAgentProcessChildSecretCommand(JSON.stringify({ password: params.password, type: 'initialize' }));
    const beforeChildStart = this._beforeChildStart();
    const preStart = await Promise.race([
      beforeChildStart.then((): 'ready' => 'ready'),
      cancellation.promise.then((): 'cancelled' => 'cancelled'),
    ]);
    if (preStart === 'cancelled' || cancellation.cancelled() || this._destroyRequested) {
      void beforeChildStart.catch((): void => {});
      throw new Error('AgentProcessRuntime: start cancelled before child startup');
    }

    const environment = childEnvironment();
    const command = [process.execPath, this._childEntry.path];
    const child = Bun.spawn({
      cmd    : command,
      cwd    : this._storageDirectory,
      env    : environment,
      stderr : 'pipe',
      stdin  : 'pipe',
      stdout : 'pipe',
    });
    this._child = child;
    this._childExited = false;
    void child.exited.then((): void => {
      if (this._child === child) { this._childExited = true; }
    });
    this._lineReader = new BoundedLineReader(child.stdout);
    this.#sawStderr = false;
    this._outputDrain = this.drainStderr(child.stderr);
    void this._outputDrain.catch((): undefined => undefined);

    try {
      const startLine = `${JSON.stringify({
        actorGatewayUri  : this.#actorGatewayUri,
        remoteDwnOrigin  : this._remoteDwnOrigin,
        storageDirectory : this._storageDirectory,
        type             : 'start',
      })}\n`;
      if (Buffer.byteLength(startLine, 'utf8') > AGENT_PROCESS_CHILD_MAX_LINE_BYTES) {
        throw new Error('AgentProcessRuntime: startup command exceeded the line limit');
      }
      child.stdin.write(startLine);
      await child.stdin.flush();

      const awaiting = parseAgentProcessAwaitingSecret(await this._lineReader.readLine(START_TIMEOUT_MS));
      if (this._lastAgentDid !== undefined && awaiting.firstLaunch) {
        throw new Error('AgentProcessRuntime: durable agent vault state is missing');
      }
      if (cancellation.cancelled() || this._destroyRequested) {
        throw new Error('AgentProcessRuntime: start cancelled before secret submission');
      }
      const beforeSecretSubmit = this._beforeSecretSubmit();
      const secretGate = await Promise.race([
        beforeSecretSubmit.then((): 'ready' => 'ready'),
        cancellation.promise.then((): 'cancelled' => 'cancelled'),
      ]);
      if (secretGate === 'cancelled' || cancellation.cancelled() || this._destroyRequested) {
        void beforeSecretSubmit.catch((): void => {});
        throw new Error('AgentProcessRuntime: start cancelled before secret submission');
      }
      const secretType = awaiting.firstLaunch ? 'initialize' : 'reopen';
      const secretLine = `${JSON.stringify({ password: params.password, type: secretType })}\n`;
      if (Buffer.byteLength(secretLine, 'utf8') > AGENT_PROCESS_CHILD_MAX_LINE_BYTES) {
        throw new Error('AgentProcessRuntime: secret command exceeded the line limit');
      }
      this._secretSubmitted = true;
      child.stdin.write(secretLine);
      await child.stdin.flush();
      const active = parseAgentProcessActive(await this._lineReader.readLine(START_TIMEOUT_MS));
      if (active.firstLaunch !== awaiting.firstLaunch || active.dwnEndpoints[0] !== this._remoteDwnOrigin ||
        active.mode !== (awaiting.firstLaunch ? 'initialized' : 'reopened')) {
        throw new Error('AgentProcessRuntime: child active state does not match the requested runtime');
      }
      if (!awaiting.firstLaunch && this._lastAgentDid !== undefined && active.agentDid !== this._lastAgentDid) {
        throw new Error('AgentProcessRuntime: reopened child returned a different durable agent DID');
      }
      const commandContainsActorGateway = command.some((entry): boolean => entry.includes(this.#actorGatewayUri));
      const environmentContainsActorGateway = Object.entries(environment).some(([key, value]): boolean =>
        key.includes(this.#actorGatewayUri) || value.includes(this.#actorGatewayUri));
      if (commandContainsActorGateway || environmentContainsActorGateway) {
        throw new Error('AgentProcessRuntime: private process input escaped the stdin protocol');
      }
      const childPid = this._child?.pid;
      if (childPid === undefined) {
        throw new Error('AgentProcessRuntime: child PID is unavailable');
      }

      const evidence: AgentProcessRuntimeEvidence = {
        actorGatewayUriTransport                : 'stdin-ndjson',
        agentDid                                : active.agentDid,
        childArgumentsContainActorGatewayUri    : false,
        childEntryKind                          : this._childEntry.kind,
        childEntryPath                          : this._childEntry.path,
        childEnvironmentContainsActorGatewayUri : false,
        childEnvironmentKeys                    : ['NO_COLOR', 'PATH'],
        childPid,
        dwnEndpoints                            : active.dwnEndpoints,
        firstLaunch                             : active.firstLaunch,
        localDwnStrategy                        : 'off',
        locked                                  : false,
        lockedBeforeSecret                      : true,
        mode                                    : active.mode,
        packageName                             : active.packageName,
        packageVersion                          : active.packageVersion,
        passwordTransport                       : 'stdin-ndjson',
        protocolRecords                         : 2,
        published                               : true,
        remoteDwnOrigin                         : this._remoteDwnOrigin,
        storageDirectory                        : this._storageDirectory,
      };
      this._active = evidence;
      this._lastAgentDid = active.agentDid;
      return evidence;
    } catch (error: unknown) {
      await this.terminateChild(false).catch((): void => {});
      throw error;
    }
  }

  private async drainStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) { break; }
        if (result.value.byteLength > 0) { this.#sawStderr = true; }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Gracefully shuts down and locks the child while preserving the durable data path for reopen. */
  public stop(): Promise<AgentProcessStopEvidence> {
    if (this._destroyRequested) {
      return Promise.reject(new Error('AgentProcessRuntime: cannot stop after destroy()'));
    }
    if (this._stopPromise !== undefined) { return this._stopPromise; }
    this._startCancellation?.cancel();
    this._stopping = true;
    const stopping = this.performStop();
    const tracked = stopping.then(
      (evidence): AgentProcessStopEvidence => {
        if (this._stopPromise === tracked) { this._stopping = false; }
        return evidence;
      },
      (error: unknown): never => {
        if (this._stopPromise === tracked) {
          this._stopping = false;
          this._stopPromise = undefined;
        }
        throw error;
      },
    );
    this._stopPromise = tracked;
    return tracked;
  }

  private async performStop(): Promise<AgentProcessStopEvidence> {
    const starting = this._startPromise;
    if (starting !== undefined && !this._secretSubmitted) {
      await this.terminateChild(false);
    }
    await starting?.catch((): void => {});
    await this.terminateChild(true);
    await this._beforeStopComplete();
    if (!existsSync(this._storageDirectory)) {
      throw new Error('AgentProcessRuntime: durable storage disappeared during stop()');
    }
    return {
      ...(this._lastAgentDid === undefined ? {} : { agentDid: this._lastAgentDid }),
      locked           : true,
      processExited    : true,
      storageDirectory : this._storageDirectory,
      storagePreserved : true,
      stopped          : true,
    };
  }

  private terminateChild(graceful: boolean): Promise<void> {
    if (this._terminationPromise === undefined) {
      const terminating = this.performChildTermination(graceful);
      const tracked = terminating.catch((error: unknown): never => {
        if (this._terminationPromise === tracked) { this._terminationPromise = undefined; }
        throw error;
      });
      this._terminationPromise = tracked;
    }
    return this._terminationPromise;
  }

  private async performChildTermination(graceful: boolean): Promise<void> {
    const child = this._child;
    const lineReader = this._lineReader;
    if (child === undefined) { return; }
    let confirmedExited = this._childExited || child.exitCode !== null;
    let stoppedRecordObserved = false;
    let terminationError: Error | undefined;
    try {
      if (child.exitCode === null && graceful && lineReader !== undefined) {
        try {
          child.stdin.write('{"type":"stop"}\n');
          child.stdin.end();
          parseAgentProcessStopped(await lineReader.readLine(CHILD_STOP_TIMEOUT_MS));
          stoppedRecordObserved = true;
        } catch (error: unknown) {
          terminationError = error instanceof Error ? error : new Error(String(error));
        }
        if (stoppedRecordObserved && await waitForExit(child, CHILD_STOP_TIMEOUT_MS)) {
          const exitCode = await child.exited;
          confirmedExited = true;
          if (exitCode !== 0) {
            terminationError = new Error(`AgentProcessRuntime: child exited with code ${exitCode} during shutdown`);
          }
        }
      }
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        if (!await waitForExit(child, CHILD_TERM_TIMEOUT_MS)) {
          child.kill('SIGKILL');
          if (!await waitForExit(child, CHILD_KILL_TIMEOUT_MS)) {
            throw new Error(`AgentProcessRuntime: child process ${child.pid} did not exit after SIGKILL`);
          }
        }
      }
      const exitCode = await child.exited;
      confirmedExited = true;
      await this._outputDrain?.catch((): void => {
        terminationError ??= new Error('AgentProcessRuntime: failed to capture bounded child output');
      });
      if (this.#sawStderr) {
        terminationError ??= new Error('AgentProcessRuntime: child emitted stderr');
      }
      if (graceful && stoppedRecordObserved && exitCode !== 0) {
        terminationError ??= new Error(`AgentProcessRuntime: child exited with code ${exitCode} during shutdown`);
      }
      if (stoppedRecordObserved) {
        await lineReader?.assertEnded().catch((error: unknown): void => {
          terminationError ??= error instanceof Error ? error : new Error(String(error));
        });
      }
      if (graceful && !stoppedRecordObserved) {
        terminationError = new Error(
          `AgentProcessRuntime: child did not prove a locked shutdown${exitCode === 0 ? '' : ` (exit ${exitCode})`}`,
        );
      }
    } finally {
      if (confirmedExited) {
        try {
          lineReader?.release();
        } catch {
          terminationError ??= new Error('AgentProcessRuntime: failed to release the child output reader');
        }
        this._active = undefined;
        this._child = undefined;
        this._childExited = true;
        this._lineReader = undefined;
        this._outputDrain = undefined;
        this.#sawStderr = false;
      }
    }
    if (terminationError !== undefined) {
      throw terminationError;
    }
  }

  /** Permanently removes the owned data path after the child process has exited. Cleanup is retryable. */
  public destroy(): Promise<AgentProcessDestroyEvidence> {
    this._destroyRequested = true;
    this._startCancellation?.cancel();
    if (this._destroyPromise === undefined) {
      const destroying = this.performDestroy();
      const tracked = destroying.catch((error: unknown): never => {
        if (this._destroyPromise === tracked) { this._destroyPromise = undefined; }
        throw error;
      });
      this._destroyPromise = tracked;
    }
    return this._destroyPromise;
  }

  private async performDestroy(): Promise<AgentProcessDestroyEvidence> {
    if (this._storageRemoved) {
      return {
        processExited    : true,
        storageDirectory : this._storageDirectory,
        storageRemoved   : true,
        stopped          : true,
      };
    }
    let processError: unknown;
    const starting = this._startPromise;
    try {
      if (starting !== undefined) {
        await this.terminateChild(false);
        await starting.catch((): void => {});
      } else {
        await this.terminateChild(true);
      }
    } catch (error: unknown) {
      processError = error;
    }
    if (this._child !== undefined) {
      throw processError ?? new Error('AgentProcessRuntime: child remained live during destroy()');
    }
    try {
      await this._removeStorage(this._storageDirectory);
    } catch (error: unknown) {
      if (!existsSync(this._storageDirectory)) { this._storageRemoved = true; }
      throw error;
    }
    if (existsSync(this._storageDirectory)) {
      throw new Error(`AgentProcessRuntime: storage directory remained at ${this._storageDirectory}`);
    }
    this._storageRemoved = true;
    if (processError !== undefined) { throw processError; }
    return {
      processExited    : true,
      storageDirectory : this._storageDirectory,
      storageRemoved   : true,
      stopped          : true,
    };
  }
}
