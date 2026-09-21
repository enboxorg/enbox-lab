import { describe, expect, it } from 'bun:test';

import { validateWalletWorkerResult } from '../src/proofs/connect/fixture/wallet-rpc-validation.js';

const RELAY_ORIGIN = 'http://127.0.0.1:18445';
const REQUEST_URI = `${RELAY_ORIGIN}/connect/authorize/550e8400-e29b-41d4-a716-446655440000.jwt`;
const HANDLE = { expiresAt: 10_000, id: 'worker-handle' };

function relayResult(): Record<string, unknown> {
  return {
    authorizeStatus        : 200,
    callbackUrl            : `${RELAY_ORIGIN}/connect/callback`,
    handle                 : HANDLE,
    method                 : 'open-relay',
    permissionRequestCount : 0,
    requestKeyZeroed       : true,
    requestUri             : REQUEST_URI,
    routePolicyRejections  : 5,
    state                  : 'opaque-state',
  };
}

describe('wallet worker RPC result validation', () => {
  it('should accept the three exact result contracts', () => {
    expect(validateWalletWorkerResult({ method: 'deny', token: 'DENIED' }, 'deny', RELAY_ORIGIN)).toMatchObject({
      method : 'deny',
      token  : 'DENIED',
    });
    expect(validateWalletWorkerResult({
      handle                 : HANDLE,
      method                 : 'open-popup',
      originMismatchRejected : true,
      otherPrincipalRejected : true,
      permissionRequestCount : 0,
    }, 'open-popup', RELAY_ORIGIN)).toMatchObject({ method: 'open-popup' });
    expect(validateWalletWorkerResult(relayResult(), 'open-relay', RELAY_ORIGIN)).toMatchObject({ method: 'open-relay' });
  });

  it('should reject method, token, handle, relay-origin, callback, and state substitutions', () => {
    const cases: Array<{ expected: 'deny' | 'open-popup' | 'open-relay'; value: unknown }> = [
      { expected: 'deny', value: { method: 'open-popup' } },
      { expected: 'deny', value: { method: 'deny', token: 'APPROVED' } },
      { expected: 'open-popup', value: { handle: null, method: 'open-popup', permissionRequestCount: 0 } },
      { expected: 'open-relay', value: { ...relayResult(), requestUri: REQUEST_URI.replace(RELAY_ORIGIN, 'https://attacker.invalid') } },
      { expected: 'open-relay', value: { ...relayResult(), callbackUrl: 'https://attacker.invalid/connect/callback' } },
      { expected: 'open-relay', value: { ...relayResult(), state: 'x'.repeat(257) } },
      { expected: 'open-relay', value: { ...relayResult(), requestKeyZeroed: false } },
    ];

    for (const entry of cases) {
      expect((): unknown => validateWalletWorkerResult(entry.value, entry.expected, RELAY_ORIGIN)).toThrow();
    }
  });
});
