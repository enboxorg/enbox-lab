import type { ApprovedDappState } from './fixture/approved-dapp.js';
import type { ApprovedWalletState } from './fixture/approved-wallet.js';
import type { Server } from 'bun';
import type { Browser, BrowserContext, Page, Request as PlaywrightRequest } from 'playwright';
import type { LabCheck, LabProofReport } from '../../proof-result.js';

import { AgentProcessRuntime } from '../../runtime/agent-process/agent-process-runtime.js';
import { chromium } from 'playwright';
import { createConnection } from 'node:net';
import { createProofReport } from '../../proof-result.js';
import { DidServerRuntime } from '../did-server/did-server-runtime.js';
import { fileURLToPath } from 'node:url';
import { findChromiumExecutable } from '../../runtime/chromium.js';
import { LAB_NOTE_WRITE_APP_NAME } from '../../runtime/agent-process/note-write-approval.js';
import { PopupApprovalBridge } from '../../runtime/popup-approval-bridge.js';
import { PrivatePkarrTestnet } from '../../runtime/private-pkarr-testnet.js';
import { startPkarrPublicationServer } from '../../pkarr-publication-server.js';
import { tmpdir } from 'node:os';

import { basename, dirname, join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

type BrowserBundles = Readonly<{
  dapp: string;
  wallet: string;
}>;

type FixtureOrigin = Readonly<{
  origin: string;
  server: Server<undefined>;
  stop(): Promise<void>;
}>;

type NetworkRequest = Readonly<{ method: string; url: string }>;

export type ApprovedPopupBrowserObservation = Readonly<{
  actorGets: number;
  actorPuts: number;
  actorRejected: number;
  agentDid: string;
  agentPackageVersion: string;
  approvalAcknowledged: boolean;
  bridgeApproveStatus: number;
  bridgeBindStatus: number;
  bridgeCapabilityInNetwork: boolean;
  bridgeRequests: readonly NetworkRequest[];
  browserVersion: string;
  connectedDid: string;
  dappOrigin: string;
  delegateDid: string;
  delegateGrantCount: number;
  delegateKeyCurves: readonly string[];
  permissionRequestCount: number;
  resolverGets: number;
  resolverRejected: number;
  serverPackageVersion: string;
  serverSdkVersion: string;
  sessionRevocationCount: number;
  walletAppName: string;
  walletOrigin: string;
}>;

export type ApprovedPopupBrowserProofOptions = Readonly<{
  browserExecutablePath?: string;
  now?: () => Date;
}>;

const SCENARIO_TIMEOUT_MS = 90_000;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/127\.0\.0\.1:\d+\/__lab\/resolver\/[^\s"'<>]*/gu, '[redacted-resolver-endpoint]')
    .replace(/\b[0-9a-f]{64}\b/giu, '[redacted-capability]')
    .slice(0, 1_024);
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

function fixtureEntry(name: 'approved-dapp' | 'approved-wallet'): string {
  const currentPath = fileURLToPath(import.meta.url);
  const extension = currentPath.endsWith('.ts') ? 'ts' : 'js';
  return join(dirname(currentPath), 'fixture', `${name}.${extension}`);
}

async function buildBrowserBundles(directory: string): Promise<BrowserBundles> {
  const outputDirectory = join(directory, 'browser');
  await mkdir(outputDirectory, { recursive: true });
  const result = await Bun.build({
    entrypoints : [fixtureEntry('approved-dapp'), fixtureEntry('approved-wallet')],
    format      : 'esm',
    minify      : true,
    outdir      : outputDirectory,
    sourcemap   : 'none',
    splitting   : false,
    target      : 'browser',
  });
  if (!result.success) {
    throw new Error(`Approved popup fixture build failed: ${result.logs.map(String).join('; ')}`);
  }
  const outputs = new Map(result.outputs.map((output): [string, string] => [basename(output.path), output.path]));
  const dapp = outputs.get('approved-dapp.js');
  const wallet = outputs.get('approved-wallet.js');
  if (dapp === undefined || wallet === undefined) {
    throw new Error(`Approved popup fixture build omitted an entry: ${JSON.stringify([...outputs.keys()].sort())}`);
  }
  return { dapp, wallet };
}

function secureResponse(body: BodyInit | null, contentType: string): Response {
  return new Response(body, {
    headers: {
      'Cache-Control'                : 'no-store',
      'Content-Security-Policy'      : 'default-src \'none\'; script-src \'self\'; connect-src \'self\'; frame-ancestors \'none\'',
      'Content-Type'                 : contentType,
      'Cross-Origin-Resource-Policy' : 'same-origin',
      'Referrer-Policy'              : 'strict-origin',
      'X-Content-Type-Options'       : 'nosniff',
    },
  });
}

function exactOriginRequest(request: Request, origin: string): URL | undefined {
  const url = new URL(request.url);
  const expectedHost = new URL(origin).host;
  return url.origin === origin && request.headers.get('host') === expectedHost &&
    url.username === '' && url.password === '' && url.search === '' && url.hash === '' &&
    url.href === `${origin}${url.pathname}` ? url : undefined;
}

async function assertPortClosed(origin: string): Promise<void> {
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
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') { resolvePromise(); } else { reject(error); }
    });
  });
}

function fixtureOrigin(origin: string, server: Server<undefined>): FixtureOrigin {
  return {
    origin,
    server,
    stop: async (): Promise<void> => {
      await server.stop(true);
      await assertPortClosed(origin);
    },
  };
}

function startDappOrigin(bundlePath: string): FixtureOrigin {
  let origin = '';
  const server = Bun.serve({
    fetch: (request): Response => {
      const url = exactOriginRequest(request, origin);
      if (url === undefined || request.method !== 'GET') { return new Response('not found', { status: 404 }); }
      if (url.pathname === '/dapp.js') { return secureResponse(Bun.file(bundlePath), 'text/javascript; charset=utf-8'); }
      if (url.pathname === '/favicon.ico') { return new Response(null, { status: 204 }); }
      if (url.pathname === '/') {
        return secureResponse(`<!doctype html>
<meta charset="utf-8">
<title>Enbox Lab approved popup dapp</title>
<button id="connect" type="button">Connect</button>
<script type="module" src="/dapp.js"></script>`, 'text/html; charset=utf-8');
      }
      return new Response('not found', { status: 404 });
    },
    hostname : '127.0.0.1',
    port     : 0,
  });
  origin = `http://localhost:${server.port}`;
  return fixtureOrigin(origin, server);
}

function startWalletOrigin(bundlePath: string): Readonly<{
  origin: FixtureOrigin;
  setBridge(bridge: PopupApprovalBridge): void;
}> {
  let approvalBridge: PopupApprovalBridge | undefined;
  let origin = '';
  const server = Bun.serve({
    fetch: (request): Promise<Response> | Response => {
      const url = exactOriginRequest(request, origin);
      if (url === undefined) { return new Response('not found', { status: 404 }); }
      if (url.pathname.startsWith('/__lab/connect/popup/')) {
        return approvalBridge === undefined ? new Response('starting', { status: 503 }) : approvalBridge.handle(request);
      }
      if (request.method !== 'GET') { return new Response('not found', { status: 404 }); }
      if (url.pathname === '/wallet.js') { return secureResponse(Bun.file(bundlePath), 'text/javascript; charset=utf-8'); }
      if (url.pathname === '/favicon.ico') { return new Response(null, { status: 204 }); }
      if (url.pathname === '/dweb-connect') {
        return secureResponse(`<!doctype html>
<meta charset="utf-8">
<title>Enbox Lab approved popup wallet</title>
<p id="request">Awaiting request</p>
<button id="approve" type="button">Approve</button>
<script type="module" src="/wallet.js"></script>`, 'text/html; charset=utf-8');
      }
      return new Response('not found', { status: 404 });
    },
    hostname           : '127.0.0.1',
    maxRequestBodySize : 65_536,
    port               : 0,
  });
  origin = `http://localhost:${server.port}`;
  return {
    origin: fixtureOrigin(origin, server),
    setBridge(bridge: PopupApprovalBridge): void { approvalBridge = bridge; },
  };
}

async function waitForFixture(page: Page, fixture: 'dapp' | 'wallet'): Promise<void> {
  await page.waitForFunction((selected): boolean => selected === 'dapp'
    ? window.enboxLabApprovedDapp !== undefined
    : window.enboxLabApprovedWallet !== undefined, fixture, { timeout: 30_000 });
}

async function runBrowserScenario(params: {
  bootstrap: ReturnType<PopupApprovalBridge['bootstrap']>;
  browser: Browser;
  dappOrigin: string;
  walletOrigin: string;
}): Promise<Readonly<{
  dapp: ApprovedDappState;
  networkRequests: NetworkRequest[];
  wallet: ApprovedWalletState;
}>> {
  const context: BrowserContext = await params.browser.newContext();
  const networkRequests: NetworkRequest[] = [];
  context.on('request', (request: PlaywrightRequest): void => {
    networkRequests.push({ method: request.method(), url: request.url() });
  });
  await context.addInitScript(({ bootstrap, dappOrigin, walletOrigin }): void => {
    if (globalThis.location.origin === walletOrigin) {
      Object.defineProperty(window, 'enboxLabApprovedWalletConfig', {
        configurable : false,
        enumerable   : false,
        value        : Object.freeze({ ...bootstrap, dappOrigin }),
        writable     : false,
      });
    }
  }, {
    bootstrap    : params.bootstrap,
    dappOrigin   : params.dappOrigin,
    walletOrigin : params.walletOrigin,
  });

  try {
    const dapp = await context.newPage();
    await dapp.goto(params.dappOrigin, { waitUntil: 'domcontentloaded' });
    await waitForFixture(dapp, 'dapp');
    const popupPromise = context.waitForEvent('page', { timeout: 30_000 });
    await dapp.evaluate((walletOrigin): void => {
      document.querySelector<HTMLButtonElement>('#connect')!.onclick = (): void => {
        window.enboxLabApprovedDapp.start(walletOrigin);
      };
    }, params.walletOrigin);
    await dapp.click('#connect');
    const wallet = await popupPromise;
    await wallet.waitForURL((url): boolean => url.origin === params.walletOrigin, { timeout: 30_000 });
    await waitForFixture(wallet, 'wallet');
    await wallet.waitForFunction((): boolean => ['awaiting-approval', 'failed']
      .includes(window.enboxLabApprovedWallet.state.status), undefined, { timeout: 30_000 });
    const beforeApproval = await wallet.evaluate((): ApprovedWalletState =>
      structuredClone(window.enboxLabApprovedWallet.state));
    if (beforeApproval.status !== 'awaiting-approval') {
      throw new Error(`Approved wallet failed before consent: ${beforeApproval.error ?? 'unknown error'}`);
    }
    await wallet.click('#approve');
    await dapp.waitForFunction((): boolean => ['connected', 'failed']
      .includes(window.enboxLabApprovedDapp.state.status), undefined, { timeout: SCENARIO_TIMEOUT_MS });
    await wallet.waitForFunction((): boolean => ['approved', 'failed']
      .includes(window.enboxLabApprovedWallet.state.status), undefined, { timeout: SCENARIO_TIMEOUT_MS });
    const dappState = await dapp.evaluate((): ApprovedDappState =>
      structuredClone(window.enboxLabApprovedDapp.state));
    const walletState = await wallet.evaluate((): ApprovedWalletState =>
      structuredClone(window.enboxLabApprovedWallet.state));
    if (dappState.status !== 'connected' || walletState.status !== 'approved') {
      throw new Error(`Approved popup did not complete: dapp=${dappState.error ?? dappState.status}; ` +
        `wallet=${walletState.error ?? walletState.status}`);
    }
    await wallet.close();
    return { dapp: dappState, networkRequests, wallet: walletState };
  } finally {
    await context.close();
  }
}

function bridgeRouteObservationPassed(observation: ApprovedPopupBrowserObservation): boolean {
  if (observation.bridgeRequests.length !== 2) { return false; }
  try {
    const bind = new URL(observation.bridgeRequests[0]!.url);
    const approve = new URL(observation.bridgeRequests[1]!.url);
    return observation.bridgeRequests[0]!.method === 'POST' && observation.bridgeRequests[1]!.method === 'POST' &&
      bind.origin === observation.walletOrigin && approve.origin === observation.walletOrigin &&
      bind.pathname === '/__lab/connect/popup/bind' && approve.pathname === '/__lab/connect/popup/approve';
  } catch {
    return false;
  }
}

/** Converts the complete browser observation into its three positive acceptance checks. */
export function approvedPopupBrowserVerdicts(observation: ApprovedPopupBrowserObservation): LabCheck[] {
  const popupPassed = observation.approvalAcknowledged && observation.delegateGrantCount === 2 &&
    observation.sessionRevocationCount === 1 && observation.permissionRequestCount === 1 &&
    observation.delegateKeyCurves.join(',') === 'Ed25519,X25519' &&
    observation.connectedDid === observation.agentDid && observation.walletAppName === LAB_NOTE_WRITE_APP_NAME &&
    observation.browserVersion.length > 0 && /^did:dht:[ybndrfg8ejkmcpqxot1uwisza345h769]{51}[yo]$/u.test(observation.agentDid) &&
    observation.delegateDid.startsWith('did:jwk:');
  const bridgePassed = observation.bridgeBindStatus === 200 && observation.bridgeApproveStatus === 200 &&
    !observation.bridgeCapabilityInNetwork && bridgeRouteObservationPassed(observation) &&
    observation.dappOrigin !== observation.walletOrigin && observation.dappOrigin.startsWith('http://localhost:') &&
    observation.walletOrigin.startsWith('http://localhost:');
  const didPassed = observation.actorGets === 0 && observation.actorPuts === 1 && observation.actorRejected === 0 &&
    observation.resolverGets > 0 && observation.resolverRejected === 0 &&
    observation.agentPackageVersion === '0.8.48' && observation.serverPackageVersion === '0.1.43' &&
    observation.serverSdkVersion === '0.4.27';
  return [
    {
      details: {
        ...observation,
        bridgeRequests    : JSON.stringify(observation.bridgeRequests),
        delegateKeyCurves : JSON.stringify(observation.delegateKeyCurves),
      },
      id      : 'A13-browser-popup-approval',
      status  : popupPassed ? 'pass' : 'fail',
      summary : popupPassed
        ? 'Managed Chromium completed the real popup approval and opened the delegated credentials'
        : 'The browser popup approval did not return the fixed delegated session',
    },
    {
      details: {
        bridgeApproveStatus       : observation.bridgeApproveStatus,
        bridgeBindStatus          : observation.bridgeBindStatus,
        bridgeCapabilityInNetwork : observation.bridgeCapabilityInNetwork,
        bridgeRequests            : JSON.stringify(observation.bridgeRequests),
        dappOrigin                : observation.dappOrigin,
        walletOrigin              : observation.walletOrigin,
      },
      id      : 'A13-browser-popup-approval-bridge',
      status  : bridgePassed ? 'pass' : 'fail',
      summary : bridgePassed
        ? 'The wallet page used only the authenticated bind and approve bridge routes without URL credentials'
        : 'The browser did not preserve the popup approval bridge route contract',
    },
    {
      details: {
        actorGets            : observation.actorGets,
        actorPuts            : observation.actorPuts,
        actorRejected        : observation.actorRejected,
        agentDid             : observation.agentDid,
        agentPackageVersion  : observation.agentPackageVersion,
        resolverGets         : observation.resolverGets,
        resolverRejected     : observation.resolverRejected,
        serverPackageVersion : observation.serverPackageVersion,
        serverSdkVersion     : observation.serverSdkVersion,
      },
      id      : 'A10-browser-popup-private-did-runtime',
      status  : didPassed ? 'pass' : 'fail',
      summary : didPassed
        ? 'The approved browser session used the released agent and server through the owned private DID ingresses'
        : 'The approved browser session did not prove its assigned private DID runtime',
    },
  ];
}

/** Runs a real managed-Chromium approved popup through the bridge and released process runtimes. */
export async function runApprovedPopupBrowserProof(
  options: ApprovedPopupBrowserProofOptions = {},
): Promise<LabProofReport> {
  const now = options.now ?? ((): Date => new Date());
  const startedAt = now();
  const executablePath = findChromiumExecutable(options.browserExecutablePath);
  if (executablePath === undefined) {
    return createProofReport({
      checks: [{
        id      : 'A04-browser-popup-approval-chromium',
        status  : 'unsupported',
        summary : 'No explicit or managed Chromium executable is available for the approved popup proof',
      }],
      finishedAt : now(),
      proof      : 'p0-browser-popup-approval',
      startedAt,
    });
  }

  const checks: LabCheck[] = [];
  const cleanupErrors: string[] = [];
  const testnet = new PrivatePkarrTestnet({ displayName: 'Approved Popup Proof' });
  let adapter: Awaited<ReturnType<typeof startPkarrPublicationServer>> | undefined;
  let agent: AgentProcessRuntime | undefined;
  let bridge: PopupApprovalBridge | undefined;
  let browser: Browser | undefined;
  let dapp: FixtureOrigin | undefined;
  let directory: string | undefined;
  let server: DidServerRuntime | undefined;
  let wallet: FixtureOrigin | undefined;

  const docker = await testnet.inspectDockerEngine();
  if (docker.exitCode !== 0) {
    return createProofReport({
      checks: [{
        details : { error: docker.stderr || docker.stdout },
        id      : 'A04-browser-popup-approval-docker',
        status  : 'unsupported',
        summary : 'Docker is unavailable, so the approved popup proof did not run',
      }],
      finishedAt : now(),
      proof      : 'p0-browser-popup-approval',
      startedAt,
    });
  }

  try {
    const relay = await testnet.start();
    const testnetEvidence = await testnet.evidence();
    checks.push({
      details: {
        containerImage : testnetEvidence.containerImage,
        labId          : testnetEvidence.labId,
        ownerId        : testnetEvidence.ownerId,
        runId          : testnetEvidence.runId,
      },
      id      : 'A06-browser-popup-private-testnet',
      status  : testnetEvidence.verified ? 'pass' : 'fail',
      summary : testnetEvidence.verified
        ? 'The approved popup used its owned digest-pinned private Pkarr testnet'
        : 'The approved popup private testnet did not satisfy its ownership contract',
    });
    if (!testnetEvidence.verified) { throw new Error('Approved popup refused an unverified private testnet.'); }

    directory = await mkdtemp(join(tmpdir(), 'enbox-lab-approved-popup-'));
    adapter = await startPkarrPublicationServer({
      actorIngress    : true,
      journalLocation : join(directory, 'journal.sqlite'),
      resolverIngress : true,
      upstreamBaseUrl : relay.endpoint,
    });
    const actorGatewayUri = adapter.actorEndpoint();
    const resolverEndpoint = adapter.resolverEndpoint();
    if (actorGatewayUri === undefined || resolverEndpoint === undefined) {
      throw new Error('Approved popup private DID ingresses are unavailable.');
    }
    server = await DidServerRuntime.create(resolverEndpoint);
    const serverEvidence = await server.start();
    agent = await AgentProcessRuntime.create({ actorGatewayUri, remoteDwnOrigin: server.origin });
    let password = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const agentEvidence = await agent.start({ password });
    password = '';

    const bundles = await buildBrowserBundles(directory);
    dapp = startDappOrigin(bundles.dapp);
    const walletRuntime = startWalletOrigin(bundles.wallet);
    wallet = walletRuntime.origin;
    bridge = new PopupApprovalBridge({
      agent,
      dappOrigin   : dapp.origin,
      walletOrigin : wallet.origin,
    });
    walletRuntime.setBridge(bridge);
    const bootstrap = bridge.bootstrap();
    browser = await chromium.launch({ executablePath, headless: true, timeout: 30_000 });
    const scenario = await withTimeout(runBrowserScenario({
      bootstrap,
      browser,
      dappOrigin   : dapp.origin,
      walletOrigin : wallet.origin,
    }), SCENARIO_TIMEOUT_MS, 'Approved popup browser scenario');
    const bridgePaths: ReadonlySet<string> = new Set([bootstrap.bindPath, bootstrap.approvePath, bootstrap.cancelPath]);
    const walletOrigin = wallet.origin;
    const bridgeRequests = scenario.networkRequests.filter((request): boolean => {
      const url = new URL(request.url);
      return url.origin === walletOrigin && bridgePaths.has(url.pathname);
    });
    const networkUrls = scenario.networkRequests.map((request): string => request.url);
    const actor = adapter.actorObservation();
    const resolver = adapter.resolverObservation();
    const observation: ApprovedPopupBrowserObservation = {
      actorGets                 : actor.admittedGets,
      actorPuts                 : actor.admittedPuts,
      actorRejected             : actor.rejected,
      agentDid                  : agentEvidence.agentDid,
      agentPackageVersion       : agentEvidence.packageVersion,
      approvalAcknowledged      : scenario.wallet.acknowledged,
      bridgeApproveStatus       : scenario.wallet.bridgeApproveStatus ?? 0,
      bridgeBindStatus          : scenario.wallet.bridgeBindStatus ?? 0,
      bridgeCapabilityInNetwork : networkUrls.some((url): boolean => url.includes(bootstrap.sessionCapability)),
      bridgeRequests,
      browserVersion            : browser.version(),
      connectedDid              : scenario.dapp.connectedDid ?? '',
      dappOrigin                : dapp.origin,
      delegateDid               : scenario.dapp.delegateDid ?? '',
      delegateGrantCount        : scenario.dapp.delegateGrantCount,
      delegateKeyCurves         : scenario.dapp.delegateKeyCurves,
      permissionRequestCount    : scenario.wallet.permissionRequestCount,
      resolverGets              : resolver.admitted,
      resolverRejected          : resolver.rejected,
      serverPackageVersion      : serverEvidence.packageVersion,
      serverSdkVersion          : serverEvidence.reportedSdkVersion,
      sessionRevocationCount    : scenario.dapp.sessionRevocationCount,
      walletAppName             : scenario.wallet.appName ?? '',
      walletOrigin              : wallet.origin,
    };
    checks.push(...approvedPopupBrowserVerdicts(observation));
    checks.push(
      {
        details : { provisioning: 'playwright-owned-context-init-script' },
        id      : 'A13-controller-wallet-session-provisioning',
        status  : 'unsupported',
        summary : 'The fixture provisions its bridge session through managed-browser automation, not the final controller channel',
      },
      {
        id      : 'A13-relay-pin-approved-response',
        status  : 'unsupported',
        summary : 'The approved relay and PIN path remains a separate stack layer',
      },
      {
        id      : 'A16-user-identity-selection',
        status  : 'unsupported',
        summary : 'This proof uses the agent DID as its provisional single provider profile',
      },
      {
        id      : 'A18-encrypted-private-note-authorization',
        status  : 'unsupported',
        summary : 'The fixed approval is unencrypted and does not yet write, read, or deny a private note',
      },
      {
        id      : 'A14-delegated-session-lifecycle',
        status  : 'unsupported',
        summary : 'Reload, wallet-lock independence, refresh, expiry, and revocation remain unproved',
      },
    );
  } catch (error: unknown) {
    checks.push({
      details : { error: errorMessage(error) },
      id      : 'browser-popup-approval-execution',
      status  : 'fail',
      summary : 'The real approved popup proof stopped before completing its observations',
    });
  } finally {
    for (const [name, cleanup] of [
      ['browser', async (): Promise<void> => { await browser?.close(); }],
      ['bridge', async (): Promise<void> => { await bridge?.stop(); }],
      ['wallet origin', async (): Promise<void> => { await wallet?.stop(); }],
      ['dapp origin', async (): Promise<void> => { await dapp?.stop(); }],
      ['agent stop', async (): Promise<void> => { if (agent?.active) { await agent.stop(); } }],
      ['agent destroy', async (): Promise<void> => { await agent?.destroy(); }],
      ['DWN server', async (): Promise<void> => { await server?.stop(); }],
      ['Pkarr adapter', async (): Promise<void> => { await adapter?.stop(); }],
      ['temporary directory', async (): Promise<void> => {
        if (directory !== undefined) { await rm(directory, { force: true, recursive: true }); }
      }],
    ] as const) {
      try { await withTimeout(cleanup(), 30_000, `${name} cleanup`); } catch (error: unknown) {
        cleanupErrors.push(`${name}: ${errorMessage(error)}`);
      }
    }
    const testnetCleanup = await testnet.stop();
    cleanupErrors.push(...testnetCleanup.errors);
    checks.push({
      details : { errors: JSON.stringify(cleanupErrors) },
      id      : 'browser-popup-approval-cleanup',
      status  : cleanupErrors.length === 0 ? 'pass' : 'fail',
      summary : cleanupErrors.length === 0
        ? 'The approved popup proof removed its browser, bridge, agent, server, adapter, and private testnet'
        : 'The approved popup proof left owned resources or cleanup uncertainty',
    });
  }

  return createProofReport({ checks, finishedAt: now(), proof: 'p0-browser-popup-approval', startedAt });
}
