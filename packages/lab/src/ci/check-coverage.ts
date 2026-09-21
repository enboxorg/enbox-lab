#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';

export type CoverageFile = {
  found: number;
  hit: number;
  path: string;
  percent: number;
};

export type CoverageSummary = {
  files: CoverageFile[];
  found: number;
  hit: number;
  percent: number;
};

/** Parses the line totals from an LCOV document. */
export function parseLcov(contents: string): CoverageSummary {
  const files = contents.split('end_of_record').flatMap((record): CoverageFile[] => {
    const path = /^SF:(.+)$/mu.exec(record)?.[1];
    const found = Number(/^LF:(\d+)$/mu.exec(record)?.[1]);
    const hit = Number(/^LH:(\d+)$/mu.exec(record)?.[1]);
    return path === undefined || !Number.isSafeInteger(found) || !Number.isSafeInteger(hit)
      ? []
      : [{ found, hit, path, percent: found === 0 ? 0 : hit / found * 100 }];
  });
  const found = files.reduce((total, file): number => total + file.found, 0);
  const hit = files.reduce((total, file): number => total + file.hit, 0);
  return { files, found, hit, percent: found === 0 ? 0 : hit / found * 100 };
}

/** Throws when a required stable module is absent or falls below its line floor. */
export function assertFileCoverage(summary: CoverageSummary, minimums: Readonly<Record<string, number>>): void {
  for (const [path, minimum] of Object.entries(minimums)) {
    const file = summary.files.find((entry): boolean => entry.path === path);
    if (file === undefined) {
      throw new Error(`Coverage report is missing required file '${path}'.`);
    }
    if (file.percent < minimum) {
      throw new Error(`Line coverage for '${path}' is ${file.percent.toFixed(2)}%, below its ${minimum.toFixed(2)}% floor.`);
    }
  }
}

export const criticalCoverageFloors = {
  'src/pkarr-publication-adapter.ts'              : 95,
  'src/pkarr-publication-journal.ts'              : 95,
  'src/pkarr-publication-server.ts'               : 90,
  'src/proof-result.ts'                           : 95,
  'src/proofs/connect/connect-worker-boundary.ts' : 95,
  'src/proofs/did-browser/did-browser-proof.ts'   : 70,
  'src/proofs/docker-proof.ts'                    : 95,
  'src/runtime/private-pkarr-testnet.ts'          : 80,
} as const;

/** Throws when aggregate line coverage falls below the configured floor. */
export function assertCoverage(summary: CoverageSummary, minimumPercent: number): void {
  if (!Number.isFinite(minimumPercent) || minimumPercent < 0 || minimumPercent > 100) {
    throw new RangeError('Coverage floor must be between 0 and 100.');
  }
  if (summary.files.length === 0 || summary.percent < minimumPercent) {
    throw new Error(`Line coverage ${summary.percent.toFixed(2)}% is below the ${minimumPercent.toFixed(2)}% floor.`);
  }
}

async function run(args: string[]): Promise<void> {
  const [path, minimum = '75'] = args;
  if (path === undefined) {
    throw new TypeError('Usage: check-coverage <lcov-path> [minimum-percent]');
  }
  const minimumPercent = Number(minimum);
  const summary = parseLcov(await readFile(path, 'utf8'));
  assertCoverage(summary, minimumPercent);
  assertFileCoverage(summary, criticalCoverageFloors);
  console.log(
    `LCOV line coverage ${summary.percent.toFixed(2)}% (${summary.hit}/${summary.found}) ` +
    `meets the ${minimumPercent.toFixed(2)}% floor and all critical module floors.`,
  );
}

if (import.meta.main) {
  await run(process.argv.slice(2));
}
