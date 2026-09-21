import type { ConnectRequest } from '@enbox/connect';
import type {
  ConnectWorkerBoundaryErrorCode,
  ConnectWorkerRequestContext,
  ConnectWorkerSessionHandle,
} from '../src/proofs/connect/connect-worker-boundary.js';

import { describe, expect, it } from 'bun:test';

import {
  CONNECT_WORKER_MAX_JWE_BYTES,
  CONNECT_WORKER_MAX_REQUEST_BYTES,
  ConnectWorkerBoundaryError,
  ConnectWorkerSessionRegistry,
  fetchBoundedRelayRequest,
  validateRelayRequestUriForPrefetch,
} from '../src/proofs/connect/connect-worker-boundary.js';

const CONTEXT: ConnectWorkerRequestContext = { principalId: 'lab-1/wallet-1/provider-page' };
const DAPP_ORIGIN = 'http://localhost:18443';
const RELAY_ORIGIN = 'http://localhost:18444';
const RELAY_REQUEST_URI = `${RELAY_ORIGIN}/connect/authorize/550e8400-e29b-41d4-a716-446655440000.jwt`;

function createRequest(reply: ConnectRequest['reply'] = { mode: 'post_message' }): ConnectRequest {
  return {
    appName            : 'Private Notes',
    clientDid          : 'did:jwk:client',
    clientMetadata     : { origin: DAPP_ORIGIN },
    nonce              : 'request-nonce',
    permissionRequests : [],
    reply,
    responseKey        : {
      crv : 'X25519',
      kty : 'OKP',
      x   : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
    state               : 'request-state',
    supportedDidMethods : ['did:dht'],
  };
}

function bindPopup(
  registry: ConnectWorkerSessionRegistry,
  request: ConnectRequest = createRequest(),
): ConnectWorkerSessionHandle {
  return registry.bind({
    channel   : { dappOrigin: DAPP_ORIGIN, kind: 'popup' },
    context   : CONTEXT,
    request,
    transport : 'postMessage',
  }).handle;
}

function expectBoundaryError(callback: () => unknown, code: ConnectWorkerBoundaryErrorCode): void {
  try {
    callback();
    throw new Error(`Expected connect worker boundary error '${code}'.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectWorkerBoundaryError);
    expect((error as ConnectWorkerBoundaryError).code).toBe(code);
  }
}

describe('connect worker session binding', () => {
  it('should snapshot the displayed request and consume that exact snapshot once', () => {
    const registry = new ConnectWorkerSessionRegistry();
    const request = createRequest();
    const bound = registry.bind({
      channel   : { dappOrigin: DAPP_ORIGIN, kind: 'popup' },
      context   : CONTEXT,
      request,
      transport : 'postMessage',
    });

    request.appName = 'Tampered caller object';
    bound.request.appName = 'Tampered display copy';

    const claimed = registry.claimForApproval(CONTEXT, bound.handle);
    expect(claimed.request.appName).toBe('Private Notes');
    expect(claimed.transport).toBe('postMessage');
    expect(claimed.channel).toEqual({ dappOrigin: DAPP_ORIGIN, kind: 'popup' });
    expectBoundaryError((): unknown => registry.claimForApproval(CONTEXT, bound.handle), 'invalid-session');
  });

  it('should reject tampered capabilities without invalidating the authentic session', () => {
    const registry = new ConnectWorkerSessionRegistry();
    const handle = bindPopup(registry);
    const mutations: ConnectWorkerSessionHandle[] = [
      { ...handle, id: crypto.randomUUID() },
      { ...handle, expiresAt: handle.expiresAt + 1 },
    ];

    for (const tampered of mutations) {
      expectBoundaryError((): unknown => registry.claimForApproval(CONTEXT, tampered), 'invalid-session');
    }

    expect(registry.claimForApproval(CONTEXT, handle).request.state).toBe('request-state');
  });

  it('should bind a session to the authenticated principal', () => {
    const registry = new ConnectWorkerSessionRegistry();
    const handle = bindPopup(registry);
    const otherContext = { principalId: 'lab-1/wallet-2/provider-page' };

    expectBoundaryError((): unknown => registry.claimForApproval(otherContext, handle), 'invalid-session');
    expect(registry.claimForApproval(CONTEXT, handle).request.clientDid).toBe('did:jwk:client');
  });

  it('should reject malformed boundary objects with stable errors', () => {
    const registry = new ConnectWorkerSessionRegistry();
    const handle = bindPopup(registry);

    expectBoundaryError((): unknown => registry.claimForApproval(null as never, handle), 'invalid-context');
    expectBoundaryError((): unknown => registry.claimForApproval(CONTEXT, null as never), 'invalid-session');
    expectBoundaryError((): unknown => registry.claimForApproval(CONTEXT, { ...handle, id: 1 } as never), 'invalid-session');
    expectBoundaryError((): unknown => registry.bind(null as never), 'invalid-request');
  });

  it('should reject an oversized opened request before storing it', () => {
    const registry = new ConnectWorkerSessionRegistry();
    const request = createRequest();
    request.appName = 'x'.repeat(CONNECT_WORKER_MAX_REQUEST_BYTES);

    expectBoundaryError((): unknown => bindPopup(registry, request), 'invalid-request');
  });

  it('should invalidate expired, cancelled, and denied sessions', () => {
    let now = 1_000;
    const registry = new ConnectWorkerSessionRegistry({ now: (): number => now, sessionTtlMs: 100 });

    const expired = bindPopup(registry);
    now = expired.expiresAt;
    expectBoundaryError((): unknown => registry.claimForApproval(CONTEXT, expired), 'session-expired');

    const cancelled = bindPopup(registry);
    registry.cancel(CONTEXT, cancelled);
    expectBoundaryError((): unknown => registry.claimForApproval(CONTEXT, cancelled), 'invalid-session');

    const denied = bindPopup(registry);
    expect(registry.deny(CONTEXT, denied)).toBe('DENIED');
    expectBoundaryError((): unknown => registry.claimForApproval(CONTEXT, denied), 'invalid-session');
  });

  it('should invalidate every handle when the worker stops or restarts', () => {
    const firstWorker = new ConnectWorkerSessionRegistry();
    const handle = bindPopup(firstWorker);
    firstWorker.stop();

    expectBoundaryError((): unknown => firstWorker.claimForApproval(CONTEXT, handle), 'worker-stopped');

    const restartedWorker = new ConnectWorkerSessionRegistry();
    expectBoundaryError((): unknown => restartedWorker.claimForApproval(CONTEXT, handle), 'invalid-session');
  });

  it('should enforce a bounded pending-session set and reclaim expired capacity', () => {
    let now = 5_000;
    const registry = new ConnectWorkerSessionRegistry({
      maxPendingSessions : 1,
      now                : (): number => now,
      sessionTtlMs       : 50,
    });
    bindPopup(registry);

    expectBoundaryError((): ConnectWorkerSessionHandle => bindPopup(registry), 'capacity-exceeded');
    now += 50;
    expect(typeof bindPopup(registry).id).toBe('string');
  });

  it('should reject channel substitution and cross-origin relay callbacks', () => {
    const registry = new ConnectWorkerSessionRegistry();
    expectBoundaryError((): unknown => registry.bind({
      channel   : { dappOrigin: DAPP_ORIGIN, kind: 'popup' },
      context   : CONTEXT,
      request   : createRequest({ mode: 'direct_post', callbackUrl: `${RELAY_ORIGIN}/connect/callback` }),
      transport : 'postMessage',
    }), 'invalid-channel');

    expectBoundaryError((): unknown => registry.bind({
      channel   : { kind: 'relay', requestUri: RELAY_REQUEST_URI },
      context   : CONTEXT,
      request   : createRequest({ mode: 'direct_post', callbackUrl: 'https://attacker.example/connect/callback' }),
      transport : 'relay',
    }), 'invalid-channel');

    const spoofedOrigin = createRequest();
    spoofedOrigin.clientMetadata = { origin: 'http://localhost:19999' };
    expectBoundaryError((): unknown => registry.bind({
      channel   : { dappOrigin: DAPP_ORIGIN, kind: 'popup' },
      context   : CONTEXT,
      request   : spoofedOrigin,
      transport : 'postMessage',
    }), 'invalid-channel');

    expectBoundaryError((): unknown => registry.bind({
      channel   : { kind: 'relay', requestUri: `${RELAY_ORIGIN}/${'x'.repeat(8_192)}` },
      context   : CONTEXT,
      request   : createRequest({ mode: 'direct_post', callbackUrl: `${RELAY_ORIGIN}/connect/callback` }),
      transport : 'relay',
    }), 'invalid-channel');
  });

  it('should validate a canonical relay request URI against a caller-owned origin before fetching', () => {
    expect(validateRelayRequestUriForPrefetch(RELAY_REQUEST_URI, RELAY_ORIGIN)).toBe(RELAY_REQUEST_URI);
  });

  it('should fetch a canonical relay request with a redirect-blocking bounded reader', async () => {
    let redirect: RequestRedirect | undefined;
    const jwe = await fetchBoundedRelayRequest({
      fetchFn: async (_input, init): Promise<Response> => {
        redirect = init?.redirect;
        return new Response('compact-jwe', { headers: { 'Content-Length': '11' } });
      },
      relayOrigin : RELAY_ORIGIN,
      requestUri  : RELAY_REQUEST_URI,
    });

    expect(jwe).toBe('compact-jwe');
    expect(redirect).toBe('error');
  });

  it('should reject fixed-length and streamed relay envelopes above the worker limit', async () => {
    await expect(fetchBoundedRelayRequest({
      fetchFn: async (): Promise<Response> => new Response('oversized', {
        headers: { 'Content-Length': String(CONNECT_WORKER_MAX_JWE_BYTES + 1) },
      }),
      relayOrigin : RELAY_ORIGIN,
      requestUri  : RELAY_REQUEST_URI,
    })).rejects.toMatchObject({ code: 'invalid-request' });

    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array(CONNECT_WORKER_MAX_JWE_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    await expect(fetchBoundedRelayRequest({
      fetchFn     : async (): Promise<Response> => new Response(oversizedStream),
      relayOrigin : RELAY_ORIGIN,
      requestUri  : RELAY_REQUEST_URI,
    })).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('should reject unsafe relay request URIs before fetching', () => {
    const unsafeRequestUris = [
      `https://attacker.example/connect/authorize/550e8400-e29b-41d4-a716-446655440000.jwt`,
      `http://user:password@localhost:18444/connect/authorize/550e8400-e29b-41d4-a716-446655440000.jwt`,
      `${RELAY_REQUEST_URI}?`,
      `${RELAY_REQUEST_URI}?next=https://attacker.example`,
      `${RELAY_REQUEST_URI}#`,
      `${RELAY_REQUEST_URI}#fragment`,
      `${RELAY_ORIGIN}/connect/authorize/not-a-uuid.jwt`,
      `${RELAY_ORIGIN}/connect/authorize/550E8400-E29B-41D4-A716-446655440000.jwt`,
      `${RELAY_ORIGIN}/connect/authorize/550e8400-e29b-41d4-a716-446655440000`,
      `${RELAY_ORIGIN}/connect/authorize/550e8400-e29b-41d4-a716-446655440000.jwt/extra`,
    ];

    for (const requestUri of unsafeRequestUris) {
      expectBoundaryError(
        (): string => validateRelayRequestUriForPrefetch(requestUri, RELAY_ORIGIN),
        'invalid-channel',
      );
    }
  });

  it('should require the caller-owned relay origin and popup origins to be literal origins', () => {
    const registry = new ConnectWorkerSessionRegistry();
    for (const relayOrigin of [
      `${RELAY_ORIGIN}/`,
      `${RELAY_ORIGIN}/connect`,
      `${RELAY_ORIGIN}?`,
      `${RELAY_ORIGIN}?query`,
      `${RELAY_ORIGIN}#`,
      `${RELAY_ORIGIN}#fragment`,
      'http://user:password@localhost:18444',
    ]) {
      expectBoundaryError(
        (): string => validateRelayRequestUriForPrefetch(RELAY_REQUEST_URI, relayOrigin),
        'invalid-channel',
      );
    }

    const request = createRequest();
    request.clientMetadata = { origin: `${DAPP_ORIGIN}/path` };
    expectBoundaryError((): unknown => registry.bind({
      channel   : { dappOrigin: `${DAPP_ORIGIN}/path`, kind: 'popup' },
      context   : CONTEXT,
      request,
      transport : 'postMessage',
    }), 'invalid-channel');
  });

  it('should require canonical same-origin relay request and callback routes when binding', () => {
    const registry = new ConnectWorkerSessionRegistry();
    const invalidRequestUris = [
      `${RELAY_ORIGIN}/connect/authorize/request.jwt`,
      `${RELAY_REQUEST_URI}?query`,
      `${RELAY_REQUEST_URI}#fragment`,
    ];
    for (const requestUri of invalidRequestUris) {
      expectBoundaryError((): unknown => registry.bind({
        channel   : { kind: 'relay', requestUri },
        context   : CONTEXT,
        request   : createRequest({ mode: 'direct_post', callbackUrl: `${RELAY_ORIGIN}/connect/callback` }),
        transport : 'relay',
      }), 'invalid-channel');
    }

    const invalidCallbacks = [
      `${RELAY_ORIGIN}/connect/callback/`,
      `${RELAY_ORIGIN}/connect/callback?`,
      `${RELAY_ORIGIN}/connect/callback?query`,
      `${RELAY_ORIGIN}/connect/callback#`,
      `${RELAY_ORIGIN}/connect/callback#fragment`,
      `${RELAY_ORIGIN}/other`,
      'http://user:password@localhost:18444/connect/callback',
      'https://attacker.example/connect/callback',
    ];
    for (const callbackUrl of invalidCallbacks) {
      expectBoundaryError((): unknown => registry.bind({
        channel   : { kind: 'relay', requestUri: RELAY_REQUEST_URI },
        context   : CONTEXT,
        request   : createRequest({ mode: 'direct_post', callbackUrl }),
        transport : 'relay',
      }), 'invalid-channel');
    }

    const bound = registry.bind({
      channel   : { kind: 'relay', requestUri: RELAY_REQUEST_URI },
      context   : CONTEXT,
      request   : createRequest({ mode: 'direct_post', callbackUrl: `${RELAY_ORIGIN}/connect/callback` }),
      transport : 'relay',
    });
    expect(registry.claimForApproval(CONTEXT, bound.handle).channel).toEqual({
      kind       : 'relay',
      requestUri : RELAY_REQUEST_URI,
    });
  });

});
