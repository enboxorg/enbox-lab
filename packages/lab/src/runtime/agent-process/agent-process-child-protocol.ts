import { isAbsolute, normalize } from 'node:path';

export const AGENT_PROCESS_CHILD_MAX_LINE_BYTES = 4_096;
export const AGENT_PROCESS_PACKAGE_NAME = '@enbox/agent';
export const AGENT_PROCESS_PACKAGE_VERSION = '0.8.48';

const DID_DHT_PATTERN = /^did:dht:[ybndrfg8ejkmcpqxot1uwisza345h769]{51}[yo]$/u;
const MAX_PASSWORD_BYTES = 1_024;
const MAX_PATH_BYTES = 4_096;
const MAX_URI_BYTES = 2_048;

export type AgentProcessChildStartCommand = Readonly<{
  actorGatewayUri: string;
  remoteDwnOrigin: string;
  storageDirectory: string;
  type: 'start';
}>;

export type AgentProcessChildSecretCommand = Readonly<{
  password: string;
  type: 'initialize' | 'reopen';
}>;

export type AgentProcessChildStopCommand = Readonly<{
  type: 'stop';
}>;

export type AgentProcessChildAwaitingSecret = Readonly<{
  firstLaunch: boolean;
  locked: true;
  packageName: typeof AGENT_PROCESS_PACKAGE_NAME;
  packageVersion: typeof AGENT_PROCESS_PACKAGE_VERSION;
  type: 'awaiting-secret';
}>;

export type AgentProcessChildActive = Readonly<{
  agentDid: string;
  dwnEndpoints: readonly [string];
  firstLaunch: boolean;
  localDwnStrategy: 'off';
  locked: false;
  mode: 'initialized' | 'reopened';
  packageName: typeof AGENT_PROCESS_PACKAGE_NAME;
  packageVersion: typeof AGENT_PROCESS_PACKAGE_VERSION;
  published: true;
  type: 'active';
}>;

export type AgentProcessChildStopped = Readonly<{
  locked: true;
  type: 'stopped';
}>;

function byteLengthWithin(value: string, maximum: number): boolean {
  return Buffer.byteLength(value, 'utf8') <= maximum;
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index): boolean => key === expectedKeys[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(line: string): Record<string, unknown> {
  if (line.length === 0 || !byteLengthWithin(line, AGENT_PROCESS_CHILD_MAX_LINE_BYTES)) {
    throw new Error('AgentProcessChildProtocol: invalid command');
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('AgentProcessChildProtocol: invalid command');
  }
  if (!isRecord(value)) {
    throw new Error('AgentProcessChildProtocol: invalid command');
  }
  return value;
}

function parseCanonicalLoopbackUrl(value: unknown, trailingSlash: boolean): string {
  if (typeof value !== 'string' || value.length === 0 || !byteLengthWithin(value, MAX_URI_BYTES)) {
    throw new Error('AgentProcessChildProtocol: invalid start command');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('AgentProcessChildProtocol: invalid start command');
  }
  const expected = trailingSlash ? `${url.origin}/` : url.origin;
  const port = Number(url.port);
  if (value !== expected || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
    !Number.isInteger(port) || port < 1 || port > 65_535 || url.username.length > 0 ||
    url.password.length > 0 || url.pathname !== '/' || url.search.length > 0 || url.hash.length > 0) {
    throw new Error('AgentProcessChildProtocol: invalid start command');
  }
  return trailingSlash ? `${url.origin}/` : url.origin;
}

function parseStorageDirectory(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || !byteLengthWithin(value, MAX_PATH_BYTES) ||
    !isAbsolute(value) || normalize(value) !== value || value === '/' || value.includes('\0')) {
    throw new Error('AgentProcessChildProtocol: invalid start command');
  }
  return value;
}

/** Parses the public, immutable process configuration without echoing rejected values. */
export function parseAgentProcessChildStartCommand(line: string): AgentProcessChildStartCommand {
  const value = parseJsonRecord(line);
  if (!hasExactKeys(value, ['actorGatewayUri', 'remoteDwnOrigin', 'storageDirectory', 'type']) ||
    value.type !== 'start') {
    throw new Error('AgentProcessChildProtocol: invalid start command');
  }
  return {
    actorGatewayUri  : parseCanonicalLoopbackUrl(value.actorGatewayUri, true),
    remoteDwnOrigin  : parseCanonicalLoopbackUrl(value.remoteDwnOrigin, false),
    storageDirectory : parseStorageDirectory(value.storageDirectory),
    type             : 'start',
  };
}

/** Parses the one-use password command without retaining or echoing the password. */
export function parseAgentProcessChildSecretCommand(line: string): AgentProcessChildSecretCommand {
  const value = parseJsonRecord(line);
  if (!hasExactKeys(value, ['password', 'type']) ||
    (value.type !== 'initialize' && value.type !== 'reopen') ||
    typeof value.password !== 'string' || value.password.trim().length === 0 ||
    !byteLengthWithin(value.password, MAX_PASSWORD_BYTES)) {
    throw new Error('AgentProcessChildProtocol: invalid secret command');
  }
  return { password: value.password, type: value.type };
}

/** Parses the sole command accepted after activation. */
export function parseAgentProcessChildStopCommand(line: string): AgentProcessChildStopCommand {
  const value = parseJsonRecord(line);
  if (!hasExactKeys(value, ['type']) || value.type !== 'stop') {
    throw new Error('AgentProcessChildProtocol: invalid stop command');
  }
  return { type: 'stop' };
}

export function isDidDhtUri(value: string): boolean {
  return DID_DHT_PATTERN.test(value);
}
