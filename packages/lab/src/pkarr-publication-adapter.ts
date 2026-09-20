import type { AcceptedPkarrPublication, PkarrPublicationStore } from './pkarr-publication-journal.js';

const PKARR_SIGNATURE_BYTES = 64;
const PKARR_SEQUENCE_BYTES = 8;
const PKARR_PACKET_MIN_BYTES = PKARR_SIGNATURE_BYTES + PKARR_SEQUENCE_BYTES;
export const PKARR_PACKET_MAX_BYTES = PKARR_PACKET_MIN_BYTES + 1000;
export const PKARR_MAX_PUBLICATIONS = 1_024;
const MAX_BEP44_SEQUENCE = 0x7fff_ffff_ffff_ffffn;

export type PkarrPublicationAdapterOptions = {
  fetch?: PkarrFetch;
  journal: PkarrPublicationStore;
  maxPublications?: number;
  now?: () => Date;
  requestTimeoutMs?: number;
  upstreamBaseUrl: string;
};

export type PkarrFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type PkarrRestoreResult = {
  detail?: string;
  identifier: string;
  sequence: string;
  status: 'failed' | 'restored';
};

class SerialQueue {
  private _tail = Promise.resolve();

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this._tail;
    let release = (): void => {};
    const current = new Promise<void>((resolve): void => { release = resolve; });
    this._tail = current;

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

class PkarrPacketTooLargeError extends Error {}

function packetsEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index): boolean => value === right[index]);
}

function readSequence(packet: Uint8Array): bigint {
  if (packet.byteLength < PKARR_PACKET_MIN_BYTES || packet.byteLength > PKARR_PACKET_MAX_BYTES) {
    throw new RangeError(`Pkarr packet must be between ${PKARR_PACKET_MIN_BYTES} and ${PKARR_PACKET_MAX_BYTES} bytes.`);
  }

  const sequence = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
    .getBigUint64(PKARR_SIGNATURE_BYTES);
  if (sequence > MAX_BEP44_SEQUENCE) {
    throw new RangeError('Pkarr sequence exceeds the BEP44 signed 64-bit maximum.');
  }
  return sequence;
}

async function readPacketBody(request: Request): Promise<Uint8Array> {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new RangeError('Pkarr Content-Length must be a non-negative safe integer.');
    }
    if (contentLength > PKARR_PACKET_MAX_BYTES) {
      throw new PkarrPacketTooLargeError(`Pkarr packet exceeds ${PKARR_PACKET_MAX_BYTES} bytes.`);
    }
  }

  if (request.body === null) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  const reader = request.body.getReader();
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > PKARR_PACKET_MAX_BYTES) {
        await reader.cancel();
        throw new PkarrPacketTooLargeError(`Pkarr packet exceeds ${PKARR_PACKET_MAX_BYTES} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const packet = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    packet.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return packet;
}

function identifierFromRequest(request: Request): string | undefined {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return segments.length === 1 ? segments[0] : undefined;
}

function upstreamBaseUrl(value: string): URL {
  const url = new URL(value);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '') {
    throw new TypeError('Pkarr upstream base URL must use HTTP(S) without credentials, a query, or a fragment.');
  }
  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

/**
 * Proxies the standard Pkarr HTTP API while durably retaining the latest accepted signed packet.
 * Reads always come from the real upstream relay/DHT rather than this journal.
 */
export class PkarrPublicationAdapter {
  private readonly _fetch: PkarrFetch;
  private readonly _activeOperations = new Set<Promise<unknown>>();
  private readonly _upstreamControllers = new Set<AbortController>();
  private readonly _journal: PkarrPublicationStore;
  private readonly _maxPublications: number;
  private readonly _now: () => Date;
  private readonly _queue = new SerialQueue();
  private readonly _requestTimeoutMs: number;
  private readonly _upstreamBaseUrl: URL;
  private _lastJournalError?: string;
  private _lastMaintenanceError?: string;
  private _lastUpstreamError?: string;
  private _accepting = true;
  private _maintenanceGeneration = 0;
  private _maintenanceTimer?: ReturnType<typeof setTimeout>;

  public constructor(options: PkarrPublicationAdapterOptions) {
    this._fetch = options.fetch ?? fetch;
    this._journal = options.journal;
    this._maxPublications = options.maxPublications ?? PKARR_MAX_PUBLICATIONS;
    this._now = options.now ?? ((): Date => new Date());
    this._requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this._upstreamBaseUrl = upstreamBaseUrl(options.upstreamBaseUrl);
    if (!Number.isSafeInteger(this._requestTimeoutMs) || this._requestTimeoutMs <= 0) {
      throw new RangeError('Pkarr upstream request timeout must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(this._maxPublications) || this._maxPublications < 1) {
      throw new RangeError('Pkarr maximum publication count must be a positive safe integer.');
    }
  }

  public handle(request: Request): Promise<Response> {
    if (!this._accepting) {
      return Promise.resolve(Response.json({ error: 'Pkarr publication adapter is stopping' }, { status: 503 }));
    }
    return this.track(this.handleRequest(request).catch((error: unknown): Response => {
      const detail = error instanceof Error ? error.message : String(error);
      return Response.json({ error: 'Pkarr upstream request failed', detail }, { status: 502 });
    }));
  }

  public beginShutdown(): void {
    this._accepting = false;
    this.stopMaintenance();
    for (const controller of this._upstreamControllers) {
      controller.abort(new Error('Pkarr publication adapter is stopping.'));
    }
  }

  public async drain(): Promise<void> {
    while (this._activeOperations.size > 0) {
      await Promise.allSettled([...this._activeOperations]);
    }
  }

  private async handleRequest(request: Request): Promise<Response> {
    const identifier = identifierFromRequest(request);
    if (identifier === undefined) {
      return Response.json({ error: 'expected a single Pkarr identifier path segment' }, { status: 404 });
    }

    if (request.method === 'GET') {
      return this.forward(identifier, { method: 'GET' });
    }
    if (request.method !== 'PUT') {
      return new Response(undefined, { headers: { Allow: 'GET, PUT' }, status: 405 });
    }

    let packet: Uint8Array;
    let sequence: bigint;
    try {
      packet = await readPacketBody(request);
      sequence = readSequence(packet);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return Response.json({ error: detail }, { status: error instanceof PkarrPacketTooLargeError ? 413 : 400 });
    }

    return this._queue.run((): Promise<Response> => this.publish(identifier, sequence, packet));
  }

  public get lastMaintenanceError(): string | undefined {
    return this._lastMaintenanceError;
  }

  public get lastError(): string | undefined {
    return this._lastMaintenanceError ?? this._lastJournalError ?? this._lastUpstreamError;
  }

  /** Confirms that the configured upstream is reachable without treating its root status as readiness data. */
  public probeUpstream(): Promise<void> {
    if (!this._accepting) {
      return Promise.reject(new Error('Pkarr publication adapter is stopping.'));
    }
    return this.track(this.performUpstreamProbe());
  }

  private async performUpstreamProbe(): Promise<void> {
    try {
      const response = await this.fetchUpstream(this._upstreamBaseUrl, {
        method   : 'GET',
        redirect : 'error',
        signal   : AbortSignal.timeout(this._requestTimeoutMs),
      });
      await response.body?.cancel().catch((): void => {});
      if (response.status >= 500) {
        throw new Error(`Pkarr upstream probe returned ${response.status}.`);
      }
      this._lastUpstreamError = undefined;
    } catch (error: unknown) {
      this._lastUpstreamError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  public restore(): Promise<PkarrRestoreResult[]> {
    if (!this._accepting) {
      return Promise.reject(new Error('Pkarr publication adapter is stopping.'));
    }
    return this.track(this.restoreAll());
  }

  private async restoreAll(): Promise<PkarrRestoreResult[]> {
    const publicationCount = this._journal.count();
    if (publicationCount > this._maxPublications) {
      throw new Error(`Pkarr journal contains ${publicationCount} publications, exceeding the configured limit of ${this._maxPublications}.`);
    }
    const results: PkarrRestoreResult[] = [];
    for (const publication of this._journal.list()) {
      results.push(await this._queue.run((): Promise<PkarrRestoreResult> => this.restoreIdentifier(publication.identifier)));
    }
    return results;
  }

  public startMaintenance(intervalMs: number): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new RangeError('Pkarr maintenance interval must be a positive safe integer.');
    }
    this.stopMaintenance();
    const generation = this._maintenanceGeneration;
    const schedule = (): void => {
      this._maintenanceTimer = setTimeout((): void => { void run(); }, intervalMs);
    };
    const run = async (): Promise<void> => {
      try {
        await this.probeUpstream();
        const results = await this.restore();
        const failures = results.filter((result): boolean => result.status === 'failed');
        this._lastMaintenanceError = failures.length === 0
          ? undefined
          : failures.map((failure): string => `${failure.identifier}: ${failure.detail ?? 'unknown failure'}`).join('; ');
      } catch (error: unknown) {
        this._lastMaintenanceError = error instanceof Error ? error.message : String(error);
      } finally {
        if (generation === this._maintenanceGeneration) {
          schedule();
        }
      }
    };
    schedule();
  }

  public stopMaintenance(): void {
    this._maintenanceGeneration += 1;
    if (this._maintenanceTimer !== undefined) {
      clearTimeout(this._maintenanceTimer);
      this._maintenanceTimer = undefined;
    }
  }

  private async forward(identifier: string, init: RequestInit): Promise<Response> {
    const url = new URL(encodeURIComponent(identifier), this._upstreamBaseUrl);
    try {
      const response = await this.fetchUpstream(url, {
        ...init,
        redirect : 'error',
        signal   : init.signal ?? AbortSignal.timeout(this._requestTimeoutMs),
      });
      this._lastUpstreamError = response.status >= 500 ? `upstream returned ${response.status}` : undefined;
      return response;
    } catch (error: unknown) {
      this._lastUpstreamError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private async publish(identifier: string, sequence: bigint, packet: Uint8Array): Promise<Response> {
    if (!this._accepting) {
      return Response.json({ error: 'Pkarr publication adapter is stopping' }, { status: 503 });
    }
    const current = this._journal.get(identifier);
    if (current === undefined && this._journal.count() >= this._maxPublications) {
      return Response.json({ error: 'Pkarr durable publication quota is full' }, { status: 507 });
    }
    if (current !== undefined && sequence < current.sequence) {
      return Response.json({ error: 'publication sequence is older than the durable accepted version' }, { status: 409 });
    }
    if (current !== undefined && sequence === current.sequence && !packetsEqual(packet, current.packet)) {
      return Response.json({ error: 'publication conflicts with the durable packet at the same sequence' }, { status: 409 });
    }

    const upstream = await this.forward(identifier, {
      body    : new Blob([packet as BlobPart]),
      headers : { 'Content-Type': 'application/octet-stream' },
      method  : 'PUT',
    });
    if (!upstream.ok) {
      return upstream;
    }

    try {
      this._journal.set({
        acceptedAt: this._now().toISOString(),
        identifier,
        packet,
        sequence,
      });
      this._lastJournalError = undefined;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this._lastJournalError = detail;
      await upstream.body?.cancel().catch((): void => {});
      return Response.json({
        error   : 'upstream accepted the publication but the durable journal failed',
        outcome : 'unknown',
        detail,
      }, { status: 500 });
    }

    return upstream;
  }

  private async restoreIdentifier(identifier: string): Promise<PkarrRestoreResult> {
    const current = this._journal.get(identifier);
    if (!this._accepting) {
      return { detail: 'Pkarr publication adapter is stopping', identifier, sequence: current?.sequence.toString() ?? '', status: 'failed' };
    }
    if (current === undefined) {
      return { detail: 'publication was removed before replay', identifier, sequence: '', status: 'failed' };
    }

    try {
      const response = await this.forward(identifier, {
        body    : new Blob([current.packet as BlobPart]),
        headers : { 'Content-Type': 'application/octet-stream' },
        method  : 'PUT',
      });
      await response.body?.cancel().catch((): void => {});
      if (!response.ok) {
        return this.restoreFailure(current, `upstream returned ${response.status}`);
      }
      return { identifier, sequence: current.sequence.toString(), status: 'restored' };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return this.restoreFailure(current, detail);
    }
  }

  private restoreFailure(publication: AcceptedPkarrPublication, detail: string): PkarrRestoreResult {
    return {
      detail,
      identifier : publication.identifier,
      sequence   : publication.sequence.toString(),
      status     : 'failed',
    };
  }

  private async fetchUpstream(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    this._upstreamControllers.add(controller);
    try {
      const signal = init.signal === undefined || init.signal === null
        ? controller.signal
        : AbortSignal.any([init.signal, controller.signal]);
      return await this._fetch(input, { ...init, signal });
    } finally {
      this._upstreamControllers.delete(controller);
    }
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally((): void => {
      this._activeOperations.delete(tracked);
    });
    this._activeOperations.add(tracked);
    return tracked;
  }
}
