import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { ConnectClientMetadata, ConnectPermissionRequest, ConnectRequest } from '@enbox/connect';

import { assertConnectRequest } from '@enbox/connect';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

export const LAB_NOTE_WRITE_APP_NAME = 'Enbox Lab note-write fixture';
export const LAB_NOTE_WRITE_MAX_APPROVALS = 64;
export const LAB_NOTE_WRITE_PROTOCOL_URI = 'https://enbox.org/protocols/lab-note-write';
export const LAB_NOTE_WRITE_SESSION_TTL_SECONDS = 60 * 60;

const REQUEST_KEYS = [
  'appName', 'clientDid', 'clientMetadata', 'expectedProviderDid', 'nonce', 'permissionRequests',
  'reply', 'requestType', 'responseKey', 'state', 'supportedDidMethods',
] as const;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) { deepFreeze(child); }
    Object.freeze(value);
  }
  return value;
}

/** Fixed unencrypted note protocol used only to prove one real write approval. */
export const LAB_NOTE_WRITE_PROTOCOL_DEFINITION: ProtocolDefinition = deepFreeze({
  protocol  : LAB_NOTE_WRITE_PROTOCOL_URI,
  published : true,
  types     : {
    note: {
      dataFormats : ['text/plain'],
      schema      : `${LAB_NOTE_WRITE_PROTOCOL_URI}/schema/note`,
    },
  },
  structure: {
    note: {},
  },
});

/** The only permission request the process-backed note-write proof may approve. */
export const LAB_NOTE_WRITE_PERMISSION_REQUEST: ConnectPermissionRequest = deepFreeze({
  permissionScopes: [{
    interface : DwnInterfaceName.Records,
    method    : DwnMethodName.Write,
    protocol  : LAB_NOTE_WRITE_PROTOCOL_URI,
  }],
  protocolDefinition: LAB_NOTE_WRITE_PROTOCOL_DEFINITION,
});

const CLIENT_METADATA_LIMITS = Object.freeze({
  language  : 64,
  languages : 16,
  origin    : 512,
  platform  : 128,
  timezone  : 128,
  userAgent : 512,
});

const CLIENT_METADATA_KEYS = ['language', 'languages', 'origin', 'platform', 'timezone', 'userAgent'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key): boolean => allowedKeys.includes(key));
}

function hasExpectedRequestKeys(value: Record<string, unknown>): boolean {
  const required = [
    'appName', 'clientDid', 'clientMetadata', 'nonce', 'permissionRequests', 'reply',
    'responseKey', 'state', 'supportedDidMethods',
  ];
  const actual = Object.keys(value);
  return required.every((key): boolean => actual.includes(key)) && hasOnlyKeys(value, REQUEST_KEYS);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key): string =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function boundedOptionalString(value: unknown, maximum: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= maximum);
}

function validClientMetadata(value: unknown, dappOrigin: string): value is ConnectClientMetadata {
  if (!isRecord(value) || !hasOnlyKeys(value, CLIENT_METADATA_KEYS)) { return false; }
  if (!boundedOptionalString(value.userAgent, CLIENT_METADATA_LIMITS.userAgent) ||
    !boundedOptionalString(value.platform, CLIENT_METADATA_LIMITS.platform) ||
    !boundedOptionalString(value.language, CLIENT_METADATA_LIMITS.language) ||
    !boundedOptionalString(value.timezone, CLIENT_METADATA_LIMITS.timezone)) {
    return false;
  }
  if (value.languages !== undefined && (!Array.isArray(value.languages) ||
    value.languages.length === 0 || value.languages.length > CLIENT_METADATA_LIMITS.languages ||
    value.languages.some((language): boolean =>
      typeof language !== 'string' || language.length === 0 || language.length > CLIENT_METADATA_LIMITS.language))) {
    return false;
  }
  return value.origin === dappOrigin;
}

function assertFixedNoteWriteRequest(
  value: unknown,
  providerDid: string,
  dappOrigin: string,
): asserts value is ConnectRequest {
  assertLabNoteWriteDappOrigin(dappOrigin);
  if (!isRecord(value)) {
    throw new Error('AgentProcessNoteWriteApproval: invalid connect request');
  }
  try {
    assertConnectRequest(value);
  } catch {
    throw new Error('AgentProcessNoteWriteApproval: invalid connect request');
  }
  if (!hasExpectedRequestKeys(value) || value.appName !== LAB_NOTE_WRITE_APP_NAME || value.appIcon !== undefined ||
    value.applicationId !== undefined || value.requestedSessionTtlSeconds !== undefined ||
    (value.requestType !== undefined && value.requestType !== 'connect') || value.delegateDid !== undefined ||
    (value.expectedProviderDid !== undefined && value.expectedProviderDid !== providerDid) ||
    !/^did:jwk:[A-Za-z0-9_-]{16,2048}$/u.test(value.clientDid) ||
    !/^[A-Za-z0-9_-]{22}$/u.test(value.nonce) || !/^[A-Za-z0-9_-]{22}$/u.test(value.state) ||
    !isRecord(value.reply) ||
    !isRecord(value.responseKey) || !hasOnlyKeys(value.responseKey, ['crv', 'kty', 'x']) ||
    !isDeepEqual(value.supportedDidMethods, ['did:dht', 'did:jwk']) ||
    !validClientMetadata(value.clientMetadata, dappOrigin) ||
    !isDeepEqual(value.permissionRequests, [LAB_NOTE_WRITE_PERMISSION_REQUEST])) {
    throw new Error('AgentProcessNoteWriteApproval: connect request is outside the fixed note-write policy');
  }
}

/** Requires the proof's canonical plain-localhost popup origin. */
export function assertLabNoteWriteDappOrigin(value: string): void {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error('AgentProcessNoteWriteApproval: invalid dapp origin');
  }
  const port = Number(origin.port);
  if (origin.origin !== value || origin.protocol !== 'http:' || origin.hostname !== 'localhost' ||
    !Number.isInteger(port) || port < 1 || port > 65_535 || origin.pathname !== '/' ||
    origin.username.length > 0 || origin.password.length > 0 || origin.search.length > 0 || origin.hash.length > 0) {
    throw new Error('AgentProcessNoteWriteApproval: invalid dapp origin');
  }
}

/** Requires the proof's exact numeric-loopback released-relay origin. */
export function assertLabNoteWriteRelayOrigin(value: string): void {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error('AgentProcessNoteWriteApproval: invalid relay origin');
  }
  const port = Number(origin.port);
  if (origin.origin !== value || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' ||
    !Number.isInteger(port) || port < 1 || port > 65_535 || origin.pathname !== '/' ||
    origin.username.length > 0 || origin.password.length > 0 || origin.search.length > 0 || origin.hash.length > 0) {
    throw new Error('AgentProcessNoteWriteApproval: invalid relay origin');
  }
}

/** Revalidates the already-opened popup request against the one fixed note-write consent policy. */
export function assertLabNoteWritePopupRequest(
  value: unknown,
  providerDid: string,
  dappOrigin: string,
): asserts value is ConnectRequest {
  assertFixedNoteWriteRequest(value, providerDid, dappOrigin);
  if (!isDeepEqual(value.reply, { mode: 'post_message' })) {
    throw new Error('AgentProcessNoteWriteApproval: popup request is outside the fixed note-write policy');
  }
}

/** Revalidates one direct-post request against the fixed note-write policy and exact relay. */
export function assertLabNoteWriteRelayRequest(
  value: unknown,
  providerDid: string,
  dappOrigin: string,
  relayOrigin: string,
): asserts value is ConnectRequest {
  assertLabNoteWriteRelayOrigin(relayOrigin);
  assertFixedNoteWriteRequest(value, providerDid, dappOrigin);
  if (!isDeepEqual(value.reply, { callbackUrl: `${relayOrigin}/connect/callback`, mode: 'direct_post' })) {
    throw new Error('AgentProcessNoteWriteApproval: relay request is outside the fixed note-write policy');
  }
}

/** Returns a JSON-owned snapshot so later caller mutation cannot alter the approved request. */
export function cloneLabNoteWriteRequest(value: ConnectRequest): ConnectRequest {
  return JSON.parse(JSON.stringify(value)) as ConnectRequest;
}

/** Returns a JSON-owned snapshot so later caller mutation cannot alter the approved request. */
export function cloneLabNoteWritePopupRequest(value: ConnectRequest): ConnectRequest {
  return cloneLabNoteWriteRequest(value);
}

/** Fingerprints every admitted request field for process-lifetime replay rejection. */
export async function fingerprintLabNoteWriteRequest(request: ConnectRequest): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(request)));
  return [...new Uint8Array(digest)].map((byte): string => byte.toString(16).padStart(2, '0')).join('');
}

/** Fingerprints every admitted request field for process-lifetime replay rejection. */
export async function fingerprintLabNoteWritePopupRequest(request: ConnectRequest): Promise<string> {
  return fingerprintLabNoteWriteRequest(request);
}
