import { join } from 'node:path';
import { PkarrPublicationJournal } from '../src/pkarr-publication-journal.js';
import { startPkarrPublicationServer } from '../src/pkarr-publication-server.js';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';

function packet(sequence: bigint): Uint8Array {
  const value = new Uint8Array(80);
  new DataView(value.buffer).setBigUint64(64, sequence);
  return value;
}

describe('Pkarr publication server', () => {
  it('should expose readiness only after an empty journal is restored', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-pkarr-server-'));
    const server = await startPkarrPublicationServer({
      fetch           : async (): Promise<Response> => new Response(undefined, { status: 204 }),
      journalLocation : join(directory, 'journal.sqlite'),
      upstreamBaseUrl : 'http://pkarr:15411/',
    });

    try {
      const response = await fetch(new URL('__lab/health', server.endpoint));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ acceptedPublications: 0, error: null, status: 'ready' });
      expect(server.restoreResults).toEqual([]);
      const post = await fetch(new URL('__lab/health', server.endpoint), { method: 'POST' });
      expect(post.status).toBe(405);
      expect(post.headers.get('allow')).toBe('GET');
    } finally {
      await server.stop();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('should allow only configured browser origins and Pkarr preflights', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-pkarr-server-'));
    let publications = 0;
    const server = await startPkarrPublicationServer({
      allowedOrigins : ['http://localhost:18443'],
      fetch          : async (_input, init): Promise<Response> => {
        if (init?.method === 'PUT') {
          publications += 1;
          return new Response(undefined, { status: 204 });
        }
        return new Response(undefined, { status: 404 });
      },
      journalLocation : join(directory, 'journal.sqlite'),
      upstreamBaseUrl : 'http://pkarr:15411/',
    });

    try {
      const preflight = await fetch(new URL('key-one', server.endpoint), {
        headers: {
          'Access-Control-Request-Headers'         : 'content-type',
          'Access-Control-Request-Method'          : 'PUT',
          'Access-Control-Request-Private-Network' : 'true',
          'Origin'                                 : 'http://localhost:18443',
        },
        method: 'OPTIONS',
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:18443');
      expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, PUT');
      expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');

      const invalidPreflight = await fetch(new URL('key-three', server.endpoint), {
        headers: {
          'Access-Control-Request-Headers' : 'authorization',
          'Access-Control-Request-Method'  : 'PUT',
          'Origin'                         : 'http://localhost:18443',
        },
        method: 'OPTIONS',
      });
      expect(invalidPreflight.status).toBe(403);
      const invalidPath = await fetch(new URL('nested/key', server.endpoint), {
        headers: {
          'Access-Control-Request-Headers' : 'content-type',
          'Access-Control-Request-Method'  : 'PUT',
          'Origin'                         : 'http://localhost:18443',
        },
        method: 'OPTIONS',
      });
      expect(invalidPath.status).toBe(403);

      const publication = await fetch(new URL('key-one', server.endpoint), {
        body    : new Blob([packet(1n) as BlobPart]),
        headers : { 'Content-Type': 'application/octet-stream', Origin: 'http://localhost:18443' },
        method  : 'PUT',
      });
      expect(publication.status).toBe(204);
      expect(publication.headers.get('access-control-allow-origin')).toBe('http://localhost:18443');
      expect(publications).toBe(1);

      const rejectionsBefore = server.browserRejectionCount();
      const foreign = await fetch(new URL('key-two', server.endpoint), {
        body    : new Blob([packet(1n) as BlobPart]),
        headers : { 'Content-Type': 'application/octet-stream', Origin: 'https://attacker.example' },
        method  : 'PUT',
      });
      expect(foreign.status).toBe(403);
      const originless = await fetch(new URL('key-two', server.endpoint));
      expect(originless.status).toBe(403);
      expect(server.browserRejectionCount()).toBe(rejectionsBefore + 2);
      expect(publications).toBe(1);
    } finally {
      await server.stop();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('should reject unsafe configured browser origins before opening the journal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-pkarr-server-'));
    try {
      await expect(startPkarrPublicationServer({
        allowedOrigins  : ['https://user:password@example.com/path'],
        fetch           : async (): Promise<Response> => new Response(undefined, { status: 204 }),
        journalLocation : join(directory, 'journal.sqlite'),
        upstreamBaseUrl : 'http://pkarr:15411/',
      })).rejects.toThrow('Expected an HTTP(S) origin');
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('should release startup resources when the primary listener cannot bind', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-pkarr-server-'));
    const journalLocation = join(directory, 'journal.sqlite');
    const blocker = Bun.serve({
      fetch    : (): Response => new Response(),
      hostname : '127.0.0.1',
      port     : 0,
    });
    try {
      await expect(startPkarrPublicationServer({
        fetch           : async (): Promise<Response> => new Response(undefined, { status: 204 }),
        journalLocation,
        port            : blocker.port,
        resolverIngress : true,
        upstreamBaseUrl : 'http://pkarr:15411/',
      })).rejects.toThrow();
    } finally {
      await blocker.stop(true);
    }

    const recovered = await startPkarrPublicationServer({
      fetch           : async (): Promise<Response> => new Response(undefined, { status: 204 }),
      journalLocation,
      upstreamBaseUrl : 'http://pkarr:15411/',
    });
    await recovered.stop();
    await rm(directory, { force: true, recursive: true });
  });

  it('should expose a capability-guarded originless resolver without weakening the browser listener', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-pkarr-server-'));
    let identifierGets = 0;
    const server = await startPkarrPublicationServer({
      allowedOrigins : ['http://localhost:18443'],
      fetch          : async (input): Promise<Response> => {
        const url = new URL(String(input));
        if (url.pathname !== '/') {
          identifierGets += 1;
          return new Response('signed-packet', { status: 200 });
        }
        return new Response(undefined, { status: 404 });
      },
      journalLocation : join(directory, 'journal.sqlite'),
      resolverIngress : true,
      upstreamBaseUrl : 'http://pkarr:15411/',
    });

    try {
      const endpoint = server.resolverEndpoint();
      expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__lab\/resolver\/[0-9a-f]{64}\/$/u);
      if (endpoint === undefined) {
        throw new Error('Expected the resolver ingress endpoint.');
      }
      const resolverUrl = new URL(endpoint);
      const identifier = 'y'.repeat(52);
      const validUrl = new URL(identifier, resolverUrl).toString();
      const wrongCapability = validUrl.replace(
        /\/resolver\/([0-9a-f])([0-9a-f]{63})\//u,
        (_match, first: string, remainder: string): string => `/resolver/${first === '0' ? '1' : '0'}${remainder}/`,
      );
      const rejected: Array<{ headers?: HeadersInit; method?: string; url: string }> = [
        { url: wrongCapability },
        { url: `${validUrl}?query=1` },
        { url: new URL('short', resolverUrl).toString() },
        { url: new URL(`${'y'.repeat(51)}b`, resolverUrl).toString() },
        { url: new URL('%2e%2e', resolverUrl).toString() },
        { headers: { Origin: 'http://localhost:18443' }, url: validUrl },
        { headers: { Origin: 'https://attacker.invalid' }, url: validUrl },
        { headers: { Referer: 'http://localhost:18443/' }, url: validUrl },
        { headers: { 'Sec-Fetch-Dest': 'image' }, url: validUrl },
        { headers: { 'Sec-Fetch-Site': 'cross-site' }, url: validUrl },
        { headers: { Host: 'evil.test' }, url: validUrl },
        { method: 'OPTIONS', url: validUrl },
        { method: 'PUT', url: validUrl },
      ];
      for (const request of rejected) {
        const response = await fetch(request.url, { headers: request.headers, method: request.method });
        expect(response.status).toBe(404);
        expect(await response.text()).toBe('not found');
      }
      expect(identifierGets).toBe(0);

      const browserOriginless = await fetch(new URL(identifier, server.endpoint));
      expect(browserOriginless.status).toBe(403);
      const response = await fetch(validUrl);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('signed-packet');
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-security-policy')).toBe('default-src \'none\'; frame-ancestors \'none\'');
      expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(identifierGets).toBe(1);
      expect(server.resolverObservation()).toEqual({ admitted: 1, rejected: rejected.length });
      expect(JSON.stringify(server)).not.toContain(resolverUrl.pathname.split('/')[3]);

      await server.stop();
      await expect(fetch(validUrl, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
      expect(server.resolverObservation()).toEqual({ admitted: 1, rejected: rejected.length });
    } finally {
      await server.stop();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('should restore a nonempty journal before exposing readiness', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-pkarr-server-'));
    const journalLocation = join(directory, 'journal.sqlite');
    const journal = new PkarrPublicationJournal(journalLocation);
    journal.set({
      acceptedAt : '2026-09-20T12:00:00.000Z',
      identifier : 'key-one',
      packet     : packet(7n),
      sequence   : 7n,
    });
    journal.close();
    const methods: string[] = [];
    const server = await startPkarrPublicationServer({
      fetch: async (_input, init): Promise<Response> => {
        methods.push(init?.method ?? 'GET');
        return new Response(undefined, { status: init?.method === 'PUT' ? 204 : 404 });
      },
      journalLocation,
      upstreamBaseUrl: 'http://pkarr:15411/',
    });

    try {
      const response = await fetch(new URL('__lab/health', server.endpoint));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ acceptedPublications: 1, status: 'ready' });
      expect(server.restoreResults).toEqual([{ identifier: 'key-one', sequence: '7', status: 'restored' }]);
      expect(methods).toEqual(['GET', 'PUT']);
    } finally {
      await server.stop();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('should refuse startup when the upstream probe returns a server error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-pkarr-server-'));
    try {
      await expect(startPkarrPublicationServer({
        fetch           : async (): Promise<Response> => new Response('unavailable', { status: 503 }),
        journalLocation : join(directory, 'journal.sqlite'),
        upstreamBaseUrl : 'http://pkarr:15411/',
      })).rejects.toThrow('Pkarr upstream probe returned 503');

      const reopened = new PkarrPublicationJournal(join(directory, 'journal.sqlite'));
      reopened.close();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('should refuse startup when a retained publication cannot be restored', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-pkarr-server-'));
    const journalLocation = join(directory, 'journal.sqlite');
    const journal = new PkarrPublicationJournal(journalLocation);
    journal.set({
      acceptedAt : '2026-09-20T12:00:00.000Z',
      identifier : 'key-one',
      packet     : packet(7n),
      sequence   : 7n,
    });
    journal.close();
    const methods: string[] = [];

    try {
      await expect(startPkarrPublicationServer({
        fetch: async (_input, init): Promise<Response> => {
          methods.push(init?.method ?? 'GET');
          return new Response(undefined, { status: init?.method === 'PUT' ? 503 : 404 });
        },
        journalLocation,
        upstreamBaseUrl: 'http://pkarr:15411/',
      })).rejects.toThrow('Pkarr restoration failed for \'key-one\': upstream returned 503');
      expect(methods).toEqual(['GET', 'PUT']);

      const reopened = new PkarrPublicationJournal(journalLocation);
      expect(reopened.get('key-one')?.sequence).toBe(7n);
      reopened.close();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('should abort and drain an in-flight publication before closing the journal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-pkarr-server-'));
    const journalLocation = join(directory, 'journal.sqlite');
    let markPutStarted = (): void => {};
    const putStarted = new Promise<void>((resolve): void => { markPutStarted = resolve; });
    const server = await startPkarrPublicationServer({
      fetch: async (_input, init): Promise<Response> => {
        if (init?.method !== 'PUT') {
          return new Response(undefined, { status: 404 });
        }
        markPutStarted();
        return await new Promise<Response>((_resolve, reject): void => {
          init.signal?.addEventListener('abort', (): void => { reject(init.signal?.reason); }, { once: true });
        });
      },
      journalLocation,
      requestTimeoutMs  : 1_000,
      shutdownTimeoutMs : 2_000,
      upstreamBaseUrl   : 'http://pkarr:15411/',
    });
    const packet = new Uint8Array(80);
    new DataView(packet.buffer).setBigUint64(64, 1n);
    const publication = fetch(new URL('key-one', server.endpoint), {
      body   : new Blob([packet as BlobPart]),
      method : 'PUT',
    }).catch((error: unknown): unknown => error);

    await putStarted;
    await server.stop();
    await publication;

    const reopened = new PkarrPublicationJournal(journalLocation);
    try {
      expect(reopened.list()).toEqual([]);
    } finally {
      reopened.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('should reject a timed-out shutdown instead of waiting forever for a noncooperative upstream', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-pkarr-server-'));
    let markPutStarted = (): void => {};
    const putStarted = new Promise<void>((resolve): void => { markPutStarted = resolve; });
    let releasePut = (_response: Response): void => {};
    const putResponse = new Promise<Response>((resolve): void => { releasePut = resolve; });
    const server = await startPkarrPublicationServer({
      fetch: async (_input, init): Promise<Response> => {
        if (init?.method !== 'PUT') {
          return new Response(undefined, { status: 404 });
        }
        markPutStarted();
        return await putResponse;
      },
      journalLocation   : join(directory, 'journal.sqlite'),
      requestTimeoutMs  : 1_000,
      shutdownTimeoutMs : 5,
      upstreamBaseUrl   : 'http://pkarr:15411/',
    });
    const publication = fetch(new URL('key-one', server.endpoint), {
      body   : new Blob([packet(1n) as BlobPart]),
      method : 'PUT',
    }).catch((error: unknown): unknown => error);

    try {
      await putStarted;
      const stopping = server.stop();
      expect(server.stop()).toBe(stopping);
      await expect(stopping).rejects.toThrow('did not drain within 5 milliseconds');
      await expect(server.stop()).rejects.toThrow('did not drain within 5 milliseconds');
    } finally {
      releasePut(new Response(undefined, { status: 204 }));
      await publication;
      await Bun.sleep(10);
      await rm(directory, { force: true, recursive: true });
    }
  });
});
