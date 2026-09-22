import type { PkarrPublicationServer } from '../../src/pkarr-publication-server.js';

import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { mkdtemp, rm } from 'node:fs/promises';

import { startPkarrPublicationServer } from '../../src/pkarr-publication-server.js';

export type TestPkarrGateway = Readonly<{
  close(): Promise<void>;
  endpoint: string;
  resolverEndpoint: string;
  requests(): readonly Readonly<{ identifier?: string; method: string }>[];
  server: PkarrPublicationServer;
}>;

/** Starts an in-memory Pkarr upstream behind the real durable actor ingress. */
export async function startTestPkarrGateway(label: string): Promise<TestPkarrGateway> {
  const directory = await mkdtemp(join(tmpdir(), `enbox-lab-agent-${label}-`));
  const packets = new Map<string, Uint8Array>();
  const requests: Array<Readonly<{ identifier?: string; method: string }>> = [];
  const server = await startPkarrPublicationServer({
    actorIngress : true,
    fetch        : async (input, init): Promise<Response> => {
      const url = new URL(String(input));
      const identifier = url.pathname === '/' ? undefined : url.pathname.slice(1);
      const method = init?.method ?? 'GET';
      requests.push({ identifier, method });
      if (identifier === undefined) {
        return new Response(undefined, { status: 404 });
      }
      if (method === 'PUT') {
        const packet = new Uint8Array(await new Response(init?.body).arrayBuffer());
        packets.set(identifier, packet);
        return new Response(undefined, { status: 204 });
      }
      const packet = packets.get(identifier);
      return packet === undefined
        ? new Response(undefined, { status: 404 })
        : new Response(new Blob([packet as BlobPart]), {
          headers : { 'Content-Type': 'application/octet-stream' },
          status  : 200,
        });
    },
    journalLocation : join(directory, 'journal.sqlite'),
    resolverIngress : true,
    upstreamBaseUrl : `http://${label}.invalid:15411/`,
  });
  const endpoint = server.actorEndpoint();
  const resolverEndpoint = server.resolverEndpoint();
  if (endpoint === undefined || resolverEndpoint === undefined) {
    await server.stop();
    await rm(directory, { force: true, recursive: true });
    throw new Error('Test Pkarr gateway did not expose its actor ingress.');
  }
  return {
    close: async (): Promise<void> => {
      await server.stop();
      await rm(directory, { force: true, recursive: true });
    },
    endpoint,
    resolverEndpoint,
    requests: (): readonly Readonly<{ identifier?: string; method: string }>[] => requests,
    server,
  };
}
