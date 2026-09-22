import type { ConnectRequest } from '@enbox/connect';
import type { ConnectWorkerSessionHandle } from '../connect-worker-boundary.js';
import type { PopupApprovalBridgeBootstrap } from '../../../runtime/popup-approval-bridge.js';

import { WalletPostMessageTransport } from '@enbox/browser';

export type ApprovedWalletConfig = PopupApprovalBridgeBootstrap & Readonly<{
  dappOrigin: string;
}>;

export type ApprovedWalletState = {
  acknowledged: boolean;
  appName?: string;
  bridgeApproveStatus?: number;
  bridgeBindStatus?: number;
  error?: string;
  permissionRequestCount: number;
  status: 'starting' | 'awaiting-approval' | 'approving' | 'approved' | 'failed';
};

declare global {
  interface Window {
    enboxLabApprovedWallet: Readonly<{
      approve(): Promise<void>;
      state: ApprovedWalletState;
    }>;
    enboxLabApprovedWalletConfig?: ApprovedWalletConfig;
  }
}

type BoundResponse = Readonly<{
  ok: true;
  result: Readonly<{
    handle: ConnectWorkerSessionHandle;
    request: ConnectRequest;
  }>;
}>;

type ApprovedResponse = Readonly<{
  ok: true;
  result: Readonly<{ idToken: string }>;
}>;

const state: ApprovedWalletState = {
  acknowledged           : false,
  permissionRequestCount : 0,
  status                 : 'starting',
};

let handle: ConnectWorkerSessionHandle | undefined;
let transport: WalletPostMessageTransport | undefined;

function config(): ApprovedWalletConfig {
  const value = window.enboxLabApprovedWalletConfig;
  if (value === undefined) { throw new Error('Approved wallet bootstrap is missing.'); }
  return value;
}

async function bridgePost(path: string, body: unknown): Promise<Response> {
  const bootstrap = config();
  return fetch(path, {
    body    : JSON.stringify(body),
    headers : {
      'Content-Type'            : 'application/json',
      [bootstrap.sessionHeader] : bootstrap.sessionCapability,
    },
    method   : 'POST',
    redirect : 'error',
  });
}

async function initialize(): Promise<void> {
  try {
    const bootstrap = config();
    transport = await WalletPostMessageTransport.create({
      dappOrigin : bootstrap.dappOrigin,
      timeoutMs  : 60_000,
    });
    const request = await transport.awaitRequest();
    const response = await bridgePost(bootstrap.bindPath, { request });
    state.bridgeBindStatus = response.status;
    if (!response.ok) { throw new Error(`Approval bridge bind returned HTTP ${response.status}.`); }
    const bound = await response.json() as BoundResponse;
    if (bound.ok !== true || bound.result.request.state !== request.state) {
      throw new Error('Approval bridge returned a mismatched request snapshot.');
    }
    handle = bound.result.handle;
    state.appName = bound.result.request.appName;
    state.permissionRequestCount = bound.result.request.permissionRequests.length;
    state.status = 'awaiting-approval';
  } catch (error: unknown) {
    state.error = error instanceof Error ? error.message : String(error);
    state.status = 'failed';
    transport?.close();
  }
}

async function approve(): Promise<void> {
  if (state.status !== 'awaiting-approval' || handle === undefined || transport === undefined) {
    throw new Error('Approved wallet has no pending consent request.');
  }
  state.status = 'approving';
  try {
    const response = await bridgePost(config().approvePath, { handle });
    state.bridgeApproveStatus = response.status;
    if (!response.ok) { throw new Error(`Approval bridge returned HTTP ${response.status}.`); }
    const approved = await response.json() as ApprovedResponse;
    if (approved.ok !== true || typeof approved.result.idToken !== 'string') {
      throw new Error('Approval bridge returned an invalid sealed response.');
    }
    state.acknowledged = await transport.sendResponseAwaitingAck(approved.result.idToken, { timeoutMs: 10_000 });
    state.status = 'approved';
  } catch (error: unknown) {
    state.error = error instanceof Error ? error.message : String(error);
    state.status = 'failed';
    transport.close();
  }
}

window.enboxLabApprovedWallet = Object.freeze({ approve, state });
document.querySelector<HTMLButtonElement>('#approve')?.addEventListener('click', (): void => { void approve(); });
void initialize();
