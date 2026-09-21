export type DidServiceWorkerConfigureRequest = {
  actorOrigin: string;
  gatewayUri: string;
  id: string;
  kind: 'configure';
};

export type DidServiceWorkerResolveRequest = {
  didUri: string;
  id: string;
  kind: 'resolve';
};

export type DidServiceWorkerRequest = DidServiceWorkerConfigureRequest | DidServiceWorkerResolveRequest;

const DID_DHT_PATTERN = /^did:dht:[ybndrfg8ejkmcpqxot1uwisza345h769]{51}[yo]$/u;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_ACTOR_ORIGIN_BYTES = 256;
const MAX_GATEWAY_URI_BYTES = 2_048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index): boolean => key === expected[index]);
}

function withinByteLimit(value: string, maximum: number): boolean {
  return new TextEncoder().encode(value).byteLength <= maximum;
}

function isCanonicalHttpOrigin(value: string): boolean {
  if (!withinByteLimit(value, MAX_ACTOR_ORIGIN_BYTES)) {
    return false;
  }
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' &&
      url.origin === value && url.pathname === '/' && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

function isCanonicalGatewayUri(value: string): boolean {
  if (!withinByteLimit(value, MAX_GATEWAY_URI_BYTES)) {
    return false;
  }
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' &&
      url.href === value && url.pathname.endsWith('/') && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

/** Parses the exact bounded command surface accepted by the DID service worker. */
export function parseDidServiceWorkerRequest(value: unknown): DidServiceWorkerRequest | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !REQUEST_ID_PATTERN.test(value.id)) {
    return undefined;
  }
  if (value.kind === 'configure') {
    if (!hasExactKeys(value, ['actorOrigin', 'gatewayUri', 'id', 'kind']) ||
      typeof value.actorOrigin !== 'string' || typeof value.gatewayUri !== 'string' ||
      !isCanonicalHttpOrigin(value.actorOrigin) || !isCanonicalGatewayUri(value.gatewayUri)) {
      return undefined;
    }
    return value as DidServiceWorkerConfigureRequest;
  }
  if (value.kind === 'resolve') {
    if (!hasExactKeys(value, ['didUri', 'id', 'kind']) || typeof value.didUri !== 'string' ||
      !DID_DHT_PATTERN.test(value.didUri)) {
      return undefined;
    }
    return value as DidServiceWorkerResolveRequest;
  }
  return undefined;
}
