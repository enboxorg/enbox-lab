# Connect page/worker boundary proof

## Decision

Keep `WalletPostMessageTransport` in the popup provider page. It owns the
opener window, pinned dapp origin, and ephemeral request-decryption key. After
the transport opens and validates the request, the page admits the request to
`ConnectWorkerSessionRegistry.bind()` over the wallet's authenticated actor
channel.
The worker requires the request's signed client-origin hint to equal that authenticated popup origin.

The wallet worker copies the request and returns a short-lived random bearer
capability. Its stored session is bound to the authenticated gateway principal,
channel, transport, request and expiry. Claim, denial and cancellation consume
the exact stored request once. Pending sessions are memory-only and are erased
at shutdown, so a restart cannot silently resume consent.
Request JSON and sealed relay envelopes have byte limits before storage or cryptographic processing.

Relay requests are opened in the worker with `ConnectProvider.openRequest()`.
The copied single-use request key is erased after opening, and the response
callback origin must match the relay request origin. The worker API exposes no
generic key export or signing operation. The actual approval ceremony is not
exposed until an integrated configured-agent proof can exercise it end to end.

## Executable evidence

Run:

```sh
bun test packages/lab/tests/connect-worker-boundary.spec.ts \
  packages/lab/tests/connect-popup-boundary.spec.ts \
  packages/lab/tests/connect-relay-boundary.spec.ts
```

The tests exercise real Connect request signing, popup ECDH-ES/XC20P opening
through `WalletPostMessageTransport`, relay direct/XC20P opening through
`ConnectProvider`, pinned popup origin/source filtering, capability guessing and tampering,
cross-principal use, expiry, denial, cancellation, one-shot use, capacity, and
worker restart invalidation.

## Remaining P0 evidence

These focused tests do not claim the full A13 browser/agent gate. The popup
test uses Bun's `MessageEvent`/`MessagePort` implementation rather than managed
Chromium, and the relay test stops after opening and binding the real request.
The proof does not provide a configured wallet agent, owner identity, DWN,
relay, service worker, encrypted note, outsider authorization check, or the
successful `executeConnectApproval()` and response-sealing path. Until the
integrated lab fixture supplies those and completes both handshakes, the real
approval/application portion of A13 and the associated A10, A18, and A24 claims
remain unsupported.
