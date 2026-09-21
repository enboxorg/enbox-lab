import { accessSync, constants, statSync } from 'node:fs';

import { chromium } from 'playwright';

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Selects one explicit, managed, or supported system Chromium executable. */
export function findChromiumExecutable(explicitPath?: string): string | undefined {
  if (explicitPath !== undefined) {
    return isExecutableFile(explicitPath) ? explicitPath : undefined;
  }
  const candidates = [
    process.env.ENBOX_LAB_CHROMIUM_PATH,
    chromium.executablePath(),
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  return candidates.find((candidate): candidate is string => candidate !== undefined && isExecutableFile(candidate));
}
