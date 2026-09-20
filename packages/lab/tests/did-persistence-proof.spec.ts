import type { DidDocument } from '@enbox/dids';
import type { Server } from 'bun';

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { didPersistenceProofInternals, runDidPersistenceProof } from '../src/proofs/did-persistence-proof.js';
import { mkdtemp, rm } from 'node:fs/promises';

type Relay = {
  endpoint: string;
  server: Server<undefined>;
};

async function startRelay(): Promise<Relay> {
  const packets = new Map<string, Uint8Array>();
  const server = Bun.serve({
    fetch: async (request): Promise<Response> => {
      const identifier = new URL(request.url).pathname.slice(1);
      if (request.method === 'PUT') {
        packets.set(identifier, new Uint8Array(await request.arrayBuffer()));
        return new Response(undefined, { status: 204 });
      }
      const packet = packets.get(identifier);
      return packet === undefined
        ? new Response(undefined, { status: 404 })
        : new Response(packet as BodyInit, { status: 200 });
    },
    hostname : '127.0.0.1',
    port     : 0,
  });
  return { endpoint: `http://127.0.0.1:${server.port}/`, server };
}

describe('DID persistence proof', () => {
  it('should require an exact DecentralizedWebNode service endpoint', () => {
    const document = {
      id      : 'did:dht:example',
      service : [{
        id              : 'did:dht:example#dwn',
        serviceEndpoint : ['http://localhost:43210', 'http://localhost:43211'],
        type            : 'DecentralizedWebNode',
      }],
    } satisfies DidDocument;

    expect(didPersistenceProofInternals.hasAdvertisedDwnEndpoint(document, 'http://localhost:43210')).toBe(true);
    expect(didPersistenceProofInternals.hasAdvertisedDwnEndpoint(document, 'http://localhost:43212')).toBe(false);
    expect(didPersistenceProofInternals.hasAdvertisedDwnEndpoint({
      ...document,
      service: [{ ...document.service[0], type: 'LinkedDomains' }],
    }, 'http://localhost:43210')).toBe(false);
    expect(didPersistenceProofInternals.hasAdvertisedDwnEndpoint(undefined, 'http://localhost:43210')).toBe(false);
  });

  it('should restore an exact signed DID publication after upstream recreation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-did-proof-'));
    let relay = await startRelay();
    try {
      const report = await runDidPersistenceProof({
        advertisedDwnEndpoint : 'http://localhost:43210',
        journalLocation       : join(directory, 'publications.sqlite'),
        recreateUpstream      : async (): Promise<string> => {
          await relay.server.stop(true);
          relay = await startRelay();
          return relay.endpoint;
        },
        upstreamBaseUrl: relay.endpoint,
      });

      expect(report.status).toBe('unsupported');
      expect(report.checks.filter((check): boolean => check.status === 'pass')).toHaveLength(4);
      expect(report.checks).toContainEqual(expect.objectContaining({
        details : expect.objectContaining({ advertisedEndpointPresent: true }),
        id      : 'A06-private-resolution-before-restart',
        status  : 'pass',
      }));
      expect(report.checks).toContainEqual(expect.objectContaining({
        details : expect.objectContaining({ advertisedEndpointPresent: true }),
        id      : 'A08-resolution-after-restoration',
        status  : 'pass',
      }));
      expect(report.checks).toContainEqual(expect.objectContaining({
        id     : 'A09-network-only-cache-bypass',
        status : 'unsupported',
      }));
    } finally {
      await relay.server.stop(true);
      await rm(directory, { force: true, recursive: true });
    }
  });
});
