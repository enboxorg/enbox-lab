import type { DidServiceWorkerRequest } from './did-service-worker-protocol.js';

import { parseDidServiceWorkerRequest } from './did-service-worker-protocol.js';

type WorkerClient = {
  id: string;
  url: string;
};

type DidServiceWorkerMessageEvent = MessageEvent<unknown> & {
  source: WorkerClient | null;
  waitUntil(operation: Promise<unknown>): void;
};

type DidServiceWorkerScope = {
  addEventListener(type: 'message', listener: (event: DidServiceWorkerMessageEvent) => void): void;
  clients: {
    matchAll(options: { includeUncontrolled: true; type: 'window' }): Promise<WorkerClient[]>;
  };
};

type WorkerConfiguration = {
  actorOrigin: string;
  gatewayUri: string;
};

type WorkerResponse =
  | { error: string; id: string; ok: false }
  | { id: string; ok: true; result: { configured: true } | { resolvedDid: string } };

const MAX_CONFIGURED_CLIENTS = 16;
const configurations = new Map<string, WorkerConfiguration>();
const scope = globalThis as unknown as DidServiceWorkerScope;

function responseId(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return '';
  }
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' && id.length <= 128 ? id : '';
}

function reply(port: MessagePort, response: WorkerResponse): void {
  port.postMessage(response);
  port.close();
}

async function pruneConfigurations(): Promise<void> {
  const clients = await scope.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  const liveIds = new Set(clients.map((client): string => client.id));
  for (const clientId of configurations.keys()) {
    if (!liveIds.has(clientId)) {
      configurations.delete(clientId);
    }
  }
}

async function configure(
  request: Extract<DidServiceWorkerRequest, { kind: 'configure' }>,
  source: WorkerClient,
  port: MessagePort,
): Promise<void> {
  let sourceOrigin: string;
  try {
    sourceOrigin = new URL(source.url).origin;
  } catch {
    reply(port, { error: 'invalid-source', id: request.id, ok: false });
    return;
  }
  if (request.actorOrigin !== sourceOrigin) {
    reply(port, { error: 'actor-mismatch', id: request.id, ok: false });
    return;
  }
  await pruneConfigurations();
  const existing = configurations.get(source.id);
  if (existing !== undefined) {
    if (existing.actorOrigin !== sourceOrigin || existing.gatewayUri !== request.gatewayUri) {
      reply(port, { error: 'configuration-conflict', id: request.id, ok: false });
      return;
    }
    reply(port, { id: request.id, ok: true, result: { configured: true } });
    return;
  }
  if (configurations.size >= MAX_CONFIGURED_CLIENTS) {
    reply(port, { error: 'configuration-capacity', id: request.id, ok: false });
    return;
  }
  configurations.set(source.id, { actorOrigin: sourceOrigin, gatewayUri: request.gatewayUri });
  reply(port, { id: request.id, ok: true, result: { configured: true } });
}

async function resolveDid(
  request: Extract<DidServiceWorkerRequest, { kind: 'resolve' }>,
  source: WorkerClient,
  port: MessagePort,
): Promise<void> {
  const configuration = configurations.get(source.id);
  if (configuration === undefined || new URL(source.url).origin !== configuration.actorOrigin) {
    reply(port, { error: 'worker-unconfigured', id: request.id, ok: false });
    return;
  }
  try {
    const { DidDht } = await import('@enbox/dids');
    const resolution = await DidDht.resolve(request.didUri, {
      allowPrivateGatewayUri : true,
      gatewayUri             : configuration.gatewayUri,
    });
    const resolvedDid = resolution.didDocument?.id ?? '';
    if (resolvedDid !== request.didUri) {
      reply(port, { error: 'resolution-failed', id: request.id, ok: false });
      return;
    }
    reply(port, { id: request.id, ok: true, result: { resolvedDid } });
  } catch {
    reply(port, { error: 'resolution-failed', id: request.id, ok: false });
  }
}

async function handleMessage(event: DidServiceWorkerMessageEvent): Promise<void> {
  const port = event.ports[0];
  if (port === undefined) {
    return;
  }
  const request = parseDidServiceWorkerRequest(event.data);
  if (request === undefined) {
    reply(port, { error: 'invalid-request', id: responseId(event.data), ok: false });
    return;
  }
  const source = event.source;
  if (source === null || source.id === '' || source.url === '') {
    reply(port, { error: 'invalid-source', id: request.id, ok: false });
    return;
  }
  if (request.kind === 'configure') {
    await configure(request, source, port);
  } else {
    await resolveDid(request, source, port);
  }
}

scope.addEventListener('message', (event): void => {
  event.waitUntil(handleMessage(event).catch((): void => {
    const port = event.ports[0];
    if (port !== undefined) {
      reply(port, { error: 'worker-failed', id: responseId(event.data), ok: false });
    }
  }));
});
