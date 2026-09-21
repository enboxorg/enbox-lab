import type { Subprocess } from 'bun';

import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

import { describe, expect, it } from 'bun:test';

import { DidDht } from '@enbox/dids';

import {
  createPrivateDidResolver,
  createPrivateDidServerConfig,
} from '../../src/proofs/did-server/did-server-child.js';
import {
  DID_SERVER_CHILD_MAX_LINE_BYTES,
  DID_SERVER_PACKAGE_NAME,
  DID_SERVER_PACKAGE_VERSION,
  parseDidServerChildStartCommand,
  parseDidServerChildStopCommand,
} from '../../src/proofs/did-server/did-server-child-protocol.js';

const CHILD_ENTRY_PATH = fileURLToPath(new URL('../../src/proofs/did-server/did-server-child.ts', import.meta.url));
const CHILD_EXIT_TIMEOUT_MS = 5_000;
const RESOLVER_CAPABILITY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const RESOLVER_BASE_URI = `http://127.0.0.1:3210/__lab/resolver/${RESOLVER_CAPABILITY}/`;
const PUBLIC_ORIGIN = 'http://127.0.0.1:4210';

type DidServerChildProcess = Subprocess<'pipe', 'pipe', 'pipe'>;

function spawnChild(): DidServerChildProcess {
  return Bun.spawn({
    cmd    : [process.execPath, CHILD_ENTRY_PATH],
    env    : { NO_COLOR: '1', PATH: process.env.PATH ?? '' },
    stderr : 'pipe',
    stdin  : 'pipe',
    stdout : 'pipe',
  });
}

function startCommand(storageDirectory: string): string {
  return JSON.stringify({
    publicOrigin    : PUBLIC_ORIGIN,
    resolverBaseUri : RESOLVER_BASE_URI,
    storageDirectory,
    type            : 'start',
  }) + '\n';
}

async function waitForExit(child: DidServerChildProcess): Promise<number> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject): void => {
    timeoutId = setTimeout((): void => { reject(new Error('DID server child exit timed out')); }, CHILD_EXIT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([child.exited, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function collectExitedChild(child: DidServerChildProcess): Promise<Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>> {
  const exitCode = await waitForExit(child);
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

function readinessOrigin(stdout: string): string {
  const lines = stdout.trimEnd().split('\n');
  expect(lines).toHaveLength(1);
  const readiness = JSON.parse(lines[0]) as Record<string, unknown>;
  expect(readiness).toEqual({
    origin         : expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
    packageName    : DID_SERVER_PACKAGE_NAME,
    packageVersion : DID_SERVER_PACKAGE_VERSION,
    type           : 'ready',
  });
  return String(readiness.origin);
}

async function readReadiness(child: DidServerChildProcess): Promise<Readonly<{
  origin: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
}>> {
  const reader = child.stdout.getReader();
  const bytes: number[] = [];
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject): void => {
    timeoutId = setTimeout((): void => {
      void reader.cancel();
      reject(new Error('DID server child readiness timed out'));
    }, CHILD_EXIT_TIMEOUT_MS);
  });
  const reading = (async (): Promise<string> => {
    while (true) {
      const result = await reader.read();
      if (result.done) { throw new Error('DID server child ended before readiness'); }
      for (const byte of result.value) {
        if (byte === 0x0a) {
          return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
        }
        bytes.push(byte);
      }
    }
  })();
  try {
    const line = await Promise.race([reading, timeout]);
    return { origin: readinessOrigin(`${line}\n`), reader };
  } catch (error: unknown) {
    reader.releaseLock();
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function expectBackendClosed(origin: string): Promise<void> {
  await expect(fetch(`${origin}/health`, {
    signal: AbortSignal.timeout(1_000),
  })).rejects.toThrow();
}

async function terminateIfRunning(child: DidServerChildProcess): Promise<void> {
  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
  await child.exited;
}

describe('DID server child protocol', () => {
  it('should accept only canonical loopback start commands and the exact stop command', () => {
    expect(parseDidServerChildStartCommand(JSON.stringify({
      publicOrigin     : PUBLIC_ORIGIN,
      resolverBaseUri  : RESOLVER_BASE_URI,
      storageDirectory : '/tmp/enbox-lab-did-server-test',
      type             : 'start',
    }))).toEqual({
      publicOrigin     : PUBLIC_ORIGIN,
      resolverBaseUri  : RESOLVER_BASE_URI,
      storageDirectory : '/tmp/enbox-lab-did-server-test',
      type             : 'start',
    });
    expect(parseDidServerChildStopCommand('{"type":"stop"}')).toEqual({ type: 'stop' });

    expect((): unknown => parseDidServerChildStartCommand(JSON.stringify({
      extra            : true,
      publicOrigin     : PUBLIC_ORIGIN,
      resolverBaseUri  : RESOLVER_BASE_URI,
      storageDirectory : '/tmp/enbox-lab-did-server-test',
      type             : 'start',
    }))).toThrow('invalid start command');
    expect((): unknown => parseDidServerChildStartCommand(JSON.stringify({
      publicOrigin     : PUBLIC_ORIGIN,
      resolverBaseUri  : `http://localhost:3210/__lab/resolver/${RESOLVER_CAPABILITY}/`,
      storageDirectory : '/tmp/enbox-lab-did-server-test',
      type             : 'start',
    }))).toThrow('invalid start command');
    expect((): unknown => parseDidServerChildStartCommand(JSON.stringify({
      publicOrigin     : PUBLIC_ORIGIN,
      resolverBaseUri  : 'http://127.0.0.1:3210/not-the-resolver-ingress/',
      storageDirectory : '/tmp/enbox-lab-did-server-test',
      type             : 'start',
    }))).toThrow('invalid start command');
    expect((): unknown => parseDidServerChildStartCommand(JSON.stringify({
      publicOrigin     : `${PUBLIC_ORIGIN}/path`,
      resolverBaseUri  : RESOLVER_BASE_URI,
      storageDirectory : '/tmp/enbox-lab-did-server-test',
      type             : 'start',
    }))).toThrow('invalid start command');
    expect((): unknown => parseDidServerChildStartCommand(JSON.stringify({
      publicOrigin     : 'http://127.0.0.1:0',
      resolverBaseUri  : RESOLVER_BASE_URI,
      storageDirectory : '/tmp/enbox-lab-did-server-test',
      type             : 'start',
    }))).toThrow('invalid start command');
    expect((): unknown => parseDidServerChildStartCommand(JSON.stringify({
      publicOrigin     : PUBLIC_ORIGIN,
      resolverBaseUri  : `http://127.0.0.1:0/__lab/resolver/${RESOLVER_CAPABILITY}/`,
      storageDirectory : '/tmp/enbox-lab-did-server-test',
      type             : 'start',
    }))).toThrow('invalid start command');
    expect((): unknown => parseDidServerChildStopCommand('{"type":"stop","extra":true}')).toThrow('invalid stop command');
  });

  it('should never reproduce secret input in parser failures', () => {
    const secret = 'never-print-this-capability';
    let message = '';
    try {
      parseDidServerChildStartCommand(JSON.stringify({
        publicOrigin     : PUBLIC_ORIGIN,
        resolverBaseUri  : `https://example.com/${secret}/`,
        storageDirectory : '/tmp/enbox-lab-did-server-test',
        type             : 'start',
      }));
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(secret);
  });
});

describe('DID server child process', () => {
  it('should reject malformed and oversized startup input without disclosing it', async () => {
    const inputs = [
      `{malformed-${RESOLVER_CAPABILITY}}\n`,
      `${'x'.repeat(DID_SERVER_CHILD_MAX_LINE_BYTES + 1)}${RESOLVER_CAPABILITY}\n`,
    ];

    for (const input of inputs) {
      const child = spawnChild();
      try {
        child.stdin.write(input);
        child.stdin.end();
        const result = await collectExitedChild(child);
        expect(result).toEqual({
          exitCode : 1,
          stderr   : 'Enbox Lab DID server child failed\n',
          stdout   : '',
        });
        expect(JSON.stringify(result)).not.toContain(RESOLVER_CAPABILITY);
      } finally {
        await terminateIfRunning(child);
      }
    }
  });

  it('should treat EOF after startup as a clean shutdown and close the backend', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'enbox-lab-child-eof-'));
    const child = spawnChild();
    try {
      child.stdin.write(startCommand(storageDirectory));
      child.stdin.end();
      const result = await collectExitedChild(child);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain(RESOLVER_CAPABILITY);
      await expectBackendClosed(readinessOrigin(result.stdout));
    } finally {
      await terminateIfRunning(child);
      await rm(storageDirectory, { force: true, recursive: true });
    }
  });

  it('should reject malformed and oversized stop input after closing the backend', async () => {
    const stopInputs = [
      '{"type":"unexpected"}\n',
      `${'x'.repeat(DID_SERVER_CHILD_MAX_LINE_BYTES + 1)}\n`,
    ];

    for (const stopInput of stopInputs) {
      const storageDirectory = await mkdtemp(join(tmpdir(), 'enbox-lab-child-stop-'));
      const child = spawnChild();
      try {
        child.stdin.write(`${startCommand(storageDirectory)}${stopInput}`);
        child.stdin.end();
        const result = await collectExitedChild(child);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe('Enbox Lab DID server child failed\n');
        expect(result.stdout).not.toContain(RESOLVER_CAPABILITY);
        await expectBackendClosed(readinessOrigin(result.stdout));
      } finally {
        await terminateIfRunning(child);
        await rm(storageDirectory, { force: true, recursive: true });
      }
    }
  });

  it('should use the released SIGTERM handler to stop and close the backend', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'enbox-lab-child-signal-'));
    const child = spawnChild();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      child.stdin.write(startCommand(storageDirectory));
      await child.stdin.flush();
      const readiness = await readReadiness(child);
      reader = readiness.reader;
      child.kill('SIGTERM');
      expect(await waitForExit(child)).toBe(0);
      expect(await new Response(child.stderr).text()).toBe('');
      await expectBackendClosed(readiness.origin);
    } finally {
      await reader?.cancel().catch((): void => {});
      reader?.releaseLock();
      await terminateIfRunning(child);
      await rm(storageDirectory, { force: true, recursive: true });
    }
  });

  it('should report startup storage failures without readiness or capability disclosure', async () => {
    const storageDirectory = await mkdtemp(join(tmpdir(), 'enbox-lab-child-start-failure-'));
    await mkdir(join(storageDirectory, 'dwn.sqlite'));
    const child = spawnChild();
    try {
      child.stdin.write(startCommand(storageDirectory));
      child.stdin.end();
      const result = await collectExitedChild(child);
      expect(result).toEqual({
        exitCode : 1,
        stderr   : 'Enbox Lab DID server child failed\n',
        stdout   : '',
      });
      expect(JSON.stringify(result)).not.toContain(RESOLVER_CAPABILITY);
    } finally {
      await terminateIfRunning(child);
      await rm(storageDirectory, { force: true, recursive: true });
    }
  });
});

describe('DID server child configuration', () => {
  it('should isolate DWN and server state while disabling unrelated services', () => {
    const config = createPrivateDidServerConfig(
      '/tmp/enbox-lab-did-server-test',
      '/released/package.json',
      PUBLIC_ORIGIN,
    );
    expect(config.baseUrl).toBe(PUBLIC_ORIGIN);
    expect(config.hostname).toBe('127.0.0.1');
    expect(config.port).toBe(0);
    expect(config.messageStore).toBe('sqlite:///tmp/enbox-lab-did-server-test/dwn.sqlite');
    expect(config.dataStore).toBe(config.messageStore);
    expect(config.resumableTaskStore).toBe(config.messageStore);
    expect(config.ttlCacheUrl).toBe('sqlite:///tmp/enbox-lab-did-server-test/server.sqlite');
    expect(config.ttlCacheUrl).not.toBe(config.messageStore);
    expect(config.deliveryEnabled).toBe(false);
    expect(config.forwardingEnabled).toBe(false);
    expect(config.registrationStoreUrl).toBeUndefined();
    expect(config.serverName).toBe(DID_SERVER_PACKAGE_NAME);
    expect(config.webSocketSupport).toBe(false);
    expect(DID_SERVER_PACKAGE_VERSION).toBe('0.1.43');
  });

  it('should expose only dht, jwk, and key resolution methods', async () => {
    const resolver = createPrivateDidResolver(RESOLVER_BASE_URI);
    const result = await resolver.resolve('did:web:example.com');
    expect(result.didResolutionMetadata.error).toBe('methodNotSupported');
  });

  it('should prevent caller options from overriding the private resolver ingress', async () => {
    const did = await DidDht.create({ options: { publish: false } });
    const privateDidDht = createPrivateDidResolver(RESOLVER_BASE_URI);
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      requestedUrl = input instanceof Request ? input.url : String(input);
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    try {
      await privateDidDht.resolve(did.uri, {
        allowPrivateGatewayUri : false,
        gatewayUri             : 'https://example.com/attacker-selected/',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestedUrl.startsWith(RESOLVER_BASE_URI)).toBe(true);
    expect(requestedUrl).not.toContain('example.com');
  });
});
