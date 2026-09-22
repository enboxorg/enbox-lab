import type { ConnectResult } from '@enbox/connect';

import { connectViaPopup } from '@enbox/browser';

import {
  LAB_NOTE_WRITE_APP_NAME,
  LAB_NOTE_WRITE_PERMISSION_REQUEST,
} from '../../../runtime/agent-process/note-write-approval.js';

export type ApprovedDappState = {
  connectedDid?: string;
  delegateDid?: string;
  delegateGrantCount: number;
  delegateKeyCurves: string[];
  error?: string;
  sessionRevocationCount: number;
  status: 'idle' | 'running' | 'connected' | 'failed';
};

declare global {
  interface Window {
    enboxLabApprovedDapp: Readonly<{
      start(walletOrigin: string): void;
      state: ApprovedDappState;
    }>;
  }
}

const state: ApprovedDappState = {
  delegateGrantCount     : 0,
  delegateKeyCurves      : [],
  sessionRevocationCount : 0,
  status                 : 'idle',
};

function recordResult(result: ConnectResult): void {
  state.connectedDid = result.connectedDid;
  state.delegateDid = result.delegatePortableDid.uri;
  state.delegateGrantCount = result.delegateGrants.length;
  state.delegateKeyCurves = (result.delegatePortableDid.privateKeys ?? [])
    .flatMap((key): string[] => key.crv === undefined ? [] : [key.crv])
    .sort();
  state.sessionRevocationCount = result.sessionRevocations.length;
  state.status = 'connected';
}

async function connect(walletOrigin: string): Promise<void> {
  state.status = 'running';
  delete state.error;
  try {
    const result = await connectViaPopup({
      appName            : LAB_NOTE_WRITE_APP_NAME,
      permissionRequests : [LAB_NOTE_WRITE_PERMISSION_REQUEST],
      timeout            : 60_000,
      walletUrl          : walletOrigin,
    });
    if (result === undefined) { throw new Error('The wallet denied the declared approval fixture.'); }
    recordResult(result);
  } catch (error: unknown) {
    state.error = error instanceof Error ? error.message : String(error);
    state.status = 'failed';
  }
}

window.enboxLabApprovedDapp = Object.freeze({
  start(walletOrigin: string): void { void connect(walletOrigin); },
  state,
});
