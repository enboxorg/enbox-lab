import type { ConnectRequest, FetchFn } from '@enbox/connect';
import type { ConnectWorkerBoundaryErrorCode, ConnectWorkerSessionHandle } from '../connect-worker-boundary.js';
import type {
  WalletWorkerDenyResult,
  WalletWorkerOpenPopupResult,
  WalletWorkerOpenRelayResult,
  WalletWorkerRequest,
  WalletWorkerResult,
} from './wallet-worker.js';

import {
  DWEB_CONNECT_REQUEST_MESSAGE_TYPE,
  WalletPostMessageTransport,
} from '@enbox/browser';
import { parseWalletConnectUri, postRelayResponse } from '@enbox/connect';

import { CONNECT_WORKER_MAX_JWE_BYTES } from '../connect-worker-boundary.js';
import { validateWalletWorkerResult } from './wallet-rpc-validation.js';

export type EnboxLabWalletConfig = {
  dappOrigin: string;
  relayOrigin: string;
  workerUrl: string;
};

export type WalletPageStatus = 'idle' | 'running' | 'holding' | 'denied' | 'failed';

export type WalletPopupState = {
  error?: string;
  oldHandleRejectedAfterRestart: boolean;
  originMismatchRejected: boolean;
  otherPrincipalRejected: boolean;
  oversizedEnvelopeRejected: boolean;
  permissionRequestCount: number;
  status: WalletPageStatus;
  wrongOriginIgnored: boolean;
  wrongSourceIgnored: boolean;
};

export type WalletRelayState = {
  authorizeStatus?: number;
  callbackStatus?: number;
  error?: string;
  malformedCommandsRejected: boolean;
  permissionRequestCount: number;
  requestKeyZeroed: boolean;
  requestUri?: string;
  routePolicyRejections: number;
  status: WalletPageStatus;
  tokenState?: string;
};

export type EnboxLabWalletState = {
  popup: WalletPopupState;
  relay: WalletRelayState;
};

export type EnboxLabWalletFixture = {
  denyActiveRelay(): Promise<void>;
  restartWorkerAndRejectOldHandle(): Promise<void>;
  state: EnboxLabWalletState;
};

declare global {
  interface Window {
    enboxLabConfig?: EnboxLabWalletConfig;
    enboxLabWallet: EnboxLabWalletFixture;
  }
}

type PendingRpc = {
  expectedMethod?: WalletWorkerResult['method'];
  reject(error: Error): void;
  resolve(result: WalletWorkerResult): void;
  timeoutId: ReturnType<typeof setTimeout>;
};

const WORKER_RPC_TIMEOUT_MS = 5_000;

class WalletWorkerRpcError extends Error {
  public constructor(message: string, public readonly code?: ConnectWorkerBoundaryErrorCode) {
    super(message);
    this.name = 'WalletWorkerRpcError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class WalletWorkerRpc {
  private readonly _pending = new Map<string, PendingRpc>();
  private _worker: Worker;

  public constructor(private readonly _workerUrl: string, private readonly _relayOrigin: string) {
    this._worker = this.createWorker();
  }

  public deny(handle: ConnectWorkerSessionHandle): Promise<WalletWorkerDenyResult> {
    return this.call<WalletWorkerDenyResult>({ handle, id: crypto.randomUUID(), method: 'deny' });
  }

  public openPopup(request: ConnectRequest, dappOrigin: string): Promise<WalletWorkerOpenPopupResult> {
    return this.call<WalletWorkerOpenPopupResult>({
      dappOrigin,
      id     : crypto.randomUUID(),
      method : 'open-popup',
      request,
    });
  }

  public openRelay(
    requestUri: string,
    requestKey: ArrayBuffer,
  ): Promise<WalletWorkerOpenRelayResult> {
    return this.call<WalletWorkerOpenRelayResult>({
      id     : crypto.randomUUID(),
      method : 'open-relay',
      requestKey,
      requestUri,
    }, [requestKey]);
  }

  public async probeMalformedCommands(): Promise<boolean> {
    const commands: Array<Record<string, unknown>> = [
      {
        id         : crypto.randomUUID(),
        method     : 'open-relay',
        requestKey : Number.MAX_SAFE_INTEGER,
        requestUri : 'https://attacker.invalid/connect/authorize/550e8400-e29b-41d4-a716-446655440000.jwt',
      },
      { id: crypto.randomUUID(), method: 'unsupported' },
    ];
    for (const command of commands) {
      try {
        await this.callRaw(command.id as string, command);
        return false;
      } catch (error: unknown) {
        if (!(error instanceof WalletWorkerRpcError) || error.code !== 'invalid-request') {
          throw error;
        }
      }
    }
    return true;
  }

  public restart(): void {
    this._worker.terminate();
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new WalletWorkerRpcError('Wallet worker restarted before completing its request.'));
    }
    this._pending.clear();
    this._worker = this.createWorker();
  }

  private call<TResult extends WalletWorkerResult>(request: WalletWorkerRequest, transfer: Transferable[] = []): Promise<TResult> {
    return this.callRaw<TResult>(request.id, request, transfer, request.method);
  }

  private callRaw<TResult extends WalletWorkerResult>(
    id: string,
    request: unknown,
    transfer: Transferable[] = [],
    expectedMethod?: WalletWorkerResult['method'],
  ): Promise<TResult> {
    return new Promise<TResult>((resolve, reject): void => {
      const timeoutId = setTimeout((): void => {
        this._pending.delete(id);
        reject(new WalletWorkerRpcError(`Wallet worker RPC timed out after ${WORKER_RPC_TIMEOUT_MS} milliseconds.`));
      }, WORKER_RPC_TIMEOUT_MS);
      this._pending.set(id, {
        ...(expectedMethod === undefined ? {} : { expectedMethod }),
        reject,
        resolve: (result): void => { resolve(result as TResult); },
        timeoutId,
      });
      try {
        this._worker.postMessage(request, transfer);
      } catch (error: unknown) {
        this._pending.delete(id);
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  private createWorker(): Worker {
    const worker = new Worker(this._workerUrl, { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<unknown>): void => {
      const response = event.data;
      if (!isRecord(response) || typeof response.id !== 'string') { return; }
      const pending = this._pending.get(response.id);
      if (pending === undefined) { return; }
      this._pending.delete(response.id);
      clearTimeout(pending.timeoutId);
      try {
        if (response.ok === true) {
          pending.resolve(validateWalletWorkerResult(response.result, pending.expectedMethod, this._relayOrigin));
          return;
        }
        if (response.ok === false && isRecord(response.error) && typeof response.error.message === 'string') {
          const code = typeof response.error.code === 'string'
            ? response.error.code as ConnectWorkerBoundaryErrorCode
            : undefined;
          pending.reject(new WalletWorkerRpcError(response.error.message, code));
          return;
        }
        pending.reject(new WalletWorkerRpcError('Wallet worker returned a malformed RPC response.'));
      } catch (error: unknown) {
        pending.reject(error instanceof Error ? error : new WalletWorkerRpcError(String(error)));
      }
    });
    worker.addEventListener('error', (event): void => {
      const error = new WalletWorkerRpcError(event.message || 'Wallet worker stopped unexpectedly.');
      for (const pending of this._pending.values()) {
        clearTimeout(pending.timeoutId);
        pending.reject(error);
      }
      this._pending.clear();
    });
    return worker;
  }

}

const state: EnboxLabWalletState = {
  popup: {
    oldHandleRejectedAfterRestart : false,
    originMismatchRejected        : false,
    otherPrincipalRejected        : false,
    oversizedEnvelopeRejected     : false,
    permissionRequestCount        : 0,
    status                        : 'idle',
    wrongOriginIgnored            : false,
    wrongSourceIgnored            : false,
  },
  relay: {
    malformedCommandsRejected : false,
    permissionRequestCount    : 0,
    requestKeyZeroed          : false,
    routePolicyRejections     : 0,
    status                    : 'idle',
  },
};

let activeHandle: ConnectWorkerSessionHandle | undefined;
let activeRelay: WalletWorkerOpenRelayResult | undefined;
let workerRpc: WalletWorkerRpc | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredConfig(): EnboxLabWalletConfig {
  const config = window.enboxLabConfig;
  if (config === undefined) {
    throw new Error('Enbox Lab wallet fixture configuration is missing.');
  }
  return config;
}

function rpc(): WalletWorkerRpc {
  if (workerRpc === undefined) {
    const config = requiredConfig();
    workerRpc = new WalletWorkerRpc(config.workerUrl, config.relayOrigin);
  }
  return workerRpc;
}

function isConnectRequestMessage(data: unknown): data is { jwe: string; type: string } {
  return typeof data === 'object' && data !== null &&
    Reflect.get(data, 'type') === DWEB_CONNECT_REQUEST_MESSAGE_TYPE &&
    typeof Reflect.get(data, 'jwe') === 'string';
}

function tamperCompactJwe(jwe: string): string {
  const segments = jwe.split('.');
  const tagIndex = segments.length - 1;
  const tag = segments[tagIndex];
  if (tag === undefined || tag.length === 0) {
    return `${jwe}invalid`;
  }
  const changedCharacter = tag[0] === 'A' ? 'B' : 'A';
  segments[tagIndex] = `${changedCharacter}${tag.slice(1)}`;
  return segments.join('.');
}

type ArmedPopupMessageProbes = {
  disarm(): void;
  injected(): boolean;
};

function armPopupEnvelopeGuard(dappOrigin: string, dappWindow: Window): {
  disarm(): void;
  rejected(): boolean;
} {
  let rejected = false;
  const encoder = new TextEncoder();
  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== dappOrigin || event.source !== dappWindow || !isConnectRequestMessage(event.data)) {
      return;
    }
    if (event.data.jwe.length > CONNECT_WORKER_MAX_JWE_BYTES ||
      encoder.encode(event.data.jwe).byteLength > CONNECT_WORKER_MAX_JWE_BYTES) {
      rejected = true;
      event.stopImmediatePropagation();
    }
  };
  window.addEventListener('message', onMessage, true);
  return {
    disarm   : (): void => { window.removeEventListener('message', onMessage, true); },
    rejected : (): boolean => rejected,
  };
}

function armPopupMessageProbes(dappOrigin: string, dappWindow: Window): ArmedPopupMessageProbes {
  let injected = false;
  const onMessage = (event: MessageEvent): void => {
    if (injected || event.origin !== dappOrigin || event.source !== dappWindow || !isConnectRequestMessage(event.data)) {
      return;
    }
    injected = true;
    const tamperedData = { ...event.data, jwe: tamperCompactJwe(event.data.jwe) };
    window.dispatchEvent(new MessageEvent('message', {
      data   : tamperedData,
      origin : 'https://wrong-origin.invalid',
      source : dappWindow,
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data   : tamperedData,
      origin : dappOrigin,
      source : window,
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data   : { ...event.data, jwe: 'x'.repeat(CONNECT_WORKER_MAX_JWE_BYTES + 1) },
      origin : dappOrigin,
      source : dappWindow,
    }));
    window.removeEventListener('message', onMessage, true);
  };
  window.addEventListener('message', onMessage, true);
  return {
    disarm(): void { window.removeEventListener('message', onMessage, true); },
    injected(): boolean { return injected; },
  };
}

async function restartWorkerAndRejectOldHandle(): Promise<void> {
  if (activeHandle === undefined) {
    throw new Error('Enbox Lab wallet fixture has no worker handle to invalidate.');
  }
  const oldHandle = activeHandle;
  rpc().restart();
  try {
    await rpc().deny(oldHandle);
    throw new Error('Restarted wallet worker accepted a handle from the previous worker.');
  } catch (error: unknown) {
    if (!(error instanceof WalletWorkerRpcError) || error.code !== 'invalid-session') {
      throw error;
    }
    state.popup.oldHandleRejectedAfterRestart = true;
  }
}

async function runPopupWallet(): Promise<void> {
  state.popup.status = 'running';
  let transport: WalletPostMessageTransport | undefined;
  let envelopeGuard: ReturnType<typeof armPopupEnvelopeGuard> | undefined;
  let probes: ArmedPopupMessageProbes | undefined;
  try {
    const config = requiredConfig();
    const dappWindow = window.opener;
    if (dappWindow === null) {
      throw new Error('Enbox Lab popup wallet has no opener window.');
    }
    envelopeGuard = armPopupEnvelopeGuard(config.dappOrigin, dappWindow);
    probes = armPopupMessageProbes(config.dappOrigin, dappWindow);
    transport = await WalletPostMessageTransport.create({
      dappOrigin : config.dappOrigin,
      dappWindow,
      timeoutMs  : 30_000,
    });
    const request = await transport.awaitRequest();
    state.popup.wrongOriginIgnored = probes.injected();
    state.popup.wrongSourceIgnored = probes.injected();
    const first = await rpc().openPopup(request, transport.dappOrigin);
    activeHandle = first.handle;
    state.popup.originMismatchRejected = first.originMismatchRejected;
    state.popup.otherPrincipalRejected = first.otherPrincipalRejected;
    state.popup.oversizedEnvelopeRejected = envelopeGuard.rejected();
    state.popup.permissionRequestCount = first.permissionRequestCount;

    await restartWorkerAndRejectOldHandle();
    const rebound = await rpc().openPopup(request, transport.dappOrigin);
    activeHandle = rebound.handle;
    const denial = await rpc().deny(rebound.handle);
    transport.sendResponse(denial.token);
    state.popup.status = 'denied';
  } catch (error: unknown) {
    transport?.close();
    state.popup.error = errorMessage(error);
    state.popup.status = 'failed';
  } finally {
    envelopeGuard?.disarm();
    probes?.disarm();
  }
}

async function runRelayWallet(): Promise<void> {
  state.relay.status = 'running';
  try {
    state.relay.malformedCommandsRejected = await rpc().probeMalformedCommands();
    if (!state.relay.malformedCommandsRejected) {
      throw new Error('Wallet worker accepted a malformed RPC command.');
    }
    const parsed = parseWalletConnectUri(globalThis.location.href);
    if (parsed === undefined) {
      throw new Error('Enbox Lab relay wallet URI has no valid fragment request.');
    }
    const fragment = new URLSearchParams(globalThis.location.hash.slice(1));
    const mode = fragment.get('lab_mode') === 'hold' ? 'hold' : 'deny';
    globalThis.history.replaceState(null, '', `${globalThis.location.pathname}${globalThis.location.search}`);

    const requestKey = Uint8Array.from(parsed.encryptionKey);
    parsed.encryptionKey.fill(0);
    const opened = await rpc().openRelay(
      parsed.requestUri,
      requestKey.buffer as ArrayBuffer,
    );
    activeRelay = opened;
    activeHandle = opened.handle;
    state.relay.authorizeStatus = opened.authorizeStatus;
    state.relay.permissionRequestCount = opened.permissionRequestCount;
    state.relay.requestKeyZeroed = opened.requestKeyZeroed;
    state.relay.requestUri = opened.requestUri;
    state.relay.routePolicyRejections = opened.routePolicyRejections;
    state.relay.tokenState = opened.state;

    if (mode === 'hold') {
      state.relay.status = 'holding';
      return;
    }

    await denyActiveRelay();
  } catch (error: unknown) {
    state.relay.error = errorMessage(error);
    state.relay.status = 'failed';
  }
}

async function denyActiveRelay(): Promise<void> {
  const opened = activeRelay;
  if (opened === undefined) {
    throw new Error('Enbox Lab wallet fixture has no active relay request to deny.');
  }
  try {
    const denial = await rpc().deny(opened.handle);
    const observingFetch: FetchFn = async (input, init): Promise<Response> => {
      const response = await globalThis.fetch(input, { ...init, redirect: 'error' });
      state.relay.callbackStatus = response.status;
      return response;
    };
    await postRelayResponse({
      callbackUrl : opened.callbackUrl,
      fetchFn     : observingFetch,
      idToken     : denial.token,
      state       : opened.state,
    });
    state.relay.status = 'denied';
  } finally {
    activeRelay = undefined;
  }
}

window.enboxLabWallet = {
  denyActiveRelay,
  restartWorkerAndRejectOldHandle,
  state,
};

if (globalThis.location.pathname.endsWith('/dweb-connect')) {
  void runPopupWallet();
} else if (globalThis.location.pathname.endsWith('/relay-connect')) {
  void runRelayWallet();
}
