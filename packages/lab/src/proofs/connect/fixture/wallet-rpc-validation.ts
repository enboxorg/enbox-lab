import type { ConnectWorkerSessionHandle } from '../connect-worker-boundary.js';
import type {
  WalletWorkerDenyResult,
  WalletWorkerOpenPopupResult,
  WalletWorkerOpenRelayResult,
  WalletWorkerResult,
} from './wallet-worker.js';

import { CONNECT_DENIED_TOKEN } from '@enbox/connect';

import { validateRelayRequestUriForPrefetch } from '../connect-worker-boundary.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSessionHandle(value: unknown): value is ConnectWorkerSessionHandle {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 &&
    Number.isSafeInteger(value.expiresAt) && (value.expiresAt as number) >= 0;
}

/** Validates data returned across the wallet-page worker boundary before use. */
export function validateWalletWorkerResult(
  value: unknown,
  expectedMethod: WalletWorkerResult['method'] | undefined,
  relayOrigin: string,
): WalletWorkerResult {
  if (!isRecord(value) || expectedMethod === undefined || value.method !== expectedMethod) {
    throw new TypeError('Wallet worker returned an unexpected RPC result method.');
  }
  if (value.method === 'deny') {
    if (value.token !== CONNECT_DENIED_TOKEN) {
      throw new TypeError('Wallet worker returned an invalid denial token.');
    }
    return value as WalletWorkerDenyResult;
  }
  if (!isSessionHandle(value.handle) || !Number.isSafeInteger(value.permissionRequestCount) ||
    (value.permissionRequestCount as number) < 0) {
    throw new TypeError('Wallet worker returned an invalid session result.');
  }
  if (value.method === 'open-popup') {
    if (typeof value.originMismatchRejected !== 'boolean' || typeof value.otherPrincipalRejected !== 'boolean') {
      throw new TypeError('Wallet worker returned an invalid popup result.');
    }
    return value as WalletWorkerOpenPopupResult;
  }

  if (typeof value.requestUri !== 'string' || typeof value.callbackUrl !== 'string' ||
    typeof value.state !== 'string' || value.state.length === 0 || value.state.length > 256 ||
    value.authorizeStatus !== 200 || value.requestKeyZeroed !== true ||
    !Number.isSafeInteger(value.routePolicyRejections) || (value.routePolicyRejections as number) < 0) {
    throw new TypeError('Wallet worker returned an invalid relay result.');
  }
  validateRelayRequestUriForPrefetch(value.requestUri, relayOrigin);
  const callback = new URL(value.callbackUrl);
  if (callback.origin !== relayOrigin || callback.toString() !== `${relayOrigin}/connect/callback`) {
    throw new TypeError('Wallet worker returned a callback outside the configured relay.');
  }
  return value as unknown as WalletWorkerOpenRelayResult;
}
