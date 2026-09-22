import type { ConnectRequest } from '@enbox/connect';
import type { ConnectWorkerSessionHandle } from '../proofs/connect/connect-worker-boundary.js';
import type {
  AgentProcessNoteWritePopupApproval,
  AgentProcessNoteWritePopupApprovalParams,
} from './agent-process/agent-process-runtime.js';

import { AgentProcessApprovalOutcomeUnknownError } from './agent-process/agent-process-runtime.js';
import { assertLabNoteWriteDappOrigin } from './agent-process/note-write-approval.js';

import { ConnectWorkerBoundaryError, ConnectWorkerSessionRegistry } from '../proofs/connect/connect-worker-boundary.js';

export const POPUP_APPROVAL_BIND_PATH = '/__lab/connect/popup/bind';
export const POPUP_APPROVAL_APPROVE_PATH = '/__lab/connect/popup/approve';
export const POPUP_APPROVAL_CANCEL_PATH = '/__lab/connect/popup/cancel';
export const POPUP_APPROVAL_SESSION_HEADER = 'x-enbox-lab-session';
export const POPUP_APPROVAL_MAX_BODY_BYTES = 65_536;
const POPUP_APPROVAL_MAX_COMPLETED_RESULTS = 64;
const POPUP_APPROVAL_STOP_TIMEOUT_MS = 65_000;

type PopupApprovalAgent = {
  approveNoteWritePopup(params: AgentProcessNoteWritePopupApprovalParams): Promise<AgentProcessNoteWritePopupApproval>;
};

type CompletedApproval = Readonly<{
  expiresAt: number;
  outcome: PopupApprovalOutcome;
}>;

type PendingApproval = Readonly<{
  expiresAt: number;
  promise: Promise<PopupApprovalOutcome>;
}>;

type PopupApprovalOutcome =
  | Readonly<{ idToken: string; ok: true }>
  | Readonly<{ code: 'approval-failed' | 'reconciliation-required'; ok: false }>;

export type PopupApprovalBridgeBootstrap = Readonly<{
  approvePath: typeof POPUP_APPROVAL_APPROVE_PATH;
  bindPath: typeof POPUP_APPROVAL_BIND_PATH;
  cancelPath: typeof POPUP_APPROVAL_CANCEL_PATH;
  sessionCapability: string;
  sessionHeader: typeof POPUP_APPROVAL_SESSION_HEADER;
  walletOrigin: string;
}>;

export type PopupApprovalBridgeOptions = Readonly<{
  agent: PopupApprovalAgent;
  dappOrigin: string;
  walletOrigin: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index): boolean => key === expected[index]);
}

function secureHeaders(contentType?: string): Headers {
  const headers = new Headers({
    'Cache-Control'                : 'no-store',
    'Content-Security-Policy'      : 'default-src \'none\'; frame-ancestors \'none\'',
    'Cross-Origin-Resource-Policy' : 'same-origin',
    'Referrer-Policy'              : 'no-referrer',
    'X-Content-Type-Options'       : 'nosniff',
  });
  if (contentType !== undefined) { headers.set('Content-Type', contentType); }
  return headers;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: secureHeaders('application/json'),
    status,
  });
}

function hiddenResponse(): Response {
  return new Response('not found', { headers: secureHeaders('text/plain'), status: 404 });
}

function failureResponse(code: string, status: number): Response {
  return jsonResponse({ error: { code }, ok: false }, status);
}

function canonicalWalletOrigin(value: string): string {
  assertLabNoteWriteDappOrigin(value);
  return value;
}

function requestPath(request: Request, walletOrigin: string): string | undefined {
  const url = new URL(request.url);
  const expectedHost = new URL(walletOrigin).host;
  if (url.origin !== walletOrigin || request.headers.get('host') !== expectedHost || url.username !== '' ||
    url.password !== '' || url.search !== '' || url.hash !== '' || url.href !== `${walletOrigin}${url.pathname}`) {
    return undefined;
  }
  return url.pathname;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type') !== 'application/json' || request.body === null) {
    throw new Error('invalid body');
  }
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 1 || declared > POPUP_APPROVAL_MAX_BODY_BYTES) {
      throw new Error('invalid body');
    }
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) { break; }
      length += result.value.byteLength;
      if (length > POPUP_APPROVAL_MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('invalid body');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) { throw new Error('invalid body'); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error('invalid body');
  }
}

function parseHandle(value: unknown): ConnectWorkerSessionHandle {
  if (!isRecord(value) || !hasExactKeys(value, ['expiresAt', 'id']) ||
    !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) < 0 ||
    typeof value.id !== 'string') {
    throw new Error('invalid handle');
  }
  return { expiresAt: value.expiresAt as number, id: value.id };
}

function validOpaqueIdToken(value: unknown): value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > POPUP_APPROVAL_MAX_BODY_BYTES) {
    return false;
  }
  const segments = value.split('.');
  return segments.length === 5 && segments[0]!.length > 0 && segments[1] === '' &&
    segments.slice(2).every((segment): boolean => /^[A-Za-z0-9_-]+$/u.test(segment));
}

async function waitForApprovals(promises: Promise<unknown>[]): Promise<boolean> {
  if (promises.length === 0) { return true; }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolvePromise): void => {
    timeoutId = setTimeout((): void => { resolvePromise(false); }, POPUP_APPROVAL_STOP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      Promise.allSettled(promises).then((): true => true),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Same-origin, session-authenticated bridge from a wallet consent page to one agent process. */
export class PopupApprovalBridge {
  #sessionCapability: string;

  private readonly _agent: PopupApprovalAgent;
  private readonly _completed = new Map<string, CompletedApproval>();
  private readonly _context: Readonly<{ principalId: string }>;
  private readonly _dappOrigin: string;
  private readonly _pending = new Map<string, PendingApproval>();
  private readonly _registry = new ConnectWorkerSessionRegistry();
  private readonly _walletOrigin: string;
  private _stopPromise?: Promise<void>;
  private _stopped = false;

  public constructor(options: PopupApprovalBridgeOptions) {
    this._agent = options.agent;
    assertLabNoteWriteDappOrigin(options.dappOrigin);
    this._dappOrigin = options.dappOrigin;
    this._walletOrigin = canonicalWalletOrigin(options.walletOrigin);
    if (this._dappOrigin === this._walletOrigin) {
      throw new Error('PopupApprovalBridge: dapp and wallet origins must be distinct');
    }
    this.#sessionCapability = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte): string => byte.toString(16).padStart(2, '0'))
      .join('');
    this._context = Object.freeze({ principalId: crypto.randomUUID() });
  }

  public get walletOrigin(): string { return this._walletOrigin; }

  /** Returns the secret bootstrap for injection into this wallet origin; it never belongs in a URL. */
  public bootstrap(): PopupApprovalBridgeBootstrap {
    if (this._stopped) { throw new Error('PopupApprovalBridge: bridge is stopped'); }
    return Object.freeze({
      approvePath       : POPUP_APPROVAL_APPROVE_PATH,
      bindPath          : POPUP_APPROVAL_BIND_PATH,
      cancelPath        : POPUP_APPROVAL_CANCEL_PATH,
      sessionCapability : this.#sessionCapability,
      sessionHeader     : POPUP_APPROVAL_SESSION_HEADER,
      walletOrigin      : this._walletOrigin,
    });
  }

  /** Prevents ordinary serialization from disclosing the session capability or request snapshots. */
  public toJSON(): Readonly<{ stopped: boolean; walletOrigin: string }> {
    return { stopped: this._stopped, walletOrigin: this._walletOrigin };
  }

  /** Handles only the three exact same-origin POST routes owned by this bridge. */
  public async handle(request: Request): Promise<Response> {
    const path = requestPath(request, this._walletOrigin);
    if (this._stopped || request.method !== 'POST' || path === undefined ||
      (path !== POPUP_APPROVAL_BIND_PATH && path !== POPUP_APPROVAL_APPROVE_PATH &&
        path !== POPUP_APPROVAL_CANCEL_PATH) ||
      request.headers.get('origin') !== this._walletOrigin ||
      request.headers.get('sec-fetch-site') !== 'same-origin' ||
      request.headers.get(POPUP_APPROVAL_SESSION_HEADER) !== this.#sessionCapability) {
      await request.body?.cancel().catch((): void => {});
      return hiddenResponse();
    }

    let body: unknown;
    try {
      body = await readBoundedJson(request);
    } catch {
      return failureResponse('invalid-request', 400);
    }
    try {
      if (path === POPUP_APPROVAL_BIND_PATH) { return this.bind(body); }
      if (path === POPUP_APPROVAL_CANCEL_PATH) { return this.cancel(body); }
      return await this.approve(body);
    } catch (error: unknown) {
      if (error instanceof ConnectWorkerBoundaryError) {
        return failureResponse(error.code, error.code === 'invalid-session' ? 409 : 400);
      }
      return failureResponse('invalid-request', 400);
    }
  }

  /** Stops admission, invalidates unclaimed handles, drains active approvals, and clears sealed delivery results. */
  public stop(): Promise<void> {
    if (this._stopPromise === undefined) {
      if (!this._stopped) {
        this._stopped = true;
        this._registry.stop();
        this.#sessionCapability = '';
      }
      const stopping = this.performStop();
      const tracked = stopping.catch((error: unknown): never => {
        if (this._stopPromise === tracked) { this._stopPromise = undefined; }
        throw error;
      });
      this._stopPromise = tracked;
    }
    return this._stopPromise;
  }

  private bind(body: unknown): Response {
    if (!isRecord(body) || !hasExactKeys(body, ['request']) || !isRecord(body.request)) {
      return failureResponse('invalid-request', 400);
    }
    this.pruneCompleted();
    if (this._completed.size + this._pending.size >= POPUP_APPROVAL_MAX_COMPLETED_RESULTS) {
      return failureResponse('capacity-exceeded', 429);
    }
    const bound = this._registry.bind({
      channel   : { dappOrigin: this._dappOrigin, kind: 'popup' },
      context   : this._context,
      request   : body.request as ConnectRequest,
      transport : 'postMessage',
    });
    return jsonResponse({ ok: true, result: bound });
  }

  private cancel(body: unknown): Response {
    if (!isRecord(body) || !hasExactKeys(body, ['handle'])) {
      return failureResponse('invalid-request', 400);
    }
    this._registry.cancel(this._context, parseHandle(body.handle));
    return new Response(null, { headers: secureHeaders(), status: 204 });
  }

  private async approve(body: unknown): Promise<Response> {
    if (!isRecord(body) || !hasExactKeys(body, ['handle'])) {
      return failureResponse('invalid-request', 400);
    }
    const handle = parseHandle(body.handle);
    this.pruneCompleted();
    const completed = this._completed.get(handle.id);
    if (completed !== undefined && completed.expiresAt === handle.expiresAt) {
      return this.outcomeResponse(completed.outcome);
    }
    const pending = this._pending.get(handle.id);
    if (pending !== undefined && pending.expiresAt === handle.expiresAt) {
      return this.outcomeResponse(await pending.promise);
    }

    const claimed = this._registry.claimForApproval(this._context, handle);
    const promise = this.runApproval(claimed.request);
    this._pending.set(handle.id, { expiresAt: handle.expiresAt, promise });
    const outcome = await promise;
    this._pending.delete(handle.id);
    if (!this._stopped) {
      this._completed.set(handle.id, { expiresAt: handle.expiresAt, outcome });
    }
    return this.outcomeResponse(outcome);
  }

  private async runApproval(request: ConnectRequest): Promise<PopupApprovalOutcome> {
    try {
      const { idToken } = await this._agent.approveNoteWritePopup({
        dappOrigin: this._dappOrigin,
        request,
      });
      if (!validOpaqueIdToken(idToken)) { return { code: 'reconciliation-required', ok: false }; }
      return { idToken, ok: true };
    } catch (error: unknown) {
      return {
        code: error instanceof AgentProcessApprovalOutcomeUnknownError
          ? 'reconciliation-required'
          : 'approval-failed',
        ok: false,
      };
    }
  }

  private outcomeResponse(outcome: PopupApprovalOutcome): Response {
    return outcome.ok
      ? jsonResponse({ ok: true, result: { idToken: outcome.idToken } })
      : failureResponse(outcome.code, outcome.code === 'reconciliation-required' ? 409 : 502);
  }

  private pruneCompleted(): void {
    const now = Date.now();
    for (const [id, completed] of this._completed) {
      if (now >= completed.expiresAt) { this._completed.delete(id); }
    }
  }

  private async performStop(): Promise<void> {
    if (!await waitForApprovals([...this._pending.values()].map(({ promise }) => promise))) {
      throw new Error('PopupApprovalBridge: timed out draining active approvals');
    }
    this._pending.clear();
    this._completed.clear();
  }
}
