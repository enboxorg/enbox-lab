import type { DidPersistenceProofOptions } from '../did-persistence-proof.js';
import type { DockerCommandResult, PrivatePkarrRelay } from '../../runtime/private-pkarr-testnet.js';
import type { LabCheck, LabProofReport } from '../../proof-result.js';

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import { createProofReport } from '../../proof-result.js';
import { runDidPersistenceProof } from '../did-persistence-proof.js';
import { PrivatePkarrTestnet, privatePkarrTestnetInternals } from '../../runtime/private-pkarr-testnet.js';

type PersistenceProofRunner = (options: DidPersistenceProofOptions) => Promise<LabProofReport>;

export type DidRuntimeProofDependencies = {
  allocatePort?: () => Promise<number>;
  now?: () => Date;
  randomUuid?: () => string;
  runCommand?: (command: string[]) => Promise<DockerCommandResult>;
  runPersistenceProof?: PersistenceProofRunner;
  waitForRelay?: (endpoint: string) => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function allocateLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 30_000 + Math.floor(Math.random() * 20_000);
    try {
      const server = Bun.serve({
        fetch    : (): Response => new Response('port allocation sentinel'),
        hostname : '127.0.0.1',
        port,
      });
      server.stop(true);
      return port;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !error.message.includes('port')) {
        throw error;
      }
    }
  }
  throw new Error('Unable to allocate an unused loopback port after 20 attempts');
}

function childCheckPassed(report: LabProofReport, id: string): boolean {
  return report.checks.some((check): boolean => check.id === id && check.status === 'pass');
}

/**
 * Runs the real Pkarr testnet boundary of the durable DID proof in an isolated Docker container.
 * The relay is recreated without retaining its state; the adapter restores from exact signed bytes.
 */
export async function runDidRuntimeProof(dependencies: DidRuntimeProofDependencies = {}): Promise<LabProofReport> {
  const now = dependencies.now ?? ((): Date => new Date());
  const allocatePort = dependencies.allocatePort ?? allocateLoopbackPort;
  const startedAt = now();
  const persistenceProof = dependencies.runPersistenceProof ?? runDidPersistenceProof;
  const testnet = new PrivatePkarrTestnet({
    randomUuid   : dependencies.randomUuid,
    runCommand   : dependencies.runCommand,
    waitForRelay : dependencies.waitForRelay,
  });
  const checks: LabCheck[] = [];
  let journalDirectory: string | undefined;

  const dockerVersion = await testnet.inspectDockerEngine();
  if (dockerVersion.exitCode !== 0) {
    return createProofReport({
      checks: [{
        details : { error: dockerVersion.stderr || dockerVersion.stdout },
        id      : 'A04-docker-engine',
        status  : 'unsupported',
        summary : 'Docker Engine is unavailable, so the real private Pkarr testnet proof did not run',
      }],
      finishedAt : now(),
      proof      : 'p0-did-runtime-persistence',
      startedAt,
    });
  }

  try {
    const runToken = testnet.runId.replaceAll('-', '').slice(0, 12).toLowerCase();
    journalDirectory = await mkdtemp(join(tmpdir(), `enbox-lab-did-${runToken}-`));
    const firstRelay = await testnet.start();
    let secondRelay: PrivatePkarrRelay | undefined;
    const advertisedActorPort = await allocatePort();

    const persistenceReport = await persistenceProof({
      advertisedDwnEndpoint : `http://localhost:${advertisedActorPort}`,
      journalLocation       : join(journalDirectory, 'accepted-publications.sqlite'),
      recreateUpstream      : async (): Promise<string> => {
        secondRelay = await testnet.restart();
        return secondRelay.endpoint;
      },
      upstreamBaseUrl: firstRelay.endpoint,
    });

    const evidence = await testnet.evidence();
    checks.push({
      details: {
        command               : JSON.stringify(evidence.command),
        attachedNetworks      : JSON.stringify(evidence.attachedNetworks),
        containerImage        : evidence.containerImage,
        dockerVersion         : evidence.dockerVersion,
        imageArchitecture     : evidence.imageArchitecture,
        imageDigest           : evidence.imageDigest,
        imageDigestRecorded   : evidence.imageDigestRecorded,
        imageId               : evidence.imageId,
        imageOs               : evidence.imageOs,
        nativeImage           : evidence.nativeImage,
        ownedNetwork          : evidence.ownedNetwork,
        advertisedDwnEndpoint : `http://localhost:${advertisedActorPort}`,
        egressMasquerading    : evidence.egressMasquerading,
        labId                 : evidence.labId,
        ownerId               : evidence.ownerId,
        runId                 : evidence.runId,
      },
      id      : 'A06-pinned-private-testnet',
      status  : evidence.verified ? 'pass' : 'fail',
      summary : evidence.verified
        ? 'The digest-pinned Pkarr relay ran in testnet mode on a private Docker network'
        : 'The running relay did not match the pinned private-testnet contract',
    });
    checks.push(...persistenceReport.checks);
    checks.push({
      details : { advertisedDwnEndpoint: `http://localhost:${advertisedActorPort}` },
      id      : 'A11-advertised-endpoint-route',
      status  : 'unsupported',
      summary : 'The DID carries the selected localhost-port form, but this persistence proof does not start or exercise that DWN route',
    });

    const signerlessReplay = secondRelay !== undefined && firstRelay.containerId !== secondRelay.containerId &&
      childCheckPassed(persistenceReport, 'A07-signed-packet-restoration');
    checks.push({
      details: {
        firstContainerId  : firstRelay.containerId,
        replaySignerInput : false,
        secondContainerId : secondRelay?.containerId ?? '',
      },
      id      : 'A07-signerless-container-replay',
      status  : signerlessReplay ? 'pass' : 'fail',
      summary : signerlessReplay
        ? 'A new upstream container accepted journal replay without a DID signer or publisher callback'
        : 'The proof did not establish signerless replay into a distinct upstream container',
    });
    checks.push({
      details : { measuredBeyondRetention: false, requiredDuration: 'longer than the pinned upstream retention window' },
      id      : 'A09-retention-soak',
      status  : 'unsupported',
      summary : 'This executable proof does not run beyond upstream retention; the locked-wallet retention soak remains a P4 gate',
    });
  } catch (error: unknown) {
    const logs = await testnet.logs();
    checks.push({
      details: {
        error     : errorMessage(error),
        relayLogs : logs.exitCode === 0 ? logs.stderr || logs.stdout : '',
      },
      id      : 'did-runtime-proof-execution',
      status  : 'fail',
      summary : 'The real Docker DID persistence proof stopped before completing its observations',
    });
  } finally {
    const cleanup = await testnet.stop();
    const cleanupErrors = [...cleanup.errors];
    if (journalDirectory !== undefined) {
      try {
        await rm(journalDirectory, { force: true, recursive: true });
      } catch (error: unknown) {
        cleanupErrors.push(errorMessage(error));
      }
    }

    const cleanupPassed = cleanup.passed && cleanupErrors.length === 0 &&
      (journalDirectory === undefined || !existsSync(journalDirectory));
    checks.push({
      details: {
        containerName    : cleanup.containerName,
        errors           : JSON.stringify(cleanupErrors),
        journalDirectory : journalDirectory ?? '',
        networkName      : cleanup.networkName,
        ownerId          : cleanup.ownerId,
        runId            : cleanup.runId,
      },
      id      : 'proof-resource-cleanup',
      status  : cleanupPassed ? 'pass' : 'fail',
      summary : cleanupPassed
        ? 'The proof removed its exact randomly named container, network, and journal directory'
        : 'One or more exact proof resources remained after cleanup',
    });
  }

  return createProofReport({
    checks,
    finishedAt : now(),
    proof      : 'p0-did-runtime-persistence',
    startedAt,
  });
}

export { PKARR_RELAY_IMAGE } from '../../runtime/private-pkarr-testnet.js';

export const didRuntimeProofInternals = privatePkarrTestnetInternals;
