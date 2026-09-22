import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';

import { describe, expect, it } from 'bun:test';

import {
  DidServerRuntime,
  parseDidServerChildReadiness,
  resolveDidServerChildEntry,
} from '../../src/proofs/did-server/did-server-runtime.js';

const CAPABILITY = 'a9'.repeat(32);
const RESOLVER_ENDPOINT = `http://127.0.0.1:9/__lab/resolver/${CAPABILITY}/`;

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((resolvePromise): void => { resolve = resolvePromise; });
  return { promise, resolve };
}

function restoreEnvironment(name: string, previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previousValue;
  }
}

describe('DidServerRuntime readiness protocol', () => {
  it('should accept one exact released-server record at a canonical numeric-loopback origin', () => {
    expect(parseDidServerChildReadiness(JSON.stringify({
      origin         : 'http://127.0.0.1:3210',
      packageName    : '@enbox/dwn-server',
      packageVersion : '0.1.43',
      type           : 'ready',
    }))).toEqual({
      origin         : 'http://127.0.0.1:3210',
      packageName    : '@enbox/dwn-server',
      packageVersion : '0.1.43',
      type           : 'ready',
    });

    for (const invalid of [
      '{"type":"ready"}',
      JSON.stringify({
        extra          : true,
        origin         : 'http://127.0.0.1:3210',
        packageName    : '@enbox/dwn-server',
        packageVersion : '0.1.43',
        type           : 'ready',
      }),
      JSON.stringify({
        origin         : 'http://localhost:3210',
        packageName    : '@enbox/dwn-server',
        packageVersion : '0.1.43',
        type           : 'ready',
      }),
      JSON.stringify({
        origin         : 'http://127.0.0.1:3210/path',
        packageName    : '@enbox/dwn-server',
        packageVersion : '0.1.43',
        type           : 'ready',
      }),
      JSON.stringify({
        origin         : 'http://127.0.0.1:3210',
        packageName    : '@enbox/dwn-server',
        packageVersion : '0.1.42',
        type           : 'ready',
      }),
      `${'x'.repeat(512)}x`,
    ]) {
      expect((): unknown => parseDidServerChildReadiness(invalid)).toThrow();
    }
  });

  it('should resolve the source child beside the source runtime', async () => {
    const child = await resolveDidServerChildEntry();
    expect(child.kind).toBe('source-ts');
    expect(child.path.endsWith('/src/proofs/did-server/did-server-child.ts')).toBe(true);
    expect(await Bun.file(child.path).exists()).toBe(true);
  });
});

describe('DidServerRuntime lifecycle', () => {
  it('should retry a thrown startup network error before accepting the exact health contract', async () => {
    let attempts = 0;
    const runtime = await DidServerRuntime.create(RESOLVER_ENDPOINT, {
      startupFetch: async (input, init): Promise<Response> => {
        attempts += 1;
        if (attempts === 1) { throw new TypeError('injected listener-readiness race'); }
        return fetch(input, init);
      },
    });
    try {
      const evidence = await runtime.start();
      expect(evidence.health).toEqual({ ok: true });
      expect(attempts).toBe(4);
    } finally {
      await runtime.stop();
    }
  });

  it('should reject a non-success startup response without retrying it', async () => {
    let attempts = 0;
    const runtime = await DidServerRuntime.create(RESOLVER_ENDPOINT, {
      startupFetch: async (): Promise<Response> => {
        attempts += 1;
        return new Response('not ready', { status: 503 });
      },
    });
    try {
      await expect(runtime.start()).rejects.toThrow('backend health check returned HTTP 503');
      expect(attempts).toBe(1);
    } finally {
      await runtime.stop();
    }
  });

  it('should bound persistent startup network failures with a runtime diagnostic', async () => {
    let attempts = 0;
    const runtime = await DidServerRuntime.create(RESOLVER_ENDPOINT, {
      startupFetch: async (): Promise<Response> => {
        attempts += 1;
        throw new TypeError('injected persistent network failure');
      },
    });
    try {
      await expect(runtime.start()).rejects.toThrow(
        /^DidServerRuntime: startup verification failed after \d+ network attempts$/u,
      );
      expect(attempts).toBeGreaterThan(1);
    } finally {
      await runtime.stop();
    }
  });

  it('should report a child exit observed during a retried startup request', async () => {
    let killed = false;
    const runtimeReference: { current?: DidServerRuntime } = {};
    const runtime = await DidServerRuntime.create(RESOLVER_ENDPOINT, {
      startupFetch: async (): Promise<Response> => {
        if (!killed) {
          killed = true;
          const pid = runtimeReference.current?.pid;
          if (pid === undefined) { throw new Error('injected startup fetch ran before child spawn'); }
          process.kill(pid, 'SIGKILL');
        }
        throw new TypeError('injected request failure after child exit');
      },
    });
    runtimeReference.current = runtime;
    try {
      await expect(runtime.start()).rejects.toThrow(
        /^DidServerRuntime: child exited with code \d+ during startup verification/u,
      );
    } finally {
      await runtime.stop();
    }
  });

  it('should run the exact released server through a stable proxy and remove both live endpoints', async () => {
    const inheritedMessageStore = process.env.DWN_STORAGE_MESSAGES;
    const inheritedRegistrationStore = process.env.DWN_REGISTRATION_STORE_URL;
    const runtime = await DidServerRuntime.create(RESOLVER_ENDPOINT);
    process.env.DWN_STORAGE_MESSAGES = `sqlite://${RESOLVER_ENDPOINT}must-not-be-inherited`;
    process.env.DWN_REGISTRATION_STORE_URL = RESOLVER_ENDPOINT;

    const publicOrigin = runtime.origin;
    let backendOrigin = '';
    let storageDirectory = '';
    try {
      expect(publicOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(runtime.pid).toBeUndefined();
      expect(JSON.stringify(runtime)).not.toContain(CAPABILITY);
      const unavailable = await fetch(`${publicOrigin}/health`);
      expect(unavailable.status).toBe(503);
      await unavailable.body?.cancel();

      const starting = runtime.start();
      expect(runtime.start()).toBe(starting);
      const evidence = await starting;
      backendOrigin = evidence.backendOrigin;
      storageDirectory = evidence.storageDirectory;
      expect(runtime.pid).toBe(evidence.childPid);
      expect(evidence).toMatchObject({
        backendHostname                         : '127.0.0.1',
        boundHostname                           : '127.0.0.1',
        childArgumentsContainResolverBaseUri    : false,
        childEntryKind                          : 'source-ts',
        childEnvironmentContainsResolverBaseUri : false,
        childEnvironmentKeys                    : ['NO_COLOR', 'PATH'],
        health                                  : { ok: true },
        origin                                  : publicOrigin,
        packageName                             : '@enbox/dwn-server',
        packageVersion                          : '0.1.43',
        readinessRecords                        : 1,
        reportedOrigin                          : publicOrigin,
        reportedSdkVersion                      : '0.4.27',
        reportedServerName                      : '@enbox/dwn-server',
        reportedVersion                         : '0.1.43',
        resolverEndpointTransport               : 'stdin-ndjson',
        storageIsolated                         : true,
        webSocketSupport                        : false,
      });
      expect(evidence.backendOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(evidence.backendPort).not.toBe(evidence.boundPort);
      expect(JSON.stringify(evidence)).not.toContain(CAPABILITY);
      expect(JSON.stringify(runtime)).not.toContain(CAPABILITY);
      expect(existsSync(evidence.storageDirectory)).toBe(true);
      expect(existsSync(`${evidence.storageDirectory}/dwn.sqlite`)).toBe(true);
      expect(existsSync(`${evidence.storageDirectory}/server.sqlite`)).toBe(true);

      const health = await fetch(`${publicOrigin}/health`);
      expect(await health.json()).toEqual({ ok: true });
      const info = await fetch(`${publicOrigin}/info`);
      expect(await info.json()).toMatchObject({
        server           : '@enbox/dwn-server',
        sdkVersion       : '0.4.27',
        url              : publicOrigin,
        version          : '0.1.43',
        webSocketSupport : false,
      });
      const wrongAuthority = await fetch(`${publicOrigin}/health`, {
        headers: { Host: `localhost:${evidence.boundPort}` },
      });
      expect(wrongAuthority.status).toBe(421);
      await wrongAuthority.body?.cancel();

      let escapedRequests = 0;
      const escapeTarget = Bun.serve({
        fetch: (): Response => {
          escapedRequests += 1;
          return new Response(null, { status: 204 });
        },
        hostname : '127.0.0.1',
        port     : 0,
      });
      try {
        const attemptedEscape = await fetch(
          `${publicOrigin}//127.0.0.1:${escapeTarget.port}/capture?source=proxy`,
          { headers: { Host: new URL(publicOrigin).host } },
        );
        await attemptedEscape.body?.cancel();
        expect(escapedRequests).toBe(0);
      } finally {
        await escapeTarget.stop(true);
      }

      if (process.platform === 'linux') {
        const [argumentsText, environmentText] = await Promise.all([
          readFile(`/proc/${evidence.childPid}/cmdline`, 'utf8'),
          readFile(`/proc/${evidence.childPid}/environ`, 'utf8'),
        ]);
        expect(argumentsText).not.toContain(CAPABILITY);
        expect(environmentText).not.toContain(CAPABILITY);
        expect(environmentText).not.toContain('DWN_STORAGE_MESSAGES');
        expect(environmentText).not.toContain('DWN_REGISTRATION_STORE_URL');
      }

      const stopping = runtime.stop();
      expect(runtime.stop()).toBe(stopping);
      expect(await stopping).toEqual({
        backendOrigin,
        origin         : publicOrigin,
        portClosed     : true,
        storageRemoved : true,
        stopped        : true,
      });
      expect(existsSync(storageDirectory)).toBe(false);
      await expect(fetch(`${publicOrigin}/health`, {
        signal: AbortSignal.timeout(1_000),
      })).rejects.toThrow();
      await expect(fetch(`${backendOrigin}/health`, {
        signal: AbortSignal.timeout(1_000),
      })).rejects.toThrow();
      await expect(runtime.start()).rejects.toThrow('cannot start after stop()');
    } finally {
      await runtime.stop().catch((): void => {});
      restoreEnvironment('DWN_STORAGE_MESSAGES', inheritedMessageStore);
      restoreEnvironment('DWN_REGISTRATION_STORE_URL', inheritedRegistrationStore);
    }
  });

  it('should stop and remove a runtime that never starts', async () => {
    const runtime = await DidServerRuntime.create(RESOLVER_ENDPOINT);
    const origin = runtime.origin;
    try {
      expect(await runtime.stop()).toEqual({
        backendOrigin  : undefined,
        origin,
        portClosed     : true,
        storageRemoved : true,
        stopped        : true,
      });
      await expect(fetch(`${origin}/health`, {
        signal: AbortSignal.timeout(1_000),
      })).rejects.toThrow();
      await expect(runtime.start()).rejects.toThrow('cannot start after stop()');
    } finally {
      await runtime.stop();
    }
  });

  it('should force-dispose a stalled pre-start hook without waiting for it', async () => {
    const entered = deferred();
    const release = deferred();
    let removeAttempts = 0;
    const runtime = await DidServerRuntime.create(RESOLVER_ENDPOINT, {
      beforeChildStart: async (): Promise<void> => {
        entered.resolve();
        await release.promise;
      },
      removeStorage: async (directory): Promise<void> => {
        removeAttempts += 1;
        await rm(directory, { force: true, recursive: true });
      },
    });
    const starting = runtime.start();
    await entered.promise;
    const stopping = runtime.stop();
    const stopped = await runtime.forceDispose();

    try {
      expect(stopped).toMatchObject({ portClosed: true, storageRemoved: true, stopped: true });
      expect(await Promise.race([
        stopping.then((): boolean => true),
        Bun.sleep(250).then((): boolean => false),
      ])).toBe(true);
      expect(removeAttempts).toBe(1);
    } finally {
      release.resolve();
    }
    await expect(starting).rejects.toThrow('disposed before child startup');
    expect(await runtime.stop()).toEqual(stopped);
  });

  it('should allow failed storage cleanup to be retried without restarting', async () => {
    let removeAttempts = 0;
    const runtime = await DidServerRuntime.create(RESOLVER_ENDPOINT, {
      removeStorage: async (directory): Promise<void> => {
        removeAttempts += 1;
        if (removeAttempts === 1) {
          throw new Error('injected DID server storage cleanup failure');
        }
        await rm(directory, { force: true, recursive: true });
      },
    });
    const origin = runtime.origin;
    await expect(runtime.stop()).rejects.toThrow('injected DID server storage cleanup failure');
    await expect(runtime.start()).rejects.toThrow('cannot start after stop()');
    expect(await runtime.stop()).toMatchObject({
      origin,
      portClosed     : true,
      storageRemoved : true,
      stopped        : true,
    });
    expect(removeAttempts).toBe(2);
  });

  it('should report an unexpected child exit while still removing safely closed storage', async () => {
    const runtime = await DidServerRuntime.create(RESOLVER_ENDPOINT);
    const evidence = await runtime.start();
    try {
      process.kill(evidence.childPid, 'SIGKILL');
      await Bun.sleep(25);
      await expect(runtime.stop()).rejects.toThrow(/child exited with code/u);
      expect(existsSync(evidence.storageDirectory)).toBe(false);
      expect(await runtime.stop()).toMatchObject({
        backendOrigin  : evidence.backendOrigin,
        origin         : evidence.origin,
        portClosed     : true,
        storageRemoved : true,
        stopped        : true,
      });
    } finally {
      await runtime.stop();
    }
  });

  it('should redact a rejected resolver endpoint from runtime serialization and startup errors', async () => {
    const secret = 'never-expose-this-resolver-capability';
    const endpoint = `https://example.com/__lab/resolver/${secret}/`;
    const runtime = await DidServerRuntime.create(endpoint);
    expect(JSON.stringify(runtime)).not.toContain(secret);

    let failure = '';
    try {
      await runtime.start();
    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure.length).toBeGreaterThan(0);
    expect(failure).not.toContain(secret);
    expect(JSON.stringify(runtime)).not.toContain(secret);
    await runtime.stop();
  });
});
