import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

import { describe, expect, it } from 'bun:test';

import {
  CONNECT_RELAY_SERVER_VERSION,
  ConnectRelayRuntime,
} from '../src/proofs/connect/connect-relay-runtime.js';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((resolvePromise): void => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('ConnectRelayRuntime', () => {
  it('should run the exact released relay on ephemeral loopback SQLite and prove shutdown', async () => {
    const runtime = await ConnectRelayRuntime.create();

    expect(runtime.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(runtime.version).toBe(CONNECT_RELAY_SERVER_VERSION);

    const starting = runtime.start();
    expect(runtime.start()).toBe(starting);
    let backendOrigin = '';
    let storageDirectory = '';

    try {
      const evidence = await starting;
      storageDirectory = evidence.storageDirectory;
      backendOrigin = `http://127.0.0.1:${evidence.backendPort}`;
      expect(evidence).toMatchObject({
        boundHostname                    : '127.0.0.1',
        configuredOrigin                 : runtime.origin,
        deliveryEnabled                  : false,
        forwardingEnabled                : false,
        health                           : { ok: true },
        origin                           : runtime.origin,
        rateLimitBurst                   : 0,
        rateLimitRequestsPerSecond       : 0,
        rateLimitTenantBurst             : 0,
        rateLimitTenantRequestsPerSecond : 0,
        reportedOrigin                   : runtime.origin,
        reportedServerName               : '@enbox/dwn-server',
        reportedVersion                  : '0.1.43',
        storageIsolated                  : true,
        webSocketSupport                 : false,
      });
      expect(evidence.boundPort).toBe(Number(new URL(runtime.origin).port));
      expect(evidence.backendPort).toBeGreaterThan(0);
      expect(evidence.backendPort).not.toBe(evidence.boundPort);
      expect(evidence.dataStore).toBe(evidence.messageStore);
      expect(evidence.dataStore).toBe(evidence.resumableTaskStore);
      expect(evidence.dataStore).not.toBe(evidence.ttlCache);
      expect(evidence.dataStore.endsWith('/dwn.sqlite')).toBe(true);
      expect(evidence.ttlCache.endsWith('/server.sqlite')).toBe(true);
      expect(evidence.dataStore.startsWith('sqlite:///tmp/enbox-lab-connect-relay-')).toBe(true);
      expect(evidence.ttlCache.startsWith('sqlite:///tmp/enbox-lab-connect-relay-')).toBe(true);
      expect(evidence.startupLogLines).toBeGreaterThan(0);
      expect(existsSync(evidence.storageDirectory)).toBe(true);
      expect(existsSync(new URL(evidence.dataStore).pathname)).toBe(true);
      expect(existsSync(new URL(evidence.ttlCache).pathname)).toBe(true);
      expect(await Bun.file(evidence.packageJsonPath).exists()).toBe(true);
      expect(evidence.serverMainPath.endsWith('/dist/esm/src/main.js')).toBe(true);
      expect(await Bun.file(evidence.serverMainPath).exists()).toBe(true);
      expect(await runtime.healthCheck()).toEqual({ ok: true });
      expect(await runtime.evidence()).toEqual(evidence);
    } finally {
      const stopping = runtime.stop();
      expect(runtime.stop()).toBe(stopping);
      const stopped = await stopping;
      expect(stopped).toEqual({
        healthReachable : false,
        origin          : runtime.origin,
        storageRemoved  : true,
        stopped         : true,
      });
      expect(existsSync(storageDirectory)).toBe(false);
      expect(await runtime.stop()).toEqual(stopped);
    }

    await expect(fetch(`${runtime.origin}/health`, {
      signal: AbortSignal.timeout(1_000),
    })).rejects.toThrow();
    await expect(fetch(`${backendOrigin}/health`, {
      signal: AbortSignal.timeout(1_000),
    })).rejects.toThrow();
    await expect(runtime.start()).rejects.toThrow('cannot start after stop()');
  });

  it('should not expose a stopped runtime request through a later runtime', async () => {
    const first = await ConnectRelayRuntime.create();
    const second = await ConnectRelayRuntime.create();
    let firstStorage = '';
    let requestPath = '';
    try {
      const firstEvidence = await first.start();
      firstStorage = firstEvidence.storageDirectory;
      const pushed = await fetch(`${first.origin}/connect/par`, {
        body    : JSON.stringify({ request: 'first-runtime-ciphertext' }),
        headers : { 'Content-Type': 'application/json' },
        method  : 'POST',
      });
      expect(pushed.status).toBe(201);
      const body = await pushed.json() as { request_uri: string };
      requestPath = new URL(body.request_uri).pathname;
      await first.stop();

      const secondEvidence = await second.start();
      expect(secondEvidence.storageDirectory).not.toBe(firstStorage);
      expect(secondEvidence.dataStore).not.toBe(firstEvidence.dataStore);
      expect(secondEvidence.ttlCache).not.toBe(firstEvidence.ttlCache);
      const leaked = await fetch(`${second.origin}${requestPath}`);
      expect(leaked.status).toBe(404);
      await leaked.body?.cancel();
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  it('should clean a created runtime that never starts', async () => {
    const runtime = await ConnectRelayRuntime.create();
    const stopped = await runtime.stop();

    expect(stopped).toMatchObject({ healthReachable: false, storageRemoved: true, stopped: true });
    await expect(fetch(`${runtime.origin}/health`, {
      signal: AbortSignal.timeout(1_000),
    })).rejects.toThrow();
    await expect(runtime.start()).rejects.toThrow('cannot start after stop()');
  });

  it('should force-dispose a stalled startup and reject its late continuation', async () => {
    const entered = deferred();
    const release = deferred();
    const runtime = await ConnectRelayRuntime.create({
      beforeServerStart: async (): Promise<void> => {
        entered.resolve();
        await release.promise;
      },
    });
    const starting = runtime.start();
    await entered.promise;

    const disposed = await runtime.forceDispose();
    release.resolve();

    expect(disposed).toMatchObject({ healthReachable: false, storageRemoved: true, stopped: true });
    await expect(starting).rejects.toThrow('disposed before server startup');
    expect(await runtime.stop()).toEqual(disposed);
  });

  it('should retry a child bind collision without changing its stable proxy origin', async () => {
    const blocker = Bun.serve({
      fetch    : (): Response => new Response('occupied'),
      hostname : '127.0.0.1',
      port     : 0,
    });
    let allocations = 0;
    const runtime = await ConnectRelayRuntime.create({
      allocateBackendPort: async (): Promise<number> => {
        allocations += 1;
        if (allocations === 1) {
          return Number(blocker.port);
        }
        const reservation = Bun.serve({
          fetch    : (): Response => new Response(null, { status: 503 }),
          hostname : '127.0.0.1',
          port     : 0,
        });
        const port = Number(reservation.port);
        await reservation.stop(true);
        return port;
      },
    });
    const origin = runtime.origin;
    try {
      const evidence = await runtime.start();
      expect(allocations).toBe(2);
      expect(evidence.origin).toBe(origin);
      expect(evidence.backendPort).not.toBe(Number(blocker.port));
    } finally {
      try {
        await runtime.stop();
      } finally {
        await blocker.stop(true);
      }
    }
  });

  it('should allow a failed storage cleanup to be retried without restarting', async () => {
    let removeAttempts = 0;
    const runtime = await ConnectRelayRuntime.create({
      removeStorage: async (directory): Promise<void> => {
        removeAttempts += 1;
        if (removeAttempts === 1) {
          throw new Error('injected storage cleanup failure');
        }
        await rm(directory, { force: true, recursive: true });
      },
    });
    const evidence = await runtime.start();

    await expect(runtime.stop()).rejects.toThrow('injected storage cleanup failure');
    expect(existsSync(evidence.storageDirectory)).toBe(true);
    await expect(runtime.start()).rejects.toThrow('cannot start after stop()');
    expect(await runtime.stop()).toMatchObject({ storageRemoved: true, stopped: true });
    expect(removeAttempts).toBe(2);
    expect(existsSync(evidence.storageDirectory)).toBe(false);
  });

  it('should start concurrently without mutating the parent global logger', async () => {
    const originalLog = console.log;
    const first = await ConnectRelayRuntime.create();
    const second = await ConnectRelayRuntime.create();
    try {
      const [firstEvidence, secondEvidence] = await Promise.all([first.start(), second.start()]);
      expect(firstEvidence.origin).not.toBe(secondEvidence.origin);
      expect(firstEvidence.startupLogLines).toBeGreaterThan(0);
      expect(secondEvidence.startupLogLines).toBeGreaterThan(0);
      expect(console.log).toBe(originalLog);
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
  });
});
