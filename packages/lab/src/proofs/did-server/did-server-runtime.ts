import type { DidServerChildReady } from './did-server-child-protocol.js';
import type { Server } from 'bun';

import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { dirname, extname, join, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import {
  DID_SERVER_CHILD_MAX_LINE_BYTES,
  DID_SERVER_PACKAGE_NAME,
  DID_SERVER_PACKAGE_VERSION,
} from './did-server-child-protocol.js';

const CHILD_KILL_TIMEOUT_MS = 2_000;
const CHILD_STOP_TIMEOUT_MS = 5_000;
const CHILD_TERM_TIMEOUT_MS = 3_000;
const DWN_SDK_VERSION = '0.4.27';
const LOOPBACK_HOSTNAME = '127.0.0.1';
const OUTPUT_TAIL_LIMIT = 16_384;
const READINESS_MAX_LINE_BYTES = 512;
const READINESS_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 2_000;
const STARTUP_FETCH_ATTEMPT_TIMEOUT_MS = 500;
const STARTUP_FETCH_RETRY_INTERVAL_MS = 25;

type DidServerChildProcess = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

type InstalledPackageManifest = Readonly<{
  name?: unknown;
  version?: unknown;
}>;

type ServerInfo = Readonly<{
  sdkVersion?: unknown;
  server?: unknown;
  url?: unknown;
  version?: unknown;
  webSocketSupport?: unknown;
}>;

type ReadinessLine = Readonly<{
  line: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  trailingBytes: Uint8Array;
}>;

type ProxyTarget = {
  backendOrigin?: string;
  publicOrigin?: string;
};

type StartupFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

type DeferredSignal = Readonly<{
  promise: Promise<void>;
  resolve(): void;
}>;

class ChildExitedProofError extends Error {}

export type DidServerRuntimeEvidence = Readonly<{
  backendHostname: typeof LOOPBACK_HOSTNAME;
  backendOrigin: string;
  backendPort: number;
  boundHostname: typeof LOOPBACK_HOSTNAME;
  boundPort: number;
  childArgumentsContainResolverBaseUri: false;
  childEntryKind: 'built-js' | 'source-ts';
  childEntryPath: string;
  childEnvironmentContainsResolverBaseUri: false;
  childEnvironmentKeys: readonly ['NO_COLOR', 'PATH'];
  childPid: number;
  health: Readonly<{ ok: true }>;
  origin: string;
  packageName: typeof DID_SERVER_PACKAGE_NAME;
  packageVersion: typeof DID_SERVER_PACKAGE_VERSION;
  readinessRecords: 1;
  reportedOrigin: string;
  reportedSdkVersion: typeof DWN_SDK_VERSION;
  reportedServerName: typeof DID_SERVER_PACKAGE_NAME;
  reportedVersion: typeof DID_SERVER_PACKAGE_VERSION;
  resolverEndpointTransport: 'stdin-ndjson';
  storageDirectory: string;
  storageIsolated: true;
  webSocketSupport: false;
}>;

export type DidServerRuntimeStopEvidence = Readonly<{
  backendOrigin?: string;
  origin: string;
  portClosed: true;
  storageRemoved: true;
  stopped: true;
}>;

export type DidServerRuntimeDependencies = Readonly<{
  beforeChildStart?: () => Promise<void>;
  removeStorage?: (directory: string) => Promise<void>;
  startupFetch?: StartupFetch;
}>;

function delay(durationMs: number): Promise<void> {
  return new Promise<void>((resolvePromise): void => { setTimeout(resolvePromise, durationMs); });
}

function deferredSignal(): DeferredSignal {
  let resolve = (): void => {};
  const promise = new Promise<void>((resolvePromise): void => { resolve = resolvePromise; });
  return { promise, resolve };
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index): boolean => key === expectedKeys[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function childEnvironment(): Record<string, string> {
  return {
    NO_COLOR : '1',
    PATH     : process.env.PATH ?? '',
  };
}

function startProxy(target: ProxyTarget): Server<undefined> {
  return Bun.serve({
    fetch: async (request): Promise<Response> => {
      const publicOrigin = target.publicOrigin;
      if (publicOrigin === undefined) {
        return new Response('DID server proxy is initializing', { status: 503 });
      }
      const incoming = new URL(request.url);
      const expected = new URL(publicOrigin);
      if (incoming.origin !== publicOrigin || request.headers.get('host') !== expected.host) {
        return new Response('invalid proxy authority', { status: 421 });
      }
      if (target.backendOrigin === undefined) {
        return new Response('DID server backend is starting', { status: 503 });
      }
      const upstream = new URL(target.backendOrigin);
      upstream.pathname = incoming.pathname;
      upstream.search = incoming.search;
      return fetch(new Request(upstream, request), { redirect: 'manual' });
    },
    hostname : LOOPBACK_HOSTNAME,
    port     : 0,
  });
}

function redactOutput(value: string, resolverBaseUri: string): string {
  const withoutExactSecret = resolverBaseUri.length > 0 ? value.split(resolverBaseUri).join('[redacted]') : value;
  return withoutExactSecret
    .replace(/(\/__lab\/resolver\/)[^/\s"'<>]+\//gu, '$1[redacted]/')
    .replace(/https?:\/\/127\.0\.0\.1:\d+\/__lab\/resolver\/[^\s"'<>]*/gu, '[redacted-resolver-endpoint]')
    .replace(/\b[0-9a-f]{64}\b/giu, '[redacted-capability]');
}

/** Resolves the colocated TypeScript child in source and JavaScript child after compilation. */
export async function resolveDidServerChildEntry(
  runtimeModulePath: string = fileURLToPath(import.meta.url),
): Promise<Readonly<{ kind: 'built-js' | 'source-ts'; path: string }>> {
  const runtimeExtension = extname(runtimeModulePath);
  const kind = runtimeExtension === '.ts' ? 'source-ts' : 'built-js';
  const childExtension = kind === 'source-ts' ? '.ts' : '.js';
  const path = join(dirname(runtimeModulePath), `did-server-child${childExtension}`);
  if (!await Bun.file(path).exists()) {
    throw new Error(`DidServerRuntime: colocated ${kind} child entry is missing`);
  }
  return { kind, path };
}

export function parseDidServerChildReadiness(line: string): DidServerChildReady {
  if (line.length === 0 || Buffer.byteLength(line, 'utf8') > READINESS_MAX_LINE_BYTES) {
    throw new Error('DidServerRuntime: invalid child readiness record');
  }

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('DidServerRuntime: invalid child readiness record');
  }
  if (!isRecord(value) ||
    !hasExactKeys(value, ['origin', 'packageName', 'packageVersion', 'type']) ||
    value.type !== 'ready' || value.packageName !== DID_SERVER_PACKAGE_NAME ||
    value.packageVersion !== DID_SERVER_PACKAGE_VERSION || typeof value.origin !== 'string') {
    throw new Error('DidServerRuntime: invalid child readiness record');
  }

  let origin: URL;
  try {
    origin = new URL(value.origin);
  } catch {
    throw new Error('DidServerRuntime: invalid child readiness origin');
  }
  if (origin.href !== `${value.origin}/` || origin.protocol !== 'http:' || origin.hostname !== LOOPBACK_HOSTNAME ||
    origin.port.length === 0 || origin.username.length > 0 || origin.password.length > 0 ||
    origin.pathname !== '/' || origin.search.length > 0 || origin.hash.length > 0) {
    throw new Error('DidServerRuntime: invalid child readiness origin');
  }
  const port = Number(origin.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('DidServerRuntime: invalid child readiness origin');
  }

  return {
    origin         : value.origin,
    packageName    : DID_SERVER_PACKAGE_NAME,
    packageVersion : DID_SERVER_PACKAGE_VERSION,
    type           : 'ready',
  };
}

async function readBoundedReadiness(stream: ReadableStream<Uint8Array>): Promise<ReadinessLine> {
  const reader = stream.getReader();
  const bytes: number[] = [];
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        throw new Error('DidServerRuntime: child stdout ended before readiness');
      }
      const newlineIndex = result.value.indexOf(0x0a);
      const lineBytes = newlineIndex === -1 ? result.value : result.value.slice(0, newlineIndex);
      if (bytes.length + lineBytes.byteLength > READINESS_MAX_LINE_BYTES) {
        throw new Error('DidServerRuntime: child readiness exceeded the line limit');
      }
      bytes.push(...lineBytes);
      if (newlineIndex !== -1) {
        if (bytes.at(-1) === 0x0d) { bytes.pop(); }
        const line = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
        return { line, reader, trailingBytes: result.value.slice(newlineIndex + 1) };
      }
    }
  } catch (error: unknown) {
    reader.releaseLock();
    throw error;
  }
}

async function waitForExit(child: DidServerChildProcess, timeoutMs: number): Promise<boolean> {
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

async function assertLoopbackPortClosed(port: number): Promise<void> {
  const deadline = performance.now() + REQUEST_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const closed = await new Promise<boolean>((resolvePromise, reject): void => {
      const socket = createConnection({ host: LOOPBACK_HOSTNAME, port });
      const timeoutId = setTimeout((): void => {
        socket.destroy();
        reject(new Error(`DidServerRuntime: port ${port} close probe timed out`));
      }, REQUEST_TIMEOUT_MS);
      socket.once('connect', (): void => {
        clearTimeout(timeoutId);
        socket.destroy();
        resolvePromise(false);
      });
      socket.once('error', (error): void => {
        clearTimeout(timeoutId);
        socket.destroy();
        if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
          resolvePromise(true);
        } else {
          reject(error);
        }
      });
    });
    if (closed) { return; }
    await delay(25);
  }
  throw new Error(`DidServerRuntime: port ${port} remained bound after shutdown`);
}

async function resolveReleasedPackageManifest(): Promise<string> {
  const serverEntryPath = fileURLToPath(import.meta.resolve(DID_SERVER_PACKAGE_NAME));
  const packageJsonPath = resolve(dirname(serverEntryPath), '../../../package.json');
  const packageFile = Bun.file(packageJsonPath);
  if (!await packageFile.exists()) {
    throw new Error('DidServerRuntime: released server manifest is missing');
  }
  const manifest = await packageFile.json() as InstalledPackageManifest;
  if (manifest.name !== DID_SERVER_PACKAGE_NAME || manifest.version !== DID_SERVER_PACKAGE_VERSION) {
    throw new Error(
      `DidServerRuntime: expected ${DID_SERVER_PACKAGE_NAME}@${DID_SERVER_PACKAGE_VERSION}, ` +
      `found ${String(manifest.name)}@${String(manifest.version)}`,
    );
  }
  return packageJsonPath;
}

/** Runs a released DWN server with a private did:dht resolver in an isolated child process. */
export class DidServerRuntime {
  #outputTail = '';
  readonly #resolverBaseUri: string;

  private readonly _beforeChildStart: () => Promise<void>;
  private readonly _childEntryKind: 'built-js' | 'source-ts';
  private readonly _childEntryPath: string;
  private readonly _directory: string;
  private readonly _forceDisposeSignal = deferredSignal();
  private readonly _origin: string;
  private readonly _proxy: Server<undefined>;
  private readonly _proxyTarget: ProxyTarget;
  private readonly _removeStorage: (directory: string) => Promise<void>;
  private readonly _startupFetch: StartupFetch;
  private _child?: DidServerChildProcess;
  private _childShutdownPromise?: Promise<void>;
  private _cleanupPromise?: Promise<DidServerRuntimeStopEvidence>;
  private _disposed = false;
  private _forceDisposePromise?: Promise<DidServerRuntimeStopEvidence>;
  private _backendOrigin?: string;
  private _childProofFailureReported = false;
  private _outputDrainPromises: Promise<void>[] = [];
  private _protocolViolation = false;
  private _startPromise?: Promise<DidServerRuntimeEvidence>;
  private _stopPromise?: Promise<DidServerRuntimeStopEvidence>;
  private _stopRequested = false;

  private constructor(
    resolverBaseUri: string,
    directory: string,
    childEntryPath: string,
    childEntryKind: 'built-js' | 'source-ts',
    proxy: Server<undefined>,
    proxyTarget: ProxyTarget,
    dependencies: DidServerRuntimeDependencies,
  ) {
    this._beforeChildStart = dependencies.beforeChildStart ?? (async (): Promise<void> => {});
    this._childEntryKind = childEntryKind;
    this._childEntryPath = childEntryPath;
    this._directory = directory;
    this._origin = `http://${LOOPBACK_HOSTNAME}:${proxy.port}`;
    this._proxy = proxy;
    this._proxyTarget = proxyTarget;
    this._removeStorage = dependencies.removeStorage ?? (async (path): Promise<void> => rm(path, {
      force     : true,
      recursive : true,
    }));
    this._startupFetch = dependencies.startupFetch ?? fetch;
    this.#resolverBaseUri = resolverBaseUri;
  }

  /** Creates unique file-backed storage and validates the exact released server dependency. */
  public static async create(
    resolverBaseUri: string,
    dependencies: DidServerRuntimeDependencies = {},
  ): Promise<DidServerRuntime> {
    await resolveReleasedPackageManifest();
    const childEntry = await resolveDidServerChildEntry();
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-did-server-'));
    let proxy: Server<undefined> | undefined;
    try {
      const proxyTarget: ProxyTarget = {};
      proxy = startProxy(proxyTarget);
      proxyTarget.publicOrigin = `http://${LOOPBACK_HOSTNAME}:${proxy.port}`;
      return new DidServerRuntime(
        resolverBaseUri,
        directory,
        childEntry.path,
        childEntry.kind,
        proxy,
        proxyTarget,
        dependencies,
      );
    } catch (error: unknown) {
      if (proxy !== undefined) { await proxy.stop(true).catch((): void => {}); }
      await rm(directory, { force: true, recursive: true }).catch((): void => {});
      throw error;
    }
  }

  public get origin(): string { return this._origin; }
  public get pid(): number | undefined { return this._child?.pid; }

  /** Prevents serialization from traversing process handles or secret-bearing protocol state. */
  public toJSON(): Readonly<{ origin: string; pid?: number }> {
    const pid = this.pid;
    return pid === undefined ? { origin: this._origin } : { origin: this._origin, pid };
  }

  /** Starts the child once and returns validated, secret-free runtime evidence. */
  public start(): Promise<DidServerRuntimeEvidence> {
    if (this._stopRequested) {
      return Promise.reject(new Error('DidServerRuntime: cannot start after stop()'));
    }
    this._startPromise ??= this.performStart();
    return this._startPromise;
  }

  private async performStart(): Promise<DidServerRuntimeEvidence> {
    await this._beforeChildStart();
    if (this._disposed) {
      throw new Error('DidServerRuntime: disposed before child startup');
    }

    const environment = childEnvironment();
    const command = [process.execPath, this._childEntryPath];
    const child = Bun.spawn({
      cmd    : command,
      cwd    : this._directory,
      env    : environment,
      stderr : 'pipe',
      stdin  : 'pipe',
      stdout : 'pipe',
    });
    this._child = child;
    this.captureStderr(child);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let readinessPromise: Promise<Readonly<{
      readiness: ReadinessLine;
      type: 'ready';
    }>> | undefined;

    try {
      const startLine = JSON.stringify({
        publicOrigin     : this._origin,
        resolverBaseUri  : this.#resolverBaseUri,
        storageDirectory : this._directory,
        type             : 'start',
      }) + '\n';
      if (Buffer.byteLength(startLine, 'utf8') > DID_SERVER_CHILD_MAX_LINE_BYTES) {
        throw new Error('DidServerRuntime: startup command exceeded the line limit');
      }
      child.stdin.write(startLine);
      await child.stdin.flush();

      const timeout = new Promise<Readonly<{ type: 'timeout' }>>((resolvePromise): void => {
        timeoutId = setTimeout((): void => { resolvePromise({ type: 'timeout' }); }, READINESS_TIMEOUT_MS);
      });
      readinessPromise = readBoundedReadiness(child.stdout).then((readiness): Readonly<{
        readiness: ReadinessLine;
        type: 'ready';
      }> => ({ readiness, type: 'ready' }));
      const exitPromise = child.exited.then((exitCode): Readonly<{ exitCode: number; type: 'exit' }> => ({
        exitCode,
        type: 'exit',
      }));
      const outcome = await Promise.race([readinessPromise, exitPromise, timeout]);
      if (outcome.type === 'timeout') {
        throw new Error(`DidServerRuntime: child readiness timed out after ${READINESS_TIMEOUT_MS}ms`);
      }
      if (outcome.type === 'exit') {
        await Promise.allSettled(this._outputDrainPromises);
        const output = redactOutput(this.#outputTail.trim(), this.#resolverBaseUri);
        throw new Error(
          `DidServerRuntime: child exited with code ${outcome.exitCode} before readiness` +
          `${output.length > 0 ? `: ${output}` : ''}`,
        );
      }

      const ready = parseDidServerChildReadiness(outcome.readiness.line);
      if (outcome.readiness.trailingBytes.byteLength > 0) {
        outcome.readiness.reader.releaseLock();
        throw new Error('DidServerRuntime: child emitted more than one readiness record');
      }
      this.captureRemainingStdout(outcome.readiness.reader);
      this._backendOrigin = ready.origin;
      if (this._disposed) {
        throw new Error('DidServerRuntime: disposed during child startup');
      }
      const evidence = await this.collectEvidence(command, environment, ready);
      if (this._protocolViolation) {
        throw new Error('DidServerRuntime: child emitted more than one readiness record');
      }
      return evidence;
    } catch (error: unknown) {
      this._proxyTarget.backendOrigin = undefined;
      await this.terminateChild(false).catch((): void => {});
      throw error;
    } finally {
      clearTimeout(timeoutId);
      void readinessPromise?.catch((): undefined => undefined);
    }
  }

  private captureStderr(child: DidServerChildProcess): void {
    this.trackOutputDrain(this.drainOutput(child.stderr, false));
  }

  private captureRemainingStdout(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    this.trackOutputDrain((async (): Promise<void> => {
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) { break; }
          if (result.value.byteLength > 0) {
            this._protocolViolation = true;
            this.appendOutput(new TextDecoder().decode(result.value));
          }
        }
      } finally {
        reader.releaseLock();
      }
    })());
  }

  private trackOutputDrain(drain: Promise<void>): void {
    this._outputDrainPromises.push(drain);
    void drain.catch((): undefined => undefined);
  }

  private async drainOutput(stream: ReadableStream<Uint8Array>, protocolOutput: boolean): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) { break; }
        if (protocolOutput && result.value.byteLength > 0) { this._protocolViolation = true; }
        this.appendOutput(decoder.decode(result.value, { stream: true }));
      }
      this.appendOutput(decoder.decode());
    } finally {
      reader.releaseLock();
    }
  }

  private appendOutput(value: string): void {
    this.#outputTail = `${this.#outputTail}${value}`.slice(-OUTPUT_TAIL_LIMIT);
  }

  private async fetchStartupResponse(url: string): Promise<Response> {
    const deadline = performance.now() + REQUEST_TIMEOUT_MS;
    let attempts = 0;
    while (performance.now() < deadline) {
      attempts += 1;
      try {
        const remainingMs = Math.max(1, Math.ceil(deadline - performance.now()));
        return await this._startupFetch(url, {
          redirect : 'error',
          signal   : AbortSignal.timeout(Math.min(STARTUP_FETCH_ATTEMPT_TIMEOUT_MS, remainingMs)),
        });
      } catch {
        const child = this._child;
        if (child === undefined) {
          throw new Error('DidServerRuntime: child is unavailable during startup verification');
        }
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) { break; }
        const outcome = await Promise.race([
          child.exited.then((exitCode): Readonly<{ exitCode: number; type: 'exit' }> => ({ exitCode, type: 'exit' })),
          delay(Math.min(STARTUP_FETCH_RETRY_INTERVAL_MS, remainingMs))
            .then((): Readonly<{ type: 'retry' }> => ({ type: 'retry' })),
        ]);
        if (outcome.type === 'exit') {
          await Promise.allSettled(this._outputDrainPromises);
          const output = redactOutput(this.#outputTail.trim(), this.#resolverBaseUri);
          throw new Error(
            `DidServerRuntime: child exited with code ${outcome.exitCode} during startup verification` +
            `${output.length > 0 ? `: ${output}` : ''}`,
          );
        }
      }
    }
    throw new Error(`DidServerRuntime: startup verification failed after ${attempts} network attempts`);
  }

  private async collectEvidence(
    command: string[],
    environment: Record<string, string>,
    ready: DidServerChildReady,
  ): Promise<DidServerRuntimeEvidence> {
    const backendHealthResponse = await this.fetchStartupResponse(`${ready.origin}/health`);
    if (!backendHealthResponse.ok) {
      await backendHealthResponse.body?.cancel().catch((): void => {});
      throw new Error(`DidServerRuntime: backend health check returned HTTP ${backendHealthResponse.status}`);
    }
    const backendHealth = await backendHealthResponse.json() as { ok?: unknown };
    if (backendHealth.ok !== true) {
      throw new Error('DidServerRuntime: backend health check did not return { ok: true }');
    }

    this._proxyTarget.backendOrigin = ready.origin;
    const [healthResponse, infoResponse] = await Promise.all([
      this.fetchStartupResponse(`${this._origin}/health`),
      this.fetchStartupResponse(`${this._origin}/info`),
    ]);
    if (!healthResponse.ok) {
      await healthResponse.body?.cancel().catch((): void => {});
      throw new Error(`DidServerRuntime: health check returned HTTP ${healthResponse.status}`);
    }
    if (!infoResponse.ok) {
      await infoResponse.body?.cancel().catch((): void => {});
      throw new Error(`DidServerRuntime: info check returned HTTP ${infoResponse.status}`);
    }
    const health = await healthResponse.json() as { ok?: unknown };
    const info = await infoResponse.json() as ServerInfo;
    if (health.ok !== true) {
      throw new Error('DidServerRuntime: health check did not return { ok: true }');
    }
    if (info.server !== DID_SERVER_PACKAGE_NAME || info.version !== DID_SERVER_PACKAGE_VERSION ||
      info.sdkVersion !== DWN_SDK_VERSION ||
      info.url !== this._origin || info.webSocketSupport !== false) {
      throw new Error('DidServerRuntime: /info did not match the released private-DID server contract');
    }

    const publicUrl = new URL(this._origin);
    const backendUrl = new URL(ready.origin);
    const childPid = this._child?.pid;
    if (childPid === undefined) {
      throw new Error('DidServerRuntime: child PID is unavailable');
    }
    const commandContainsSecret = command.some((value): boolean => value.includes(this.#resolverBaseUri));
    const environmentContainsSecret = Object.entries(environment).some(([key, value]): boolean =>
      key.includes(this.#resolverBaseUri) || value.includes(this.#resolverBaseUri));
    if (commandContainsSecret || environmentContainsSecret) {
      throw new Error('DidServerRuntime: resolver endpoint escaped the stdin protocol');
    }

    return {
      backendHostname                         : LOOPBACK_HOSTNAME,
      backendOrigin                           : ready.origin,
      backendPort                             : Number(backendUrl.port),
      boundHostname                           : LOOPBACK_HOSTNAME,
      boundPort                               : Number(publicUrl.port),
      childArgumentsContainResolverBaseUri    : false,
      childEntryKind                          : this._childEntryKind,
      childEntryPath                          : this._childEntryPath,
      childEnvironmentContainsResolverBaseUri : false,
      childEnvironmentKeys                    : ['NO_COLOR', 'PATH'],
      childPid,
      health                                  : { ok: true },
      origin                                  : this._origin,
      packageName                             : ready.packageName,
      packageVersion                          : ready.packageVersion,
      readinessRecords                        : 1,
      reportedOrigin                          : this._origin,
      reportedSdkVersion                      : DWN_SDK_VERSION,
      reportedServerName                      : info.server,
      reportedVersion                         : info.version,
      resolverEndpointTransport               : 'stdin-ndjson',
      storageDirectory                        : this._directory,
      storageIsolated                         : true,
      webSocketSupport                        : false,
    };
  }

  /** Cancels startup without waiting for a stalled pre-start dependency. */
  public forceDispose(): Promise<DidServerRuntimeStopEvidence> {
    this._disposed = true;
    this._stopRequested = true;
    void this._startPromise?.catch((): undefined => undefined);
    if (this._forceDisposePromise === undefined) {
      const disposing = this.cleanupOnce('force cleanup', false);
      const tracked = disposing.catch((error: unknown): never => {
        if (this._forceDisposePromise === tracked) {
          this._forceDisposePromise = undefined;
          this._stopPromise = undefined;
        }
        throw error;
      });
      this._forceDisposePromise = tracked;
      this._stopPromise = tracked;
      this._forceDisposeSignal.resolve();
    }
    return this._forceDisposePromise;
  }

  /** Sends the normal stop command, then escalates to TERM and KILL if necessary. */
  public stop(): Promise<DidServerRuntimeStopEvidence> {
    this._stopRequested = true;
    if (this._forceDisposePromise !== undefined) { return this._forceDisposePromise; }
    if (this._stopPromise === undefined) {
      const stopping = this.performStop();
      const tracked = stopping.catch((error: unknown): never => {
        if (this._stopPromise === tracked) { this._stopPromise = undefined; }
        throw error;
      });
      this._stopPromise = tracked;
    }
    return this._stopPromise;
  }

  private async performStop(): Promise<DidServerRuntimeStopEvidence> {
    if (this._startPromise !== undefined) {
      await Promise.race([
        this._startPromise.catch((): void => {}),
        this._forceDisposeSignal.promise,
      ]);
    }
    if (this._forceDisposePromise !== undefined) { return this._forceDisposePromise; }
    return this.cleanupOnce('cleanup', true);
  }

  private cleanupOnce(action: string, graceful: boolean): Promise<DidServerRuntimeStopEvidence> {
    if (this._cleanupPromise === undefined) {
      const cleaning = this.cleanupRuntime(action, graceful);
      const tracked = cleaning.catch((error: unknown): never => {
        if (this._cleanupPromise === tracked) { this._cleanupPromise = undefined; }
        throw error;
      });
      this._cleanupPromise = tracked;
    }
    return this._cleanupPromise;
  }

  private async cleanupRuntime(action: string, graceful: boolean): Promise<DidServerRuntimeStopEvidence> {
    const errors: string[] = [];
    const backendOrigin = this._backendOrigin;
    this._proxyTarget.backendOrigin = undefined;
    let childClosed = this._child === undefined;
    try {
      await this.terminateChild(graceful);
      childClosed = true;
    } catch (error: unknown) {
      if (error instanceof ChildExitedProofError) { childClosed = true; }
      errors.push(redactOutput(error instanceof Error ? error.message : String(error), this.#resolverBaseUri));
    }
    try { await this._proxy.stop(true); } catch (error: unknown) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    let publicPortClosed = false;
    try {
      await assertLoopbackPortClosed(Number(new URL(this._origin).port));
      publicPortClosed = true;
    } catch (error: unknown) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    let backendPortClosed = backendOrigin === undefined;
    if (backendOrigin !== undefined) {
      try {
        await assertLoopbackPortClosed(Number(new URL(backendOrigin).port));
        backendPortClosed = true;
      } catch (error: unknown) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (childClosed && publicPortClosed && backendPortClosed) {
      try {
        await this._removeStorage(this._directory);
        if (existsSync(this._directory)) {
          errors.push(`DidServerRuntime: storage directory remained at ${this._directory}`);
        }
      } catch (error: unknown) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (errors.length > 0) {
      throw new Error(`DidServerRuntime: ${action} failed: ${errors.join('; ')}`);
    }
    return {
      backendOrigin,
      origin         : this._origin,
      portClosed     : true,
      storageRemoved : true,
      stopped        : true,
    };
  }

  private terminateChild(graceful: boolean): Promise<void> {
    if (this._childShutdownPromise === undefined) {
      const terminating = this.performChildTermination(graceful);
      const tracked = terminating.catch((error: unknown): never => {
        if (this._childShutdownPromise === tracked) { this._childShutdownPromise = undefined; }
        throw error;
      });
      this._childShutdownPromise = tracked;
    }
    return this._childShutdownPromise;
  }

  private async performChildTermination(graceful: boolean): Promise<void> {
    const child = this._child;
    if (child === undefined) { return; }
    if (child.exitCode === null && graceful) {
      try {
        child.stdin.write('{"type":"stop"}\n');
        child.stdin.end();
      } catch {
        // The child can close stdin while failing startup; signal escalation remains available.
      }
      if (await waitForExit(child, CHILD_STOP_TIMEOUT_MS)) {
        const exitCode = await child.exited;
        await this.assertCleanOutputAndExit(exitCode, true);
        return;
      }
    }
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      if (!await waitForExit(child, CHILD_TERM_TIMEOUT_MS)) {
        child.kill('SIGKILL');
        if (!await waitForExit(child, CHILD_KILL_TIMEOUT_MS)) {
          throw new Error(`DidServerRuntime: child process ${child.pid} did not exit after SIGKILL`);
        }
      }
      await child.exited;
      await this.assertCleanOutputAndExit(undefined, false);
    } else {
      const exitCode = await child.exited;
      await this.assertCleanOutputAndExit(exitCode, graceful);
    }
  }

  private async assertCleanOutputAndExit(exitCode: number | undefined, requireCleanExit: boolean): Promise<void> {
    const drainResults = await Promise.allSettled(this._outputDrainPromises);
    let failure: string | undefined;
    if (drainResults.some((result): boolean => result.status === 'rejected')) {
      failure = 'DidServerRuntime: failed to capture bounded child output';
    } else if (this._protocolViolation) {
      failure = 'DidServerRuntime: child emitted stdout after its readiness record';
    } else if (requireCleanExit && exitCode !== 0) {
      const output = redactOutput(this.#outputTail.trim(), this.#resolverBaseUri);
      failure =
        `DidServerRuntime: child exited with code ${String(exitCode)} during shutdown` +
        `${output.length > 0 ? `: ${output}` : ''}`;
    }
    if (failure !== undefined && !this._childProofFailureReported) {
      this._childProofFailureReported = true;
      throw new ChildExitedProofError(failure);
    }
  }
}
