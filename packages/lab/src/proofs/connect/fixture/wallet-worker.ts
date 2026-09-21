import type { ConnectRequest, FetchFn } from '@enbox/connect';
import type {
  ConnectWorkerBoundaryErrorCode,
  ConnectWorkerSessionHandle,
} from '../connect-worker-boundary.js';

import { REQUEST_KEY_BYTE_LENGTH } from '@enbox/connect';

import {
  ConnectWorkerBoundaryError,
  ConnectWorkerSessionRegistry,
  fetchBoundedRelayRequest,
  validateRelayRequestUriForPrefetch,
} from '../connect-worker-boundary.js';

export type WalletWorkerOpenPopupRequest = {
  dappOrigin: string;
  id: string;
  method: 'open-popup';
  request: ConnectRequest;
};

export type WalletWorkerOpenRelayRequest = {
  id: string;
  method: 'open-relay';
  requestKey: ArrayBuffer;
  requestUri: string;
};

export type WalletWorkerDenyRequest = {
  handle: ConnectWorkerSessionHandle;
  id: string;
  method: 'deny';
};

export type WalletWorkerRequest =
  | WalletWorkerOpenPopupRequest
  | WalletWorkerOpenRelayRequest
  | WalletWorkerDenyRequest;

export type WalletWorkerOpenPopupResult = {
  handle: ConnectWorkerSessionHandle;
  method: 'open-popup';
  originMismatchRejected: boolean;
  otherPrincipalRejected: boolean;
  permissionRequestCount: number;
};

export type WalletWorkerOpenRelayResult = {
  authorizeStatus: number;
  callbackUrl: string;
  handle: ConnectWorkerSessionHandle;
  method: 'open-relay';
  permissionRequestCount: number;
  requestKeyZeroed: boolean;
  requestUri: string;
  routePolicyRejections: number;
  state: string;
};

export type WalletWorkerDenyResult = {
  method: 'deny';
  token: string;
};

export type WalletWorkerResult =
  | WalletWorkerOpenPopupResult
  | WalletWorkerOpenRelayResult
  | WalletWorkerDenyResult;

export type WalletWorkerResponse =
  | { id: string; ok: true; result: WalletWorkerResult }
  | {
    error: {
      code?: ConnectWorkerBoundaryErrorCode;
      message: string;
      name: string;
    };
    id: string;
    ok: false;
  };

type WorkerScope = {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: WalletWorkerResponse): void;
};

declare const ENBOX_LAB_RELAY_ORIGIN: string;

const PRINCIPAL = Object.freeze({ principalId: 'enbox-lab/wallet/connect-worker' });
const OTHER_PRINCIPAL = Object.freeze({ principalId: 'enbox-lab/wallet/other-principal' });
const registry = new ConnectWorkerSessionRegistry();
const scope = globalThis as unknown as WorkerScope;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageId(value: unknown): string {
  return isRecord(value) && typeof value.id === 'string' ? value.id : '';
}

function validateWorkerRequest(value: unknown): WalletWorkerRequest {
  if (!isRecord(value) || typeof value.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.id)) {
    throw new ConnectWorkerBoundaryError('invalid-request', 'Wallet worker command must carry a canonical request ID.');
  }
  if (value.method === 'open-popup') {
    if (typeof value.dappOrigin !== 'string' || !isRecord(value.request)) {
      throw new ConnectWorkerBoundaryError('invalid-request', 'Wallet worker popup command is malformed.');
    }
    return value as WalletWorkerOpenPopupRequest;
  }
  if (value.method === 'open-relay') {
    if (typeof value.requestUri !== 'string' || !(value.requestKey instanceof ArrayBuffer) ||
      value.requestKey.byteLength !== REQUEST_KEY_BYTE_LENGTH) {
      throw new ConnectWorkerBoundaryError('invalid-request', 'Wallet worker relay command is malformed.');
    }
    return value as WalletWorkerOpenRelayRequest;
  }
  if (value.method === 'deny') {
    if (!isRecord(value.handle)) {
      throw new ConnectWorkerBoundaryError('invalid-request', 'Wallet worker denial command is malformed.');
    }
    return value as WalletWorkerDenyRequest;
  }
  throw new ConnectWorkerBoundaryError('invalid-request', 'Wallet worker command method is unsupported.');
}

function relayOrigin(): string {
  const origin = ENBOX_LAB_RELAY_ORIGIN;
  if (typeof origin !== 'string') {
    throw new ConnectWorkerBoundaryError('invalid-context', 'Wallet worker relay configuration is missing.');
  }
  return origin;
}

function expectBoundaryRejection(callback: () => unknown, code: ConnectWorkerBoundaryErrorCode): boolean {
  try {
    callback();
    return false;
  } catch (error: unknown) {
    return error instanceof ConnectWorkerBoundaryError && error.code === code;
  }
}

function routePolicyProbeUris(requestUri: string): string[] {
  const uri = new URL(requestUri);
  return [
    `https://attacker.invalid${uri.pathname}`,
    `${uri.origin}/connect/authorize/not-a-uuid.jwt`,
    `${requestUri}?redirect=https://attacker.invalid`,
    `${requestUri}#fragment-secret`,
    `${uri.protocol}//attacker@${uri.host}${uri.pathname}`,
  ];
}

function probeRoutePolicy(requestUri: string, relayOrigin: string): number {
  let rejections = 0;
  for (const candidate of routePolicyProbeUris(requestUri)) {
    if (expectBoundaryRejection(
      (): string => validateRelayRequestUriForPrefetch(candidate, relayOrigin),
      'invalid-channel',
    )) {
      rejections += 1;
    }
  }
  return rejections;
}

function openPopup(message: WalletWorkerOpenPopupRequest): WalletWorkerOpenPopupResult {
  const originMismatchRejected = expectBoundaryRejection(() => registry.bind({
    channel   : { dappOrigin: 'https://wrong-origin.invalid', kind: 'popup' },
    context   : PRINCIPAL,
    request   : message.request,
    transport : 'postMessage',
  }), 'invalid-channel');

  const bound = registry.bind({
    channel   : { dappOrigin: message.dappOrigin, kind: 'popup' },
    context   : PRINCIPAL,
    request   : message.request,
    transport : 'postMessage',
  });
  const otherPrincipalRejected = expectBoundaryRejection(
    (): string => registry.deny(OTHER_PRINCIPAL, bound.handle),
    'invalid-session',
  );

  return {
    handle                 : bound.handle,
    method                 : 'open-popup',
    originMismatchRejected,
    otherPrincipalRejected,
    permissionRequestCount : bound.request.permissionRequests.length,
  };
}

async function openRelay(message: WalletWorkerOpenRelayRequest): Promise<WalletWorkerOpenRelayResult> {
  if (!(message.requestKey instanceof ArrayBuffer) || message.requestKey.byteLength !== REQUEST_KEY_BYTE_LENGTH) {
    throw new ConnectWorkerBoundaryError(
      'invalid-request',
      `Relay worker request key must be a ${REQUEST_KEY_BYTE_LENGTH}-byte ArrayBuffer.`,
    );
  }
  const requestKey = new Uint8Array(message.requestKey);
  const configuredRelayOrigin = relayOrigin();
  let authorizeStatus: number | undefined;
  const noRedirectFetch: FetchFn = async (input, init): Promise<Response> => {
    const response = await globalThis.fetch(input, { ...init, redirect: 'error' });
    authorizeStatus = response.status;
    return response;
  };

  let result: Omit<WalletWorkerOpenRelayResult, 'requestKeyZeroed'>;
  try {
    const requestUri = validateRelayRequestUriForPrefetch(message.requestUri, configuredRelayOrigin);
    const routePolicyRejections = probeRoutePolicy(requestUri, configuredRelayOrigin);
    if (routePolicyRejections !== routePolicyProbeUris(requestUri).length) {
      throw new ConnectWorkerBoundaryError('invalid-channel', 'Relay worker route-policy probes did not all fail closed.');
    }
    const jwe = await fetchBoundedRelayRequest({
      fetchFn     : noRedirectFetch,
      relayOrigin : configuredRelayOrigin,
      requestUri,
    });
    const bound = await registry.openRelayRequest({
      context: PRINCIPAL,
      jwe,
      requestKey,
      requestUri,
    });
    if (bound.request.reply.mode !== 'direct_post') {
      throw new ConnectWorkerBoundaryError('invalid-channel', 'Relay worker received a non-relay reply descriptor.');
    }
    if (authorizeStatus === undefined) {
      throw new Error('Relay authorize fetch completed without an observable HTTP status.');
    }

    result = {
      authorizeStatus,
      callbackUrl            : bound.request.reply.callbackUrl,
      handle                 : bound.handle,
      method                 : 'open-relay',
      permissionRequestCount : bound.request.permissionRequests.length,
      requestUri,
      routePolicyRejections,
      state                  : bound.request.state,
    };
  } finally {
    requestKey.fill(0);
  }
  return {
    ...result,
    requestKeyZeroed: requestKey.every((byte): boolean => byte === 0),
  };
}

function deny(message: WalletWorkerDenyRequest): WalletWorkerDenyResult {
  return {
    method : 'deny',
    token  : registry.deny(PRINCIPAL, message.handle),
  };
}

async function dispatch(value: unknown): Promise<WalletWorkerResult> {
  const message = validateWorkerRequest(value);
  switch (message.method) {
    case 'open-popup':
      return openPopup(message);
    case 'open-relay':
      return await openRelay(message);
    case 'deny':
      return deny(message);
  }
}

function serializeError(error: unknown): WalletWorkerResponse & { ok: false } {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return {
    error: {
      ...(normalized instanceof ConnectWorkerBoundaryError ? { code: normalized.code } : {}),
      message : normalized.message,
      name    : normalized.name,
    },
    id : '',
    ok : false,
  };
}

scope.addEventListener('message', (event): void => {
  const id = messageId(event.data);
  void dispatch(event.data).then(
    (result): void => {
      scope.postMessage({ id, ok: true, result });
    },
    (error: unknown): void => {
      scope.postMessage({ ...serializeError(error), id });
    },
  );
});
