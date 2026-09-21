import type { LabProofReport } from '../src/proof-result.js';
import type { PkarrFetch } from '../src/pkarr-publication-adapter.js';
import type {
  BrowserDidTransportDependencies,
  PrivateBrowserDidProofDependencies,
} from '../src/proofs/did-browser/did-browser-proof.js';
import type {
  PrivatePkarrTestnetCleanup,
  PrivatePkarrTestnetEvidence,
} from '../src/runtime/private-pkarr-testnet.js';

import { describe, expect, it } from 'bun:test';

import { createProofReport } from '../src/proof-result.js';
import { parseDidServiceWorkerRequest } from '../src/proofs/did-browser/fixture/did-service-worker-protocol.js';
import { browserDidProofInternals, runPrivateBrowserDidProof } from '../src/proofs/did-browser/did-browser-proof.js';

const TEST_DID_IDENTIFIER = 'y'.repeat(52);
const TEST_DID_URI = `did:dht:${TEST_DID_IDENTIFIER}`;

type TransportHarnessOptions = {
  allowedReadStatus?: number;
  cleanupFailures?: ReadonlySet<string>;
  foreignUpstreamRequests?: number;
  launchError?: string;
  published?: boolean;
  putRejected?: boolean;
  rejectionCount?: number;
  resolvedDid?: string;
  resolvedDwnEndpoint?: string;
  secureContext?: boolean;
  subresourceRejected?: boolean;
  workerActorSubstitutionRejected?: boolean;
  workerAllowedResolvedDid?: string;
  workerBootstrapLocked?: boolean;
  workerConfigured?: boolean;
  workerForeignBootstrapLocked?: boolean;
  workerForeignConfigured?: boolean;
  workerForeignError?: string;
  workerForeignReconfigurationRejected?: boolean;
  workerForeignRejectionIncrement?: number;
  workerForeignPublicFallbackRequest?: boolean;
  workerForeignRequestServiceWorkerOwned?: boolean;
  workerForeignRequestWorkerUrl?: string;
  workerForeignUpstreamRequests?: number;
  workerMalformedCommandRejected?: boolean;
  workerNetworkRejectionIncrement?: number;
  workerOversizedCommandRejected?: boolean;
  workerProbeRejectionIncrement?: number;
  workerProbeGatewayRequests?: number;
  workerProbeBootstrapLocked?: boolean;
  workerProbePublicFallbackRequest?: boolean;
  workerProbeUpstreamRequests?: number;
  workerReconfigurationRejected?: boolean;
  workerPublicFallbackRequest?: boolean;
  workerRequestServiceWorkerOwned?: boolean;
  workerRequestWorkerUrl?: string;
  workerSiblingBootstrapLocked?: boolean;
  workerSiblingGatewayRequests?: number;
  workerSiblingPublicFallbackRequest?: boolean;
  workerSiblingRejectionIncrement?: number;
  workerSiblingUnconfiguredError?: string;
  workerSiblingUpstreamRequests?: number;
  workerUnconfiguredError?: string;
  workerUpstreamRequests?: number;
};

type WorkerProbe = {
  actorSubstitutionRejected: boolean;
  bootstrapLocked: boolean;
  browserRequests: Array<{ method: string; serviceWorkerOwned: boolean; serviceWorkerUrl: string; url: string }>;
  malformedCommandRejected: boolean;
  oversizedCommandRejected: boolean;
  scriptUrl: string;
  unconfiguredError: string;
};

type WorkerResolution = {
  bootstrapLocked: boolean;
  browserRequests: Array<{ method: string; serviceWorkerOwned: boolean; serviceWorkerUrl: string; url: string }>;
  configured: boolean;
  reconfigurationRejected: boolean;
  resolutionError: string;
  resolvedDid: string;
  scriptUrl: string;
};

function transportHarness(options: TransportHarnessOptions = {}): {
  cleanupCalls: string[];
  dependencies: BrowserDidTransportDependencies;
} {
  const cleanupCalls: string[] = [];
  const origins = ['http://127.0.0.1:41001', 'http://127.0.0.1:41002'];
  let originIndex = 0;
  let rejections = 0;
  let adapterFetch: PkarrFetch | undefined;
  const cleanup = async (name: string): Promise<void> => {
    cleanupCalls.push(name);
    if (options.cleanupFailures?.has(name) === true) {
      throw new Error(`${name} cleanup failed`);
    }
  };
  const callUpstream = async (url = 'http://upstream.invalid/key'): Promise<void> => {
    if (adapterFetch === undefined) {
      throw new Error('adapter fetch was not installed');
    }
    await adapterFetch(url);
  };
  const browserRequest = (url: string, serviceWorkerUrl: string, serviceWorkerOwned = true): {
    method: string;
    serviceWorkerOwned: boolean;
    serviceWorkerUrl: string;
    url: string;
  } => ({ method: 'GET', serviceWorkerOwned, serviceWorkerUrl: serviceWorkerOwned ? serviceWorkerUrl : '', url });
  const dependencies: BrowserDidTransportDependencies = {
    buildWorkerBundle : async (): Promise<string> => '/test/did-service-worker.js',
    createDirectory   : async (): Promise<string> => '/tmp/browser-proof-test',
    findExecutable    : (): string => '/test/chromium',
    launchDriver      : async () => {
      if (options.launchError !== undefined) {
        throw new Error(options.launchError);
      }
      return {
        allowedReadStatus: async (): Promise<number> => {
          await callUpstream();
          return options.allowedReadStatus ?? 200;
        },
        attemptForeignServiceWorker: async (origin, didUri): Promise<WorkerResolution> => {
          for (let index = 0; index < (options.workerForeignUpstreamRequests ?? 0); index += 1) {
            await callUpstream(`http://127.0.0.1:41004/${didUri.split(':').at(-1) ?? ''}`);
          }
          rejections += options.workerForeignRejectionIncrement ?? 1;
          return {
            bootstrapLocked : options.workerForeignBootstrapLocked ?? true,
            browserRequests : [
              browserRequest(
                `http://127.0.0.1:41003/${didUri.split(':').at(-1) ?? ''}`,
                options.workerForeignRequestWorkerUrl ?? `${origin}/did-service-worker.mjs`,
                options.workerForeignRequestServiceWorkerOwned ?? true,
              ),
              ...(options.workerForeignPublicFallbackRequest === true
                ? [browserRequest(
                  `https://diddht.tbddev.org/${TEST_DID_IDENTIFIER}`,
                  `${origin}/did-service-worker.mjs`,
                )] : []),
            ],
            configured              : options.workerForeignConfigured ?? true,
            reconfigurationRejected : options.workerForeignReconfigurationRejected ?? true,
            resolutionError         : options.workerForeignError ?? 'resolution-failed',
            resolvedDid             : '',
            scriptUrl               : `${origin}/did-service-worker.mjs`,
          };
        },
        attemptForeignRequests: async (): Promise<{
          putError: string;
          putRejected: boolean;
          subresourceRejected: boolean;
        }> => {
          rejections = options.rejectionCount ?? 2;
          for (let index = 0; index < (options.foreignUpstreamRequests ?? 0); index += 1) {
            await callUpstream();
          }
          return {
            putError            : 'TypeError: Failed to fetch',
            putRejected         : options.putRejected ?? true,
            subresourceRejected : options.subresourceRejected ?? true,
          };
        },
        close              : async (): Promise<void> => { await cleanup('driver'); },
        probeServiceWorker : async (origin): Promise<WorkerProbe> => {
          for (let index = 0; index < (options.workerProbeUpstreamRequests ?? 0); index += 1) {
            await callUpstream();
          }
          rejections += options.workerProbeRejectionIncrement ?? 0;
          return {
            actorSubstitutionRejected : options.workerActorSubstitutionRejected ?? true,
            bootstrapLocked           : options.workerProbeBootstrapLocked ?? true,
            browserRequests           : [
              ...Array.from({ length: options.workerProbeGatewayRequests ?? 0 }, () => (
                browserRequest(
                  `http://127.0.0.1:41003/${TEST_DID_IDENTIFIER}`,
                  `${origin}/did-service-worker.mjs`,
                )
              )),
              ...(options.workerProbePublicFallbackRequest === true
                ? [browserRequest(
                  `https://diddht.tbddev.org/${TEST_DID_IDENTIFIER}`,
                  `${origin}/did-service-worker.mjs`,
                )] : []),
            ],
            malformedCommandRejected : options.workerMalformedCommandRejected ?? true,
            oversizedCommandRejected : options.workerOversizedCommandRejected ?? true,
            scriptUrl                : `${origin}/did-service-worker.mjs`,
            unconfiguredError        : options.workerUnconfiguredError ?? 'worker-unconfigured',
          };
        },
        probeSiblingServiceWorker: async (origin): Promise<WorkerProbe> => {
          for (let index = 0; index < (options.workerSiblingUpstreamRequests ?? 0); index += 1) {
            await callUpstream();
          }
          rejections += options.workerSiblingRejectionIncrement ?? 0;
          return {
            actorSubstitutionRejected : true,
            bootstrapLocked           : options.workerSiblingBootstrapLocked ?? true,
            browserRequests           : [
              ...Array.from({ length: options.workerSiblingGatewayRequests ?? 0 }, () => (
                browserRequest(
                  `http://127.0.0.1:41003/${TEST_DID_IDENTIFIER}`,
                  `${origin}/did-service-worker.mjs`,
                )
              )),
              ...(options.workerSiblingPublicFallbackRequest === true
                ? [browserRequest(
                  `https://diddht.tbddev.org/${TEST_DID_IDENTIFIER}`,
                  `${origin}/did-service-worker.mjs`,
                )] : []),
            ],
            malformedCommandRejected : true,
            oversizedCommandRejected : true,
            scriptUrl                : `${origin}/did-service-worker.mjs`,
            unconfiguredError        : options.workerSiblingUnconfiguredError ?? 'worker-unconfigured',
          };
        },
        publishAndResolve: async (): Promise<{
          didUri: string;
          published: boolean;
          resolvedDid: string;
          resolvedDwnEndpoint: string;
          secureContext: boolean;
        }> => {
          await callUpstream();
          return {
            didUri              : TEST_DID_URI,
            published           : options.published ?? true,
            resolvedDid         : options.resolvedDid ?? TEST_DID_URI,
            resolvedDwnEndpoint : options.resolvedDwnEndpoint ?? 'http://localhost:41000',
            secureContext       : options.secureContext ?? true,
          };
        },
        resolveFromServiceWorker: async (origin, didUri): Promise<WorkerResolution> => {
          for (let index = 0; index < (options.workerUpstreamRequests ?? 1); index += 1) {
            await callUpstream(`http://127.0.0.1:41004/${didUri.split(':').at(-1) ?? ''}`);
          }
          rejections += options.workerNetworkRejectionIncrement ?? 0;
          return {
            bootstrapLocked : options.workerBootstrapLocked ?? true,
            browserRequests : [
              browserRequest(
                `http://127.0.0.1:41003/${didUri.split(':').at(-1) ?? ''}`,
                options.workerRequestWorkerUrl ?? `${origin}/did-service-worker.mjs`,
                options.workerRequestServiceWorkerOwned ?? true,
              ),
              ...(options.workerPublicFallbackRequest === true
                ? [browserRequest(
                  `https://diddht.tbddev.org/${TEST_DID_IDENTIFIER}`,
                  `${origin}/did-service-worker.mjs`,
                )] : []),
            ],
            configured              : options.workerConfigured ?? true,
            reconfigurationRejected : options.workerReconfigurationRejected ?? true,
            resolutionError         : '',
            resolvedDid             : options.workerAllowedResolvedDid ?? didUri,
            scriptUrl               : `${origin}/did-service-worker.mjs`,
          };
        },
        version: (): string => 'test-browser',
      };
    },
    removeDirectory : async (): Promise<void> => { await cleanup('directory'); },
    resolveBundle   : (): string => '/test/dids.mjs',
    startAdapter    : async (adapterOptions) => {
      adapterFetch = adapterOptions.fetch;
      return {
        browserRejectionCount : (): number => rejections,
        endpoint              : 'http://127.0.0.1:41003/',
        resolverEndpoint      : (): undefined => undefined,
        resolverObservation   : (): { admitted: number; rejected: number } => ({ admitted: 0, rejected: 0 }),
        restoreResults        : [],
        stop                  : async (): Promise<void> => { await cleanup('adapter'); },
      };
    },
    startOrigin: (): { configureGateway(gatewayUri: string): void; origin: string; stop(): Promise<void> } => {
      const origin = origins[originIndex++]!;
      const name = originIndex === 1 ? 'allowed-origin' : 'foreign-origin';
      let gateway: string | undefined;
      return {
        configureGateway: (gatewayUri): void => {
          if (gateway !== undefined && gateway !== gatewayUri) {
            throw new Error('gateway changed');
          }
          gateway = gatewayUri;
        },
        origin,
        stop: async (): Promise<void> => { await cleanup(name); },
      };
    },
    upstreamFetch: async (): Promise<Response> => new Response(undefined, { status: 200 }),
  };
  return { cleanupCalls, dependencies };
}

function passingEvidence(): PrivatePkarrTestnetEvidence {
  return {
    attachedNetworks    : ['proof-network'],
    command             : ['pkarr-relay', '--testnet'],
    containerImage      : 'digest-image',
    displayName         : 'Browser DID Proof',
    dockerVersion       : 'test-docker',
    egressMasquerading  : false,
    imageArchitecture   : 'amd64',
    imageDigest         : 'digest-image',
    imageDigestRecorded : true,
    imageId             : 'image-id',
    imageOs             : 'linux',
    labId               : 'lab-id',
    nativeImage         : true,
    ownedNetwork        : true,
    ownerId             : 'owner-id',
    runId               : 'run-id',
    verified            : true,
  };
}

function cleanup(passed = true): PrivatePkarrTestnetCleanup {
  return {
    containerName : 'proof-container',
    errors        : passed ? [] : ['cleanup uncertain'],
    networkName   : 'proof-network',
    ownerId       : 'owner-id',
    passed,
    runId         : 'run-id',
  };
}

function privateProofDependencies(params: {
  cleanupPassed?: boolean;
  evidenceVerified?: boolean;
  onRunTransport?: () => void;
  startError?: string;
} = {}): PrivateBrowserDidProofDependencies {
  return {
    createTestnet: () => ({
      evidence: async (): Promise<PrivatePkarrTestnetEvidence> => ({
        ...passingEvidence(),
        verified: params.evidenceVerified ?? true,
      }),
      inspectDockerEngine : async () => ({ exitCode: 0, stderr: '', stdout: 'docker' }),
      logs                : async () => ({ exitCode: 0, stderr: '', stdout: 'relay log' }),
      start               : async (): Promise<{ containerId: string; endpoint: string }> => {
        if (params.startError !== undefined) {
          throw new Error(params.startError);
        }
        return { containerId: 'container-id', endpoint: 'http://127.0.0.1:41004/' };
      },
      stop: async (): Promise<PrivatePkarrTestnetCleanup> => cleanup(params.cleanupPassed ?? true),
    }),
    runTransport: async (options): Promise<LabProofReport> => {
      params.onRunTransport?.();
      return createProofReport({
        checks: [
          {
            id      : 'transport-check',
            status  : 'pass',
            summary : `used ${options.upstreamBaseUrl}`,
          },
          {
            id      : 'A03-service-worker-did-containment',
            status  : 'pass',
            summary : 'worker contained',
          },
          {
            id      : 'A10-service-worker-private-did-network-subcheck',
            status  : 'pass',
            summary : 'worker resolved',
          },
        ],
        finishedAt : new Date('2026-09-20T12:00:00.000Z'),
        proof      : 'p0-browser-did-transport',
        startedAt  : new Date('2026-09-20T12:00:00.000Z'),
      });
    },
  };
}

describe('Browser private DID proof verdicts', () => {
  it('should preserve a missing explicit browser as unsupported without opening resources', async () => {
    const report = await browserDidProofInternals.runBrowserDidTransportProof({
      browserExecutablePath : '/definitely/missing/chromium',
      now                   : (): Date => new Date('2026-09-20T12:00:00.000Z'),
      upstreamBaseUrl       : 'http://127.0.0.1:1/',
    });

    expect(report.proof).toBe('p0-browser-did-transport');
    expect(report.status).toBe('unsupported');
    expect(report.checks).toEqual([
      expect.objectContaining({ id: 'A04-browser-runtime', status: 'unsupported' }),
      expect.objectContaining({ id: 'browser-did-proof-cleanup', status: 'pass' }),
    ]);
  });

  it('should deterministically compose successful browser and origin evidence', async () => {
    const harness = transportHarness();
    const report = await browserDidProofInternals.runBrowserDidTransportProof({
      upstreamBaseUrl: 'http://127.0.0.1:41004/',
    }, harness.dependencies);

    expect(report.status).toBe('pass');
    expect(report.checks).toEqual([
      expect.objectContaining({ id: 'A10-browser-direct-did-network-subcheck', status: 'pass' }),
      expect.objectContaining({
        details : expect.objectContaining({ rejectionsAfter: 2, rejectionsBefore: 0, upstreamRequestsAfter: 2 }),
        id      : 'A03-browser-did-origin-allowlist-subcheck',
        status  : 'pass',
      }),
      expect.objectContaining({
        details: expect.objectContaining({
          bootstrapLocked            : true,
          configured                 : true,
          reconfigurationRejected    : true,
          upstreamRequestsAfter      : 3,
          upstreamRequestsBefore     : 2,
          workerLookupMethod         : 'GET',
          workerLookupPath           : `/${TEST_DID_IDENTIFIER}`,
          workerRejectionsAfter      : 2,
          workerRejectionsBefore     : 2,
          workerRequestMethod        : 'GET',
          workerRequestServiceWorker : true,
        }),
        id     : 'A10-service-worker-private-did-network-subcheck',
        status : 'pass',
      }),
      expect.objectContaining({
        details: expect.objectContaining({
          actorSubstitutionRejected : true,
          foreignRejectionsAfter    : 3,
          foreignRejectionsBefore   : 2,
          foreignUpstreamAfter      : 3,
          foreignUpstreamBefore     : 3,
          malformedCommandRejected  : true,
          oversizedCommandRejected  : true,
          probeRejectionsAfter      : 2,
          probeRejectionsBefore     : 2,
        }),
        id     : 'A03-service-worker-did-containment',
        status : 'pass',
      }),
      expect.objectContaining({ id: 'browser-did-proof-cleanup', status: 'pass' }),
    ]);
    expect(harness.cleanupCalls).toEqual(['driver', 'adapter', 'allowed-origin', 'foreign-origin', 'directory']);
  });

  it('should fail the origin verdict when a rejected request reaches upstream', async () => {
    const harness = transportHarness({ foreignUpstreamRequests: 1 });
    const report = await browserDidProofInternals.runBrowserDidTransportProof({
      upstreamBaseUrl: 'http://127.0.0.1:41004/',
    }, harness.dependencies);

    expect(report.checks).toContainEqual(expect.objectContaining({
      details : expect.objectContaining({ foreignReachedUpstream: true }),
      id      : 'A03-browser-did-origin-allowlist-subcheck',
      status  : 'fail',
    }));
    expect(report.status).toBe('fail');
  });

  it('should independently fail the service-worker network verdict on incomplete positive evidence', async () => {
    for (const options of [
      { workerUpstreamRequests: 2 },
      { workerNetworkRejectionIncrement: 1 },
      { workerBootstrapLocked: false },
      { workerConfigured: false },
      { workerAllowedResolvedDid: '' },
      { workerReconfigurationRejected: false },
      { workerPublicFallbackRequest: true },
      { workerRequestServiceWorkerOwned: false },
      { workerRequestWorkerUrl: 'http://127.0.0.1:41001/other-worker.mjs' },
    ]) {
      const harness = transportHarness(options);
      const report = await browserDidProofInternals.runBrowserDidTransportProof({
        upstreamBaseUrl: 'http://127.0.0.1:41004/',
      }, harness.dependencies);
      expect(report.checks).toContainEqual(expect.objectContaining({
        id     : 'A10-service-worker-private-did-network-subcheck',
        status : 'fail',
      }));
      expect(report.checks).toContainEqual(expect.objectContaining({
        id     : 'A03-service-worker-did-containment',
        status : 'pass',
      }));
      expect(report.status).toBe('fail');
    }
  });

  it('should independently fail worker containment on incomplete denial evidence', async () => {
    for (const options of [
      { workerActorSubstitutionRejected: false },
      { workerForeignError: '' },
      { workerForeignPublicFallbackRequest: true },
      { workerForeignRejectionIncrement: 0 },
      { workerForeignRequestServiceWorkerOwned: false },
      { workerForeignRequestWorkerUrl: 'http://127.0.0.1:41002/other-worker.mjs' },
      { workerForeignUpstreamRequests: 1 },
      { workerMalformedCommandRejected: false },
      { workerOversizedCommandRejected: false },
      { workerProbeGatewayRequests: 1 },
      { workerProbeBootstrapLocked: false },
      { workerProbePublicFallbackRequest: true },
      { workerProbeRejectionIncrement: 1 },
      { workerProbeUpstreamRequests: 1 },
      { workerSiblingBootstrapLocked: false },
      { workerSiblingGatewayRequests: 1 },
      { workerSiblingPublicFallbackRequest: true },
      { workerSiblingRejectionIncrement: 1 },
      { workerSiblingUnconfiguredError: '' },
      { workerSiblingUpstreamRequests: 1 },
      { workerUnconfiguredError: '' },
    ]) {
      const harness = transportHarness(options);
      const report = await browserDidProofInternals.runBrowserDidTransportProof({
        upstreamBaseUrl: 'http://127.0.0.1:41004/',
      }, harness.dependencies);
      expect(report.checks).toContainEqual(expect.objectContaining({
        id     : 'A03-service-worker-did-containment',
        status : 'fail',
      }));
      expect(report.checks).toContainEqual(expect.objectContaining({
        id     : 'A10-service-worker-private-did-network-subcheck',
        status : 'pass',
      }));
      expect(report.status).toBe('fail');
    }
  });

  it('should accept only exact bounded service-worker commands', () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    const configure = {
      actorOrigin : 'http://127.0.0.1:41001',
      gatewayUri  : 'http://127.0.0.1:41003/',
      id,
      kind        : 'configure',
    } as const;
    const resolve = { didUri: TEST_DID_URI, id, kind: 'resolve' } as const;
    expect(parseDidServiceWorkerRequest(configure)).toEqual(configure);
    expect(parseDidServiceWorkerRequest(resolve)).toEqual(resolve);

    for (const invalid of [
      { ...configure, extra: true },
      { ...configure, actorOrigin: 'not-an-origin' },
      { ...configure, actorOrigin: 'http://127.0.0.1:41001/path' },
      { ...configure, actorOrigin: `http://127.0.0.1/${'x'.repeat(257)}` },
      { ...configure, gatewayUri: 'not-a-gateway' },
      { ...configure, gatewayUri: `http://127.0.0.1/${'x'.repeat(2_049)}/` },
      { ...configure, gatewayUri: 'http://user@127.0.0.1:41003/' },
      { ...configure, id: 'not-a-request-id' },
      { ...resolve, didUri: 'did:dht:not-valid' },
      { ...resolve, extra: true },
      { id, kind: 'unsupported' },
      null,
    ]) {
      expect(parseDidServiceWorkerRequest(invalid)).toBeUndefined();
    }
  });

  it('should reject every incomplete DID and origin observation', () => {
    const didObservation = {
      didUri              : TEST_DID_URI,
      published           : true,
      resolvedDid         : TEST_DID_URI,
      resolvedDwnEndpoint : 'http://localhost:41000',
      secureContext       : true,
    };
    expect(browserDidProofInternals.didObservationPassed(didObservation, 'http://localhost:41000')).toBe(true);
    for (const changed of [
      { published: false },
      { resolvedDid: `did:dht:${'o'.repeat(52)}` },
      { resolvedDwnEndpoint: 'http://localhost:42000' },
      { secureContext: false },
    ]) {
      expect(browserDidProofInternals.didObservationPassed({ ...didObservation, ...changed }, 'http://localhost:41000')).toBe(false);
    }

    const originObservation = {
      allowedReadStatus      : 200,
      foreign                : { putError: 'blocked', putRejected: true, subresourceRejected: true },
      rejectionsAfter        : 2,
      rejectionsBefore       : 0,
      upstreamRequestsAfter  : 4,
      upstreamRequestsBefore : 3,
    };
    expect(browserDidProofInternals.originObservationPassed(originObservation)).toBe(true);
    for (const changed of [
      { allowedReadStatus: 503 },
      { foreign: { ...originObservation.foreign, putRejected: false } },
      { foreign: { ...originObservation.foreign, subresourceRejected: false } },
      { rejectionsAfter: 1 },
      { upstreamRequestsAfter: 5 },
    ]) {
      expect(browserDidProofInternals.originObservationPassed({ ...originObservation, ...changed })).toBe(false);
    }
  });

  it('should report execution and every cleanup failure without skipping later cleanup', async () => {
    const executionHarness = transportHarness({ launchError: 'browser failed' });
    const execution = await browserDidProofInternals.runBrowserDidTransportProof({
      upstreamBaseUrl: 'http://127.0.0.1:41004/',
    }, executionHarness.dependencies);
    expect(execution.checks).toContainEqual(expect.objectContaining({ id: 'browser-did-proof-execution', status: 'fail' }));
    expect(execution.checks).toContainEqual(expect.objectContaining({ id: 'browser-did-proof-cleanup', status: 'pass' }));

    const cleanupHarness = transportHarness({
      cleanupFailures: new Set(['driver', 'adapter', 'allowed-origin', 'foreign-origin', 'directory']),
    });
    const cleanupReport = await browserDidProofInternals.runBrowserDidTransportProof({
      upstreamBaseUrl: 'http://127.0.0.1:41004/',
    }, cleanupHarness.dependencies);
    const cleanupCheck = cleanupReport.checks.find((check): boolean => check.id === 'browser-did-proof-cleanup');
    expect(cleanupCheck).toMatchObject({ status: 'fail' });
    expect(JSON.parse(String(cleanupCheck?.details?.errors))).toHaveLength(5);
    expect(cleanupHarness.cleanupCalls).toEqual(['driver', 'adapter', 'allowed-origin', 'foreign-origin', 'directory']);
  });

  it('should compose the owned boundary and keep the unfinished default-runtime path explicit', async () => {
    const report = await browserDidProofInternals.runPrivateBrowserDidProofWithDependencies(
      { now: (): Date => new Date('2026-09-20T12:00:00.000Z') },
      privateProofDependencies(),
    );

    expect(report.status).toBe('unsupported');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'A06-browser-private-testnet', status: 'pass' }),
      expect.objectContaining({ id: 'transport-check', status: 'pass' }),
      expect.objectContaining({ id: 'A10-default-runtime-did-network', status: 'unsupported' }),
      expect.objectContaining({ id: 'A03-service-worker-did-containment', status: 'pass' }),
      expect.objectContaining({ id: 'A10-service-worker-private-did-network-subcheck', status: 'pass' }),
      expect.objectContaining({ id: 'browser-private-did-runtime-cleanup', status: 'pass' }),
    ]));
  });

  it('should preserve execution and cleanup failures in the owned boundary report', async () => {
    const execution = await browserDidProofInternals.runPrivateBrowserDidProofWithDependencies(
      {},
      privateProofDependencies({ startError: 'relay start failed' }),
    );
    expect(execution.checks).toContainEqual(expect.objectContaining({
      details : expect.objectContaining({ relayLogs: 'relay log' }),
      id      : 'browser-private-did-runtime-execution',
      status  : 'fail',
    }));

    const cleanupFailure = await browserDidProofInternals.runPrivateBrowserDidProofWithDependencies(
      {},
      privateProofDependencies({ cleanupPassed: false }),
    );
    expect(cleanupFailure.checks).toContainEqual(expect.objectContaining({
      id     : 'browser-private-did-runtime-cleanup',
      status : 'fail',
    }));
    expect(cleanupFailure.status).toBe('fail');
  });

  it('should refuse to launch Chromium against an unverified testnet', async () => {
    let transportRuns = 0;
    const report = await browserDidProofInternals.runPrivateBrowserDidProofWithDependencies(
      {},
      privateProofDependencies({
        evidenceVerified : false,
        onRunTransport   : (): number => transportRuns += 1,
      }),
    );

    expect(transportRuns).toBe(0);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'A06-browser-private-testnet', status: 'fail' }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'browser-private-did-runtime-execution', status: 'fail' }));
    expect(report.status).toBe('fail');
  });

  it('should preserve an unavailable Docker engine as unsupported', async () => {
    const report = await runPrivateBrowserDidProof({
      now     : (): Date => new Date('2026-09-20T12:00:00.000Z'),
      testnet : {
        runCommand: async (): Promise<{ exitCode: number; stderr: string; stdout: string }> => ({
          exitCode : 1,
          stderr   : 'daemon unavailable',
          stdout   : '',
        }),
      },
    });

    expect(report.proof).toBe('p0-browser-private-did-boundary');
    expect(report.status).toBe('unsupported');
    expect(report.checks).toEqual([
      expect.objectContaining({ id: 'A04-browser-did-docker', status: 'unsupported' }),
    ]);
  });
});
