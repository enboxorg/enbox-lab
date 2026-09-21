import type { Page } from 'playwright';
import type { PkarrFetch } from '../../pkarr-publication-adapter.js';
import type { PrivatePkarrTestnetDependencies } from '../../runtime/private-pkarr-testnet.js';
import type { LabCheck, LabProofReport } from '../../proof-result.js';

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { chromium } from 'playwright';

import { createProofReport } from '../../proof-result.js';
import { findChromiumExecutable } from '../../runtime/chromium.js';
import { PrivatePkarrTestnet } from '../../runtime/private-pkarr-testnet.js';
import { startPkarrPublicationServer } from '../../pkarr-publication-server.js';

type BrowserDidObservation = {
  didUri: string;
  published: boolean;
  resolvedDid: string;
  resolvedDwnEndpoint: string;
  secureContext: boolean;
};

type ForeignOriginObservation = {
  putError: string;
  putRejected: boolean;
  subresourceRejected: boolean;
};

export type BrowserDidTransportProofOptions = {
  browserExecutablePath?: string;
  now?: () => Date;
  upstreamBaseUrl: string;
};

export type PrivateBrowserDidProofOptions = Omit<BrowserDidTransportProofOptions, 'upstreamBaseUrl'> & {
  testnet?: PrivatePkarrTestnetDependencies;
};

type BrowserOrigin = {
  origin: string;
  stop(): Promise<void>;
};

type BrowserDriver = {
  allowedReadStatus(gatewayUri: string, didUri: string): Promise<number>;
  attemptForeignRequests(origin: string, gatewayUri: string, didUri: string): Promise<ForeignOriginObservation>;
  close(): Promise<void>;
  publishAndResolve(origin: string, gatewayUri: string, advertisedDwnEndpoint: string): Promise<BrowserDidObservation>;
  version(): string;
};

export type BrowserDidTransportDependencies = {
  createDirectory(): Promise<string>;
  findExecutable(explicitPath?: string): string | undefined;
  launchDriver(executablePath: string): Promise<BrowserDriver>;
  removeDirectory(directory: string): Promise<void>;
  resolveBundle(): string;
  startAdapter: typeof startPkarrPublicationServer;
  startOrigin(bundlePath: string): BrowserOrigin;
  upstreamFetch: PkarrFetch;
};

type PrivateTestnet = Pick<PrivatePkarrTestnet, 'evidence' | 'inspectDockerEngine' | 'logs' | 'start' | 'stop'>;

export type PrivateBrowserDidProofDependencies = {
  createTestnet(options: PrivatePkarrTestnetDependencies): PrivateTestnet;
  runTransport(options: BrowserDidTransportProofOptions): Promise<LabProofReport>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function didsBrowserBundle(): string {
  const esmEntry = fileURLToPath(import.meta.resolve('@enbox/dids'));
  return resolve(dirname(esmEntry), '../browser.mjs');
}

function startBrowserOrigin(bundlePath: string): BrowserOrigin {
  const server = Bun.serve({
    fetch(request): Response {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/dids.mjs') {
        return new Response(Bun.file(bundlePath), {
          headers: {
            'Cache-Control' : 'no-store',
            'Content-Type'  : 'text/javascript; charset=utf-8',
          },
        });
      }
      if (pathname === '/') {
        return new Response('<!doctype html><meta charset="utf-8"><title>Enbox DID browser proof</title>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      return new Response('not found', { status: 404 });
    },
    hostname : '127.0.0.1',
    port     : 0,
  });
  return {
    origin : `http://127.0.0.1:${server.port}`,
    stop   : async (): Promise<void> => { await server.stop(true); },
  };
}

async function publishAndResolve(page: Page, gatewayUri: string, advertisedDwnEndpoint: string): Promise<BrowserDidObservation> {
  return page.evaluate(async ({ advertisedDwnEndpoint: endpoint, gatewayUri: gateway }) => {
    const didsModulePath = '/dids.mjs';
    const { DidDht } = await import(didsModulePath);
    const did = await DidDht.create({
      options: {
        publish  : false,
        services : [{ id: 'dwn', serviceEndpoint: endpoint, type: 'DecentralizedWebNode' }],
      },
    });
    const publication = await DidDht.publish({
      allowPrivateGatewayUri : true,
      did,
      gatewayUri             : gateway,
    });
    const resolution = await DidDht.resolve(did.uri, {
      allowPrivateGatewayUri : true,
      gatewayUri             : gateway,
    });
    const service = resolution.didDocument?.service?.find((entry: { type?: unknown }): boolean => entry.type === 'DecentralizedWebNode');
    const serviceEndpoint = Array.isArray(service?.serviceEndpoint) ? service.serviceEndpoint[0] : service?.serviceEndpoint;
    return {
      didUri              : did.uri,
      published           : publication.didDocumentMetadata.published === true,
      resolvedDid         : resolution.didDocument?.id ?? '',
      resolvedDwnEndpoint : typeof serviceEndpoint === 'string' ? serviceEndpoint : '',
      secureContext       : window.isSecureContext,
    };
  }, { advertisedDwnEndpoint, gatewayUri });
}

async function attemptForeignRequests(page: Page, gatewayUri: string, didUri: string): Promise<ForeignOriginObservation> {
  return page.evaluate(async ({ didUri: uri, gatewayUri: gateway }) => {
    const identifier = uri.split(':').at(-1) ?? '';
    let putError = '';
    let putRejected = false;
    try {
      await fetch(new URL(identifier, gateway), {
        body    : new Uint8Array(80),
        headers : { 'Content-Type': 'application/octet-stream' },
        method  : 'PUT',
        mode    : 'cors',
      });
    } catch (error: unknown) {
      putError = String(error);
      putRejected = true;
    }
    const subresourceRejected = await new Promise<boolean>((resolve): void => {
      const image = new Image();
      image.addEventListener('error', (): void => { resolve(true); }, { once: true });
      image.addEventListener('load', (): void => { resolve(false); }, { once: true });
      image.src = new URL(`${identifier}?originless=1`, gateway).toString();
    });
    return { putError, putRejected, subresourceRejected };
  }, { didUri, gatewayUri });
}

async function allowedReadStatus(page: Page, gatewayUri: string, didUri: string): Promise<number> {
  return page.evaluate(async ({ didUri: uri, gatewayUri: gateway }) => {
    const identifier = uri.split(':').at(-1) ?? '';
    const response = await fetch(new URL(identifier, gateway), { mode: 'cors' });
    await response.body?.cancel();
    return response.status;
  }, { didUri, gatewayUri });
}

async function launchBrowserDriver(executablePath: string): Promise<BrowserDriver> {
  const browser = await chromium.launch({ executablePath, headless: true });
  let allowedPage: Page | undefined;
  return {
    allowedReadStatus: async (gatewayUri, didUri): Promise<number> => {
      if (allowedPage === undefined) {
        throw new Error('Browser DID driver: publishAndResolve() must run before allowedReadStatus().');
      }
      return allowedReadStatus(allowedPage, gatewayUri, didUri);
    },
    attemptForeignRequests: async (origin, gatewayUri, didUri): Promise<ForeignOriginObservation> => {
      const page = await browser.newPage();
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      return attemptForeignRequests(page, gatewayUri, didUri);
    },
    close             : async (): Promise<void> => { await browser.close(); },
    publishAndResolve : async (origin, gatewayUri, advertisedDwnEndpoint): Promise<BrowserDidObservation> => {
      allowedPage = await browser.newPage();
      await allowedPage.goto(origin, { waitUntil: 'domcontentloaded' });
      return publishAndResolve(allowedPage, gatewayUri, advertisedDwnEndpoint);
    },
    version: (): string => browser.version(),
  };
}

function didObservationPassed(observation: BrowserDidObservation, advertisedDwnEndpoint: string): boolean {
  return observation.published && observation.resolvedDid === observation.didUri &&
    observation.resolvedDwnEndpoint === advertisedDwnEndpoint && observation.secureContext;
}

function originObservationPassed(params: {
  allowedReadStatus: number;
  foreign: ForeignOriginObservation;
  rejectionsAfter: number;
  rejectionsBefore: number;
  upstreamRequestsAfter: number;
  upstreamRequestsBefore: number;
}): boolean {
  return params.foreign.putRejected && params.foreign.subresourceRejected &&
    params.rejectionsAfter - params.rejectionsBefore === 2 &&
    params.upstreamRequestsAfter === params.upstreamRequestsBefore + 1 && params.allowedReadStatus === 200;
}

const defaultBrowserDidTransportDependencies: BrowserDidTransportDependencies = {
  createDirectory : (): Promise<string> => mkdtemp(join(tmpdir(), 'enbox-lab-browser-did-')),
  findExecutable  : findChromiumExecutable,
  launchDriver    : launchBrowserDriver,
  removeDirectory : async (directory): Promise<void> => { await rm(directory, { force: true, recursive: true }); },
  resolveBundle   : didsBrowserBundle,
  startAdapter    : startPkarrPublicationServer,
  startOrigin     : startBrowserOrigin,
  upstreamFetch   : fetch,
};

/** Proves real browser did:dht publication and resolution through one caller-supplied transport. */
async function runBrowserDidTransportProof(
  options: BrowserDidTransportProofOptions,
  dependencies: BrowserDidTransportDependencies = defaultBrowserDidTransportDependencies,
): Promise<LabProofReport> {
  const now = options.now ?? ((): Date => new Date());
  const startedAt = now();
  const checks: LabCheck[] = [];
  const executablePath = dependencies.findExecutable(options.browserExecutablePath);
  if (executablePath === undefined) {
    checks.push({
      id      : 'A04-browser-runtime',
      status  : 'unsupported',
      summary : 'No managed or supported system Chromium executable is available for the browser DID proof',
    });
    checks.push({
      details : { errors: '[]' },
      id      : 'browser-did-proof-cleanup',
      status  : 'pass',
      summary : 'The browser DID proof created no resources before reporting the missing browser',
    });
    return createProofReport({ checks, finishedAt: now(), proof: 'p0-browser-did-transport', startedAt });
  }
  let directory: string | undefined;
  let app: BrowserOrigin | undefined;
  let foreignApp: BrowserOrigin | undefined;
  let adapter: Awaited<ReturnType<typeof startPkarrPublicationServer>> | undefined;
  let driver: BrowserDriver | undefined;
  let upstreamRequests = 0;
  const countedFetch: PkarrFetch = async (input, init): Promise<Response> => {
    upstreamRequests += 1;
    return await dependencies.upstreamFetch(input, init);
  };

  try {
    directory = await dependencies.createDirectory();
    const bundle = dependencies.resolveBundle();
    app = dependencies.startOrigin(bundle);
    foreignApp = dependencies.startOrigin(bundle);
    adapter = await dependencies.startAdapter({
      allowedOrigins  : [app.origin],
      fetch           : countedFetch,
      journalLocation : join(directory, 'accepted-publications.sqlite'),
      upstreamBaseUrl : options.upstreamBaseUrl,
    });
    driver = await dependencies.launchDriver(executablePath);
    const advertisedDwnEndpoint = 'http://localhost:41000';
    const observation = await driver.publishAndResolve(app.origin, adapter.endpoint, advertisedDwnEndpoint);
    const didPassed = didObservationPassed(observation, advertisedDwnEndpoint);
    checks.push({
      details: {
        advertisedDwnEndpoint,
        browserVersion      : driver.version(),
        didUri              : observation.didUri,
        executablePath,
        gatewayUri          : adapter.endpoint,
        origin              : app.origin,
        resolvedDwnEndpoint : observation.resolvedDwnEndpoint,
        secureContext       : observation.secureContext,
      },
      id      : 'A10-browser-direct-did-network-subcheck',
      status  : didPassed ? 'pass' : 'fail',
      summary : didPassed
        ? 'Chromium published and resolved a did:dht identity through the configured private gateway'
        : 'Chromium did not publish and resolve through the configured private gateway',
    });

    const requestsBeforeForeignRead = upstreamRequests;
    const rejectionsBefore = adapter.browserRejectionCount();
    const foreign = await driver.attemptForeignRequests(foreignApp.origin, adapter.endpoint, observation.didUri);
    const rejectionsAfter = adapter.browserRejectionCount();
    const foreignReachedUpstream = upstreamRequests !== requestsBeforeForeignRead;
    const allowedRead = await driver.allowedReadStatus(adapter.endpoint, observation.didUri);
    const originPassed = !foreignReachedUpstream && originObservationPassed({
      allowedReadStatus      : allowedRead,
      foreign,
      rejectionsAfter,
      rejectionsBefore,
      upstreamRequestsAfter  : upstreamRequests,
      upstreamRequestsBefore : requestsBeforeForeignRead,
    });
    checks.push({
      details: {
        allowedReadStatus      : allowedRead,
        allowedOrigin          : app.origin,
        foreignOrigin          : foreignApp.origin,
        foreignReachedUpstream,
        putError               : foreign.putError,
        rejectionsAfter,
        rejectionsBefore,
        subresourceRejected    : foreign.subresourceRejected,
        upstreamRequestsAfter  : upstreamRequests,
        upstreamRequestsBefore : requestsBeforeForeignRead,
      },
      id      : 'A03-browser-did-origin-allowlist-subcheck',
      status  : originPassed ? 'pass' : 'fail',
      summary : originPassed
        ? 'The private DID gateway rejected a foreign browser origin before upstream access'
        : 'A foreign browser origin reached or read from the private DID gateway',
    });
  } catch (error: unknown) {
    checks.push({
      details : { error: errorMessage(error) },
      id      : 'browser-did-proof-execution',
      status  : 'fail',
      summary : 'The real browser DID proof stopped before completing its observations',
    });
  } finally {
    const cleanupErrors: string[] = [];
    try {
      await driver?.close();
    } catch (error: unknown) {
      cleanupErrors.push(errorMessage(error));
    }
    try {
      await adapter?.stop();
    } catch (error: unknown) {
      cleanupErrors.push(errorMessage(error));
    }
    for (const origin of [app, foreignApp]) {
      try {
        await origin?.stop();
      } catch (error: unknown) {
        cleanupErrors.push(errorMessage(error));
      }
    }
    try {
      if (directory !== undefined) {
        await dependencies.removeDirectory(directory);
      }
    } catch (error: unknown) {
      cleanupErrors.push(errorMessage(error));
    }
    checks.push({
      details : { errors: JSON.stringify(cleanupErrors) },
      id      : 'browser-did-proof-cleanup',
      status  : cleanupErrors.length === 0 ? 'pass' : 'fail',
      summary : cleanupErrors.length === 0
        ? 'The browser DID proof removed its browser, adapter, servers, and temporary journal'
        : 'The browser DID proof left one or more owned resources open',
    });
  }

  return createProofReport({ checks, finishedAt: now(), proof: 'p0-browser-did-transport', startedAt });
}

const defaultPrivateBrowserDidProofDependencies: PrivateBrowserDidProofDependencies = {
  createTestnet : (options): PrivatePkarrTestnet => new PrivatePkarrTestnet(options),
  runTransport  : (options): Promise<LabProofReport> => runBrowserDidTransportProof(options),
};

async function runPrivateBrowserDidProofWithDependencies(
  options: PrivateBrowserDidProofOptions,
  dependencies: PrivateBrowserDidProofDependencies,
): Promise<LabProofReport> {
  const now = options.now ?? ((): Date => new Date());
  const startedAt = now();
  const checks: LabCheck[] = [];
  const testnet = dependencies.createTestnet({
    displayName: 'Browser DID Proof',
    ...options.testnet,
  });
  const docker = await testnet.inspectDockerEngine();
  if (docker.exitCode !== 0) {
    return createProofReport({
      checks: [{
        details : { error: docker.stderr || docker.stdout },
        id      : 'A04-browser-did-docker',
        status  : 'unsupported',
        summary : 'Docker is unavailable, so the private browser DID proof did not run',
      }],
      finishedAt : now(),
      proof      : 'p0-browser-private-did-boundary',
      startedAt,
    });
  }

  try {
    const relay = await testnet.start();
    const evidence = await testnet.evidence();
    checks.push({
      details: {
        attachedNetworks    : JSON.stringify(evidence.attachedNetworks),
        command             : JSON.stringify(evidence.command),
        containerImage      : evidence.containerImage,
        displayName         : evidence.displayName,
        egressMasquerading  : evidence.egressMasquerading,
        imageArchitecture   : evidence.imageArchitecture,
        imageDigest         : evidence.imageDigest,
        imageDigestRecorded : evidence.imageDigestRecorded,
        labId               : evidence.labId,
        nativeImage         : evidence.nativeImage,
        ownerId             : evidence.ownerId,
        ownedNetwork        : evidence.ownedNetwork,
        runId               : evidence.runId,
      },
      id      : 'A06-browser-private-testnet',
      status  : evidence.verified ? 'pass' : 'fail',
      summary : evidence.verified
        ? 'The browser DID proof used its owned digest-pinned private Pkarr testnet'
        : 'The browser DID proof testnet did not match its pinned ownership and isolation contract',
    });
    if (!evidence.verified) {
      throw new Error('Private browser DID proof refused to use an unverified testnet runtime');
    }
    const browserReport = await dependencies.runTransport({
      browserExecutablePath : options.browserExecutablePath,
      now,
      upstreamBaseUrl       : relay.endpoint,
    });
    checks.push(...browserReport.checks);
    checks.push({
      id      : 'A10-default-runtime-did-network',
      status  : 'unsupported',
      summary : 'Default agent, auth, API, and service-worker DID network propagation requires the released Enbox #1726 package cohort',
    });
    checks.push({
      id      : 'A03-service-worker-did-containment',
      status  : 'unsupported',
      summary : 'Service-worker DID traffic containment remains part of the full browser actor E2E',
    });
    checks.push({
      id      : 'A10-server-private-did-ingress',
      status  : 'unsupported',
      summary : 'Server-side DID resolution needs a separate authenticated or private-network ingress to the durable gateway',
    });
  } catch (error: unknown) {
    const logs = await testnet.logs();
    checks.push({
      details: {
        error     : errorMessage(error),
        relayLogs : logs.exitCode === 0 ? logs.stderr || logs.stdout : '',
      },
      id      : 'browser-private-did-runtime-execution',
      status  : 'fail',
      summary : 'The owned private browser DID proof stopped before completing its observations',
    });
  } finally {
    const cleanup = await testnet.stop();
    checks.push({
      details: {
        containerName : cleanup.containerName,
        errors        : JSON.stringify(cleanup.errors),
        networkName   : cleanup.networkName,
        ownerId       : cleanup.ownerId,
        runId         : cleanup.runId,
      },
      id      : 'browser-private-did-runtime-cleanup',
      status  : cleanup.passed ? 'pass' : 'fail',
      summary : cleanup.passed
        ? 'The private browser DID runtime removed its exact owned Docker resources'
        : 'The private browser DID runtime left owned Docker resources or cleanup uncertainty',
    });
  }

  return createProofReport({ checks, finishedAt: now(), proof: 'p0-browser-private-did-boundary', startedAt });
}

/** Runs the browser DID proof against a newly owned, digest-pinned private Pkarr testnet. */
export function runPrivateBrowserDidProof(options: PrivateBrowserDidProofOptions = {}): Promise<LabProofReport> {
  return runPrivateBrowserDidProofWithDependencies(options, defaultPrivateBrowserDidProofDependencies);
}

export const browserDidProofInternals = {
  didObservationPassed,
  originObservationPassed,
  runBrowserDidTransportProof,
  runPrivateBrowserDidProofWithDependencies,
};
