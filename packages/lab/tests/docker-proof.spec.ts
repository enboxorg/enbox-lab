import { describe, expect, it } from 'bun:test';

import { ROUTING_BUN_IMAGE } from '../src/proofs/routing/routing-proof.js';
import {
  dockerResourceIsAbsent,
  imageMatchesHostArchitecture,
  isDigestPinnedImage,
} from '../src/proofs/docker-proof.js';

describe('Docker proof invariants', () => {
  it('should require an immutable image digest', () => {
    expect(isDigestPinnedImage(ROUTING_BUN_IMAGE)).toBe(true);
    expect(isDigestPinnedImage(`oven/bun:1.3.14@sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(isDigestPinnedImage('oven/bun:1.3.14')).toBe(false);
    expect(isDigestPinnedImage(`oven/bun@sha256:${'g'.repeat(64)}`)).toBe(false);
  });

  it('should reject foreign and emulated image platforms', () => {
    expect(imageMatchesHostArchitecture({ Architecture: 'amd64', Os: 'linux' }, 'x64')).toBe(true);
    expect(imageMatchesHostArchitecture({ Architecture: 'arm64', Os: 'linux' }, 'x64')).toBe(false);
    expect(imageMatchesHostArchitecture({ Architecture: 'amd64', Os: 'windows' }, 'x64')).toBe(false);
    expect(imageMatchesHostArchitecture({ Architecture: 'amd64', Os: 'linux' }, 's390x')).toBe(false);
  });

  it('should require a confirmed not-found response before claiming cleanup', () => {
    expect(dockerResourceIsAbsent({ exitCode: 1, stderr: 'Error: No such object: proof', stdout: '' })).toBe(true);
    expect(dockerResourceIsAbsent({ exitCode: 1, stderr: 'Error response from daemon: network proof not found', stdout: '' })).toBe(true);
    expect(dockerResourceIsAbsent({ exitCode: 1, stderr: 'Executable not found in $PATH: docker', stdout: '' })).toBe(false);
    expect(dockerResourceIsAbsent({ exitCode: 1, stderr: 'permission denied', stdout: '' })).toBe(false);
    expect(dockerResourceIsAbsent({ exitCode: 0, stderr: '', stdout: '[]' })).toBe(false);
  });
});
