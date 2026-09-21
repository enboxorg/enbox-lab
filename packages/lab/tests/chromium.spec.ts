import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { findChromiumExecutable } from '../src/runtime/chromium.js';

let directory: string | undefined;
const originalOverride = process.env.ENBOX_LAB_CHROMIUM_PATH;

describe('Chromium executable selection', () => {
  afterEach(async () => {
    if (originalOverride === undefined) {
      delete process.env.ENBOX_LAB_CHROMIUM_PATH;
    } else {
      process.env.ENBOX_LAB_CHROMIUM_PATH = originalOverride;
    }
    if (directory !== undefined) {
      await rm(directory, { force: true, recursive: true });
      directory = undefined;
    }
  });

  it('should honor an exact explicit path without silently falling back', async () => {
    directory = await mkdtemp(join(tmpdir(), 'enbox-lab-chromium-'));
    const executable = join(directory, 'chromium');
    await writeFile(executable, '');
    await chmod(executable, 0o700);

    expect(findChromiumExecutable(executable)).toBe(executable);
    expect(findChromiumExecutable(join(directory, 'missing'))).toBeUndefined();
    expect(findChromiumExecutable(directory)).toBeUndefined();
    await chmod(executable, 0o600);
    expect(findChromiumExecutable(executable)).toBeUndefined();
  });

  it('should prefer the configured lab override', async () => {
    directory = await mkdtemp(join(tmpdir(), 'enbox-lab-chromium-'));
    const executable = join(directory, 'chromium');
    await writeFile(executable, '');
    await chmod(executable, 0o700);
    process.env.ENBOX_LAB_CHROMIUM_PATH = executable;

    expect(findChromiumExecutable()).toBe(executable);
  });
});
