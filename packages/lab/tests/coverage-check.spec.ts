import { describe, expect, it } from 'bun:test';

import { assertCoverage, assertFileCoverage, criticalCoverageFloors, parseLcov } from '../src/ci/check-coverage.js';

describe('coverage gate', () => {
  it('should aggregate LCOV line totals and enforce the configured floor', () => {
    const summary = parseLcov(`
SF:src/one.ts
LF:10
LH:9
end_of_record
SF:src/two.ts
LF:10
LH:7
end_of_record
`);

    expect(summary).toMatchObject({ found: 20, hit: 16, percent: 80 });
    expect((): void => assertCoverage(summary, 80)).not.toThrow();
    expect((): void => assertCoverage(summary, 80.01)).toThrow('below the 80.01% floor');
  });

  it('should require each named file to meet its own floor', () => {
    const summary = parseLcov('SF:src/one.ts\nLF:10\nLH:9\nend_of_record\n');
    expect((): void => assertFileCoverage(summary, { 'src/one.ts': 90 })).not.toThrow();
    expect((): void => assertFileCoverage(summary, { 'src/one.ts': 91 })).toThrow('below its 91.00% floor');
    expect((): void => assertFileCoverage(summary, { 'src/missing.ts': 0 })).toThrow('missing required file');
  });

  it('should fail empty reports and invalid thresholds', () => {
    expect((): void => assertCoverage(parseLcov(''), 0)).toThrow('below');
    expect((): void => assertCoverage(parseLcov(''), 101)).toThrow('between 0 and 100');
  });

  it('should keep the browser runtime and worker parser on critical coverage floors', () => {
    expect(criticalCoverageFloors['src/proofs/did-browser/did-browser-runtime.ts']).toBe(20);
    expect(criticalCoverageFloors['src/proofs/did-browser/fixture/did-service-worker-protocol.ts']).toBe(85);
  });
});
