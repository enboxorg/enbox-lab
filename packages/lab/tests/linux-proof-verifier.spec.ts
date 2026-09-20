import type { ProofContract } from '../src/ci/verify-linux-proofs.js';
import type { LabCheck, LabProofReport } from '../src/proof-result.js';

import { describe, expect, it } from 'bun:test';

import { linuxProofContracts, validateProofReport } from '../src/ci/verify-linux-proofs.js';

const contract: ProofContract = {
  pass        : ['required-pass'],
  proof       : 'test-proof',
  unsupported : ['known-gap'],
};

function report(checks: LabCheck[], status: LabProofReport['status'] = 'unsupported'): LabProofReport {
  return {
    checks,
    finishedAt    : '2026-09-20T12:00:01.000Z',
    proof         : 'test-proof',
    schemaVersion : 1,
    startedAt     : '2026-09-20T12:00:00.000Z',
    status,
  };
}

describe('Linux proof evidence verifier', () => {
  it('should keep every real proof contract nonempty and free of duplicate IDs', () => {
    for (const proofContract of Object.values(linuxProofContracts)) {
      const ids = [...proofContract.pass, ...proofContract.unsupported];
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('should accept only the exact pass and unsupported contract', () => {
    expect(validateProofReport(report([
      { id: 'required-pass', status: 'pass', summary: 'passed' },
      { id: 'known-gap', status: 'unsupported', summary: 'pending' },
    ]), contract)).toEqual([]);
  });

  it('should reject a missing pass, changed status, and newly unsupported check', () => {
    expect(validateProofReport(report([
      { id: 'known-gap', status: 'pass', summary: 'incorrectly promoted' },
      { id: 'new-gap', status: 'unsupported', summary: 'not allowlisted' },
    ]), contract)).toEqual([
      'check \'known-gap\' was pass; expected unsupported',
      'unexpected unsupported check \'new-gap\'',
      'missing check \'required-pass\'',
    ]);
  });

  it('should reject duplicate checks and a misleading aggregate verdict', () => {
    expect(validateProofReport(report([
      { id: 'required-pass', status: 'pass', summary: 'passed' },
      { id: 'required-pass', status: 'pass', summary: 'duplicated' },
      { id: 'known-gap', status: 'unsupported', summary: 'pending' },
    ], 'pass'), contract)).toEqual([
      'duplicate check \'required-pass\'',
      'aggregate status was pass; expected unsupported',
    ]);
  });
});
