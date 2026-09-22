import type { AgentProcessNoteWriteRelayApprovalParams } from '../src/runtime/agent-process/agent-process-runtime.js';

import { createTestNoteWriteRelayRequest } from './agent-process/test-note-write-relay.js';
import { describe, expect, it } from 'bun:test';

import type { RelayApprovalBridgeBootstrap } from '../src/runtime/popup-approval-bridge.js';

import { RelayApprovalBridge } from '../src/runtime/popup-approval-bridge.js';

const DAPP_ORIGIN = 'http://localhost:44001';
const WALLET_ORIGIN = 'http://localhost:44002';
const RELAY_ORIGIN = 'http://127.0.0.1:44003';
const ID_TOKEN = 'header..iv.ciphertext.tag';

function headers(bootstrap: RelayApprovalBridgeBootstrap): Record<string, string> {
  return {
    'Content-Type'            : 'application/json',
    'Host'                    : new URL(WALLET_ORIGIN).host,
    'Origin'                  : WALLET_ORIGIN,
    'Sec-Fetch-Site'          : 'same-origin',
    [bootstrap.sessionHeader] : bootstrap.sessionCapability,
  };
}

function post(
  bootstrap: RelayApprovalBridgeBootstrap,
  path: string,
  body: unknown,
  overrides: Record<string, string> = {},
): Request {
  return new Request(`${WALLET_ORIGIN}${path}`, {
    body    : JSON.stringify(body),
    headers : { ...headers(bootstrap), ...overrides },
    method  : 'POST',
  });
}

describe('relay approval bridge', () => {
  it('should bind one exact relay request and cache one PIN-sealed approval', async () => {
    const calls: AgentProcessNoteWriteRelayApprovalParams[] = [];
    const bridge = new RelayApprovalBridge({
      agent: {
        approveNoteWriteRelay: async (params): Promise<Readonly<{ idToken: string }>> => {
          calls.push(params);
          return { idToken: ID_TOKEN };
        },
      },
      dappOrigin   : DAPP_ORIGIN,
      relayOrigin  : RELAY_ORIGIN,
      walletOrigin : WALLET_ORIGIN,
    });
    const bootstrap = bridge.bootstrap();
    const fixture = await createTestNoteWriteRelayRequest(DAPP_ORIGIN, RELAY_ORIGIN);
    try {
      const boundResponse = await bridge.handle(post(bootstrap, bootstrap.bindPath, {
        request    : fixture.request,
        requestUri : `${RELAY_ORIGIN}/connect/authorize/550e8400-e29b-41d4-a716-446655440000.jwt`,
      }));
      expect(boundResponse.status).toBe(200);
      const bound = await boundResponse.json() as { result: { handle: unknown } };
      const approval = post(bootstrap, bootstrap.approvePath, { handle: bound.result.handle, pin: '4821' });
      expect(await (await bridge.handle(approval.clone())).json()).toEqual({ ok: true, result: { idToken: ID_TOKEN } });
      expect(await (await bridge.handle(approval)).json()).toEqual({ ok: true, result: { idToken: ID_TOKEN } });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        dappOrigin  : DAPP_ORIGIN,
        pin         : '4821',
        relayOrigin : RELAY_ORIGIN,
      });
      expect(JSON.stringify(bridge)).not.toContain(bootstrap.sessionCapability);
      expect(JSON.stringify(bridge)).not.toContain('4821');
    } finally {
      await bridge.stop();
    }
  });

  it('should reject invalid authentication, PINs, and relay substitution before approval', async () => {
    let calls = 0;
    const bridge = new RelayApprovalBridge({
      agent: {
        approveNoteWriteRelay: async (): Promise<Readonly<{ idToken: string }>> => {
          calls += 1;
          return { idToken: ID_TOKEN };
        },
      },
      dappOrigin   : DAPP_ORIGIN,
      relayOrigin  : RELAY_ORIGIN,
      walletOrigin : WALLET_ORIGIN,
    });
    const bootstrap = bridge.bootstrap();
    const fixture = await createTestNoteWriteRelayRequest(DAPP_ORIGIN, RELAY_ORIGIN);
    try {
      expect((await bridge.handle(post(bootstrap, bootstrap.bindPath, {
        request    : fixture.request,
        requestUri : 'http://127.0.0.1:44004/connect/authorize/550e8400-e29b-41d4-a716-446655440000.jwt',
      }))).status).toBe(400);
      expect((await bridge.handle(post(bootstrap, bootstrap.bindPath, {
        request    : fixture.request,
        requestUri : `${RELAY_ORIGIN}/connect/authorize/550e8400-e29b-41d4-a716-446655440000.jwt`,
      }, { Origin: 'http://localhost:44009' }))).status).toBe(404);

      const boundResponse = await bridge.handle(post(bootstrap, bootstrap.bindPath, {
        request    : fixture.request,
        requestUri : `${RELAY_ORIGIN}/connect/authorize/550e8400-e29b-41d4-a716-446655440001.jwt`,
      }));
      const bound = await boundResponse.json() as { result: { handle: unknown } };
      expect((await bridge.handle(post(bootstrap, bootstrap.approvePath, {
        handle : bound.result.handle,
        pin    : '12345',
      }))).status).toBe(400);
      expect(calls).toBe(0);
    } finally {
      await bridge.stop();
    }
  });
});
