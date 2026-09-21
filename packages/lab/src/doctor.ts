import type { LabCheck, LabProofReport } from './proof-result.js';

import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createProofReport } from './proof-result.js';
import { findChromiumExecutable } from './runtime/chromium.js';

const EXPECTED_BUN_VERSION = '1.3.14';
const SUPPORTED_ARCHITECTURES = new Set(['arm64', 'x64']);
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux']);

export type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

export type LabDoctorDependencies = {
  architecture?: string;
  browserExecutablePath?: string;
  now?: () => Date;
  platform?: string;
  runCommand?: (command: string[]) => Promise<CommandResult>;
};

async function runCommand(command: string[]): Promise<CommandResult> {
  try {
    const process = Bun.spawn(command, {
      stderr : 'pipe',
      stdout : 'pipe',
    });
    const [exitCode, stderr, stdout] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
      new Response(process.stdout).text(),
    ]);
    return { exitCode, stderr: stderr.trim(), stdout: stdout.trim() };
  } catch (error: unknown) {
    return {
      exitCode : -1,
      stderr   : error instanceof Error ? error.message : String(error),
      stdout   : '',
    };
  }
}

function commandCheck(id: string, name: string, result: CommandResult): LabCheck {
  if (result.exitCode !== 0) {
    return {
      details: {
        exitCode : result.exitCode,
        stderr   : result.stderr || 'command failed without stderr',
      },
      id,
      status  : 'fail',
      summary : `${name} is unavailable`,
    };
  }

  return {
    details : { version: result.stdout },
    id,
    status  : 'pass',
    summary : `${name} is available`,
  };
}

async function browserCheck(browserExecutablePath: string | undefined): Promise<LabCheck> {
  if (browserExecutablePath === undefined) {
    return {
      details : { executablePath: '' },
      id      : 'chromium',
      status  : 'fail',
      summary : 'Chromium executable is not installed',
    };
  }
  try {
    await access(browserExecutablePath, constants.X_OK);
    return {
      details : { executablePath: browserExecutablePath },
      id      : 'chromium',
      status  : 'pass',
      summary : 'Chromium executable is installed',
    };
  } catch {
    return {
      details : { executablePath: browserExecutablePath },
      id      : 'chromium',
      status  : 'fail',
      summary : 'Chromium executable is not installed or executable',
    };
  }
}

/** Inspects the local prerequisites used by Enbox Lab P0 proofs. */
export async function runDoctor(dependencies: LabDoctorDependencies = {}): Promise<LabProofReport> {
  const now = dependencies.now ?? ((): Date => new Date());
  const startedAt = now();
  const runner = dependencies.runCommand ?? runCommand;
  const architecture = dependencies.architecture ?? process.arch;
  const platform = dependencies.platform ?? process.platform;
  const browserExecutablePath = findChromiumExecutable(dependencies.browserExecutablePath);

  const [bunVersion, dockerVersion, chromiumCheck] = await Promise.all([
    runner(['bun', '--version']),
    runner(['docker', 'version', '--format', '{{.Client.Version}}/{{.Server.Version}}']),
    browserCheck(browserExecutablePath),
  ]);

  const bunCheck = commandCheck('bun', 'Bun', bunVersion);
  if (bunCheck.status === 'pass' && bunVersion.stdout !== EXPECTED_BUN_VERSION) {
    bunCheck.status = 'fail';
    bunCheck.summary = `Bun ${bunVersion.stdout} does not match the pinned ${EXPECTED_BUN_VERSION}`;
  }

  const platformSupported = SUPPORTED_PLATFORMS.has(platform) && SUPPORTED_ARCHITECTURES.has(architecture);
  const checks: LabCheck[] = [
    bunCheck,
    commandCheck('docker-engine', 'Docker Engine', dockerVersion),
    chromiumCheck,
    {
      details : { architecture, platform },
      id      : 'platform',
      status  : platformSupported ? 'pass' : 'unsupported',
      summary : platformSupported
        ? `${platform}/${architecture} is a candidate supported platform`
        : `${platform}/${architecture} is outside the P0 support matrix`,
    },
  ];

  return createProofReport({ checks, finishedAt: now(), proof: 'doctor', startedAt });
}
