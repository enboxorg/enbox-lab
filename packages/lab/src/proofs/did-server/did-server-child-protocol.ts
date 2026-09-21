export const DID_SERVER_CHILD_MAX_LINE_BYTES = 8_192;
export const DID_SERVER_PACKAGE_NAME = '@enbox/dwn-server';
export const DID_SERVER_PACKAGE_VERSION = '0.1.43';

const MAX_RESOLVER_BASE_URI_LENGTH = 2_048;
const MAX_STORAGE_DIRECTORY_LENGTH = 4_096;
const RESOLVER_PATH_PATTERN = /^\/__lab\/resolver\/[0-9a-f]{64}\/$/u;

export type DidServerChildStartCommand = Readonly<{
  publicOrigin: string;
  resolverBaseUri: string;
  storageDirectory: string;
  type: 'start';
}>;

export type DidServerChildStopCommand = Readonly<{
  type: 'stop';
}>;

export type DidServerChildReady = Readonly<{
  origin: string;
  packageName: typeof DID_SERVER_PACKAGE_NAME;
  packageVersion: typeof DID_SERVER_PACKAGE_VERSION;
  type: 'ready';
}>;

function hasExactKeys(value: Record<string, unknown>, expectedKeys: string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index): boolean => key === expectedKeys[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUsablePort(url: URL): boolean {
  const port = Number(url.port);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function parseJsonRecord(line: string): Record<string, unknown> {
  if (line.length === 0 || Buffer.byteLength(line, 'utf8') > DID_SERVER_CHILD_MAX_LINE_BYTES) {
    throw new Error('DidServerChildProtocol: invalid command');
  }

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('DidServerChildProtocol: invalid command');
  }
  if (!isRecord(value)) {
    throw new Error('DidServerChildProtocol: invalid command');
  }
  return value;
}

function assertResolverBaseUri(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RESOLVER_BASE_URI_LENGTH) {
    throw new Error('DidServerChildProtocol: invalid start command');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DidServerChildProtocol: invalid start command');
  }

  if (url.href !== value || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !hasUsablePort(url) ||
    url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0 ||
    !RESOLVER_PATH_PATTERN.test(url.pathname)) {
    throw new Error('DidServerChildProtocol: invalid start command');
  }
}

function assertPublicOrigin(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RESOLVER_BASE_URI_LENGTH) {
    throw new Error('DidServerChildProtocol: invalid start command');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DidServerChildProtocol: invalid start command');
  }
  if (url.origin !== value || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !hasUsablePort(url) ||
    url.username.length > 0 || url.password.length > 0 || url.pathname !== '/' ||
    url.search.length > 0 || url.hash.length > 0) {
    throw new Error('DidServerChildProtocol: invalid start command');
  }
}

function assertStorageDirectory(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STORAGE_DIRECTORY_LENGTH ||
    !value.startsWith('/') || value.includes('\0')) {
    throw new Error('DidServerChildProtocol: invalid start command');
  }
}

/** Parses the sole startup command without including its secret values in failures. */
export function parseDidServerChildStartCommand(line: string): DidServerChildStartCommand {
  const value = parseJsonRecord(line);
  if (!hasExactKeys(value, ['publicOrigin', 'resolverBaseUri', 'storageDirectory', 'type']) || value.type !== 'start') {
    throw new Error('DidServerChildProtocol: invalid start command');
  }
  assertPublicOrigin(value.publicOrigin);
  assertResolverBaseUri(value.resolverBaseUri);
  assertStorageDirectory(value.storageDirectory);
  return {
    publicOrigin     : value.publicOrigin,
    resolverBaseUri  : value.resolverBaseUri,
    storageDirectory : value.storageDirectory,
    type             : 'start',
  };
}

/** Parses the exact shutdown command and rejects fields the child does not understand. */
export function parseDidServerChildStopCommand(line: string): DidServerChildStopCommand {
  const value = parseJsonRecord(line);
  if (!hasExactKeys(value, ['type']) || value.type !== 'stop') {
    throw new Error('DidServerChildProtocol: invalid stop command');
  }
  return { type: 'stop' };
}
