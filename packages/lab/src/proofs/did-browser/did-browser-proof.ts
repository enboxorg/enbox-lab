import type { PkarrFetch } from '../../pkarr-publication-adapter.js';
import type { PrivatePkarrTestnetDependencies } from '../../runtime/private-pkarr-testnet.js';
import type {
  BrowserDidObservation,
  BrowserDriver,
  BrowserOrigin,
  BrowserRequestObservation,
  ForeignOriginObservation,
  ServiceWorkerProbeObservation,
  ServiceWorkerResolutionObservation,
} from './did-browser-runtime.js';
import type { LabCheck, LabProofReport } from '../../proof-result.js';

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { createProofReport } from '../../proof-result.js';
import { findChromiumExecutable } from '../../runtime/chromium.js';
import { PrivatePkarrTestnet } from '../../runtime/private-pkarr-testnet.js';
import { startPkarrPublicationServer } from '../../pkarr-publication-server.js';
import {
  buildServiceWorkerBundle,
  didsBrowserBundle,
  launchBrowserDriver,
  startBrowserOrigin,
} from './did-browser-runtime.js';

type UpstreamRequestObservation = {
  method: string;
  url: string;
};

export type BrowserDidTransportProofOptions = {
  browserExecutablePath?: string;
  now?: () => Date;
  upstreamBaseUrl: string;
};

export type PrivateBrowserDidProofOptions = Omit<BrowserDidTransportProofOptions, 'upstreamBaseUrl'> & {
  testnet?: PrivatePkarrTestnetDependencies;
};

export type BrowserDidTransportDependencies = {
  buildWorkerBundle(directory: string): Promise<string>;
  createDirectory(): Promise<string>;
  findExecutable(explicitPath?: string): string | undefined;
  launchDriver(executablePath: string): Promise<BrowserDriver>;
  removeDirectory(directory: string): Promise<void>;
  resolveBundle(): string;
  startAdapter: typeof startPkarrPublicationServer;
  startOrigin(bundlePath: string, workerBundlePath: string): BrowserOrigin;
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

function observeUpstreamRequest(input: RequestInfo | URL, init?: RequestInit): UpstreamRequestObservation {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  return { method: method.toUpperCase(), url: new URL(url).href };
}

function workerOwnedRequests(requests: readonly BrowserRequestObservation[]): BrowserRequestObservation[] {
  return requests.filter((request): boolean => request.serviceWorkerOwned);
}

function serviceWorkerNetworkObservationPassed(params: {
  didUri: string;
  gatewayUri: string;
  observation: ServiceWorkerResolutionObservation;
  origin: string;
  rejectionsAfter: number;
  rejectionsBefore: number;
  upstreamBaseUrl: string;
  upstreamRequests: UpstreamRequestObservation[];
}): boolean {
  const identifier = params.didUri.split(':').at(-1) ?? '';
  const expectedUpstreamUrl = new URL(identifier, params.upstreamBaseUrl).href;
  const expectedGatewayUrl = new URL(identifier, params.gatewayUri).href;
  const gatewayRequests = workerOwnedRequests(params.observation.browserRequests);
  return params.observation.bootstrapLocked && params.observation.configured &&
    params.observation.reconfigurationRejected && params.observation.resolutionError === '' &&
    params.observation.resolvedDid === params.didUri &&
    params.observation.scriptUrl === new URL('/did-service-worker.mjs', params.origin).href &&
    gatewayRequests.length === 1 && gatewayRequests[0]?.method === 'GET' &&
    gatewayRequests[0]?.serviceWorkerOwned === true && gatewayRequests[0]?.serviceWorkerUrl === params.observation.scriptUrl &&
    gatewayRequests[0]?.url === expectedGatewayUrl &&
    params.rejectionsAfter === params.rejectionsBefore && params.upstreamRequests.length === 1 &&
    params.upstreamRequests[0]?.method === 'GET' && params.upstreamRequests[0]?.url === expectedUpstreamUrl;
}

function serviceWorkerContainmentObservationPassed(params: {
  didUri: string;
  foreign: ServiceWorkerResolutionObservation;
  foreignOrigin: string;
  foreignRejectionsAfter: number;
  foreignRejectionsBefore: number;
  foreignUpstreamRequests: UpstreamRequestObservation[];
  gatewayUri: string;
  origin: string;
  probe: ServiceWorkerProbeObservation;
  probeRejectionsAfter: number;
  probeRejectionsBefore: number;
  probeUpstreamRequests: UpstreamRequestObservation[];
  sibling: ServiceWorkerProbeObservation;
  siblingRejectionsAfter: number;
  siblingRejectionsBefore: number;
  siblingUpstreamRequests: UpstreamRequestObservation[];
}): boolean {
  const identifier = params.didUri.split(':').at(-1) ?? '';
  const expectedGatewayUrl = new URL(identifier, params.gatewayUri).href;
  const probeGatewayRequests = workerOwnedRequests(params.probe.browserRequests);
  const siblingGatewayRequests = workerOwnedRequests(params.sibling.browserRequests);
  const foreignGatewayRequests = workerOwnedRequests(params.foreign.browserRequests);
  return params.probe.actorSubstitutionRejected && params.probe.bootstrapLocked &&
    params.probe.malformedCommandRejected && params.probe.oversizedCommandRejected &&
    params.probe.unconfiguredError === 'worker-unconfigured' &&
    params.probe.scriptUrl === new URL('/did-service-worker.mjs', params.origin).href &&
    probeGatewayRequests.length === 0 && params.probeRejectionsAfter === params.probeRejectionsBefore &&
    params.probeUpstreamRequests.length === 0 &&
    params.sibling.bootstrapLocked && params.sibling.unconfiguredError === 'worker-unconfigured' &&
    params.sibling.scriptUrl === new URL('/did-service-worker.mjs', params.origin).href &&
    siblingGatewayRequests.length === 0 && params.siblingRejectionsAfter === params.siblingRejectionsBefore &&
    params.siblingUpstreamRequests.length === 0 &&
    params.foreign.bootstrapLocked && params.foreign.configured && params.foreign.reconfigurationRejected &&
    params.foreign.resolutionError === 'resolution-failed' && params.foreign.resolvedDid === '' &&
    params.foreign.scriptUrl === new URL('/did-service-worker.mjs', params.foreignOrigin).href &&
    foreignGatewayRequests.length === 1 && foreignGatewayRequests[0]?.method === 'GET' &&
    foreignGatewayRequests[0]?.serviceWorkerOwned === true &&
    foreignGatewayRequests[0]?.serviceWorkerUrl === params.foreign.scriptUrl &&
    foreignGatewayRequests[0]?.url === expectedGatewayUrl &&
    params.foreignRejectionsAfter === params.foreignRejectionsBefore + 1 && params.foreignUpstreamRequests.length === 0;
}

const defaultBrowserDidTransportDependencies: BrowserDidTransportDependencies = {
  buildWorkerBundle : buildServiceWorkerBundle,
  createDirectory   : (): Promise<string> => mkdtemp(join(tmpdir(), 'enbox-lab-browser-did-')),
  findExecutable    : findChromiumExecutable,
  launchDriver      : launchBrowserDriver,
  removeDirectory   : async (directory): Promise<void> => { await rm(directory, { force: true, recursive: true }); },
  resolveBundle     : didsBrowserBundle,
  startAdapter      : startPkarrPublicationServer,
  startOrigin       : startBrowserOrigin,
  upstreamFetch     : fetch,
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
  const upstreamRequestObservations: UpstreamRequestObservation[] = [];
  const countedFetch: PkarrFetch = async (input, init): Promise<Response> => {
    upstreamRequests += 1;
    upstreamRequestObservations.push(observeUpstreamRequest(input, init));
    return await dependencies.upstreamFetch(input, init);
  };

  try {
    directory = await dependencies.createDirectory();
    const bundle = dependencies.resolveBundle();
    const workerBundle = await dependencies.buildWorkerBundle(directory);
    app = dependencies.startOrigin(bundle, workerBundle);
    foreignApp = dependencies.startOrigin(bundle, workerBundle);
    adapter = await dependencies.startAdapter({
      allowedOrigins  : [app.origin],
      fetch           : countedFetch,
      journalLocation : join(directory, 'accepted-publications.sqlite'),
      upstreamBaseUrl : options.upstreamBaseUrl,
    });
    app.configureGateway(adapter.endpoint);
    foreignApp.configureGateway(adapter.endpoint);
    driver = await dependencies.launchDriver(executablePath);
    const advertisedDwnEndpoint = 'http://localhost:41000';
    const observation = await driver.publishAndResolve(app.origin, advertisedDwnEndpoint);
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
    const foreign = await driver.attemptForeignRequests(foreignApp.origin, observation.didUri);
    const rejectionsAfter = adapter.browserRejectionCount();
    const foreignReachedUpstream = upstreamRequests !== requestsBeforeForeignRead;
    const allowedRead = await driver.allowedReadStatus(observation.didUri);
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

    const probeUpstreamIndex = upstreamRequestObservations.length;
    const probeRejectionsBefore = adapter.browserRejectionCount();
    const workerProbe = await driver.probeServiceWorker(app.origin, observation.didUri);
    const probeRejectionsAfter = adapter.browserRejectionCount();
    const probeUpstreamRequests = upstreamRequestObservations.slice(probeUpstreamIndex);

    const workerUpstreamIndex = upstreamRequestObservations.length;
    const workerRejectionsBefore = adapter.browserRejectionCount();
    const worker = await driver.resolveFromServiceWorker(app.origin, observation.didUri);
    const workerRejectionsAfter = adapter.browserRejectionCount();
    const workerUpstreamRequests = upstreamRequestObservations.slice(workerUpstreamIndex);
    const workerNetworkPassed = serviceWorkerNetworkObservationPassed({
      didUri           : observation.didUri,
      gatewayUri       : adapter.endpoint,
      observation      : worker,
      origin           : app.origin,
      rejectionsAfter  : workerRejectionsAfter,
      rejectionsBefore : workerRejectionsBefore,
      upstreamBaseUrl  : options.upstreamBaseUrl,
      upstreamRequests : workerUpstreamRequests,
    });
    const workerRequest = workerUpstreamRequests[0];
    const workerBrowserRequest = workerOwnedRequests(worker.browserRequests)[0];
    checks.push({
      details: {
        actorOrigin                : app.origin,
        bootstrapLocked            : worker.bootstrapLocked,
        configured                 : worker.configured,
        reconfigurationRejected    : worker.reconfigurationRejected,
        resolvedDid                : worker.resolvedDid,
        workerScriptPath           : new URL(worker.scriptUrl).pathname,
        upstreamRequestsAfter      : upstreamRequestObservations.length,
        upstreamRequestsBefore     : workerUpstreamIndex,
        workerLookupMethod         : workerRequest?.method ?? '',
        workerLookupPath           : workerRequest === undefined ? '' : new URL(workerRequest.url).pathname,
        workerRequestMethod        : workerBrowserRequest?.method ?? '',
        workerRequestPath          : workerBrowserRequest === undefined ? '' : new URL(workerBrowserRequest.url).pathname,
        workerRequestServiceWorker : workerBrowserRequest?.serviceWorkerOwned ?? false,
        workerRequestWorkerPath    : workerBrowserRequest?.serviceWorkerUrl === undefined ||
          workerBrowserRequest.serviceWorkerUrl === '' ? '' : new URL(workerBrowserRequest.serviceWorkerUrl).pathname,
        workerRejectionsAfter,
        workerRejectionsBefore,
      },
      id      : 'A10-service-worker-private-did-network-subcheck',
      status  : workerNetworkPassed ? 'pass' : 'fail',
      summary : workerNetworkPassed
        ? 'The source-bound service worker used its immutable actor bootstrap for one exact private DID lookup'
        : 'The service worker did not prove one exact lookup from its immutable actor bootstrap',
    });

    const siblingUpstreamIndex = upstreamRequestObservations.length;
    const siblingRejectionsBefore = adapter.browserRejectionCount();
    const siblingWorkerProbe = await driver.probeSiblingServiceWorker(app.origin, observation.didUri);
    const siblingRejectionsAfter = adapter.browserRejectionCount();
    const siblingUpstreamRequests = upstreamRequestObservations.slice(siblingUpstreamIndex);

    const foreignWorkerUpstreamIndex = upstreamRequestObservations.length;
    const foreignWorkerRejectionsBefore = adapter.browserRejectionCount();
    const foreignWorker = await driver.attemptForeignServiceWorker(foreignApp.origin, observation.didUri);
    const foreignWorkerRejectionsAfter = adapter.browserRejectionCount();
    const foreignWorkerUpstreamRequests = upstreamRequestObservations.slice(foreignWorkerUpstreamIndex);
    const workerContainmentPassed = serviceWorkerContainmentObservationPassed({
      didUri                  : observation.didUri,
      foreign                 : foreignWorker,
      foreignOrigin           : foreignApp.origin,
      foreignRejectionsAfter  : foreignWorkerRejectionsAfter,
      foreignRejectionsBefore : foreignWorkerRejectionsBefore,
      foreignUpstreamRequests : foreignWorkerUpstreamRequests,
      gatewayUri              : adapter.endpoint,
      origin                  : app.origin,
      probe                   : workerProbe,
      probeRejectionsAfter,
      probeRejectionsBefore,
      probeUpstreamRequests,
      sibling                 : siblingWorkerProbe,
      siblingRejectionsAfter,
      siblingRejectionsBefore,
      siblingUpstreamRequests,
    });
    const foreignWorkerRequest = workerOwnedRequests(foreignWorker.browserRequests)[0];
    checks.push({
      details: {
        actorSubstitutionRejected  : workerProbe.actorSubstitutionRejected,
        foreignBootstrapLocked     : foreignWorker.bootstrapLocked,
        foreignConfigured          : foreignWorker.configured,
        foreignError               : foreignWorker.resolutionError,
        foreignOrigin              : foreignApp.origin,
        foreignRejectionsAfter     : foreignWorkerRejectionsAfter,
        foreignRejectionsBefore    : foreignWorkerRejectionsBefore,
        foreignUpstreamAfter       : upstreamRequestObservations.length,
        foreignUpstreamBefore      : foreignWorkerUpstreamIndex,
        foreignWorkerScriptPath    : new URL(foreignWorker.scriptUrl).pathname,
        foreignWorkerRequestMethod : foreignWorkerRequest?.method ?? '',
        foreignWorkerRequestPath   : foreignWorkerRequest === undefined ? '' : new URL(foreignWorkerRequest.url).pathname,
        foreignWorkerRequestOwner  : foreignWorkerRequest?.serviceWorkerOwned ?? false,
        foreignWorkerRequestWorker : foreignWorkerRequest?.serviceWorkerUrl === undefined ||
          foreignWorkerRequest.serviceWorkerUrl === '' ? '' : new URL(foreignWorkerRequest.serviceWorkerUrl).pathname,
        malformedCommandRejected : workerProbe.malformedCommandRejected,
        oversizedCommandRejected : workerProbe.oversizedCommandRejected,
        probeRejectionsAfter,
        probeRejectionsBefore,
        probeUpstreamAfter       : probeUpstreamIndex + probeUpstreamRequests.length,
        probeUpstreamBefore      : probeUpstreamIndex,
        siblingRejectionsAfter,
        siblingRejectionsBefore,
        siblingUnconfiguredError : siblingWorkerProbe.unconfiguredError,
        siblingUpstreamAfter     : siblingUpstreamIndex + siblingUpstreamRequests.length,
        siblingUpstreamBefore    : siblingUpstreamIndex,
        unconfiguredError        : workerProbe.unconfiguredError,
      },
      id      : 'A03-service-worker-did-containment',
      status  : workerContainmentPassed ? 'pass' : 'fail',
      summary : workerContainmentPassed
        ? 'Malformed, substituted, unconfigured sibling, and foreign service-worker traffic stayed upstream-isolated'
        : 'One or more denied service-worker DID paths reached the gateway upstream or did not fail closed',
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
      summary : 'Default agent, auth, and API DID network propagation requires the released Enbox #1726 package cohort',
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
  serviceWorkerContainmentObservationPassed,
  serviceWorkerNetworkObservationPassed,
};
