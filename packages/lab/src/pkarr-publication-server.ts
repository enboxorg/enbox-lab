import type { Server } from 'bun';

import type { PkarrFetch, PkarrRestoreResult } from './pkarr-publication-adapter.js';

import { PkarrPublicationJournal } from './pkarr-publication-journal.js';
import { PKARR_PACKET_MAX_BYTES, PkarrPublicationAdapter } from './pkarr-publication-adapter.js';

/** BEP44 recommends re-announcing mutable items once per hour. */
export const PKARR_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

export type PkarrPublicationServerOptions = {
  allowedOrigins?: readonly string[];
  fetch?: PkarrFetch;
  hostname?: string;
  journalLocation: string;
  maintenanceIntervalMs?: number;
  maxPublications?: number;
  port?: number;
  requestTimeoutMs?: number;
  /** Starts a second capability-guarded loopback listener for originless server resolvers. */
  resolverIngress?: boolean;
  shutdownTimeoutMs?: number;
  upstreamBaseUrl: string;
};

const MAX_ALLOWED_ORIGINS = 64;
const DID_DHT_IDENTIFIER_PATTERN = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{51}[yo]$/u;

function randomCapability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte): string => byte.toString(16).padStart(2, '0')).join('');
}

function resolverHeaders(response?: Response): Headers {
  const headers = new Headers(response?.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Security-Policy', 'default-src \'none\'; frame-ancestors \'none\'');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.delete('Access-Control-Allow-Origin');
  return headers;
}

function resolverResponse(response: Response): Response {
  return new Response(response.body, {
    headers    : resolverHeaders(response),
    status     : response.status,
    statusText : response.statusText,
  });
}

function resolverNotFound(): Response {
  return new Response('not found', { headers: resolverHeaders(), status: 404 });
}

function hasBrowserRequestMetadata(headers: Headers): boolean {
  let present = headers.has('origin') || headers.has('referer');
  headers.forEach((_value, name): void => {
    if (name.toLowerCase().startsWith('sec-fetch-')) {
      present = true;
    }
  });
  return present;
}

function normalizeAllowedOrigins(origins: readonly string[]): Set<string> {
  if (origins.length > MAX_ALLOWED_ORIGINS) {
    throw new RangeError(`Pkarr publication server accepts at most ${MAX_ALLOWED_ORIGINS} browser origins.`);
  }
  return new Set(origins.map((origin): string => {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new TypeError(`Invalid Pkarr browser origin '${origin}'.`);
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' ||
      url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.origin === 'null') {
      throw new TypeError(`Invalid Pkarr browser origin '${origin}'. Expected an HTTP(S) origin without path, credentials, query, or fragment.`);
    }
    return url.origin;
  }));
}

function corsHeaders(request: Request, allowedOrigins: ReadonlySet<string>, requireOrigin: boolean): Headers | undefined {
  const origin = request.headers.get('origin');
  if (origin === null) {
    return requireOrigin ? undefined : new Headers();
  }
  if (!allowedOrigins.has(origin)) {
    return undefined;
  }
  return new Headers({
    'Access-Control-Allow-Origin' : origin,
    'Cache-Control'               : 'no-store',
    'Vary'                        : 'Origin',
  });
}

function withCors(response: Response, cors: Headers): Response {
  const headers = new Headers(response.headers);
  cors.forEach((value, name): void => { headers.set(name, value); });
  return new Response(response.body, {
    headers,
    status     : response.status,
    statusText : response.statusText,
  });
}

function preflightResponse(request: Request, cors: Headers): Response {
  const requestedMethod = request.headers.get('access-control-request-method')?.toUpperCase();
  const requestedHeaders = (request.headers.get('access-control-request-headers') ?? '')
    .split(',')
    .map((header): string => header.trim().toLowerCase())
    .filter(Boolean);
  if ((requestedMethod !== 'GET' && requestedMethod !== 'PUT') ||
    requestedHeaders.some((header): boolean => header !== 'content-type')) {
    return withCors(new Response('CORS preflight is outside the Pkarr route contract.', { status: 403 }), cors);
  }
  cors.set('Access-Control-Allow-Headers', 'content-type');
  cors.set('Access-Control-Allow-Methods', 'GET, PUT');
  cors.set('Access-Control-Max-Age', '0');
  if (request.headers.get('access-control-request-private-network') === 'true') {
    cors.set('Access-Control-Allow-Private-Network', 'true');
  }
  return new Response(null, { headers: cors, status: 204 });
}

function isPkarrPath(pathname: string): boolean {
  return pathname.split('/').filter(Boolean).length === 1 && pathname !== '/__lab/health';
}

export type PkarrPublicationServer = {
  browserRejectionCount(): number;
  endpoint: string;
  /** Returns the secret resolver base URI. Keep it out of logs, reports, URLs exposed to browsers, and argv. */
  resolverEndpoint(): string | undefined;
  /** Returns policy admission counters without exposing the capability. */
  resolverObservation(): { admitted: number; rejected: number };
  restoreResults: PkarrRestoreResult[];
  stop(): Promise<void>;
};

/** Starts the durable adapter only after all retained packets have been restored upstream. */
export async function startPkarrPublicationServer(options: PkarrPublicationServerOptions): Promise<PkarrPublicationServer> {
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins ?? []);
  const upstreamBaseUrl = new URL(options.upstreamBaseUrl).href;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const maintenanceIntervalMs = options.maintenanceIntervalMs ?? PKARR_MAINTENANCE_INTERVAL_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? requestTimeoutMs + 5_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new RangeError('Pkarr upstream request timeout must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) {
    throw new RangeError('Pkarr publication server shutdown timeout must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(maintenanceIntervalMs) || maintenanceIntervalMs <= 0) {
    throw new RangeError('Pkarr maintenance interval must be a positive safe integer.');
  }
  if (options.maxPublications !== undefined && (!Number.isSafeInteger(options.maxPublications) || options.maxPublications < 1)) {
    throw new RangeError('Pkarr maximum publication count must be a positive safe integer.');
  }
  const journal = new PkarrPublicationJournal(options.journalLocation);
  const adapter = new PkarrPublicationAdapter({
    fetch           : options.fetch,
    journal,
    maxPublications : options.maxPublications,
    requestTimeoutMs,
    upstreamBaseUrl,
  });

  let restoreResults: PkarrRestoreResult[];
  try {
    await adapter.probeUpstream();
    restoreResults = await adapter.restore();
    const failure = restoreResults.find((result): boolean => result.status === 'failed');
    if (failure !== undefined) {
      throw new Error(`Pkarr restoration failed for '${failure.identifier}': ${failure.detail ?? 'unknown failure'}`);
    }
  } catch (error: unknown) {
    journal.close();
    throw error;
  }

  const hostname = options.hostname ?? '127.0.0.1';
  let browserRejections = 0;
  let resolverAdmitted = 0;
  let resolverRejected = 0;
  let resolverOrigin: string | undefined;
  let resolverServer: Server<undefined> | undefined;
  let resolverUri: string | undefined;
  let server: Server<undefined> | undefined;
  try {
    if (options.resolverIngress === true) {
      const capability = randomCapability();
      const prefix = `/__lab/resolver/${capability}/`;
      resolverServer = Bun.serve({
        fetch: async (request): Promise<Response> => {
          const url = new URL(request.url);
          const hasBrowserHeader = hasBrowserRequestMetadata(request.headers);
          const identifier = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
          if (url.origin !== resolverOrigin || request.method !== 'GET' || url.search !== '' || hasBrowserHeader ||
            !DID_DHT_IDENTIFIER_PATTERN.test(identifier)) {
            resolverRejected += 1;
            return resolverNotFound();
          }
          resolverAdmitted += 1;
          return resolverResponse(await adapter.handle(new Request(`http://resolver.invalid/${identifier}`, {
            method : 'GET',
            signal : request.signal,
          })));
        },
        hostname           : '127.0.0.1',
        maxRequestBodySize : 1_024,
        port               : 0,
      });
      resolverOrigin = `http://127.0.0.1:${resolverServer.port}`;
      resolverUri = `${resolverOrigin}${prefix}`;
    }
    server = Bun.serve({
      fetch: async (request): Promise<Response> => {
        const url = new URL(request.url);
        const isHealthRoute = url.pathname === '/__lab/health';
        const cors = corsHeaders(request, allowedOrigins, allowedOrigins.size > 0 && !isHealthRoute);
        if (cors === undefined) {
          browserRejections += 1;
          return new Response('Browser origin is outside this lab.', { status: 403 });
        }
        if (request.method === 'OPTIONS') {
          if (request.headers.get('origin') === null || !isPkarrPath(url.pathname)) {
            return new Response('CORS preflight is outside the Pkarr route contract.', { status: 403 });
          }
          return preflightResponse(request, cors);
        }
        if (url.pathname === '/__lab/health') {
          if (request.method !== 'GET') {
            return withCors(new Response(null, { headers: { Allow: 'GET' }, status: 405 }), cors);
          }
          const error = adapter.lastError;
          return withCors(Response.json({
            acceptedPublications : journal.count(),
            error                : error ?? null,
            status               : error === undefined ? 'ready' : 'degraded',
          }, { status: error === undefined ? 200 : 503 }), cors);
        }
        return withCors(await adapter.handle(request), cors);
      },
      hostname,
      maxRequestBodySize : PKARR_PACKET_MAX_BYTES,
      port               : options.port ?? 0,
    });
    adapter.startMaintenance(maintenanceIntervalMs);
  } catch (error: unknown) {
    await resolverServer?.stop(true);
    await server?.stop(true);
    adapter.stopMaintenance();
    journal.close();
    throw error;
  }
  if (server === undefined) {
    adapter.stopMaintenance();
    journal.close();
    throw new Error('Pkarr publication server did not create its primary listener.');
  }

  let stopPromise: Promise<void> | undefined;
  const stop = async (): Promise<void> => {
    adapter.beginShutdown();
    const stopping = Promise.all([
      Promise.resolve(resolverServer?.stop(true)),
      Promise.resolve(server.stop(true)),
      adapter.drain(),
    ]);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const shutdownTimeout = new Promise<false>((resolve): void => {
      timeoutId = setTimeout((): void => { resolve(false); }, shutdownTimeoutMs);
    });
    const stopped = await Promise.race([stopping.then((): true => true), shutdownTimeout]);
    clearTimeout(timeoutId);
    if (!stopped) {
      void resolverServer?.stop(true);
      void server.stop(true);
      void stopping.then((): void => { journal.close(); }).catch((): void => {});
      throw new Error(`Pkarr publication server did not drain within ${shutdownTimeoutMs} milliseconds.`);
    }
    journal.close();
  };
  return {
    browserRejectionCount : (): number => browserRejections,
    endpoint              : `http://${hostname}:${server.port}/`,
    resolverEndpoint      : (): string | undefined => resolverUri,
    resolverObservation   : (): { admitted: number; rejected: number } => ({
      admitted : resolverAdmitted,
      rejected : resolverRejected,
    }),
    restoreResults,
    stop: (): Promise<void> => {
      if (stopPromise === undefined) {
        stopPromise = stop();
      }
      return stopPromise;
    },
  };
}
