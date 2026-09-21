#!/usr/bin/env bun

import type { LabCheck, LabProofReport } from './proof-result.js';

import { exitCodeForProofStatus } from './proof-result.js';
import { runCatalogPreflightCli } from './catalog/preflight.js';
import { runConnectBrowserProof } from './proofs/connect/connect-browser-proof.js';
import { runDidRuntimeProof } from './proofs/did-runtime/did-runtime-proof.js';
import { runDoctor } from './doctor.js';
import { runHistoricalArtifactBuildCli } from './catalog/build.js';
import { runPrivateBrowserDidProof } from './proofs/did-browser/did-browser-proof.js';
import { runRoutingProof } from './proofs/routing/routing-proof.js';
import { runServerPrivateDidProof } from './proofs/did-server/server-private-did-proof.js';

const usage = `enbox-lab <command> [options]

Commands:
  catalog      Verify pinned historical DWN source or fixture capabilities.
  connect-browser  Run real Chromium popup and relay connect denial boundaries.
  did-browser  Run real Chromium did:dht publication through an owned private gateway.
  did-runtime  Run the owned private-Pkarr restart and restoration proof.
  did-server   Prove released-server authorization through two isolated private DID networks.
  doctor       Inspect prerequisites for the P0 proof harnesses.
  prepare      Materialize and prepare one pinned historical artifact.
  routing      Run the isolated addressing and ownership proof.

Options:
  --json       Print the versioned JSON report.
  -h, --help   Show help.
`;

function printTextReport(report: LabProofReport): void {
  console.log(`${report.proof}: ${report.status}`);
  for (const check of report.checks) {
    printTextCheck(check);
  }
}

function printTextCheck(check: LabCheck): void {
  console.log(`  ${check.status.padEnd(11)} ${check.id}: ${check.summary}`);
  if (check.details !== undefined) {
    console.log(`               ${JSON.stringify(check.details)}`);
  }
}

async function run(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    return 0;
  }

  const command = args[0];
  if (command === 'catalog') {
    return runCatalogPreflightCli(args.slice(1));
  }

  if (command === 'did-runtime') {
    const didArgs = args.slice(1);
    if (didArgs.some((argument): boolean => argument !== '--json')) {
      console.error(usage);
      return 2;
    }
    const report = await runDidRuntimeProof();
    if (didArgs.includes('--json')) {
      console.log(JSON.stringify(report, undefined, 2));
    } else {
      printTextReport(report);
    }
    return exitCodeForProofStatus(report.status);
  }

  if (command === 'did-browser') {
    const didBrowserArgs = args.slice(1);
    if (didBrowserArgs.some((argument): boolean => argument !== '--json')) {
      console.error(usage);
      return 2;
    }
    const report = await runPrivateBrowserDidProof();
    if (didBrowserArgs.includes('--json')) {
      console.log(JSON.stringify(report, undefined, 2));
    } else {
      printTextReport(report);
    }
    return exitCodeForProofStatus(report.status);
  }

  if (command === 'did-server') {
    const didServerArgs = args.slice(1);
    if (didServerArgs.some((argument): boolean => argument !== '--json')) {
      console.error(usage);
      return 2;
    }
    const report = await runServerPrivateDidProof();
    if (didServerArgs.includes('--json')) {
      console.log(JSON.stringify(report, undefined, 2));
    } else {
      printTextReport(report);
    }
    return exitCodeForProofStatus(report.status);
  }

  if (command === 'connect-browser') {
    const connectBrowserArgs = args.slice(1);
    if (connectBrowserArgs.some((argument): boolean => argument !== '--json')) {
      console.error(usage);
      return 2;
    }
    const report = await runConnectBrowserProof();
    if (connectBrowserArgs.includes('--json')) {
      console.log(JSON.stringify(report, undefined, 2));
    } else {
      printTextReport(report);
    }
    return exitCodeForProofStatus(report.status);
  }

  if (command === 'prepare') {
    return runHistoricalArtifactBuildCli(args.slice(1));
  }

  if (command === 'routing') {
    const routingArgs = args.slice(1);
    if (routingArgs.some((argument): boolean => argument !== '--json')) {
      console.error(usage);
      return 2;
    }
    const report = await runRoutingProof();
    if (routingArgs.includes('--json')) {
      console.log(JSON.stringify(report, undefined, 2));
    } else {
      printTextReport(report);
    }
    return exitCodeForProofStatus(report.status);
  }

  const doctorArgs = args.slice(1);
  const positionals = doctorArgs.filter((arg): boolean => !arg.startsWith('-'));
  const unknownOptions = doctorArgs.filter((arg): boolean => arg.startsWith('-') && arg !== '--json');
  if (unknownOptions.length > 0 || positionals.length !== 0 || command !== 'doctor') {
    console.error(usage);
    return 2;
  }

  const report = await runDoctor();
  if (doctorArgs.includes('--json')) {
    console.log(JSON.stringify(report, undefined, 2));
  } else {
    printTextReport(report);
  }
  return exitCodeForProofStatus(report.status);
}

process.exitCode = await run();
