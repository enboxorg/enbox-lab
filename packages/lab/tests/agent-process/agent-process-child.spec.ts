import type { Subprocess } from 'bun';

import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { describe, expect, it } from 'bun:test';

import {
  AGENT_PROCESS_CHILD_MAX_LINE_BYTES,
} from '../../src/runtime/agent-process/agent-process-child-protocol.js';
import {
  parseAgentProcessAwaitingSecret,
  parseAgentProcessStopped,
} from '../../src/runtime/agent-process/agent-process-runtime.js';

const CHILD_ENTRY = fileURLToPath(new URL(
  '../../src/runtime/agent-process/agent-process-child.ts',
  import.meta.url,
));
const CHILD_TIMEOUT_MS = 10_000;
const ACTOR_GATEWAY_URI = 'http://127.0.0.1:3210/';
const REMOTE_DWN_ORIGIN = 'http://127.0.0.1:4210';

type AgentChild = Subprocess<'pipe', 'pipe', 'pipe'>;

function spawnChild(): AgentChild {
  return Bun.spawn({
    cmd    : [process.execPath, CHILD_ENTRY],
    env    : { NO_COLOR: '1', PATH: process.env.PATH ?? '' },
    stderr : 'pipe',
    stdin  : 'pipe',
    stdout : 'pipe',
  });
}

function startLine(storageDirectory: string): string {
  return `${JSON.stringify({
    actorGatewayUri : ACTOR_GATEWAY_URI,
    remoteDwnOrigin : REMOTE_DWN_ORIGIN,
    storageDirectory,
    type            : 'start',
  })}\n`;
}

async function waitForExit(child: AgentChild): Promise<number> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject): void => {
    timeoutId = setTimeout((): void => {
      child.kill('SIGKILL');
      reject(new Error('Agent child test timed out'));
    }, CHILD_TIMEOUT_MS);
  });
  try {
    return await Promise.race([child.exited, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function collectChild(child: AgentChild): Promise<Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>> {
  const [exitCode, stdout, stderr] = await Promise.all([
    waitForExit(child),
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function readLine(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const bytes: number[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) { throw new Error('Agent child ended before its next record.'); }
    const newline = result.value.indexOf(0x0a);
    if (newline !== -1) {
      if (newline + 1 !== result.value.byteLength) {
        throw new Error('Agent child emitted unexpected trailing protocol bytes.');
      }
      bytes.push(...result.value.slice(0, newline));
      return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
    }
    bytes.push(...result.value);
  }
}

describe('released agent child process', () => {
  it('should open a fresh vault locked and shut down cleanly when no secret arrives', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-agent-child-'));
    const inheritedGateway = process.env.DID_DHT_GATEWAY_URI;
    const inheritedOptIn = process.env.DID_DHT_ALLOW_PRIVATE_GATEWAY;
    process.env.DID_DHT_GATEWAY_URI = 'parent-process-must-remain-unchanged';
    process.env.DID_DHT_ALLOW_PRIVATE_GATEWAY = 'parent-opt-in-must-remain-unchanged';
    const child = spawnChild();
    try {
      child.stdin.write(startLine(directory));
      await child.stdin.flush();
      child.stdin.end();
      const result = await collectChild(child);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      const lines = result.stdout.trimEnd().split('\n');
      expect(lines).toHaveLength(2);
      expect(parseAgentProcessAwaitingSecret(lines[0]!)).toMatchObject({
        firstLaunch : true,
        locked      : true,
      });
      expect(parseAgentProcessStopped(lines[1]!)).toEqual({ locked: true, type: 'stopped' });
      expect(process.env.DID_DHT_GATEWAY_URI).toBe('parent-process-must-remain-unchanged');
      expect(process.env.DID_DHT_ALLOW_PRIVATE_GATEWAY).toBe('parent-opt-in-must-remain-unchanged');
    } finally {
      if (child.exitCode === null) { child.kill('SIGKILL'); }
      await child.exited;
      await rm(directory, { force: true, recursive: true });
      if (inheritedGateway === undefined) {
        delete process.env.DID_DHT_GATEWAY_URI;
      } else {
        process.env.DID_DHT_GATEWAY_URI = inheritedGateway;
      }
      if (inheritedOptIn === undefined) {
        delete process.env.DID_DHT_ALLOW_PRIVATE_GATEWAY;
      } else {
        process.env.DID_DHT_ALLOW_PRIVATE_GATEWAY = inheritedOptIn;
      }
    }
  });

  it('should reject malformed and oversized secret frames without disclosing their contents', async () => {
    const secrets = [
      'never-print-this-malformed-password',
      'never-print-this-oversized-password',
    ];
    const secretLines = [
      `${JSON.stringify({ extra: ACTOR_GATEWAY_URI, password: secrets[0], type: 'initialize' })}\n`,
      `${secrets[1]}${'x'.repeat(AGENT_PROCESS_CHILD_MAX_LINE_BYTES + 1)}\n`,
    ];

    for (const secretLine of secretLines) {
      const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-agent-child-invalid-'));
      const child = spawnChild();
      try {
        child.stdin.write(`${startLine(directory)}${secretLine}`);
        await child.stdin.flush();
        child.stdin.end();
        const result = await collectChild(child);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe('Enbox Lab agent child failed\n');
        const outputLines = result.stdout.trimEnd().split('\n');
        expect(outputLines).toHaveLength(1);
        expect(parseAgentProcessAwaitingSecret(outputLines[0]!)).toMatchObject({ locked: true });
        for (const secret of secrets) {
          expect(JSON.stringify(result)).not.toContain(secret);
        }
      } finally {
        if (child.exitCode === null) { child.kill('SIGKILL'); }
        await child.exited;
        await rm(directory, { force: true, recursive: true });
      }
    }
  });

  it('should cancel its pending secret read and lock on SIGTERM', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-agent-child-signal-'));
    const child = spawnChild();
    const reader = child.stdout.getReader();
    try {
      child.stdin.write(startLine(directory));
      await child.stdin.flush();
      expect(parseAgentProcessAwaitingSecret(await readLine(reader))).toMatchObject({
        firstLaunch : true,
        locked      : true,
      });
      child.kill('SIGTERM');
      expect(parseAgentProcessStopped(await readLine(reader))).toEqual({ locked: true, type: 'stopped' });
      expect(await waitForExit(child)).toBe(0);
      expect((await reader.read()).done).toBe(true);
      expect(await new Response(child.stderr).text()).toBe('');
    } finally {
      await reader.cancel().catch((): void => {});
      reader.releaseLock();
      if (child.exitCode === null) { child.kill('SIGKILL'); }
      await child.exited;
      await rm(directory, { force: true, recursive: true });
    }
  });
});
