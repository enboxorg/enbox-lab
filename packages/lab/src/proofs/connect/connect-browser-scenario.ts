import type { Server } from 'bun';
import type { Browser, BrowserContext, Page, Request as PlaywrightRequest, Response as PlaywrightResponse } from 'playwright';
import type { BrowserConnectObservation, BrowserConnectScenarioOutcome } from './connect-browser-types.js';
import type { DappConnectState, StartRelayOptions } from './fixture/dapp.js';
import type { EnboxLabWalletConfig, EnboxLabWalletState } from './fixture/wallet-page.js';

import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { chromium } from 'playwright';

import { ConnectRelayRuntime } from './connect-relay-runtime.js';
import { basename, dirname, join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

type BrowserBundles = {
  dapp: string;
  walletPage: string;
  walletWorker: string;
};

type FixtureOrigin = {
  origin: string;
  stop(): Promise<void>;
};

type NetworkRequestObservation = { method: string; url: string };

const SCENARIO_TIMEOUT_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve): void => { setTimeout(resolve, milliseconds); });
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject): void => {
    timeoutId = setTimeout((): void => { reject(new Error(`${label} timed out after ${timeoutMs} milliseconds.`)); }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function fixtureEntry(name: 'dapp' | 'wallet-page' | 'wallet-worker'): string {
  const currentPath = fileURLToPath(import.meta.url);
  const extension = currentPath.endsWith('.ts') ? 'ts' : 'js';
  return join(dirname(currentPath), 'fixture', `${name}.${extension}`);
}

async function buildBrowserBundles(directory: string, relayOrigin: string): Promise<BrowserBundles> {
  const outputDirectory = join(directory, 'browser');
  await mkdir(outputDirectory, { recursive: true });
  const result = await Bun.build({
    entrypoints : [fixtureEntry('dapp'), fixtureEntry('wallet-page'), fixtureEntry('wallet-worker')],
    define      : { ENBOX_LAB_RELAY_ORIGIN: JSON.stringify(relayOrigin) },
    format      : 'esm',
    minify      : true,
    outdir      : outputDirectory,
    sourcemap   : 'none',
    splitting   : false,
    target      : 'browser',
  });
  if (!result.success) {
    throw new Error(`Browser connect fixture build failed: ${result.logs.map(String).join('; ')}`);
  }

  const outputs = new Map(result.outputs.map((output): [string, string] => [basename(output.path), output.path]));
  const dapp = outputs.get('dapp.js');
  const walletPage = outputs.get('wallet-page.js');
  const walletWorker = outputs.get('wallet-worker.js');
  if (dapp === undefined || walletPage === undefined || walletWorker === undefined) {
    throw new Error(`Browser connect fixture build omitted an entry: ${JSON.stringify([...outputs.keys()].sort())}`);
  }
  return { dapp, walletPage, walletWorker };
}

function scriptResponse(path: string): Response {
  return new Response(Bun.file(path), {
    headers: {
      'Cache-Control' : 'no-store',
      'Content-Type'  : 'text/javascript; charset=utf-8',
    },
  });
}

function startOrigin(fetch: (request: Request) => Response | Promise<Response>): { origin: string; server: Server<undefined> } {
  const server = Bun.serve({ fetch, hostname: '127.0.0.1', port: 0 });
  return { origin: `http://localhost:${server.port}`, server };
}

function fixtureOrigin(origin: string, server: Server<undefined>): FixtureOrigin {
  return {
    origin,
    stop: async (): Promise<void> => {
      await server.stop(true);
      const port = Number(new URL(origin).port);
      await new Promise<void>((resolvePromise, reject): void => {
        const socket = createConnection({ host: '127.0.0.1', port });
        const timeoutId = setTimeout((): void => {
          socket.destroy();
          reject(new Error(`Fixture origin ${origin} port-close probe timed out.`));
        }, 1_000);
        socket.once('connect', (): void => {
          clearTimeout(timeoutId);
          socket.destroy();
          reject(new Error(`Fixture origin ${origin} remained bound after stop().`));
        });
        socket.once('error', (error): void => {
          clearTimeout(timeoutId);
          socket.destroy();
          if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
            resolvePromise();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}

function startDappOrigin(bundlePath: string): FixtureOrigin {
  const started = startOrigin((request): Response => {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/dapp.js') {
      return scriptResponse(bundlePath);
    }
    if (pathname === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }
    if (pathname === '/') {
      return new Response(`<!doctype html>
<meta charset="utf-8">
<title>Enbox Lab connect dapp</title>
<button id="popup-connect" type="button">Popup connect</button>
<button id="relay-connect" type="button">Relay connect</button>
<script type="module" src="/dapp.js"></script>`, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    return new Response('not found', { status: 404 });
  });
  return fixtureOrigin(started.origin, started.server);
}

function startWalletOrigin(bundles: BrowserBundles, config: Omit<EnboxLabWalletConfig, 'workerUrl'>): FixtureOrigin {
  const started = startOrigin((request): Response => {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/wallet-page.js') {
      return scriptResponse(bundles.walletPage);
    }
    if (pathname === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }
    if (pathname === '/wallet-worker.js') {
      return scriptResponse(bundles.walletWorker);
    }
    if (pathname === '/dweb-connect' || pathname === '/relay-connect') {
      const injectedConfig: EnboxLabWalletConfig = {
        dappOrigin  : config.dappOrigin,
        relayOrigin : config.relayOrigin,
        workerUrl   : '/wallet-worker.js',
      };
      return new Response(`<!doctype html>
<meta charset="utf-8">
<title>Enbox Lab connect wallet</title>
<script>window.enboxLabConfig = Object.freeze(${JSON.stringify(injectedConfig)});</script>
<script type="module" src="/wallet-page.js"></script>`, {
        headers: {
          'Cache-Control'   : 'no-store',
          'Content-Type'    : 'text/html; charset=utf-8',
          'Referrer-Policy' : 'strict-origin',
        },
      });
    }
    return new Response('not found', { status: 404 });
  });
  return fixtureOrigin(started.origin, started.server);
}

async function readDappState(page: Page): Promise<DappConnectState> {
  return page.evaluate((): DappConnectState => structuredClone(window.enboxLabConnect.state));
}

async function readWalletState(page: Page): Promise<EnboxLabWalletState> {
  return page.evaluate((): EnboxLabWalletState => structuredClone(window.enboxLabWallet.state));
}

async function waitForDapp(page: Page, channel: 'popup' | 'relay', statuses: string[]): Promise<void> {
  await page.waitForFunction(({ channel: selected, statuses: expected }): boolean => {
    return expected.includes(window.enboxLabConnect.state[selected].status);
  }, { channel, statuses }, { timeout: SCENARIO_TIMEOUT_MS });
}

async function waitForWallet(page: Page, channel: 'popup' | 'relay', statuses: string[]): Promise<void> {
  await page.waitForFunction(({ channel: selected, statuses: expected }): boolean => {
    return expected.includes(window.enboxLabWallet.state[selected].status);
  }, { channel, statuses }, { timeout: SCENARIO_TIMEOUT_MS });
}

async function waitForFixture(page: Page, fixture: 'dapp' | 'wallet'): Promise<void> {
  await page.waitForFunction((selected): boolean => selected === 'dapp'
    ? window.enboxLabConnect !== undefined
    : window.enboxLabWallet !== undefined, fixture, { timeout: SCENARIO_TIMEOUT_MS });
}

async function triggerPopup(page: Page, walletOrigin: string): Promise<void> {
  await page.evaluate((origin): void => {
    const button = document.querySelector<HTMLButtonElement>('#popup-connect');
    if (button === null) { throw new Error('Popup connect button is missing.'); }
    button.onclick = (): void => { window.enboxLabConnect.startPopup(origin); };
  }, walletOrigin);
  await page.click('#popup-connect');
}

async function triggerRelay(page: Page, options: StartRelayOptions): Promise<void> {
  await page.evaluate((relayOptions): void => {
    const button = document.querySelector<HTMLButtonElement>('#relay-connect');
    if (button === null) { throw new Error('Relay connect button is missing.'); }
    button.onclick = (): void => { window.enboxLabConnect.startRelay(relayOptions); };
  }, options);
  await page.click('#relay-connect');
}

async function waitForWalletPage(context: BrowserContext, trigger: () => Promise<void>, expectedOrigin: string): Promise<{
  diagnostics: string[];
  navigationUrls: string[];
  page: Page;
}> {
  const opened = context.waitForEvent('page', { timeout: SCENARIO_TIMEOUT_MS });
  await trigger();
  const page = await opened;
  const diagnostics: string[] = [];
  page.on('console', (message): void => {
    if (message.type() === 'error' || message.type() === 'warning') {
      diagnostics.push(`${message.type()}: ${message.text()}`.slice(0, 1_024));
    }
  });
  page.on('pageerror', (error): void => { diagnostics.push(`pageerror: ${error.message}`.slice(0, 1_024)); });
  page.on('response', (response): void => {
    if (response.status() >= 400) {
      diagnostics.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`);
    }
  });
  const navigationUrls = [page.url()];
  page.on('framenavigated', (frame): void => {
    if (frame === page.mainFrame()) {
      navigationUrls.push(frame.url());
    }
  });
  await page.waitForURL((url): boolean => url.origin === expectedOrigin, { timeout: SCENARIO_TIMEOUT_MS });
  await waitForFixture(page, 'wallet');
  return { diagnostics, navigationUrls, page };
}

function recordNetwork(
  context: BrowserContext,
  relayOrigin: string,
  networkRequests: NetworkRequestObservation[],
  tokenResponses: Array<{ status: number; url: string }>,
): void {
  context.on('request', (request: PlaywrightRequest): void => {
    networkRequests.push({ method: request.method(), url: request.url() });
  });
  context.on('response', (response: PlaywrightResponse): void => {
    const url = new URL(response.url());
    if (url.origin === relayOrigin && url.pathname.startsWith('/connect/token/')) {
      tokenResponses.push({ status: response.status(), url: response.url() });
    }
  });
}

async function waitForCondition(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) { return; }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForRequestQuiescence(counter: () => number, quietMs = 200, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let lastCount = counter();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await delay(25);
    const currentCount = counter();
    if (currentCount !== lastCount) {
      lastCount = currentCount;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return true;
    }
  }
  return false;
}

function assertCompleted(status: string, error: string | undefined, expected: string, label: string): void {
  if (status !== expected) {
    throw new Error(`${label} ended as '${status}': ${error ?? 'no error detail'}`);
  }
}

function isExpectedRelayRoute(url: URL): boolean {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const token = '[A-Za-z0-9_-]{16,256}';
  const route = new RegExp(
    `^/connect/(?:par|callback|authorize/${uuid}\\.jwt|status/${uuid}|token/${token}\\.jwt)$`,
    'u',
  );
  return url.username === '' && url.password === '' && url.search === '' && url.hash === '' && route.test(url.pathname);
}

function isExpectedRelayRequest(request: NetworkRequestObservation): boolean {
  const url = new URL(request.url);
  if (!isExpectedRelayRoute(url)) { return false; }
  if (url.pathname === '/connect/par' || url.pathname === '/connect/callback') {
    return request.method === 'POST' || request.method === 'OPTIONS';
  }
  return request.method === 'GET';
}

function networkContainsValue(urls: readonly string[], value: string): boolean {
  return urls.some((url): boolean => url.includes(value));
}

async function runBrowserFlows(params: {
  browser: Browser;
  dappOrigin: string;
  executablePath: string;
  relayOrigin: string;
  relayRuntimeIsolated: boolean;
  relayServerVersion: string;
  walletOrigin: string;
}): Promise<BrowserConnectObservation> {
  const context = await params.browser.newContext();
  const networkRequests: NetworkRequestObservation[] = [];
  const tokenResponses: Array<{ status: number; url: string }> = [];
  let oldHandleRejectedAfterRestart = false;
  recordNetwork(context, params.relayOrigin, networkRequests, tokenResponses);
  const dapp = await context.newPage();
  await dapp.goto(params.dappOrigin, { waitUntil: 'domcontentloaded' });
  await waitForFixture(dapp, 'dapp');

  const { diagnostics: popupDiagnostics, page: popupWallet } = await waitForWalletPage(
    context,
    (): Promise<void> => triggerPopup(dapp, params.walletOrigin),
    params.walletOrigin,
  );
  await waitForWallet(popupWallet, 'popup', ['denied', 'failed']);
  const popupWalletState = await readWalletState(popupWallet);
  assertCompleted(
    popupWalletState.popup.status,
    [popupWalletState.popup.error, ...popupDiagnostics].filter(Boolean).join('; ') || undefined,
    'denied',
    'Popup wallet',
  );
  await waitForDapp(dapp, 'popup', ['denied', 'failed']);
  const popupDappState = await readDappState(dapp);
  assertCompleted(popupDappState.popup.status, popupDappState.popup.error, 'denied', 'Popup dapp');
  await popupWallet.close();

  const { page: heldWallet } = await waitForWalletPage(
    context,
    (): Promise<void> => triggerRelay(dapp, {
      connectServerUrl : `${params.relayOrigin}/connect`,
      mode             : 'hold',
      walletUri        : `${params.walletOrigin}/relay-connect`,
    }),
    params.walletOrigin,
  );
  await waitForWallet(heldWallet, 'relay', ['holding', 'failed']);
  const heldState = await readWalletState(heldWallet);
  assertCompleted(heldState.relay.status, heldState.relay.error, 'holding', 'Held relay wallet');
  if (heldState.relay.tokenState === undefined || heldState.relay.requestUri === undefined) {
    throw new Error('Held relay wallet did not retain its transient request URI and token state.');
  }
  const heldTokenUrl = `${params.relayOrigin}/connect/token/${encodeURIComponent(heldState.relay.tokenState)}.jwt`;
  const heldTokenRequestCount = (): number => networkRequests.filter((request): boolean => request.url === heldTokenUrl).length;
  await waitForCondition(
    (): boolean => tokenResponses.some((response): boolean => response.url === heldTokenUrl && response.status === 204),
    'the held relay client to observe a pending token response',
  );
  if (heldTokenRequestCount() < 1) {
    throw new Error('Held relay cancellation had no pre-cancel token request baseline.');
  }
  await withTimeout(heldWallet.evaluate(async (): Promise<void> => {
    await window.enboxLabWallet.restartWorkerAndRejectOldHandle();
  }), 10_000, 'Wallet worker restart probe');
  oldHandleRejectedAfterRestart = true;
  await dapp.evaluate((): void => { window.enboxLabConnect.cancelRelay(); });
  await waitForDapp(dapp, 'relay', ['cancelled', 'failed']);
  const cancelledState = await readDappState(dapp);
  assertCompleted(cancelledState.relay.status, cancelledState.relay.error, 'cancelled', 'Cancelled relay dapp');
  const pollingStoppedAfterCancellation = await waitForRequestQuiescence(heldTokenRequestCount);
  await heldWallet.close();

  const { navigationUrls: relayWalletNavigationUrls, page: relayWallet } = await waitForWalletPage(
    context,
    (): Promise<void> => triggerRelay(dapp, {
      connectServerUrl : `${params.relayOrigin}/connect`,
      mode             : 'hold',
      walletUri        : `${params.walletOrigin}/relay-connect`,
    }),
    params.walletOrigin,
  );
  await waitForWallet(relayWallet, 'relay', ['holding', 'failed']);
  const pendingRelayState = await readWalletState(relayWallet);
  assertCompleted(pendingRelayState.relay.status, pendingRelayState.relay.error, 'holding', 'Fresh relay wallet');
  if (pendingRelayState.relay.tokenState === undefined || pendingRelayState.relay.requestUri === undefined) {
    throw new Error('Fresh relay wallet did not retain its transient request URI and token state.');
  }
  if (pendingRelayState.relay.tokenState === heldState.relay.tokenState ||
    pendingRelayState.relay.requestUri === heldState.relay.requestUri) {
    throw new Error('Fresh relay flow reused the abandoned flow request URI or token state.');
  }
  const freshTokenUrl = `${params.relayOrigin}/connect/token/${encodeURIComponent(pendingRelayState.relay.tokenState)}.jwt`;
  await waitForCondition(
    (): boolean => tokenResponses.some((response): boolean => response.url === freshTokenUrl && response.status === 204),
    'the fresh relay client to observe a pending token response',
  );
  await withTimeout(
    relayWallet.evaluate(async (): Promise<void> => { await window.enboxLabWallet.denyActiveRelay(); }),
    10_000,
    'Fresh relay denial',
  );
  await waitForWallet(relayWallet, 'relay', ['denied', 'failed']);
  await waitForDapp(dapp, 'relay', ['denied', 'failed']);
  const relayWalletState = await readWalletState(relayWallet);
  const relayDappState = await readDappState(dapp);
  assertCompleted(relayWalletState.relay.status, relayWalletState.relay.error, 'denied', 'Relay wallet');
  assertCompleted(relayDappState.relay.status, relayDappState.relay.error, 'denied', 'Relay dapp');

  const requestUri = relayWalletState.relay.requestUri;
  const tokenState = relayWalletState.relay.tokenState;
  let walletUri = relayWalletNavigationUrls.find((url): boolean => url.includes('#') && url.includes('encryption_key='));
  if (requestUri === undefined || tokenState === undefined || walletUri === undefined) {
    throw new Error('Relay flow did not retain its transient navigation, request URI, and token state.');
  }
  const authorizeReplay = await fetch(requestUri, { redirect: 'error' });
  await authorizeReplay.body?.cancel().catch((): void => {});
  const tokenConsumed = await fetch(`${params.relayOrigin}/connect/token/${encodeURIComponent(tokenState)}.jwt`, {
    redirect: 'error',
  });
  await tokenConsumed.body?.cancel().catch((): void => {});
  const tokenStatuses = tokenResponses
    .filter((response): boolean => response.url === freshTokenUrl)
    .map((response): number => response.status);

  let encryptionKey = new URLSearchParams(new URL(walletUri).hash.slice(1)).get('encryption_key');
  if (encryptionKey === null || encryptionKey.length === 0) {
    throw new Error('Relay handoff did not contain its fragment encryption key.');
  }
  const networkUrls = networkRequests.map((request): string => request.url);
  const parsedNetworkUrls = networkUrls.map((url): URL => new URL(url));
  const expectedOrigins = new Set([params.dappOrigin, params.walletOrigin, params.relayOrigin]);
  const fragmentSecretReachedNetwork = networkContainsValue(networkUrls, encryptionKey);
  const unexpectedNetworkOrigin = parsedNetworkUrls.some((url): boolean => !expectedOrigins.has(url.origin));
  const unexpectedRelayRoute = networkRequests.some((request): boolean => {
    const url = new URL(request.url);
    return url.origin === params.relayOrigin && !isExpectedRelayRequest(request);
  });
  encryptionKey = '';
  walletUri = '';
  relayWalletNavigationUrls.fill('');
  const observation: BrowserConnectObservation = {
    authorizeReplayStatus           : authorizeReplay.status,
    authorizeStatus                 : relayWalletState.relay.authorizeStatus ?? 0,
    browserVersion                  : params.browser.version(),
    callbackStatus                  : relayWalletState.relay.callbackStatus ?? 0,
    cancelledFlowPendingObserved    : true,
    claimedObserved                 : relayDappState.relay.claimed === 1,
    dappOrigin                      : params.dappOrigin,
    executablePath                  : params.executablePath,
    fragmentSecretReachedNetwork,
    freshRelayIdentifiersDistinct   : true,
    oldHandleRejectedAfterRestart,
    pollingStoppedAfterCancellation,
    popupDenied                     : popupDappState.popup.status === 'denied',
    popupDappWrongOriginIgnored     : popupDappState.popup.wrongWalletOriginIgnored,
    popupDappWrongSourceIgnored     : popupDappState.popup.wrongWalletSourceIgnored,
    popupOriginMismatchRejected     : popupWalletState.popup.originMismatchRejected,
    popupOtherPrincipalRejected     : popupWalletState.popup.otherPrincipalRejected,
    popupOversizedEnvelopeRejected  : popupWalletState.popup.oversizedEnvelopeRejected,
    popupPermissionRequestCount     : popupWalletState.popup.permissionRequestCount,
    popupWrongOriginIgnored         : popupWalletState.popup.wrongOriginIgnored,
    popupWrongSourceIgnored         : popupWalletState.popup.wrongSourceIgnored,
    relayDenied                     : relayDappState.relay.status === 'denied',
    relayOrigin                     : params.relayOrigin,
    relayPermissionRequestCount     : relayWalletState.relay.permissionRequestCount,
    relayRequestKeyZeroed           : relayWalletState.relay.requestKeyZeroed,
    relayRequestPinCalls            : relayDappState.relay.requestPinCalls,
    relayRuntimeIsolated            : params.relayRuntimeIsolated,
    relayServerVersion              : params.relayServerVersion,
    routePolicyRejections           : relayWalletState.relay.routePolicyRejections,
    tokenConsumedStatus             : tokenConsumed.status,
    tokenStatuses,
    unexpectedNetworkOrigin,
    unexpectedRelayRoute,
    walletOrigin                    : params.walletOrigin,
    workerMalformedCommandsRejected : relayWalletState.relay.malformedCommandsRejected,
  };
  await relayWallet.close();
  await context.close();
  return observation;
}

/** Runs the real managed-browser popup and released-relay denial scenario. */
export async function runConnectBrowserScenario(executablePath: string): Promise<BrowserConnectScenarioOutcome> {
  const browserCleanupErrors: string[] = [];
  const relayCleanupErrors: string[] = [];
  let browser: Browser | undefined;
  let dappOrigin: FixtureOrigin | undefined;
  let directory: string | undefined;
  let executionError: string | undefined;
  let observation: BrowserConnectObservation | undefined;
  let relay: ConnectRelayRuntime | undefined;
  let relayStopped = true;
  let walletOrigin: FixtureOrigin | undefined;

  try {
    directory = await mkdtemp(join(tmpdir(), 'enbox-lab-connect-browser-'));
    relay = await ConnectRelayRuntime.create();
    relayStopped = false;
    let relayEvidence: Awaited<ReturnType<ConnectRelayRuntime['start']>>;
    try {
      relayEvidence = await withTimeout(relay.start(), 30_000, 'Connect relay startup');
    } catch (error: unknown) {
      try {
        const disposed = await withTimeout(relay.forceDispose(), 10_000, 'Connect relay force cleanup');
        relayStopped = disposed.stopped && !disposed.healthReachable && disposed.storageRemoved;
      } catch (cleanupError: unknown) {
        relayCleanupErrors.push(errorMessage(cleanupError));
      }
      throw error;
    }
    const bundles = await withTimeout(buildBrowserBundles(directory, relay.origin), 30_000, 'Browser fixture build');
    dappOrigin = startDappOrigin(bundles.dapp);
    walletOrigin = startWalletOrigin(bundles, { dappOrigin: dappOrigin.origin, relayOrigin: relay.origin });
    browser = await withTimeout(chromium.launch({ executablePath, headless: true, timeout: 25_000 }), 30_000, 'Chromium launch');
    observation = await withTimeout(runBrowserFlows({
      browser,
      dappOrigin           : dappOrigin.origin,
      executablePath,
      relayOrigin          : relay.origin,
      relayRuntimeIsolated : relayEvidence.storageIsolated &&
        !relayEvidence.deliveryEnabled && !relayEvidence.forwardingEnabled && !relayEvidence.webSocketSupport,
      relayServerVersion : relayEvidence.reportedVersion,
      walletOrigin       : walletOrigin.origin,
    }), 90_000, 'Browser connect scenario');
  } catch (error: unknown) {
    executionError = errorMessage(error);
  } finally {
    for (const [name, operation] of [
      ['browser', async (): Promise<void> => { await browser?.close(); }],
      ['wallet origin', async (): Promise<void> => { await walletOrigin?.stop(); }],
      ['dapp origin', async (): Promise<void> => { await dappOrigin?.stop(); }],
      ['browser bundle directory', async (): Promise<void> => {
        if (directory !== undefined) {
          await rm(directory, { force: true, recursive: true });
        }
      }],
    ] as const) {
      try {
        await withTimeout(operation(), 10_000, `${name} cleanup`);
      } catch (error: unknown) {
        browserCleanupErrors.push(`${name}: ${errorMessage(error)}`);
      }
    }
    if (relay !== undefined) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 2 && !relayStopped; attempt += 1) {
        try {
          const stopped = await withTimeout(relay.stop(), 30_000, `Connect relay cleanup attempt ${attempt}`);
          relayStopped = stopped.stopped && !stopped.healthReachable && stopped.storageRemoved;
        } catch (error: unknown) {
          lastError = error;
        }
      }
      if (!relayStopped) {
        relayCleanupErrors.push(errorMessage(lastError));
      }
    }
  }

  return {
    browserCleanupErrors,
    ...(executionError === undefined ? {} : { executionError }),
    ...(observation === undefined ? {} : { observation }),
    relayCleanupErrors,
    relayStopped,
  };
}
