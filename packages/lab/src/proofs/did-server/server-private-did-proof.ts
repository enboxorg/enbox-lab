import type { DwnRpcResponse } from '@enbox/dwn-clients';
import type { BearerDid, BearerDidSigner } from '@enbox/dids';
import type { DidServerRuntimeEvidence, DidServerRuntimeStopEvidence } from './did-server-runtime.js';
import type { LabCheck, LabProofReport } from '../../proof-result.js';
import type { MessageSigner, ProtocolsQueryMessage } from '@enbox/dwn-sdk-js';
import type {
  PrivatePkarrRelay,
  PrivatePkarrTestnetCleanup,
  PrivatePkarrTestnetDependencies,
  PrivatePkarrTestnetEvidence,
} from '../../runtime/private-pkarr-testnet.js';

import { createProofReport } from '../../proof-result.js';
import { DidServerRuntime } from './did-server-runtime.js';
import { existsSync } from 'node:fs';
import { HttpDwnRpcClient } from '@enbox/dwn-clients';
import { join } from 'node:path';
import { PrivatePkarrTestnet } from '../../runtime/private-pkarr-testnet.js';
import { startPkarrPublicationServer } from '../../pkarr-publication-server.js';
import { tmpdir } from 'node:os';

import { DidDht, DidJwk } from '@enbox/dids';
import { mkdtemp, rm } from 'node:fs/promises';
import { ProtocolsQuery, Time } from '@enbox/dwn-sdk-js';

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DID_RESOLUTION_FAILURE = 'didResolution';
const DID_RESOLUTION_NOT_FOUND = 'notFound';
const GET_PUBLIC_KEY_NOT_FOUND = 'GeneralJwsVerifierGetPublicKeyNotFound';
const INVALID_SIGNATURE = 'GeneralJwsVerifierInvalidSignature';
const RELEASED_SERVER_NAME = '@enbox/dwn-server';
const RELEASED_SERVER_VERSION = '0.1.43';

type ProofSlot = 'a' | 'b';

type UpstreamRequest = Readonly<{
  method: string;
  pathname: string;
}>;

type ResolverCounters = Readonly<{
  admitted: number;
  rejected: number;
}>;

type AdapterSnapshot = Readonly<{
  resolver: ResolverCounters;
  upstreamCount: number;
}>;

type TrackedAdapter = Readonly<{
  publicationEndpoint: string;
  resolverEndpoint(): string | undefined;
  resolverObservation(): ResolverCounters;
  stop(): Promise<void>;
  upstreamRequests(): readonly UpstreamRequest[];
}>;

type ProofTestnet = Readonly<{
  containerName: string;
  evidence(): Promise<Pick<PrivatePkarrTestnetEvidence,
    'labId' | 'ownerId' | 'runId' | 'verified'>>;
  inspectDockerEngine(): Promise<Readonly<{ exitCode: number }>>;
  labId: string;
  networkName: string;
  ownerId: string;
  runId: string;
  start(): Promise<PrivatePkarrRelay>;
  stop(): Promise<PrivatePkarrTestnetCleanup>;
}>;

type ProofServerRuntime = Readonly<{
  forceDispose(): Promise<DidServerRuntimeStopEvidence>;
  start(): Promise<Pick<DidServerRuntimeEvidence,
    'childArgumentsContainResolverBaseUri' |
    'childEnvironmentContainsResolverBaseUri' |
    'childPid' |
    'packageName' |
    'packageVersion' |
    'resolverEndpointTransport' |
    'origin' |
    'storageDirectory' |
    'storageIsolated'>>;
  stop(): Promise<DidServerRuntimeStopEvidence>;
}>;

type RuntimeResources = Readonly<{
  adapterA: TrackedAdapter;
  adapterB: TrackedAdapter;
  requestTimeoutMs: number;
  runtimeOriginA: string;
  runtimeOriginB: string;
}>;

export type ServerPrivateDidProofOptions = Readonly<{
  now?: () => Date;
  requestTimeoutMs?: number;
  testnetA?: PrivatePkarrTestnetDependencies;
  testnetB?: PrivatePkarrTestnetDependencies;
}>;

export type ServerPrivateDidObservation = Readonly<{
  crossLab: Readonly<{
    boundaryExact: boolean;
    didResolutionError: string;
    errorCode: string;
    jwkBoundaryQuiet: boolean;
    jwkEntries: number;
    jwkNoRejectedRequests: boolean;
    jwkStatusCode: number;
    noRejectedRequests: boolean;
    publicKeyFailure: string;
    statusCode: number;
  }>;
  ingress: Readonly<{
    boundaryExact: boolean;
    entries: number;
    messagesDistinct: boolean;
    noRejectedRequests: boolean;
    publicationAOnly: boolean;
    publicationAcknowledged: boolean;
    statusCode: number;
  }>;
  signature: Readonly<{
    boundaryExact: boolean;
    errorCode: string;
    noRejectedRequests: boolean;
    statusCode: number;
  }>;
  testnets: Readonly<{
    containerIdsDistinct: boolean;
    labIdsDistinct: boolean;
    networkNamesDistinct: boolean;
    ownerIdsDistinct: boolean;
    runIdsDistinct: boolean;
    runtimeContractsValid: boolean;
    runtimePidsDistinct: boolean;
    storageDirectoriesDistinct: boolean;
    verified: boolean;
  }>;
}>;

type BoundaryObservation = Pick<ServerPrivateDidObservation, 'crossLab' | 'ingress' | 'signature'>;

type ServerPrivateDidProofDependencies = Readonly<{
  createDirectory(prefix: string): Promise<string>;
  createRuntime(slot: ProofSlot, resolverEndpoint: string): Promise<ProofServerRuntime>;
  createTestnet(slot: ProofSlot, options: PrivatePkarrTestnetDependencies): ProofTestnet;
  directoryExists(path: string): boolean;
  executeScenario(resources: RuntimeResources): Promise<BoundaryObservation>;
  removeDirectory(path: string): Promise<void>;
  startAdapter(params: Readonly<{
    journalDirectory: string;
    requestTimeoutMs: number;
    slot: ProofSlot;
    upstreamBaseUrl: string;
  }>): Promise<TrackedAdapter>;
}>;

type ResourceState = {
  adapterA?: TrackedAdapter;
  adapterB?: TrackedAdapter;
  directoryA?: string;
  directoryB?: string;
  relayA?: PrivatePkarrRelay;
  relayB?: PrivatePkarrRelay;
  runtimeA?: ProofServerRuntime;
  runtimeB?: ProofServerRuntime;
  runtimeAStarted: boolean;
  runtimeBStarted: boolean;
  testnetA?: ProofTestnet;
  testnetACleanupRequired: boolean;
  testnetB?: ProofTestnet;
  testnetBCleanupRequired: boolean;
};

type ProofStage =
  'adapter-start' |
  'directory-create' |
  'docker-inspection' |
  'proof-execution' |
  'runtime-create' |
  'runtime-start' |
  'testnet-create' |
  'testnet-ownership' |
  'testnet-start' |
  'testnet-verify';

type CleanupOperation = Readonly<{
  code: string;
  run(): Promise<boolean>;
}>;

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
}

async function startTrackedAdapter(params: Readonly<{
  journalDirectory: string;
  requestTimeoutMs: number;
  upstreamBaseUrl: string;
}>): Promise<TrackedAdapter> {
  const upstreamRequests: UpstreamRequest[] = [];
  const server = await startPkarrPublicationServer({
    fetch: async (input, init): Promise<Response> => {
      upstreamRequests.push({
        method   : requestMethod(input, init),
        pathname : new URL(requestUrl(input)).pathname,
      });
      return fetch(input, init);
    },
    journalLocation  : join(params.journalDirectory, 'accepted-publications.sqlite'),
    requestTimeoutMs : params.requestTimeoutMs,
    resolverIngress  : true,
    upstreamBaseUrl  : params.upstreamBaseUrl,
  });
  return {
    publicationEndpoint : server.endpoint,
    resolverEndpoint    : (): string | undefined => server.resolverEndpoint(),
    resolverObservation : (): ResolverCounters => server.resolverObservation(),
    stop                : (): Promise<void> => server.stop(),
    upstreamRequests    : (): readonly UpstreamRequest[] => upstreamRequests,
  };
}

function messageSigner(signer: BearerDidSigner): MessageSigner {
  return {
    algorithm : signer.algorithm,
    keyId     : signer.keyId,
    sign      : (content): Promise<Uint8Array> => signer.sign({ data: content }),
  };
}

function nextTimestamp(previous?: string): string {
  return previous === undefined ? Time.getCurrentTimestamp() : Time.createTimestampAfter(previous, 0);
}

async function signedQuery(did: BearerDid, messageTimestamp: string): Promise<ProtocolsQueryMessage> {
  const signer = messageSigner(await did.getSigner());
  return (await ProtocolsQuery.create({ messageTimestamp, signer })).message;
}

function tamperFirstSignatureCharacter(message: ProtocolsQueryMessage): ProtocolsQueryMessage {
  const tampered = structuredClone(message);
  const signature = tampered.authorization?.signature.signatures[0]?.signature;
  if (signature === undefined || signature.length === 0) {
    throw new Error('Server private DID proof generated an unsigned tamper candidate');
  }
  const replacement = signature[0] === 'A' ? 'B' : 'A';
  tampered.authorization!.signature.signatures[0].signature = `${replacement}${signature.slice(1)}`;
  return tampered;
}

function signatureSerialization(message: ProtocolsQueryMessage): string {
  const signature = message.authorization?.signature;
  if (signature === undefined) {
    throw new Error('Server private DID proof generated an unsigned query');
  }
  return JSON.stringify(signature);
}

function adapterSnapshot(adapter: TrackedAdapter): AdapterSnapshot {
  return {
    resolver      : adapter.resolverObservation(),
    upstreamCount : adapter.upstreamRequests().length,
  };
}

function exactNewRequest(
  adapter: TrackedAdapter,
  before: AdapterSnapshot,
  method: string,
  pathname: string,
): boolean {
  const requests = adapter.upstreamRequests().slice(before.upstreamCount);
  return requests.length === 1 && requests[0].method === method && requests[0].pathname === pathname;
}

function noNewRequests(adapter: TrackedAdapter, before: AdapterSnapshot): boolean {
  return adapter.upstreamRequests().length === before.upstreamCount;
}

function resolverDeltaIs(
  adapter: TrackedAdapter,
  before: AdapterSnapshot,
  admitted: number,
  rejected: number,
): boolean {
  const after = adapter.resolverObservation();
  return after.admitted - before.resolver.admitted === admitted &&
    after.rejected - before.resolver.rejected === rejected;
}

function resolverQueryPhase(
  adapterA: TrackedAdapter,
  beforeA: AdapterSnapshot,
  adapterB: TrackedAdapter,
  beforeB: AdapterSnapshot,
  expectedSlot: ProofSlot | undefined,
  pathname: string,
): Readonly<{ boundaryExact: boolean; noRejectedRequests: boolean }> {
  const noRejectedRequests = adapterA.resolverObservation().rejected - beforeA.resolver.rejected === 0 &&
    adapterB.resolverObservation().rejected - beforeB.resolver.rejected === 0;
  if (expectedSlot === undefined) {
    return {
      boundaryExact: noNewRequests(adapterA, beforeA) && noNewRequests(adapterB, beforeB) &&
        resolverDeltaIs(adapterA, beforeA, 0, 0) && resolverDeltaIs(adapterB, beforeB, 0, 0),
      noRejectedRequests,
    };
  }
  const expected = expectedSlot === 'a' ? adapterA : adapterB;
  const expectedBefore = expectedSlot === 'a' ? beforeA : beforeB;
  const foreign = expectedSlot === 'a' ? adapterB : adapterA;
  const foreignBefore = expectedSlot === 'a' ? beforeB : beforeA;
  return {
    boundaryExact: exactNewRequest(expected, expectedBefore, 'GET', pathname) &&
      noNewRequests(foreign, foreignBefore) && resolverDeltaIs(expected, expectedBefore, 1, 0) &&
      resolverDeltaIs(foreign, foreignBefore, 0, 0),
    noRejectedRequests,
  };
}

function entriesLength(reply: DwnRpcResponse): number {
  return Array.isArray(reply.entries) ? reply.entries.length : -1;
}

async function sendQuery(
  client: HttpDwnRpcClient,
  runtimeOrigin: string,
  didUri: string,
  message: ProtocolsQueryMessage,
  requestTimeoutMs: number,
): Promise<DwnRpcResponse> {
  return client.sendDwnRequest({
    dwnUrl    : runtimeOrigin,
    message,
    signal    : AbortSignal.timeout(requestTimeoutMs),
    targetDid : didUri,
    timeoutMs : requestTimeoutMs,
  });
}

async function executeServerPrivateDidScenario(resources: RuntimeResources): Promise<BoundaryObservation> {
  const client = new HttpDwnRpcClient(undefined, { maxRetries: 0 });
  const did = await DidDht.create({ options: { publish: false } });
  const didJwk = await DidJwk.create();
  const identifier = did.uri.slice('did:dht:'.length);
  const expectedPath = `/${identifier}`;
  const beforePublicationA = adapterSnapshot(resources.adapterA);
  const beforePublicationB = adapterSnapshot(resources.adapterB);
  const publication = await DidDht.publish({
    allowPrivateGatewayUri : true,
    did,
    gatewayUri             : resources.adapterA.publicationEndpoint,
  });
  const publicationAOnly = exactNewRequest(resources.adapterA, beforePublicationA, 'PUT', expectedPath) &&
    noNewRequests(resources.adapterB, beforePublicationB) &&
    resolverDeltaIs(resources.adapterA, beforePublicationA, 0, 0) &&
    resolverDeltaIs(resources.adapterB, beforePublicationB, 0, 0);

  const timestamps = [nextTimestamp()];
  for (let index = 1; index < 4; index += 1) {
    timestamps.push(nextTimestamp(timestamps[index - 1]));
  }
  const [crossLabMessage, jwkMessage, ingressMessage, tamperCandidate] = await Promise.all([
    signedQuery(did, timestamps[0]),
    signedQuery(didJwk, timestamps[1]),
    signedQuery(did, timestamps[2]),
    signedQuery(did, timestamps[3]),
  ]);
  const tamperedMessage = tamperFirstSignatureCharacter(tamperCandidate);
  const messagesDistinct = new Set([
    signatureSerialization(crossLabMessage),
    signatureSerialization(jwkMessage),
    signatureSerialization(ingressMessage),
    signatureSerialization(tamperedMessage),
  ]).size === 4;

  const beforeCrossLabA = adapterSnapshot(resources.adapterA);
  const beforeCrossLabB = adapterSnapshot(resources.adapterB);
  const crossLabReply = await sendQuery(
    client,
    resources.runtimeOriginB,
    did.uri,
    crossLabMessage,
    resources.requestTimeoutMs,
  );
  const crossLabPhase = resolverQueryPhase(
    resources.adapterA,
    beforeCrossLabA,
    resources.adapterB,
    beforeCrossLabB,
    'b',
    expectedPath,
  );

  const beforeJwkA = adapterSnapshot(resources.adapterA);
  const beforeJwkB = adapterSnapshot(resources.adapterB);
  const jwkReply = await sendQuery(
    client,
    resources.runtimeOriginB,
    didJwk.uri,
    jwkMessage,
    resources.requestTimeoutMs,
  );
  const jwkPhase = resolverQueryPhase(
    resources.adapterA,
    beforeJwkA,
    resources.adapterB,
    beforeJwkB,
    undefined,
    expectedPath,
  );

  const beforeIngressA = adapterSnapshot(resources.adapterA);
  const beforeIngressB = adapterSnapshot(resources.adapterB);
  const ingressReply = await sendQuery(
    client,
    resources.runtimeOriginA,
    did.uri,
    ingressMessage,
    resources.requestTimeoutMs,
  );
  const ingressPhase = resolverQueryPhase(
    resources.adapterA,
    beforeIngressA,
    resources.adapterB,
    beforeIngressB,
    'a',
    expectedPath,
  );

  const beforeSignatureA = adapterSnapshot(resources.adapterA);
  const beforeSignatureB = adapterSnapshot(resources.adapterB);
  const signatureReply = await sendQuery(
    client,
    resources.runtimeOriginA,
    did.uri,
    tamperedMessage,
    resources.requestTimeoutMs,
  );
  const signaturePhase = resolverQueryPhase(
    resources.adapterA,
    beforeSignatureA,
    resources.adapterB,
    beforeSignatureB,
    'a',
    expectedPath,
  );

  return {
    crossLab: {
      boundaryExact         : crossLabPhase.boundaryExact,
      didResolutionError    : String(crossLabReply.status.info?.didResolutionError ?? ''),
      errorCode             : crossLabReply.status.errorCode ?? '',
      jwkBoundaryQuiet      : jwkPhase.boundaryExact,
      jwkEntries            : entriesLength(jwkReply),
      jwkNoRejectedRequests : jwkPhase.noRejectedRequests,
      jwkStatusCode         : jwkReply.status.code,
      noRejectedRequests    : crossLabPhase.noRejectedRequests,
      publicKeyFailure      : String(crossLabReply.status.info?.publicKeyFailure ?? ''),
      statusCode            : crossLabReply.status.code,
    },
    ingress: {
      boundaryExact           : ingressPhase.boundaryExact,
      entries                 : entriesLength(ingressReply),
      messagesDistinct,
      noRejectedRequests      : ingressPhase.noRejectedRequests,
      publicationAOnly,
      publicationAcknowledged : publication.didDocumentMetadata.published === true,
      statusCode              : ingressReply.status.code,
    },
    signature: {
      boundaryExact      : signaturePhase.boundaryExact,
      errorCode          : signatureReply.status.errorCode ?? '',
      noRejectedRequests : signaturePhase.noRejectedRequests,
      statusCode         : signatureReply.status.code,
    },
  };
}

function testnetVerdict(observation: ServerPrivateDidObservation['testnets']): LabCheck {
  const passed = observation.verified && observation.labIdsDistinct && observation.ownerIdsDistinct &&
    observation.runIdsDistinct && observation.networkNamesDistinct && observation.containerIdsDistinct &&
    observation.runtimeContractsValid && observation.runtimePidsDistinct && observation.storageDirectoriesDistinct;
  return {
    details : { ...observation },
    id      : 'A06-server-private-testnets',
    status  : passed ? 'pass' : 'fail',
    summary : passed
      ? 'Two verified private testnets and released server children remained independently owned'
      : 'The private testnets or released server children did not prove independent ownership',
  };
}

function crossLabVerdict(observation: ServerPrivateDidObservation['crossLab']): LabCheck {
  const passed = observation.statusCode === 401 && observation.errorCode === GET_PUBLIC_KEY_NOT_FOUND &&
    observation.publicKeyFailure === DID_RESOLUTION_FAILURE && observation.didResolutionError === DID_RESOLUTION_NOT_FOUND &&
    observation.boundaryExact && observation.noRejectedRequests && observation.jwkStatusCode === 200 &&
    observation.jwkEntries === 0 && observation.jwkBoundaryQuiet && observation.jwkNoRejectedRequests;
  return {
    details : { ...observation },
    id      : 'A03-server-private-did-cross-lab-isolation',
    status  : passed ? 'pass' : 'fail',
    summary : passed
      ? 'The foreign private testnet could not resolve the DID while its did:jwk control remained valid'
      : 'The foreign private testnet or did:jwk control violated the isolation contract',
  };
}

function ingressVerdict(observation: ServerPrivateDidObservation['ingress']): LabCheck {
  const passed = observation.publicationAcknowledged && observation.publicationAOnly && observation.statusCode === 200 &&
    observation.entries === 0 && observation.boundaryExact && observation.noRejectedRequests && observation.messagesDistinct;
  return {
    details : { ...observation },
    id      : 'A10-server-private-did-ingress',
    status  : passed ? 'pass' : 'fail',
    summary : passed
      ? 'The released server authenticated its tenant through only the owned resolver ingress'
      : 'The released server did not prove the exact owned resolver ingress path',
  };
}

function signatureVerdict(
  observation: ServerPrivateDidObservation['signature'],
  messagesDistinct: boolean,
): LabCheck {
  const passed = observation.statusCode === 401 && observation.errorCode === INVALID_SIGNATURE &&
    observation.boundaryExact && observation.noRejectedRequests && messagesDistinct;
  return {
    details : { ...observation, messagesDistinct },
    id      : 'A10-server-private-did-signature-enforcement',
    status  : passed ? 'pass' : 'fail',
    summary : passed
      ? 'The released server resolved the private DID and rejected the independently tampered signature'
      : 'The private DID signature enforcement boundary was not proven',
  };
}

/** Converts the complete machine observations into the four required acceptance checks. */
export function serverPrivateDidVerdicts(observation: ServerPrivateDidObservation): LabCheck[] {
  return [
    testnetVerdict(observation.testnets),
    crossLabVerdict(observation.crossLab),
    ingressVerdict(observation.ingress),
    signatureVerdict(observation.signature, observation.ingress.messagesDistinct),
  ];
}

function runtimeContractValid(evidence: Awaited<ReturnType<ProofServerRuntime['start']>>): boolean {
  return evidence.packageName === RELEASED_SERVER_NAME && evidence.packageVersion === RELEASED_SERVER_VERSION &&
    evidence.resolverEndpointTransport === 'stdin-ndjson' && evidence.childArgumentsContainResolverBaseUri === false &&
    evidence.childEnvironmentContainsResolverBaseUri === false && evidence.storageIsolated === true &&
    Number.isSafeInteger(evidence.childPid) && evidence.childPid > 0 && evidence.storageDirectory.length > 0;
}

async function runCleanupGroup(operations: CleanupOperation[], failureCodes: string[]): Promise<void> {
  const results = await Promise.allSettled(operations.map((operation): Promise<boolean> => operation.run()));
  results.forEach((result, index): void => {
    if (result.status === 'rejected' || result.value !== true) {
      failureCodes.push(operations[index].code);
    }
  });
}

async function cleanupResources(
  resources: ResourceState,
  dependencies: ServerPrivateDidProofDependencies,
): Promise<string[]> {
  const failures: string[] = [];
  const childOperations: CleanupOperation[] = [];
  if (resources.runtimeA !== undefined) {
    childOperations.push({
      code : 'children:a',
      run  : async (): Promise<boolean> => {
        const evidence = resources.runtimeAStarted
          ? await resources.runtimeA!.stop()
          : await resources.runtimeA!.forceDispose();
        return evidence.portClosed && evidence.storageRemoved && evidence.stopped;
      },
    });
  }
  if (resources.runtimeB !== undefined) {
    childOperations.push({
      code : 'children:b',
      run  : async (): Promise<boolean> => {
        const evidence = resources.runtimeBStarted
          ? await resources.runtimeB!.stop()
          : await resources.runtimeB!.forceDispose();
        return evidence.portClosed && evidence.storageRemoved && evidence.stopped;
      },
    });
  }
  await runCleanupGroup(childOperations, failures);

  const adapterOperations: CleanupOperation[] = [
    ...(resources.adapterA === undefined ? [] : [{
      code : 'adapters:a',
      run  : async (): Promise<true> => { await resources.adapterA!.stop(); return true; },
    }]),
    ...(resources.adapterB === undefined ? [] : [{
      code : 'adapters:b',
      run  : async (): Promise<true> => { await resources.adapterB!.stop(); return true; },
    }]),
  ];
  await runCleanupGroup(adapterOperations, failures);

  const directoryOperations: CleanupOperation[] = [
    ...(resources.directoryA === undefined ? [] : [{
      code : 'directories:a',
      run  : async (): Promise<boolean> => {
        await dependencies.removeDirectory(resources.directoryA!);
        return !dependencies.directoryExists(resources.directoryA!);
      },
    }]),
    ...(resources.directoryB === undefined ? [] : [{
      code : 'directories:b',
      run  : async (): Promise<boolean> => {
        await dependencies.removeDirectory(resources.directoryB!);
        return !dependencies.directoryExists(resources.directoryB!);
      },
    }]),
  ];
  await runCleanupGroup(directoryOperations, failures);

  const testnetOperations: CleanupOperation[] = [
    ...(resources.testnetA === undefined || !resources.testnetACleanupRequired ? [] : [{
      code : 'testnets:a',
      run  : async (): Promise<boolean> => (await resources.testnetA!.stop()).passed,
    }]),
    ...(resources.testnetB === undefined || !resources.testnetBCleanupRequired ? [] : [{
      code : 'testnets:b',
      run  : async (): Promise<boolean> => (await resources.testnetB!.stop()).passed,
    }]),
  ];
  await runCleanupGroup(testnetOperations, failures);
  return failures;
}

function cleanupCheck(failureCodes: string[]): LabCheck {
  return {
    details: {
      failureCodes : JSON.stringify(failureCodes),
      failures     : failureCodes.length,
    },
    id      : 'server-private-did-runtime-cleanup',
    status  : failureCodes.length === 0 ? 'pass' : 'fail',
    summary : failureCodes.length === 0
      ? 'The proof removed its children, adapters, temporary directories, and testnets in dependency order'
      : 'One or more owned server private DID resources could not be removed',
  };
}

function executionFailure(stage: ProofStage): LabCheck {
  return {
    details : { failureStage: stage },
    id      : 'server-private-did-proof-execution',
    status  : 'fail',
    summary : 'The server private DID proof stopped before completing its machine observations',
  };
}

function requireResolverEndpoint(adapter: TrackedAdapter): string {
  const endpoint = adapter.resolverEndpoint();
  if (endpoint === undefined) {
    throw new Error('Server private DID proof resolver ingress is unavailable');
  }
  return endpoint;
}

const defaultDependencies: ServerPrivateDidProofDependencies = {
  createDirectory : (prefix): Promise<string> => mkdtemp(join(tmpdir(), prefix)),
  createRuntime   : async (_slot, resolverEndpoint): Promise<ProofServerRuntime> => DidServerRuntime.create(resolverEndpoint),
  createTestnet   : (_slot, options): ProofTestnet => new PrivatePkarrTestnet(options),
  directoryExists : (path): boolean => existsSync(path),
  executeScenario : (resources): Promise<BoundaryObservation> => executeServerPrivateDidScenario(resources),
  removeDirectory : (path): Promise<void> => rm(path, { force: true, recursive: true }),
  startAdapter    : (params): Promise<TrackedAdapter> => startTrackedAdapter(params),
};

async function runServerPrivateDidProofWithDependencies(
  options: ServerPrivateDidProofOptions,
  dependencies: ServerPrivateDidProofDependencies,
): Promise<LabProofReport> {
  const now = options.now ?? ((): Date => new Date());
  const startedAt = now();
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new RangeError('Server private DID proof request timeout must be a positive safe integer');
  }
  const checks: LabCheck[] = [];
  const resources: ResourceState = {
    runtimeAStarted         : false,
    runtimeBStarted         : false,
    testnetACleanupRequired : false,
    testnetBCleanupRequired : false,
  };
  let stage: ProofStage = 'testnet-create';

  try {
    resources.testnetA = dependencies.createTestnet('a', {
      ...options.testnetA,
      displayName: 'Server Private DID Proof A',
    });
    resources.testnetB = dependencies.createTestnet('b', {
      ...options.testnetB,
      displayName: 'Server Private DID Proof B',
    });

    stage = 'testnet-ownership';
    if (resources.testnetA.runId === resources.testnetB.runId ||
      resources.testnetA.labId === resources.testnetB.labId ||
      resources.testnetA.ownerId === resources.testnetB.ownerId ||
      resources.testnetA.networkName === resources.testnetB.networkName ||
      resources.testnetA.containerName === resources.testnetB.containerName) {
      throw new Error('Server private DID proof testnet ownership must be distinct');
    }

    stage = 'docker-inspection';
    const [dockerA, dockerB] = await Promise.all([
      resources.testnetA.inspectDockerEngine(),
      resources.testnetB.inspectDockerEngine(),
    ]);
    if (dockerA.exitCode !== 0 || dockerB.exitCode !== 0) {
      checks.push({
        details: {
          testnetAExitCode : dockerA.exitCode,
          testnetBExitCode : dockerB.exitCode,
        },
        id      : 'A04-server-private-did-docker',
        status  : 'unsupported',
        summary : 'Docker is unavailable, so the server private DID proof did not run',
      });
    } else {
      stage = 'testnet-start';
      resources.testnetACleanupRequired = true;
      resources.testnetBCleanupRequired = true;
      const relayResults = await Promise.allSettled([
        resources.testnetA.start(),
        resources.testnetB.start(),
      ]);
      if (relayResults[0].status === 'fulfilled') { resources.relayA = relayResults[0].value; }
      if (relayResults[1].status === 'fulfilled') { resources.relayB = relayResults[1].value; }
      if (resources.relayA === undefined || resources.relayB === undefined) {
        throw new Error('Server private DID proof could not start both testnets');
      }

      stage = 'testnet-verify';
      const [evidenceA, evidenceB] = await Promise.all([
        resources.testnetA.evidence(),
        resources.testnetB.evidence(),
      ]);
      if (!evidenceA.verified || !evidenceB.verified) {
        throw new Error('Server private DID proof refused an unverified testnet boundary');
      }

      stage = 'directory-create';
      const directoryResults = await Promise.allSettled([
        dependencies.createDirectory('enbox-lab-server-did-a-'),
        dependencies.createDirectory('enbox-lab-server-did-b-'),
      ]);
      if (directoryResults[0].status === 'fulfilled') { resources.directoryA = directoryResults[0].value; }
      if (directoryResults[1].status === 'fulfilled') { resources.directoryB = directoryResults[1].value; }
      if (resources.directoryA === undefined || resources.directoryB === undefined) {
        throw new Error('Server private DID proof could not create both journal directories');
      }

      stage = 'adapter-start';
      const adapterResults = await Promise.allSettled([
        dependencies.startAdapter({
          journalDirectory : resources.directoryA,
          requestTimeoutMs,
          slot             : 'a',
          upstreamBaseUrl  : resources.relayA.endpoint,
        }),
        dependencies.startAdapter({
          journalDirectory : resources.directoryB,
          requestTimeoutMs,
          slot             : 'b',
          upstreamBaseUrl  : resources.relayB.endpoint,
        }),
      ]);
      if (adapterResults[0].status === 'fulfilled') { resources.adapterA = adapterResults[0].value; }
      if (adapterResults[1].status === 'fulfilled') { resources.adapterB = adapterResults[1].value; }
      if (resources.adapterA === undefined || resources.adapterB === undefined) {
        throw new Error('Server private DID proof could not start both adapters');
      }

      stage = 'runtime-create';
      const resolverEndpointA = requireResolverEndpoint(resources.adapterA);
      const resolverEndpointB = requireResolverEndpoint(resources.adapterB);
      const runtimeResults = await Promise.allSettled([
        dependencies.createRuntime('a', resolverEndpointA),
        dependencies.createRuntime('b', resolverEndpointB),
      ]);
      if (runtimeResults[0].status === 'fulfilled') { resources.runtimeA = runtimeResults[0].value; }
      if (runtimeResults[1].status === 'fulfilled') { resources.runtimeB = runtimeResults[1].value; }
      if (resources.runtimeA === undefined || resources.runtimeB === undefined) {
        throw new Error('Server private DID proof could not create both server children');
      }

      stage = 'runtime-start';
      const runtimeStartResults = await Promise.allSettled([
        resources.runtimeA.start(),
        resources.runtimeB.start(),
      ]);
      resources.runtimeAStarted = runtimeStartResults[0].status === 'fulfilled';
      resources.runtimeBStarted = runtimeStartResults[1].status === 'fulfilled';
      if (runtimeStartResults[0].status !== 'fulfilled' || runtimeStartResults[1].status !== 'fulfilled') {
        throw new Error('Server private DID proof could not start both server children');
      }
      const runtimeEvidenceA = runtimeStartResults[0].value;
      const runtimeEvidenceB = runtimeStartResults[1].value;

      stage = 'proof-execution';
      const boundary = await dependencies.executeScenario({
        adapterA       : resources.adapterA,
        adapterB       : resources.adapterB,
        requestTimeoutMs,
        runtimeOriginA : runtimeEvidenceA.origin,
        runtimeOriginB : runtimeEvidenceB.origin,
      });
      const observation: ServerPrivateDidObservation = {
        ...boundary,
        testnets: {
          containerIdsDistinct       : resources.relayA.containerId !== resources.relayB.containerId,
          labIdsDistinct             : evidenceA.labId !== evidenceB.labId,
          networkNamesDistinct       : resources.testnetA.networkName !== resources.testnetB.networkName,
          ownerIdsDistinct           : evidenceA.ownerId !== evidenceB.ownerId,
          runIdsDistinct             : evidenceA.runId !== evidenceB.runId,
          runtimeContractsValid      : runtimeContractValid(runtimeEvidenceA) && runtimeContractValid(runtimeEvidenceB),
          runtimePidsDistinct        : runtimeEvidenceA.childPid !== runtimeEvidenceB.childPid,
          storageDirectoriesDistinct : runtimeEvidenceA.storageDirectory !== runtimeEvidenceB.storageDirectory,
          verified                   : evidenceA.verified && evidenceB.verified,
        },
      };
      checks.push(...serverPrivateDidVerdicts(observation));
    }
  } catch {
    checks.push(executionFailure(stage));
  } finally {
    const cleanupFailures = await cleanupResources(resources, dependencies);
    checks.push(cleanupCheck(cleanupFailures));
  }

  return createProofReport({
    checks,
    finishedAt : now(),
    proof      : 'p0-server-private-did-ingress',
    startedAt,
  });
}

/** Runs the released server against two independently owned private Pkarr testnets. */
export function runServerPrivateDidProof(options: ServerPrivateDidProofOptions = {}): Promise<LabProofReport> {
  return runServerPrivateDidProofWithDependencies(options, defaultDependencies);
}

export const serverPrivateDidProofInternals = {
  adapterSnapshot,
  executeServerPrivateDidScenario,
  resolverQueryPhase,
  runServerPrivateDidProofWithDependencies,
};
