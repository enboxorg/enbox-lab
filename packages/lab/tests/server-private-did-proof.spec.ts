import type { DidServerRuntimeStopEvidence } from '../src/proofs/did-server/did-server-runtime.js';
import type { ServerPrivateDidObservation } from '../src/proofs/did-server/server-private-did-proof.js';
import type { PrivatePkarrRelay, PrivatePkarrTestnetCleanup } from '../src/runtime/private-pkarr-testnet.js';

import { describe, expect, it } from 'bun:test';

import {
  serverPrivateDidProofInternals,
  serverPrivateDidVerdicts,
} from '../src/proofs/did-server/server-private-did-proof.js';

type ProofDependencies = Parameters<typeof serverPrivateDidProofInternals.runServerPrivateDidProofWithDependencies>[1];
type ProofRuntime = Awaited<ReturnType<ProofDependencies['createRuntime']>>;
type ProofRuntimeEvidence = Awaited<ReturnType<ProofRuntime['start']>>;
type ProofTestnet = ReturnType<ProofDependencies['createTestnet']>;
type TrackedAdapter = Awaited<ReturnType<ProofDependencies['startAdapter']>>;

type HarnessOptions = Readonly<{
  adapterStartFailure?: 'a' | 'b';
  cleanupFailures?: ReadonlySet<string>;
  dockerUnavailable?: boolean;
  executeFailure?: boolean;
  ownershipCollision?: boolean;
  runtimeCreateFailure?: 'a' | 'b';
  runtimeStartFailure?: 'a' | 'b';
  testnetStartFailure?: 'a' | 'b';
  unverified?: 'a' | 'b';
}>;

const KNOWN_CAPABILITY = 'a'.repeat(64);
const KNOWN_RESOLVER_A = `http://127.0.0.1:41001/__lab/resolver/${KNOWN_CAPABILITY}/`;
const KNOWN_RESOLVER_B = `http://127.0.0.1:41002/__lab/resolver/${'b'.repeat(64)}/`;

function passingObservation(): ServerPrivateDidObservation {
  return {
    crossLab: {
      boundaryExact         : true,
      didResolutionError    : 'notFound',
      errorCode             : 'GeneralJwsVerifierGetPublicKeyNotFound',
      jwkBoundaryQuiet      : true,
      jwkEntries            : 0,
      jwkNoRejectedRequests : true,
      jwkStatusCode         : 200,
      noRejectedRequests    : true,
      publicKeyFailure      : 'didResolution',
      statusCode            : 401,
    },
    ingress: {
      boundaryExact           : true,
      entries                 : 0,
      messagesDistinct        : true,
      noRejectedRequests      : true,
      publicationAOnly        : true,
      publicationAcknowledged : true,
      statusCode              : 200,
    },
    signature: {
      boundaryExact      : true,
      errorCode          : 'GeneralJwsVerifierInvalidSignature',
      noRejectedRequests : true,
      statusCode         : 401,
    },
    testnets: {
      containerIdsDistinct       : true,
      labIdsDistinct             : true,
      networkNamesDistinct       : true,
      ownerIdsDistinct           : true,
      runIdsDistinct             : true,
      runtimeContractsValid      : true,
      runtimePidsDistinct        : true,
      storageDirectoriesDistinct : true,
      verified                   : true,
    },
  };
}

function failedObservationFact(
  section: keyof ServerPrivateDidObservation,
  key: string,
  value: boolean | number | string,
): ServerPrivateDidObservation {
  const observation = structuredClone(passingObservation()) as unknown as Record<string, Record<string, unknown>>;
  observation[section][key] = value;
  return observation as unknown as ServerPrivateDidObservation;
}

function cleanup(slot: 'a' | 'b', passed = true): PrivatePkarrTestnetCleanup {
  return {
    containerName : `container-${slot}`,
    errors        : passed ? [] : ['secret-bearing cleanup failure'],
    networkName   : `network-${slot}`,
    ownerId       : `owner-${slot}`,
    passed,
    runId         : `run-${slot}`,
  };
}

function runtimeCleanup(slot: 'a' | 'b'): DidServerRuntimeStopEvidence {
  return {
    backendOrigin  : `http://127.0.0.1:${slot === 'a' ? 43001 : 43002}`,
    origin         : `http://127.0.0.1:${slot === 'a' ? 42001 : 42002}`,
    portClosed     : true,
    storageRemoved : true,
    stopped        : true,
  };
}

function proofHarness(options: HarnessOptions = {}): Readonly<{
  dependencies: ProofDependencies;
  events: string[];
  maxConcurrentRuntimeStarts(): number;
  runtimeStarts: string[];
}> {
  let activeRuntimeStarts = 0;
  const events: string[] = [];
  let maxConcurrentRuntimeStarts = 0;
  const runtimeStarts: string[] = [];
  const cleanupFailures = options.cleanupFailures ?? new Set<string>();
  const dependencies: ProofDependencies = {
    createDirectory: async (prefix): Promise<string> => {
      const slot = prefix.includes('-a-') ? 'a' : 'b';
      return `/tmp/server-private-did-${slot}`;
    },
    createRuntime: async (slot, resolverEndpoint) => {
      expect(resolverEndpoint).toBe(slot === 'a' ? KNOWN_RESOLVER_A : KNOWN_RESOLVER_B);
      if (options.runtimeCreateFailure === slot) {
        throw new Error(`${resolverEndpoint}: create failed`);
      }
      return {
        forceDispose: async (): Promise<DidServerRuntimeStopEvidence> => {
          events.push(`children:${slot}:force`);
          if (cleanupFailures.has(`children:${slot}`)) { throw new Error(`${resolverEndpoint}: secret`); }
          return runtimeCleanup(slot);
        },
        start: async (): Promise<ProofRuntimeEvidence> => {
          runtimeStarts.push(slot);
          activeRuntimeStarts += 1;
          maxConcurrentRuntimeStarts = Math.max(maxConcurrentRuntimeStarts, activeRuntimeStarts);
          await Promise.resolve();
          activeRuntimeStarts -= 1;
          if (options.runtimeStartFailure === slot) {
            throw new Error(`DidServerRuntime: ${resolverEndpoint}: start failed`);
          }
          return {
            childArgumentsContainResolverBaseUri    : false as const,
            childEnvironmentContainsResolverBaseUri : false as const,
            childPid                                : slot === 'a' ? 10_001 : 10_002,
            origin                                  : `http://127.0.0.1:${slot === 'a' ? 42001 : 42002}`,
            packageName                             : '@enbox/dwn-server' as const,
            packageVersion                          : '0.1.43' as const,
            resolverEndpointTransport               : 'stdin-ndjson' as const,
            storageDirectory                        : `/tmp/server-storage-${slot}`,
            storageIsolated                         : true as const,
          };
        },
        stop: async (): Promise<DidServerRuntimeStopEvidence> => {
          events.push(`children:${slot}:stop`);
          if (cleanupFailures.has(`children:${slot}`)) { throw new Error(`${resolverEndpoint}: secret`); }
          return runtimeCleanup(slot);
        },
      };
    },
    createTestnet: (slot): ProofTestnet => {
      const identity = options.ownershipCollision ? 'a' : slot;
      return {
        containerName : `container-${identity}`,
        evidence      : async () => ({
          labId    : `lab-${identity}`,
          ownerId  : `owner-${identity}`,
          runId    : `run-${identity}`,
          verified : options.unverified !== slot,
        }),
        inspectDockerEngine : async () => ({ exitCode: options.dockerUnavailable && slot === 'a' ? 1 : 0 }),
        labId               : `lab-${identity}`,
        networkName         : `network-${identity}`,
        ownerId             : `owner-${identity}`,
        runId               : `run-${identity}`,
        start               : async (): Promise<PrivatePkarrRelay> => {
          if (options.testnetStartFailure === slot) { throw new Error(`testnet ${slot} failed`); }
          return { containerId: `container-id-${slot}`, endpoint: `http://127.0.0.1:4000${slot === 'a' ? 1 : 2}/` };
        },
        stop: async (): Promise<PrivatePkarrTestnetCleanup> => {
          events.push(`testnets:${slot}`);
          if (cleanupFailures.has(`testnets:${slot}`)) { throw new Error(`testnet ${slot} secret`); }
          return cleanup(slot);
        },
      };
    },
    directoryExists : (): boolean => false,
    executeScenario : async () => {
      if (options.executeFailure) { throw new Error(`${KNOWN_RESOLVER_A}: execution failed`); }
      const { crossLab, ingress, signature } = passingObservation();
      return { crossLab, ingress, signature };
    },
    removeDirectory: async (path): Promise<void> => {
      const slot = path.endsWith('-a') ? 'a' : 'b';
      events.push(`directories:${slot}`);
      if (cleanupFailures.has(`directories:${slot}`)) { throw new Error(`${path}: secret`); }
    },
    startAdapter: async ({ slot }) => {
      if (options.adapterStartFailure === slot) { throw new Error(`adapter ${slot} failed`); }
      return {
        publicationEndpoint : `http://127.0.0.1:4400${slot === 'a' ? 1 : 2}/`,
        resolverEndpoint    : (): string => slot === 'a' ? KNOWN_RESOLVER_A : KNOWN_RESOLVER_B,
        resolverObservation : () => ({ admitted: 0, rejected: 0 }),
        stop                : async (): Promise<void> => {
          events.push(`adapters:${slot}`);
          if (cleanupFailures.has(`adapters:${slot}`)) {
            throw new Error(`${slot === 'a' ? KNOWN_RESOLVER_A : KNOWN_RESOLVER_B}: secret`);
          }
        },
        upstreamRequests: () => [],
      };
    },
  };
  return {
    dependencies,
    events,
    maxConcurrentRuntimeStarts: (): number => maxConcurrentRuntimeStarts,
    runtimeStarts,
  };
}

describe('server private DID proof', () => {
  it('should make every required machine observation load-bearing', () => {
    expect(serverPrivateDidVerdicts(passingObservation()).map((check) => check.status)).toEqual([
      'pass',
      'pass',
      'pass',
      'pass',
    ]);

    const mutations: ReadonlyArray<Readonly<{
      checkId: string;
      key: string;
      section: keyof ServerPrivateDidObservation;
      value: boolean | number | string;
    }>> = [
      { checkId: 'A06-server-private-testnets', key: 'containerIdsDistinct', section: 'testnets', value: false },
      { checkId: 'A06-server-private-testnets', key: 'labIdsDistinct', section: 'testnets', value: false },
      { checkId: 'A06-server-private-testnets', key: 'networkNamesDistinct', section: 'testnets', value: false },
      { checkId: 'A06-server-private-testnets', key: 'ownerIdsDistinct', section: 'testnets', value: false },
      { checkId: 'A06-server-private-testnets', key: 'runIdsDistinct', section: 'testnets', value: false },
      { checkId: 'A06-server-private-testnets', key: 'runtimeContractsValid', section: 'testnets', value: false },
      { checkId: 'A06-server-private-testnets', key: 'runtimePidsDistinct', section: 'testnets', value: false },
      { checkId: 'A06-server-private-testnets', key: 'storageDirectoriesDistinct', section: 'testnets', value: false },
      { checkId: 'A06-server-private-testnets', key: 'verified', section: 'testnets', value: false },
      { checkId: 'A03-server-private-did-cross-lab-isolation', key: 'boundaryExact', section: 'crossLab', value: false },
      { checkId: 'A03-server-private-did-cross-lab-isolation', key: 'didResolutionError', section: 'crossLab', value: 'internalError' },
      { checkId: 'A03-server-private-did-cross-lab-isolation', key: 'errorCode', section: 'crossLab', value: 'wrong' },
      { checkId: 'A03-server-private-did-cross-lab-isolation', key: 'jwkBoundaryQuiet', section: 'crossLab', value: false },
      { checkId: 'A03-server-private-did-cross-lab-isolation', key: 'jwkEntries', section: 'crossLab', value: 1 },
      { checkId: 'A03-server-private-did-cross-lab-isolation', key: 'jwkNoRejectedRequests', section: 'crossLab', value: false },
      { checkId: 'A03-server-private-did-cross-lab-isolation', key: 'jwkStatusCode', section: 'crossLab', value: 401 },
      { checkId: 'A03-server-private-did-cross-lab-isolation', key: 'noRejectedRequests', section: 'crossLab', value: false },
      { checkId: 'A03-server-private-did-cross-lab-isolation', key: 'publicKeyFailure', section: 'crossLab', value: 'wrong' },
      { checkId: 'A03-server-private-did-cross-lab-isolation', key: 'statusCode', section: 'crossLab', value: 200 },
      { checkId: 'A10-server-private-did-ingress', key: 'boundaryExact', section: 'ingress', value: false },
      { checkId: 'A10-server-private-did-ingress', key: 'entries', section: 'ingress', value: 1 },
      { checkId: 'A10-server-private-did-ingress', key: 'messagesDistinct', section: 'ingress', value: false },
      { checkId: 'A10-server-private-did-ingress', key: 'noRejectedRequests', section: 'ingress', value: false },
      { checkId: 'A10-server-private-did-ingress', key: 'publicationAOnly', section: 'ingress', value: false },
      { checkId: 'A10-server-private-did-ingress', key: 'publicationAcknowledged', section: 'ingress', value: false },
      { checkId: 'A10-server-private-did-ingress', key: 'statusCode', section: 'ingress', value: 401 },
      { checkId: 'A10-server-private-did-signature-enforcement', key: 'boundaryExact', section: 'signature', value: false },
      { checkId: 'A10-server-private-did-signature-enforcement', key: 'errorCode', section: 'signature', value: 'wrong' },
      { checkId: 'A10-server-private-did-signature-enforcement', key: 'noRejectedRequests', section: 'signature', value: false },
      { checkId: 'A10-server-private-did-signature-enforcement', key: 'statusCode', section: 'signature', value: 200 },
    ];

    for (const mutation of mutations) {
      const checks = serverPrivateDidVerdicts(failedObservationFact(
        mutation.section,
        mutation.key,
        mutation.value,
      ));
      expect(checks.find((check) => check.id === mutation.checkId)?.status, `${mutation.section}.${mutation.key}`).toBe('fail');
    }
  });

  it('should report Docker unavailability without cleaning resources that were never created', async () => {
    const harness = proofHarness({ dockerUnavailable: true });
    const report = await serverPrivateDidProofInternals.runServerPrivateDidProofWithDependencies({
      now: (): Date => new Date('2026-09-21T00:00:00.000Z'),
    }, harness.dependencies);

    expect(report.status).toBe('unsupported');
    expect(report.checks).toContainEqual(expect.objectContaining({
      id     : 'A04-server-private-did-docker',
      status : 'unsupported',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      id     : 'server-private-did-runtime-cleanup',
      status : 'pass',
    }));
    expect(harness.events).toEqual([]);
  });

  it('should snapshot a phase before later resolver traffic changes its counters', () => {
    const states = {
      a : { admitted: 0, rejected: 0, requests: [] as Array<{ method: string; pathname: string }> },
      b : { admitted: 0, rejected: 0, requests: [] as Array<{ method: string; pathname: string }> },
    };
    const adapter = (slot: 'a' | 'b'): TrackedAdapter => ({
      publicationEndpoint : `http://127.0.0.1/${slot}`,
      resolverEndpoint    : (): string => KNOWN_RESOLVER_A,
      resolverObservation : (): { admitted: number; rejected: number } => ({
        admitted : states[slot].admitted,
        rejected : states[slot].rejected,
      }),
      stop             : async (): Promise<void> => {},
      upstreamRequests : (): Array<{ method: string; pathname: string }> => states[slot].requests,
    });
    const adapterA = adapter('a');
    const adapterB = adapter('b');
    const beforeA = serverPrivateDidProofInternals.adapterSnapshot(adapterA);
    const beforeB = serverPrivateDidProofInternals.adapterSnapshot(adapterB);
    states.b.admitted += 1;
    states.b.requests.push({ method: 'GET', pathname: '/private-did' });

    const captured = serverPrivateDidProofInternals.resolverQueryPhase(
      adapterA,
      beforeA,
      adapterB,
      beforeB,
      'b',
      '/private-did',
    );
    states.a.admitted += 1;
    states.a.requests.push({ method: 'GET', pathname: '/later-phase' });

    expect(captured).toEqual({ boundaryExact: true, noRejectedRequests: true });
  });

  it('should reject every causal-network deviation from one exact resolver lookup', () => {
    type MutableState = {
      a: { admitted: number; rejected: number; requests: Array<{ method: string; pathname: string }> };
      b: { admitted: number; rejected: number; requests: Array<{ method: string; pathname: string }> };
    };
    const deviations: ReadonlyArray<Readonly<{
      mutate(state: MutableState): void;
      name: string;
    }>> = [
      { mutate: (state): void => { state.b.requests[0].pathname = '/wrong'; }, name: 'wrong path' },
      { mutate: (state): void => { state.b.requests[0].method = 'POST'; }, name: 'wrong method' },
      { mutate: (state): void => { state.b.requests.push({ method: 'GET', pathname: '/private-did' }); }, name: 'extra expected request' },
      { mutate: (state): void => { state.b.admitted = 2; }, name: 'unexpected expected admission count' },
      { mutate: (state): void => { state.b.rejected = 1; }, name: 'expected-side rejection' },
      { mutate: (state): void => { state.a.requests.push({ method: 'GET', pathname: '/private-did' }); }, name: 'foreign request' },
      { mutate: (state): void => { state.a.admitted = 1; }, name: 'foreign admission' },
      { mutate: (state): void => { state.a.rejected = 1; }, name: 'foreign rejection' },
    ];

    for (const deviation of deviations) {
      const state: MutableState = {
        a : { admitted: 0, rejected: 0, requests: [] },
        b : { admitted: 0, rejected: 0, requests: [] },
      };
      const adapter = (slot: 'a' | 'b'): TrackedAdapter => ({
        publicationEndpoint : `http://127.0.0.1/${slot}`,
        resolverEndpoint    : (): string => KNOWN_RESOLVER_A,
        resolverObservation : (): { admitted: number; rejected: number } => ({
          admitted : state[slot].admitted,
          rejected : state[slot].rejected,
        }),
        stop             : async (): Promise<void> => {},
        upstreamRequests : (): Array<{ method: string; pathname: string }> => state[slot].requests,
      });
      const adapterA = adapter('a');
      const adapterB = adapter('b');
      const beforeA = serverPrivateDidProofInternals.adapterSnapshot(adapterA);
      const beforeB = serverPrivateDidProofInternals.adapterSnapshot(adapterB);
      state.b.admitted = 1;
      state.b.requests.push({ method: 'GET', pathname: '/private-did' });
      deviation.mutate(state);

      const result = serverPrivateDidProofInternals.resolverQueryPhase(
        adapterA,
        beforeA,
        adapterB,
        beforeB,
        'b',
        '/private-did',
      );
      expect(result.boundaryExact, deviation.name).toBe(false);
    }
  });

  it('should refuse colliding ownership before starting either testnet', async () => {
    const harness = proofHarness({ ownershipCollision: true });
    const report = await serverPrivateDidProofInternals.runServerPrivateDidProofWithDependencies({}, harness.dependencies);

    expect(report.checks).toContainEqual(expect.objectContaining({
      details : { failureStage: 'testnet-ownership' },
      id      : 'server-private-did-proof-execution',
    }));
    expect(harness.events).toEqual([]);
  });

  it('should refuse an unverified testnet before creating adapters or server children', async () => {
    const harness = proofHarness({ unverified: 'b' });
    const report = await serverPrivateDidProofInternals.runServerPrivateDidProofWithDependencies({}, harness.dependencies);

    expect(report.checks).toContainEqual(expect.objectContaining({
      details : { failureStage: 'testnet-verify' },
      id      : 'server-private-did-proof-execution',
    }));
    expect(harness.events).toEqual(['testnets:a', 'testnets:b']);
  });

  it('should clean both owners after a partial testnet start', async () => {
    const harness = proofHarness({ testnetStartFailure: 'b' });
    const report = await serverPrivateDidProofInternals.runServerPrivateDidProofWithDependencies({}, harness.dependencies);

    expect(report.status).toBe('fail');
    expect(report.checks).toContainEqual(expect.objectContaining({
      details : { failureStage: 'testnet-start' },
      id      : 'server-private-did-proof-execution',
    }));
    expect(harness.events).toEqual(['testnets:a', 'testnets:b']);
  });

  it('should force a partially started child before cleaning later resource groups', async () => {
    const harness = proofHarness({ runtimeStartFailure: 'b' });
    const report = await serverPrivateDidProofInternals.runServerPrivateDidProofWithDependencies({}, harness.dependencies);

    expect(report.status).toBe('fail');
    const execution = report.checks.find((check) => check.id === 'server-private-did-proof-execution');
    expect(execution).toMatchObject({
      details: {
        failureStage : 'runtime-start',
        reason       : 'DidServerRuntime: [redacted-resolver-endpoint] start failed',
      },
      status: 'fail',
    });
    expect(JSON.stringify(execution)).not.toContain(KNOWN_CAPABILITY);
    expect(harness.events).toEqual([
      'children:a:stop',
      'children:b:force',
      'adapters:a',
      'adapters:b',
      'directories:a',
      'directories:b',
      'testnets:a',
      'testnets:b',
    ]);
  });

  it('should force a created child when its peer cannot be created', async () => {
    const harness = proofHarness({ runtimeCreateFailure: 'b' });
    const report = await serverPrivateDidProofInternals.runServerPrivateDidProofWithDependencies({}, harness.dependencies);

    expect(report.status).toBe('fail');
    expect(report.checks).toContainEqual(expect.objectContaining({
      details : { failureStage: 'runtime-create' },
      id      : 'server-private-did-proof-execution',
    }));
    expect(harness.runtimeStarts).toEqual([]);
    expect(harness.events).toEqual([
      'children:a:force',
      'adapters:a',
      'adapters:b',
      'directories:a',
      'directories:b',
      'testnets:a',
      'testnets:b',
    ]);
  });

  it('should clean a started adapter when its peer cannot start', async () => {
    const harness = proofHarness({ adapterStartFailure: 'b' });
    const report = await serverPrivateDidProofInternals.runServerPrivateDidProofWithDependencies({}, harness.dependencies);

    expect(report.status).toBe('fail');
    expect(report.checks).toContainEqual(expect.objectContaining({
      details : { failureStage: 'adapter-start' },
      id      : 'server-private-did-proof-execution',
    }));
    expect(harness.events).toEqual([
      'adapters:a',
      'directories:a',
      'directories:b',
      'testnets:a',
      'testnets:b',
    ]);
  });

  it('should attempt every cleanup group after execution and sanitize aggregate failures', async () => {
    const cleanupFailures = new Set([
      'children:a',
      'children:b',
      'adapters:a',
      'adapters:b',
      'directories:a',
      'directories:b',
      'testnets:a',
      'testnets:b',
    ]);
    const harness = proofHarness({ cleanupFailures, executeFailure: true });
    const report = await serverPrivateDidProofInternals.runServerPrivateDidProofWithDependencies({}, harness.dependencies);
    const cleanupResult = report.checks.find((check) => check.id === 'server-private-did-runtime-cleanup');

    expect(harness.events).toEqual([
      'children:a:stop',
      'children:b:stop',
      'adapters:a',
      'adapters:b',
      'directories:a',
      'directories:b',
      'testnets:a',
      'testnets:b',
    ]);
    expect(cleanupResult).toEqual(expect.objectContaining({
      details: {
        failureCodes: JSON.stringify([
          'children:a',
          'children:b',
          'adapters:a',
          'adapters:b',
          'directories:a',
          'directories:b',
          'testnets:a',
          'testnets:b',
        ]),
        failures: 8,
      },
      status: 'fail',
    }));
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(JSON.stringify(report)).not.toContain(KNOWN_CAPABILITY);
  });

  it('should emit only the standalone proof report without resolver capabilities', async () => {
    const harness = proofHarness();
    const report = await serverPrivateDidProofInternals.runServerPrivateDidProofWithDependencies({
      now: (): Date => new Date('2026-09-21T00:00:00.000Z'),
    }, harness.dependencies);
    const serialized = JSON.stringify(report);

    expect(report.proof).toBe('p0-server-private-did-ingress');
    expect(report.status).toBe('pass');
    expect(report.checks.map((check) => check.id)).toEqual([
      'A06-server-private-testnets',
      'A03-server-private-did-cross-lab-isolation',
      'A10-server-private-did-ingress',
      'A10-server-private-did-signature-enforcement',
      'server-private-did-runtime-cleanup',
    ]);
    expect(serialized).not.toContain(KNOWN_CAPABILITY);
    expect(serialized).not.toContain('/__lab/resolver/');
    expect(serialized).not.toContain('"detail":');
    expect(harness.maxConcurrentRuntimeStarts()).toBe(1);
    expect(harness.runtimeStarts).toEqual(['a', 'b']);
    expect(harness.events).toEqual([
      'children:a:stop',
      'children:b:stop',
      'adapters:a',
      'adapters:b',
      'directories:a',
      'directories:b',
      'testnets:a',
      'testnets:b',
    ]);
  });
});
