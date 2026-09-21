import type { Server } from 'bun';

import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { dirname, join, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

export const CONNECT_RELAY_SERVER_VERSION = '0.1.43';

const BACKEND_START_ATTEMPTS = 3;
const CHILD_KILL_TIMEOUT_MS = 2_000;
const CHILD_TERM_TIMEOUT_MS = 3_000;
const EXPECTED_SERVER_BIN = './dist/esm/src/main.js';
const LOOPBACK_HOSTNAME = '127.0.0.1';
const OUTPUT_TAIL_LIMIT = 16_384;
const READINESS_POLL_MS = 25;
const READINESS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 1_000;
const SERVER_PACKAGE_NAME = '@enbox/dwn-server';

type RelayChildProcess = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

export type ConnectRelayHealth = Readonly<{ ok: true }>;

export type ConnectRelayRuntimeEvidence = Readonly<{
  backendPort: number;
  boundHostname: string;
  boundPort: number;
  configuredOrigin: string;
  dataStore: string;
  deliveryEnabled: false;
  forwardingEnabled: false;
  health: ConnectRelayHealth;
  messageStore: string;
  origin: string;
  packageJsonPath: string;
  rateLimitBurst: 0;
  rateLimitRequestsPerSecond: 0;
  rateLimitTenantBurst: 0;
  rateLimitTenantRequestsPerSecond: 0;
  reportedOrigin: string;
  reportedServerName: typeof SERVER_PACKAGE_NAME;
  reportedVersion: typeof CONNECT_RELAY_SERVER_VERSION;
  resumableTaskStore: string;
  serverMainPath: string;
  startupLogLines: number;
  storageDirectory: string;
  storageIsolated: true;
  ttlCache: string;
  webSocketSupport: false;
}>;

export type ConnectRelayStopEvidence = Readonly<{
  healthReachable: false;
  origin: string;
  storageRemoved: true;
  stopped: true;
}>;

export type ConnectRelayRuntimeDependencies = {
  allocateBackendPort?: () => Promise<number>;
  beforeServerStart?: () => Promise<void>;
  removeStorage?: (directory: string) => Promise<void>;
};

type RelayBackendTarget = { origin?: string };
type ServerInfo = { server?: unknown; url?: unknown; version?: unknown; webSocketSupport?: unknown };
type ServerPackageJson = { bin?: Record<string, unknown>; name?: unknown; version?: unknown };

class ChildStartupError extends Error {
  public constructor(message: string, public readonly isBindFailure: boolean) {
    super(message);
  }
}

async function assertLoopbackPortClosed(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject): void => {
    const socket = createConnection({ host: LOOPBACK_HOSTNAME, port });
    const timeoutId = setTimeout((): void => {
      socket.destroy();
      reject(new Error(`ConnectRelayRuntime: port ${port} close probe timed out`));
    }, REQUEST_TIMEOUT_MS);
    socket.once('connect', (): void => {
      clearTimeout(timeoutId);
      socket.destroy();
      reject(new Error(`ConnectRelayRuntime: port ${port} remained bound after stop()`));
    });
    socket.once('error', (error): void => {
      clearTimeout(timeoutId);
      socket.destroy();
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        resolvePromise();
      } else {
        reject(error);
      }
    });
  });
}

async function allocateLoopbackPort(): Promise<number> {
  const reservation = Bun.serve({
    fetch    : (): Response => new Response(null, { status: 503 }),
    hostname : LOOPBACK_HOSTNAME,
    port     : 0,
  });
  const port = Number(reservation.port);
  await reservation.stop(true);
  await assertLoopbackPortClosed(port);
  return port;
}

function childEnvironment(
  backendPort: number,
  origin: string,
  packageJsonPath: string,
  dwnSqliteUrl: string,
  serverSqliteUrl: string,
): Record<string, string> {
  return {
    DS_HOST                                   : LOOPBACK_HOSTNAME,
    DS_PORT                                   : String(backendPort),
    DS_WEBSOCKET_SERVER                       : 'off',
    DWN_ADMIN_TOKEN                           : '',
    DWN_BASE_URL                              : origin,
    DWN_DELIVERY_ENABLED                      : 'false',
    DWN_EVENT_BUS_PLUGIN_PATH                 : '',
    DWN_FORWARDING_ENABLED                    : 'false',
    DWN_LOCAL_NODE_ALLOWED_ORIGINS            : '',
    DWN_LOCAL_NODE_PROFILE                    : 'false',
    DWN_PROVIDER_AUTH_ENABLED                 : 'false',
    DWN_RATE_LIMIT_BURST                      : '0',
    DWN_RATE_LIMIT_REQUESTS_PER_SECOND        : '0',
    DWN_RATE_LIMIT_TENANT_BURST               : '0',
    DWN_RATE_LIMIT_TENANT_REQUESTS_PER_SECOND : '0',
    DWN_REGISTRATION_PROOF_OF_WORK_ENABLED    : 'false',
    DWN_REGISTRATION_STORE_URL                : '',
    DWN_SERVER_LOG_LEVEL                      : 'ERROR',
    DWN_SERVER_PACKAGE_JSON                   : packageJsonPath,
    DWN_SERVER_PACKAGE_NAME                   : SERVER_PACKAGE_NAME,
    DWN_STORAGE_DATA                          : dwnSqliteUrl,
    DWN_STORAGE_MESSAGES                      : dwnSqliteUrl,
    DWN_STORAGE_RESUMABLE_TASKS               : dwnSqliteUrl,
    DWN_TTL_CACHE_URL                         : serverSqliteUrl,
    NO_COLOR                                  : '1',
    PATH                                      : process.env.PATH ?? '',
  };
}

function delay(durationMs: number): Promise<void> {
  return new Promise<void>((resolvePromise): void => { setTimeout(resolvePromise, durationMs); });
}

function isBindFailure(output: string): boolean {
  return /EADDRINUSE|address already in use|port \d+ is in use|failed to start server.*port/iu.test(output);
}

function resolveServerPackageJson(): string {
  const serverEntryPath = fileURLToPath(import.meta.resolve(SERVER_PACKAGE_NAME));
  return resolve(dirname(serverEntryPath), '../../../package.json');
}

function startRelayProxy(target: RelayBackendTarget): Server<undefined> {
  return Bun.serve({
    fetch: async (request): Promise<Response> => {
      if (target.origin === undefined) {
        return new Response('relay backend is starting', { status: 503 });
      }
      const incoming = new URL(request.url);
      const upstream = new URL(`${incoming.pathname}${incoming.search}`, target.origin);
      return fetch(new Request(upstream, request), { redirect: 'manual' });
    },
    hostname : LOOPBACK_HOSTNAME,
    port     : 0,
  });
}

async function waitForExit(child: RelayChildProcess, timeoutMs: number): Promise<boolean> {
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

/** Runs one exact released DWN server CLI as an ephemeral loopback connect relay. */
export class ConnectRelayRuntime {
  private readonly _allocateBackendPort: () => Promise<number>;
  private readonly _backendPorts = new Set<number>();
  private readonly _backendTarget: RelayBackendTarget;
  private readonly _beforeServerStart: () => Promise<void>;
  private readonly _directory: string;
  private readonly _dwnSqliteUrl: string;
  private readonly _origin: string;
  private readonly _packageJsonPath: string;
  private readonly _proxy: Server<undefined>;
  private readonly _removeStorage: (directory: string) => Promise<void>;
  private readonly _serverMainPath: string;
  private readonly _serverSqliteUrl: string;
  private _backendPort?: number;
  private _child?: RelayChildProcess;
  private _childOutputTail = '';
  private _childShutdownPromise?: Promise<void>;
  private _disposed = false;
  private _forceDisposePromise?: Promise<ConnectRelayStopEvidence>;
  private _outputDrainPromises: Promise<void>[] = [];
  private _startPromise?: Promise<ConnectRelayRuntimeEvidence>;
  private _started = false;
  private _startupLogLines = 0;
  private _stopPromise?: Promise<ConnectRelayStopEvidence>;
  private _stopRequested = false;

  private constructor(
    packageJsonPath: string,
    serverMainPath: string,
    directory: string,
    dwnSqliteUrl: string,
    serverSqliteUrl: string,
    proxy: Server<undefined>,
    backendTarget: RelayBackendTarget,
    dependencies: ConnectRelayRuntimeDependencies,
  ) {
    this._allocateBackendPort = dependencies.allocateBackendPort ?? allocateLoopbackPort;
    this._backendTarget = backendTarget;
    this._beforeServerStart = dependencies.beforeServerStart ?? (async (): Promise<void> => {});
    this._directory = directory;
    this._dwnSqliteUrl = dwnSqliteUrl;
    this._origin = `http://${LOOPBACK_HOSTNAME}:${proxy.port}`;
    this._packageJsonPath = packageJsonPath;
    this._proxy = proxy;
    this._removeStorage = dependencies.removeStorage ?? (async (path): Promise<void> => rm(path, {
      force     : true,
      recursive : true,
    }));
    this._serverMainPath = serverMainPath;
    this._serverSqliteUrl = serverSqliteUrl;
  }

  /** Allocates the stable proxy origin and validates the exact installed server executable. */
  public static async create(dependencies: ConnectRelayRuntimeDependencies = {}): Promise<ConnectRelayRuntime> {
    const packageJsonPath = resolveServerPackageJson();
    const packageFile = Bun.file(packageJsonPath);
    if (!await packageFile.exists()) {
      throw new Error(`ConnectRelayRuntime: installed package manifest does not exist at ${packageJsonPath}`);
    }
    const packageJson = await packageFile.json() as ServerPackageJson;
    if (packageJson.name !== SERVER_PACKAGE_NAME || packageJson.version !== CONNECT_RELAY_SERVER_VERSION) {
      throw new Error(
        `ConnectRelayRuntime: expected ${SERVER_PACKAGE_NAME}@${CONNECT_RELAY_SERVER_VERSION}, ` +
        `found ${String(packageJson.name)}@${String(packageJson.version)}`,
      );
    }
    if (packageJson.bin?.['dwn-server'] !== EXPECTED_SERVER_BIN) {
      throw new Error(`ConnectRelayRuntime: installed package does not expose the expected ${EXPECTED_SERVER_BIN} executable`);
    }
    const serverMainPath = resolve(dirname(packageJsonPath), EXPECTED_SERVER_BIN);
    if (!await Bun.file(serverMainPath).exists()) {
      throw new Error(`ConnectRelayRuntime: installed server executable does not exist at ${serverMainPath}`);
    }

    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-connect-relay-'));
    let proxy: Server<undefined> | undefined;
    try {
      const dwnSqliteUrl = `sqlite://${join(directory, 'dwn.sqlite')}`;
      const serverSqliteUrl = `sqlite://${join(directory, 'server.sqlite')}`;
      const backendTarget: RelayBackendTarget = {};
      proxy = startRelayProxy(backendTarget);
      return new ConnectRelayRuntime(
        packageJsonPath,
        serverMainPath,
        directory,
        dwnSqliteUrl,
        serverSqliteUrl,
        proxy,
        backendTarget,
        dependencies,
      );
    } catch (error: unknown) {
      const cleanupErrors: string[] = [];
      if (proxy !== undefined) {
        try {
          await proxy.stop(true);
          await assertLoopbackPortClosed(Number(proxy.port));
        } catch (cleanupError: unknown) {
          cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
        }
      }
      try {
        await rm(directory, { force: true, recursive: true });
      } catch (cleanupError: unknown) {
        cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
      }
      if (cleanupErrors.length > 0) {
        throw new Error(
          `ConnectRelayRuntime: construction failed (${error instanceof Error ? error.message : String(error)}); ` +
          `cleanup failed: ${cleanupErrors.join('; ')}`,
        );
      }
      throw error;
    }
  }

  public get origin(): string { return this._origin; }
  public get version(): typeof CONNECT_RELAY_SERVER_VERSION { return CONNECT_RELAY_SERVER_VERSION; }

  /** Starts the released CLI once and returns live package, bind, and feature evidence. */
  public start(): Promise<ConnectRelayRuntimeEvidence> {
    if (this._stopRequested) {
      return Promise.reject(new Error('ConnectRelayRuntime: cannot start after stop()'));
    }
    this._startPromise ??= this.performStart();
    return this._startPromise;
  }

  private async performStart(): Promise<ConnectRelayRuntimeEvidence> {
    await this._beforeServerStart();
    if (this._disposed) {
      throw new Error('ConnectRelayRuntime: disposed before server startup');
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= BACKEND_START_ATTEMPTS; attempt += 1) {
      const backendPort = await this._allocateBackendPort();
      if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65_535) {
        throw new Error(`ConnectRelayRuntime: backend port allocator returned invalid port ${backendPort}`);
      }
      if (this._disposed) {
        throw new Error('ConnectRelayRuntime: disposed before server startup');
      }
      this._backendPort = backendPort;
      this._backendPorts.add(backendPort);
      this._childOutputTail = '';
      const child = Bun.spawn({
        cmd : [process.execPath, this._serverMainPath],
        cwd : this._directory,
        env : childEnvironment(
          backendPort,
          this._origin,
          this._packageJsonPath,
          this._dwnSqliteUrl,
          this._serverSqliteUrl,
        ),
        stderr : 'pipe',
        stdin  : 'ignore',
        stdout : 'pipe',
      });
      this._child = child;
      this._childShutdownPromise = undefined;
      this.captureOutput(child);
      try {
        await this.waitForReadiness(child, backendPort);
        if (this._disposed) {
          await this.terminateChild();
          throw new Error('ConnectRelayRuntime: disposed during server startup');
        }
        this._backendTarget.origin = `http://${LOOPBACK_HOSTNAME}:${backendPort}`;
        this._started = true;
        return this.evidence();
      } catch (error: unknown) {
        lastError = error;
        if (this._disposed) {
          await this.terminateChild().catch((): void => {});
          throw new Error('ConnectRelayRuntime: disposed during server startup');
        }
        if (error instanceof ChildStartupError && error.isBindFailure && attempt < BACKEND_START_ATTEMPTS) {
          this._backendPorts.delete(backendPort);
          continue;
        }
        await this.terminateChild().catch((): void => {});
        throw error;
      }
    }
    throw lastError;
  }

  private captureOutput(child: RelayChildProcess): void {
    this._outputDrainPromises = [child.stdout, child.stderr].map(async (stream): Promise<void> => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let incompleteLine = '';
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) { break; }
          const text = decoder.decode(result.value, { stream: true });
          this._childOutputTail = `${this._childOutputTail}${text}`.slice(-OUTPUT_TAIL_LIMIT);
          const lines = `${incompleteLine}${text}`.split(/\r?\n/u);
          incompleteLine = lines.pop() ?? '';
          this._startupLogLines += lines.length;
        }
        const finalText = decoder.decode();
        this._childOutputTail = `${this._childOutputTail}${finalText}`.slice(-OUTPUT_TAIL_LIMIT);
        incompleteLine += finalText;
        if (incompleteLine.length > 0) { this._startupLogLines += 1; }
      } finally {
        reader.releaseLock();
      }
    });
  }

  private async waitForReadiness(child: RelayChildProcess, backendPort: number): Promise<void> {
    const deadline = performance.now() + READINESS_TIMEOUT_MS;
    const backendOrigin = `http://${LOOPBACK_HOSTNAME}:${backendPort}`;
    while (performance.now() < deadline) {
      if (child.exitCode !== null) {
        const exitCode = await child.exited;
        await Promise.allSettled(this._outputDrainPromises);
        const output = this._childOutputTail.trim();
        throw new ChildStartupError(
          `ConnectRelayRuntime: child exited with code ${exitCode} before readiness${output.length > 0 ? `: ${output}` : ''}`,
          isBindFailure(output),
        );
      }
      if (this._disposed) { throw new Error('ConnectRelayRuntime: disposed during server startup'); }
      try {
        const response = await fetch(`${backendOrigin}/health`, {
          redirect : 'error',
          signal   : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.ok && (await response.json() as { ok?: unknown }).ok === true) { return; }
        await response.body?.cancel().catch((): void => {});
      } catch {
        // The child has not bound the preallocated port yet.
      }
      await delay(READINESS_POLL_MS);
    }
    throw new ChildStartupError(`ConnectRelayRuntime: child readiness timed out after ${READINESS_TIMEOUT_MS}ms`, false);
  }

  /** Checks the stable proxy health route and rejects malformed responses. */
  public async healthCheck(): Promise<ConnectRelayHealth> {
    const response = await fetch(`${this._origin}/health`, {
      redirect : 'error',
      signal   : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch((): void => {});
      throw new Error(`ConnectRelayRuntime: health check returned HTTP ${response.status}`);
    }
    const body = await response.json() as { ok?: unknown };
    if (body.ok !== true) { throw new Error('ConnectRelayRuntime: health check did not return { ok: true }'); }
    return { ok: true };
  }

  /** Captures isolated configuration and exact values reported by the child CLI. */
  public async evidence(): Promise<ConnectRelayRuntimeEvidence> {
    if (!this._started || this._backendPort === undefined) {
      throw new Error('ConnectRelayRuntime: start() must succeed before evidence()');
    }
    const [health, infoResponse] = await Promise.all([
      this.healthCheck(),
      fetch(`${this._origin}/info`, { redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    ]);
    if (!infoResponse.ok) {
      await infoResponse.body?.cancel().catch((): void => {});
      throw new Error(`ConnectRelayRuntime: info check returned HTTP ${infoResponse.status}`);
    }
    const info = await infoResponse.json() as ServerInfo;
    if (info.server !== SERVER_PACKAGE_NAME || info.url !== this._origin ||
      info.version !== CONNECT_RELAY_SERVER_VERSION || info.webSocketSupport !== false) {
      throw new Error(
        'ConnectRelayRuntime: /info did not report the configured server name, origin, exact package version, and disabled WebSocket support',
      );
    }
    const boundHostname = this._proxy.hostname;
    const boundPort = this._proxy.port;
    const backendPort = this._backendPort;
    if (boundHostname !== LOOPBACK_HOSTNAME || typeof boundPort !== 'number' ||
      boundPort !== Number(new URL(this._origin).port) || backendPort < 1 ||
      this._backendTarget.origin !== `http://${LOOPBACK_HOSTNAME}:${backendPort}`) {
      throw new Error('ConnectRelayRuntime: proxy and backend binds do not match the isolated loopback contract');
    }
    if (!this._dwnSqliteUrl.endsWith('/dwn.sqlite') || !this._serverSqliteUrl.endsWith('/server.sqlite') ||
      this._dwnSqliteUrl === this._serverSqliteUrl) {
      throw new Error('ConnectRelayRuntime: runtime storage drifted from the isolated file-backed SQLite contract');
    }
    return {
      backendPort,
      boundHostname,
      boundPort,
      configuredOrigin                 : this._origin,
      dataStore                        : this._dwnSqliteUrl,
      deliveryEnabled                  : false,
      forwardingEnabled                : false,
      health,
      messageStore                     : this._dwnSqliteUrl,
      origin                           : this._origin,
      packageJsonPath                  : this._packageJsonPath,
      rateLimitBurst                   : 0,
      rateLimitRequestsPerSecond       : 0,
      rateLimitTenantBurst             : 0,
      rateLimitTenantRequestsPerSecond : 0,
      reportedOrigin                   : info.url,
      reportedServerName               : info.server,
      reportedVersion                  : info.version,
      resumableTaskStore               : this._dwnSqliteUrl,
      serverMainPath                   : this._serverMainPath,
      startupLogLines                  : this._startupLogLines,
      storageDirectory                 : this._directory,
      storageIsolated                  : true,
      ttlCache                         : this._serverSqliteUrl,
      webSocketSupport                 : false,
    };
  }

  /** Cancels startup without waiting for a stalled pre-start dependency. */
  public forceDispose(): Promise<ConnectRelayStopEvidence> {
    this._disposed = true;
    this._stopRequested = true;
    void this._startPromise?.catch((): undefined => undefined);
    if (this._forceDisposePromise === undefined) {
      const disposing = this.cleanupRuntime('force cleanup');
      const tracked = disposing.catch((error: unknown): never => {
        if (this._forceDisposePromise === tracked) {
          this._forceDisposePromise = undefined;
          this._stopPromise = undefined;
        }
        throw error;
      });
      this._forceDisposePromise = tracked;
      this._stopPromise = tracked;
    }
    return this._forceDisposePromise;
  }

  /** Stops the child, proxy, and storage. Failed cleanup may be retried. */
  public stop(): Promise<ConnectRelayStopEvidence> {
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

  private async performStop(): Promise<ConnectRelayStopEvidence> {
    if (this._startPromise !== undefined) { await this._startPromise.catch((): void => {}); }
    return this.cleanupRuntime('cleanup');
  }

  private async cleanupRuntime(action: string): Promise<ConnectRelayStopEvidence> {
    const errors: string[] = [];
    this._backendTarget.origin = undefined;
    try {
      await this.terminateChild();
      this._started = false;
    } catch (error: unknown) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try { await this._proxy.stop(true); } catch (error: unknown) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try { await assertLoopbackPortClosed(Number(new URL(this._origin).port)); } catch (error: unknown) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    for (const backendPort of this._backendPorts) {
      try { await assertLoopbackPortClosed(backendPort); } catch (error: unknown) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (errors.length === 0) {
      try {
        await this._removeStorage(this._directory);
        if (existsSync(this._directory)) {
          errors.push(`ConnectRelayRuntime: storage directory remained at ${this._directory}`);
        }
      } catch (error: unknown) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (errors.length > 0) { throw new Error(`ConnectRelayRuntime: ${action} failed: ${errors.join('; ')}`); }
    return {
      healthReachable : false,
      origin          : this._origin,
      storageRemoved  : true,
      stopped         : true,
    };
  }

  private terminateChild(): Promise<void> {
    if (this._childShutdownPromise === undefined) {
      const terminating = this.performChildTermination();
      const tracked = terminating.catch((error: unknown): never => {
        if (this._childShutdownPromise === tracked) { this._childShutdownPromise = undefined; }
        throw error;
      });
      this._childShutdownPromise = tracked;
    }
    return this._childShutdownPromise;
  }

  private async performChildTermination(): Promise<void> {
    const child = this._child;
    if (child === undefined) { return; }
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      if (!await waitForExit(child, CHILD_TERM_TIMEOUT_MS)) {
        child.kill('SIGKILL');
        if (!await waitForExit(child, CHILD_KILL_TIMEOUT_MS)) {
          throw new Error(`ConnectRelayRuntime: child process ${child.pid} did not exit after SIGKILL`);
        }
      }
    } else {
      await child.exited;
    }
    await Promise.allSettled(this._outputDrainPromises);
  }
}
