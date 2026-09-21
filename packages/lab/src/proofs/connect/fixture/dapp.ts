import type { WalletUriHandoff } from '@enbox/connect';

import {
  connectViaPopup,
  DWEB_CONNECT_LOADED_MESSAGE_TYPE,
  DWEB_CONNECT_RESPONSE_MESSAGE_TYPE,
  RelayConnectCancelledError,
  runRelayConnect,
} from '@enbox/browser';

export type DappConnectStatus = 'idle' | 'running' | 'denied' | 'cancelled' | 'failed';

export type DappPopupState = {
  error?: string;
  status: DappConnectStatus;
  wrongWalletOriginIgnored: boolean;
  wrongWalletSourceIgnored: boolean;
};

export type DappRelayState = {
  claimed: number;
  error?: string;
  requestPinCalls: number;
  status: DappConnectStatus;
};

export type DappConnectState = {
  popup: DappPopupState;
  relay: DappRelayState;
};

export type StartRelayOptions = {
  connectServerUrl: string;
  mode: 'deny' | 'hold';
  walletUri: string;
};

export type EnboxLabConnectFixture = {
  cancelRelay(): void;
  startPopup(walletUrl: string): void;
  startRelay(options: StartRelayOptions): void;
  state: DappConnectState;
};

declare global {
  interface Window {
    enboxLabConnect: EnboxLabConnectFixture;
  }
}

type RelayCancellation = {
  cancelled(): boolean;
  promise: Promise<never>;
  reject(error: Error): void;
};

const state: DappConnectState = {
  popup : { status: 'idle', wrongWalletOriginIgnored: false, wrongWalletSourceIgnored: false },
  relay : { claimed: 0, requestPinCalls: 0, status: 'idle' },
};

let relayCancellation: RelayCancellation | undefined;
let relayGeneration = 0;
let relayWalletWindow: Window | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function armDappPopupProbes(walletOrigin: string): {
  disarm(): void;
  wrongOriginIgnored(): boolean;
  wrongSourceIgnored(): boolean;
} {
  let wrongOriginInjections = 0;
  let wrongSourceInjections = 0;
  const injectedTypes = new Set<string>();
  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== walletOrigin || event.source === null || event.source === window || !isRecord(event.data)) {
      return;
    }
    const type = event.data.type;
    if ((type !== DWEB_CONNECT_LOADED_MESSAGE_TYPE && type !== DWEB_CONNECT_RESPONSE_MESSAGE_TYPE) || injectedTypes.has(type)) {
      return;
    }
    injectedTypes.add(type);
    const forged = type === DWEB_CONNECT_RESPONSE_MESSAGE_TYPE
      ? { ...event.data, payload: 'FORGED-RESPONSE' }
      : event.data;
    window.dispatchEvent(new MessageEvent('message', {
      data   : forged,
      origin : 'https://wrong-wallet.invalid',
      source : event.source,
    }));
    wrongOriginInjections += 1;
    window.dispatchEvent(new MessageEvent('message', {
      data   : forged,
      origin : walletOrigin,
      source : window,
    }));
    wrongSourceInjections += 1;
  };
  window.addEventListener('message', onMessage, true);
  return {
    disarm             : (): void => { window.removeEventListener('message', onMessage, true); },
    wrongOriginIgnored : (): boolean => wrongOriginInjections === 2,
    wrongSourceIgnored : (): boolean => wrongSourceInjections === 2,
  };
}

function createRelayCancellation(): RelayCancellation {
  let cancelled = false;
  let rejectCancellation: ((error: Error) => void) | undefined;
  const promise = new Promise<never>((_resolve, reject): void => {
    rejectCancellation = reject;
  });

  // Cancellation can be requested before the relay runner reaches its race.
  // Mark the rejection handled here while preserving it for that later race.
  void promise.catch((): undefined => undefined);
  return {
    cancelled(): boolean { return cancelled; },
    promise,
    reject(error: Error): void {
      cancelled = true;
      rejectCancellation?.(error);
      rejectCancellation = undefined;
    },
  };
}

function walletUriForMode(handoff: WalletUriHandoff, mode: StartRelayOptions['mode']): string {
  const walletUri = new URL(handoff.walletUri);
  const fragment = new URLSearchParams(walletUri.hash.slice(1));
  fragment.set('lab_mode', mode);
  walletUri.hash = fragment.toString();
  return walletUri.toString();
}

async function runPopup(walletUrl: string): Promise<void> {
  const probes = armDappPopupProbes(new URL(walletUrl).origin);
  try {
    const result = await connectViaPopup({
      appName            : 'Enbox Lab denial fixture',
      permissionRequests : [],
      timeout            : 30_000,
      walletUrl,
    });
    state.popup = {
      status                   : result === undefined ? 'denied' : 'failed',
      wrongWalletOriginIgnored : probes.wrongOriginIgnored(),
      wrongWalletSourceIgnored : probes.wrongSourceIgnored(),
    };
    if (result !== undefined) {
      state.popup.error = 'The denial-only popup fixture unexpectedly received delegated credentials.';
    }
  } catch (error: unknown) {
    state.popup = {
      error                    : errorMessage(error),
      status                   : 'failed',
      wrongWalletOriginIgnored : probes.wrongOriginIgnored(),
      wrongWalletSourceIgnored : probes.wrongSourceIgnored(),
    };
  } finally {
    probes.disarm();
  }
}

async function runRelay(
  options: StartRelayOptions,
  cancellation: RelayCancellation,
  generation: number,
  walletWindow: Window,
): Promise<void> {
  try {
    const result = await runRelayConnect({
      appName          : 'Enbox Lab denial fixture',
      cancelled        : cancellation.promise,
      clientMetadata   : { origin: globalThis.location.origin },
      connectServerUrl : options.connectServerUrl,
      onClaimed        : (): void => {
        if (relayGeneration === generation) {
          state.relay.claimed += 1;
        }
      },
      onWalletUriReady: (handoff): void => {
        if (relayGeneration !== generation || cancellation.cancelled()) { return; }
        const walletUri = walletUriForMode(handoff, options.mode);
        walletWindow.location.assign(walletUri);
      },
      permissionRequests : [],
      pollIntervalMs     : 50,
      requestPin         : async (): Promise<string> => {
        state.relay.requestPinCalls += 1;
        throw new Error('The denial-only relay fixture must not request a pairing PIN.');
      },
      timeoutMs : 30_000,
      walletUri : options.walletUri,
    });

    if (relayGeneration !== generation) { return; }
    state.relay.status = result === undefined ? 'denied' : 'failed';
    if (result !== undefined) {
      state.relay.error = 'The denial-only relay fixture unexpectedly received delegated credentials.';
    }
  } catch (error: unknown) {
    if (relayGeneration !== generation) { return; }
    if (error instanceof RelayConnectCancelledError) {
      state.relay.status = 'cancelled';
      return;
    }
    state.relay.error = errorMessage(error);
    state.relay.status = 'failed';
  } finally {
    if (relayGeneration !== generation || state.relay.status === 'cancelled') {
      try { walletWindow.close(); } catch { /* best-effort cleanup */ }
    }
    if (relayCancellation === cancellation) {
      relayCancellation = undefined;
    }
    if (relayWalletWindow === walletWindow) {
      relayWalletWindow = undefined;
    }
  }
}

const fixture: EnboxLabConnectFixture = {
  cancelRelay(): void {
    relayCancellation?.reject(new RelayConnectCancelledError());
    try { relayWalletWindow?.close(); } catch { /* best-effort cleanup */ }
  },

  startPopup(walletUrl: string): void {
    state.popup = { status: 'running', wrongWalletOriginIgnored: false, wrongWalletSourceIgnored: false };
    void runPopup(walletUrl);
  },

  startRelay(options: StartRelayOptions): void {
    relayCancellation?.reject(new RelayConnectCancelledError());
    try { relayWalletWindow?.close(); } catch { /* best-effort cleanup */ }
    relayGeneration += 1;
    state.relay = { claimed: 0, requestPinCalls: 0, status: 'running' };
    const walletWindow = window.open('about:blank', '_blank');
    if (walletWindow === null) {
      state.relay = {
        claimed         : 0,
        error           : 'Enbox Lab relay wallet window was blocked.',
        requestPinCalls : 0,
        status          : 'failed',
      };
      return;
    }
    const cancellation = createRelayCancellation();
    relayCancellation = cancellation;
    relayWalletWindow = walletWindow;
    void runRelay(options, cancellation, relayGeneration, walletWindow);
  },

  state,
};

window.enboxLabConnect = fixture;
