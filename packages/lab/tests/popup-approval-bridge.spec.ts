import type {
  AgentProcessNoteWritePopupApprovalParams,
} from '../src/runtime/agent-process/agent-process-runtime.js';
import type { ConnectRequest } from '@enbox/connect';
import type {
  PopupApprovalBridgeBootstrap,
} from '../src/runtime/popup-approval-bridge.js';
import type { Server } from 'bun';

import { AgentProcessApprovalOutcomeUnknownError } from '../src/runtime/agent-process/agent-process-runtime.js';
import { createTestNoteWritePopupRequest } from './agent-process/test-note-write-popup.js';

import { describe, expect, it } from 'bun:test';
import {
  POPUP_APPROVAL_APPROVE_PATH,
  POPUP_APPROVAL_BIND_PATH,
  POPUP_APPROVAL_CANCEL_PATH,
  POPUP_APPROVAL_MAX_BODY_BYTES,
  POPUP_APPROVAL_SESSION_HEADER,
  PopupApprovalBridge,
} from '../src/runtime/popup-approval-bridge.js';

const DAPP_ORIGIN = 'http://localhost:44001';
const ID_TOKEN = 'header..iv.ciphertext.tag';

type ApprovalAgent = Readonly<{
  approveNoteWritePopup(params: AgentProcessNoteWritePopupApprovalParams): Promise<Readonly<{ idToken: string }>>;
}>;

type BridgeHarness = Readonly<{
  bootstrap: PopupApprovalBridgeBootstrap;
  bridge: PopupApprovalBridge;
  server: Server<undefined>;
}>;

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void }> {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((resolvePromise): void => { resolve = resolvePromise; });
  return { promise, resolve };
}

function startBridge(agent: ApprovalAgent): BridgeHarness {
  const target: { bridge?: PopupApprovalBridge } = {};
  const server = Bun.serve({
    fetch: (request): Promise<Response> | Response => target.bridge === undefined
      ? new Response('starting', { status: 503 })
      : target.bridge.handle(request),
    hostname : '127.0.0.1',
    port     : 0,
  });
  const bridge = new PopupApprovalBridge({
    agent,
    dappOrigin   : DAPP_ORIGIN,
    walletOrigin : `http://localhost:${server.port}`,
  });
  target.bridge = bridge;
  return { bootstrap: bridge.bootstrap(), bridge, server };
}

function requestHeaders(bootstrap: PopupApprovalBridgeBootstrap): Record<string, string> {
  return {
    'Content-Type'                  : 'application/json',
    'Origin'                        : bootstrap.walletOrigin,
    'Sec-Fetch-Site'                : 'same-origin',
    [POPUP_APPROVAL_SESSION_HEADER] : bootstrap.sessionCapability,
  };
}

async function post(
  bootstrap: PopupApprovalBridgeBootstrap,
  path: string,
  body: unknown,
  headers: Record<string, string> = requestHeaders(bootstrap),
): Promise<Response> {
  return fetch(`${bootstrap.walletOrigin}${path}`, {
    body     : JSON.stringify(body),
    headers,
    method   : 'POST',
    redirect : 'error',
  });
}

describe('popup approval bridge', () => {
  it('should bind an immutable request and retry only the same sealed delivery result', async () => {
    const calls: AgentProcessNoteWritePopupApprovalParams[] = [];
    const harness = startBridge({
      approveNoteWritePopup: async (params): Promise<Readonly<{ idToken: string }>> => {
        calls.push(structuredClone(params));
        return { idToken: ID_TOKEN };
      },
    });
    try {
      const fixture = await createTestNoteWritePopupRequest(DAPP_ORIGIN);
      const originalState = fixture.request.state;
      expect(JSON.stringify(harness.bridge)).not.toContain(harness.bootstrap.sessionCapability);
      expect(harness.bootstrap.walletOrigin).not.toContain(harness.bootstrap.sessionCapability);

      const boundResponse = await post(harness.bootstrap, POPUP_APPROVAL_BIND_PATH, { request: fixture.request });
      expect(boundResponse.status).toBe(200);
      expect(boundResponse.headers.get('cache-control')).toBe('no-store');
      expect(boundResponse.headers.get('access-control-allow-origin')).toBeNull();
      const bound = await boundResponse.json() as {
        ok: true;
        result: { handle: { expiresAt: number; id: string }; request: ConnectRequest };
      };
      expect(bound.result.request.state).toBe(originalState);
      fixture.request.state = 'A'.repeat(22);

      const approved = await post(harness.bootstrap, POPUP_APPROVAL_APPROVE_PATH, {
        handle: bound.result.handle,
      });
      expect(approved.status).toBe(200);
      expect(await approved.json()).toEqual({ ok: true, result: { idToken: ID_TOKEN } });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ dappOrigin: DAPP_ORIGIN });
      expect(calls[0]!.request.state).toBe(originalState);

      const deliveryRetry = await post(harness.bootstrap, POPUP_APPROVAL_APPROVE_PATH, {
        handle: bound.result.handle,
      });
      expect(deliveryRetry.status).toBe(200);
      expect(await deliveryRetry.json()).toEqual({ ok: true, result: { idToken: ID_TOKEN } });
      expect(calls).toHaveLength(1);
    } finally {
      await harness.bridge.stop();
      await harness.server.stop(true);
    }
  });

  it('should hide unauthorized routes, bound bodies, and cancelled handles before agent access', async () => {
    let calls = 0;
    const harness = startBridge({
      approveNoteWritePopup: async (): Promise<Readonly<{ idToken: string }>> => {
        calls += 1;
        return { idToken: ID_TOKEN };
      },
    });
    try {
      const fixture = await createTestNoteWritePopupRequest(DAPP_ORIGIN);
      const validHeaders = requestHeaders(harness.bootstrap);
      const probes = [
        fetch(`${harness.bootstrap.walletOrigin}${POPUP_APPROVAL_BIND_PATH}`, { method: 'GET' }),
        fetch(`${harness.bootstrap.walletOrigin}${POPUP_APPROVAL_BIND_PATH}`, { method: 'OPTIONS' }),
        post(harness.bootstrap, `${POPUP_APPROVAL_BIND_PATH}?query=1`, { request: fixture.request }),
        post(harness.bootstrap, POPUP_APPROVAL_BIND_PATH, { request: fixture.request }, {
          ...validHeaders,
          [POPUP_APPROVAL_SESSION_HEADER]: 'wrong-capability',
        }),
        post(harness.bootstrap, POPUP_APPROVAL_BIND_PATH, { request: fixture.request }, {
          ...validHeaders,
          Origin: 'http://localhost:1',
        }),
        post(harness.bootstrap, POPUP_APPROVAL_BIND_PATH, { request: fixture.request }, {
          ...validHeaders,
          'Sec-Fetch-Site': 'cross-site',
        }),
        fetch(`http://127.0.0.1:${harness.server.port}${POPUP_APPROVAL_BIND_PATH}`, {
          body    : JSON.stringify({ request: fixture.request }),
          headers : validHeaders,
          method  : 'POST',
        }),
      ];
      const rejected = await Promise.all(probes);
      expect(rejected.map((response): number => response.status)).toEqual(Array(probes.length).fill(404));
      for (const response of rejected) {
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
        await response.body?.cancel();
      }

      const oversized = await fetch(`${harness.bootstrap.walletOrigin}${POPUP_APPROVAL_BIND_PATH}`, {
        body    : 'x'.repeat(POPUP_APPROVAL_MAX_BODY_BYTES + 1),
        headers : validHeaders,
        method  : 'POST',
      });
      expect(oversized.status).toBe(400);

      const wrongOriginRequest = structuredClone(fixture.request);
      wrongOriginRequest.clientMetadata!.origin = 'http://localhost:44003';
      const wrongOrigin = await post(harness.bootstrap, POPUP_APPROVAL_BIND_PATH, {
        request: wrongOriginRequest,
      });
      expect(wrongOrigin.status).toBe(400);

      const bound = await (await post(harness.bootstrap, POPUP_APPROVAL_BIND_PATH, {
        request: fixture.request,
      })).json() as { result: { handle: { expiresAt: number; id: string } } };
      const cancelled = await post(harness.bootstrap, POPUP_APPROVAL_CANCEL_PATH, {
        handle: bound.result.handle,
      });
      expect(cancelled.status).toBe(204);
      const cancelledApproval = await post(harness.bootstrap, POPUP_APPROVAL_APPROVE_PATH, {
        handle: bound.result.handle,
      });
      expect(cancelledApproval.status).toBe(409);
      expect(calls).toBe(0);

      await harness.bridge.stop();
      const stopped = await post(harness.bootstrap, POPUP_APPROVAL_BIND_PATH, { request: fixture.request });
      expect(stopped.status).toBe(404);
    } finally {
      await harness.bridge.stop();
      await harness.server.stop(true);
    }
  });

  it('should share one in-flight mutation, drain it on stop, and cache reconciliation failures', async () => {
    let approval = deferred<Readonly<{ idToken: string }>>();
    let calls = 0;
    const harness = startBridge({
      approveNoteWritePopup: async (): Promise<Readonly<{ idToken: string }>> => {
        calls += 1;
        return approval.promise;
      },
    });
    try {
      const fixture = await createTestNoteWritePopupRequest(DAPP_ORIGIN);
      const firstBound = await (await post(harness.bootstrap, POPUP_APPROVAL_BIND_PATH, {
        request: fixture.request,
      })).json() as { result: { handle: { expiresAt: number; id: string } } };
      const first = post(harness.bootstrap, POPUP_APPROVAL_APPROVE_PATH, { handle: firstBound.result.handle });
      const concurrent = post(harness.bootstrap, POPUP_APPROVAL_APPROVE_PATH, { handle: firstBound.result.handle });
      while (calls === 0) { await Bun.sleep(1); }
      await Bun.sleep(10);
      approval.resolve({ idToken: ID_TOKEN });
      expect((await first).status).toBe(200);
      expect((await concurrent).status).toBe(200);
      expect(calls).toBe(1);

      approval = deferred<Readonly<{ idToken: string }>>();
      const secondFixture = await createTestNoteWritePopupRequest(DAPP_ORIGIN);
      const secondBound = await (await post(harness.bootstrap, POPUP_APPROVAL_BIND_PATH, {
        request: secondFixture.request,
      })).json() as { result: { handle: { expiresAt: number; id: string } } };
      const second = post(harness.bootstrap, POPUP_APPROVAL_APPROVE_PATH, { handle: secondBound.result.handle });
      while (calls < 2) { await Bun.sleep(1); }
      const stopping = harness.bridge.stop();
      let stopped = false;
      void stopping.then((): void => { stopped = true; });
      await Bun.sleep(10);
      expect(stopped).toBe(false);
      approval.resolve({ idToken: ID_TOKEN });
      expect((await second).status).toBe(200);
      await stopping;
      expect(calls).toBe(2);
    } finally {
      approval.resolve({ idToken: ID_TOKEN });
      await harness.bridge.stop();
      await harness.server.stop(true);
    }

    let failureMode: 'generic' | 'malformed' | 'unknown' = 'unknown';
    const failedHarness = startBridge({
      approveNoteWritePopup: async (): Promise<Readonly<{ idToken: string }>> => {
        calls += 1;
        if (failureMode === 'generic') { throw new Error('never-leak-this-agent-error'); }
        if (failureMode === 'malformed') { return { idToken: 'not-a-jwe' }; }
        throw new AgentProcessApprovalOutcomeUnknownError();
      },
    });
    try {
      const fixture = await createTestNoteWritePopupRequest(DAPP_ORIGIN);
      const bound = await (await post(failedHarness.bootstrap, POPUP_APPROVAL_BIND_PATH, {
        request: fixture.request,
      })).json() as { result: { handle: { expiresAt: number; id: string } } };
      const firstFailure = await post(failedHarness.bootstrap, POPUP_APPROVAL_APPROVE_PATH, {
        handle: bound.result.handle,
      });
      expect(firstFailure.status).toBe(409);
      expect(await firstFailure.json()).toEqual({
        error : { code: 'reconciliation-required' },
        ok    : false,
      });
      const callsAfterFailure = calls;
      const retriedFailure = await post(failedHarness.bootstrap, POPUP_APPROVAL_APPROVE_PATH, {
        handle: bound.result.handle,
      });
      expect(retriedFailure.status).toBe(409);
      expect(calls).toBe(callsAfterFailure);

      failureMode = 'generic';
      const genericFixture = await createTestNoteWritePopupRequest(DAPP_ORIGIN);
      const genericBound = await (await post(failedHarness.bootstrap, POPUP_APPROVAL_BIND_PATH, {
        request: genericFixture.request,
      })).json() as { result: { handle: { expiresAt: number; id: string } } };
      const genericFailure = await post(failedHarness.bootstrap, POPUP_APPROVAL_APPROVE_PATH, {
        handle: genericBound.result.handle,
      });
      expect(genericFailure.status).toBe(502);
      const genericBody = await genericFailure.text();
      expect(genericBody).toContain('approval-failed');
      expect(genericBody).not.toContain('never-leak-this-agent-error');

      failureMode = 'malformed';
      const malformedFixture = await createTestNoteWritePopupRequest(DAPP_ORIGIN);
      const malformedBound = await (await post(failedHarness.bootstrap, POPUP_APPROVAL_BIND_PATH, {
        request: malformedFixture.request,
      })).json() as { result: { handle: { expiresAt: number; id: string } } };
      const malformed = await post(failedHarness.bootstrap, POPUP_APPROVAL_APPROVE_PATH, {
        handle: malformedBound.result.handle,
      });
      expect(malformed.status).toBe(409);
      expect(await malformed.json()).toEqual({
        error : { code: 'reconciliation-required' },
        ok    : false,
      });
    } finally {
      await failedHarness.bridge.stop();
      await failedHarness.server.stop(true);
    }
  });
});
