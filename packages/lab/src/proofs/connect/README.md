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

Run the live browser denial boundary:

```sh
bun packages/lab/src/cli.ts connect-browser --json
```

This proof bundles the released browser/connect code into real Chromium. The
dapp and wallet use separate canonical `http://localhost:<port>` origins. Popup requests pass through
`PopupClientTransport`, `WalletPostMessageTransport`, and a dedicated worker
whose fixture principal is fixed inside the worker rather than accepted from a
command body. The relay path uses
the real `RelayClientTransport` against exact `@enbox/dwn-server@0.1.43` with
an owned file-backed SQLite database and forwarding, delivery, WebSockets, and rate limits off.
It verifies denial, exact relay routes, single-use request and response state,
fragment-key containment, worker restart invalidation, client cancellation,
fresh-session liveness, and cleanup.

## Remaining integrated evidence

The denial proof still does not provide a configured wallet agent, owner
identity, approved grants, service worker, encrypted note, outsider
authorization check, or the successful `executeConnectApproval()` and
response-sealing path. The PIN is intentionally never requested because a
denial carries no approved response. Those application portions of A10,
A12-A14, A18, and A24 remain explicit `unsupported` report checks until the
integrated fixture supplies them. The fixed fixture principal proves registry
binding behavior, not the future authenticated gateway channel to a wallet
agent process; that channel remains an explicit unsupported check.
