#!/usr/bin/env bun

import type { LabCheckStatus, LabProofReport } from '../proof-result.js';

import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { runCatalogPreflight } from '../catalog/catalog-preflight.js';
import { runDidRuntimeProof } from '../proofs/did-runtime/did-runtime-proof.js';
import { runDoctor } from '../doctor.js';
import { runPrivateBrowserDidProof } from '../proofs/did-browser/did-browser-proof.js';
import { runRoutingProof } from '../proofs/routing/routing-proof.js';

export type ProofContract = {
  pass: readonly string[];
  proof: string;
  unsupported: readonly string[];
};

type CliOptions = {
  evidenceDirectory: string;
  repositoryRoot: string;
};

type VerificationEntry = {
  errors: string[];
  evidenceFile: string;
  proof: string;
  status: 'fail' | 'pass';
};

type RunnerFailureEvidence = {
  error: string;
  proof: string;
  stack?: string;
  status: 'fail';
};

const usage = `verify-linux-proofs --repository <path> --evidence <path>

Runs the real Linux proof suite and verifies its exact pass/unsupported contract.
`;

export const linuxProofContracts = {
  browserDid: {
    pass: [
      'A06-browser-private-testnet',
      'A10-browser-direct-did-network-subcheck',
      'A03-browser-did-origin-allowlist-subcheck',
      'browser-did-proof-cleanup',
      'browser-private-did-runtime-cleanup',
    ],
    proof       : 'p0-browser-private-did-boundary',
    unsupported : [
      'A10-default-runtime-did-network',
      'A03-service-worker-did-containment',
      'A10-server-private-did-ingress',
    ],
  },
  catalog: {
    pass: [
      'dwn-server-0.1.43.commit',
      'dwn-server-0.1.43.tree',
      'dwn-server-0.1.43.source-files',
      'dwn-server-0.1.43.dependency-lock',
      'dwn-server-0.1.43.versions',
      'dwn-server-0.1.43.capability-inventory',
      'dwn-server-0.1.42.commit',
      'dwn-server-0.1.42.tree',
      'dwn-server-0.1.42.source-files',
      'dwn-server-0.1.42.dependency-lock',
      'dwn-server-0.1.42.versions',
      'dwn-server-0.1.42.capability-inventory',
    ],
    proof       : 'catalog-preflight:source',
    unsupported : [],
  },
  didRuntime: {
    pass: [
      'A06-pinned-private-testnet',
      'A07-acknowledged-publication',
      'A06-private-resolution-before-restart',
      'A07-signed-packet-restoration',
      'A08-resolution-after-restoration',
      'A07-signerless-container-replay',
      'proof-resource-cleanup',
    ],
    proof       : 'p0-did-runtime-persistence',
    unsupported : [
      'A09-network-only-cache-bypass',
      'A11-advertised-endpoint-route',
      'A09-retention-soak',
    ],
  },
  doctor: {
    pass        : ['bun', 'docker-engine', 'chromium', 'platform'],
    proof       : 'doctor',
    unsupported : [],
  },
  routing: {
    pass: [
      'A01-host-canonical-url',
      'A01-container-canonical-url',
      'A02-browser-policy',
      'A02-origin-enforcement',
      'A03-actor-network-egress-subcheck',
      'A05-ownership-labels',
      'A05-owned-cleanup',
      'A04-current-platform',
      'A01-address-family-observation',
      'proof-resource-cleanup',
    ],
    proof       : 'p0-addressing-ownership',
    unsupported : [
      'A03-host-default-and-did-miss-containment',
      'A04-macos-evidence',
    ],
  },
} as const satisfies Record<string, ProofContract>;

function parseOptions(args: string[]): CliOptions | undefined {
  let evidenceDirectory: string | undefined;
  let repositoryRoot: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--evidence') {
      evidenceDirectory = args[++index];
    } else if (argument === '--repository') {
      repositoryRoot = args[++index];
    } else {
      return undefined;
    }
    if (args[index] === undefined) {
      return undefined;
    }
  }

  return evidenceDirectory === undefined || repositoryRoot === undefined
    ? undefined
    : { evidenceDirectory: resolve(evidenceDirectory), repositoryRoot: resolve(repositoryRoot) };
}

function expectedStatuses(contract: ProofContract): Map<string, LabCheckStatus> {
  return new Map([
    ...contract.pass.map((id): [string, LabCheckStatus] => [id, 'pass']),
    ...contract.unsupported.map((id): [string, LabCheckStatus] => [id, 'unsupported']),
  ]);
}

/** Verifies that a report contains exactly the named evidence and no newly unsupported checks. */
export function validateProofReport(report: LabProofReport, contract: ProofContract): string[] {
  const errors: string[] = [];
  const expected = expectedStatuses(contract);
  const seen = new Set<string>();
  if (report.schemaVersion !== 1) {
    errors.push(`expected schema version 1, received ${String(report.schemaVersion)}`);
  }
  if (report.proof !== contract.proof) {
    errors.push(`expected proof '${contract.proof}', received '${report.proof}'`);
  }
  if (expected.size === 0) {
    errors.push('proof contract contains no expected checks');
  }

  for (const check of report.checks) {
    if (seen.has(check.id)) {
      errors.push(`duplicate check '${check.id}'`);
      continue;
    }
    seen.add(check.id);
    const expectedStatus = expected.get(check.id);
    if (expectedStatus === undefined) {
      errors.push(`unexpected ${check.status} check '${check.id}'`);
    } else if (check.status !== expectedStatus) {
      errors.push(`check '${check.id}' was ${check.status}; expected ${expectedStatus}`);
    }
  }

  for (const id of expected.keys()) {
    if (!seen.has(id)) {
      errors.push(`missing check '${id}'`);
    }
  }

  const expectedStatus: LabCheckStatus = contract.unsupported.length === 0 ? 'pass' : 'unsupported';
  if (report.status !== expectedStatus) {
    errors.push(`aggregate status was ${report.status}; expected ${expectedStatus}`);
  }
  return errors;
}

function errorEvidence(proof: string, error: unknown): RunnerFailureEvidence {
  if (error instanceof Error) {
    return { error: error.message, proof, stack: error.stack, status: 'fail' };
  }
  return { error: String(error), proof, status: 'fail' };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`);
}

async function runEvidence(params: {
  contract: ProofContract;
  evidenceDirectory: string;
  filename: string;
  run(): Promise<LabProofReport>;
}): Promise<VerificationEntry> {
  const evidenceFile = resolve(params.evidenceDirectory, params.filename);
  try {
    const report = await params.run();
    await writeJson(evidenceFile, report);
    const errors = validateProofReport(report, params.contract);
    return {
      errors,
      evidenceFile,
      proof  : params.contract.proof,
      status : errors.length === 0 ? 'pass' : 'fail',
    };
  } catch (error: unknown) {
    const failure = errorEvidence(params.contract.proof, error);
    await writeJson(evidenceFile, failure);
    return {
      errors : [failure.error],
      evidenceFile,
      proof  : params.contract.proof,
      status : 'fail',
    };
  }
}

async function run(options: CliOptions): Promise<number> {
  await mkdir(options.evidenceDirectory, { recursive: true });
  const entries: VerificationEntry[] = [];
  entries.push(await runEvidence({
    contract          : linuxProofContracts.doctor,
    evidenceDirectory : options.evidenceDirectory,
    filename          : 'doctor.json',
    run               : runDoctor,
  }));
  entries.push(await runEvidence({
    contract          : linuxProofContracts.catalog,
    evidenceDirectory : options.evidenceDirectory,
    filename          : 'catalog-source.json',
    run               : (): Promise<LabProofReport> => runCatalogPreflight({
      mode           : 'source',
      repositoryRoot : options.repositoryRoot,
    }),
  }));
  entries.push(await runEvidence({
    contract          : linuxProofContracts.routing,
    evidenceDirectory : options.evidenceDirectory,
    filename          : 'routing.json',
    run               : runRoutingProof,
  }));
  entries.push(await runEvidence({
    contract          : linuxProofContracts.browserDid,
    evidenceDirectory : options.evidenceDirectory,
    filename          : 'browser-private-did.json',
    run               : runPrivateBrowserDidProof,
  }));
  entries.push(await runEvidence({
    contract          : linuxProofContracts.didRuntime,
    evidenceDirectory : options.evidenceDirectory,
    filename          : 'did-runtime.json',
    run               : runDidRuntimeProof,
  }));

  const passed = entries.every((entry): boolean => entry.status === 'pass');
  const summary = {
    entries,
    finishedAt     : new Date().toISOString(),
    repositoryRoot : options.repositoryRoot,
    status         : passed ? 'pass' : 'fail',
  };
  await writeJson(resolve(options.evidenceDirectory, 'verification.json'), summary);
  for (const entry of entries) {
    console.log(`${entry.status.padEnd(4)} ${entry.proof} -> ${entry.evidenceFile}`);
    for (const error of entry.errors) {
      console.error(`     ${error}`);
    }
  }
  return passed ? 0 : 1;
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  if (options === undefined) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    process.exitCode = await run(options);
  }
}
