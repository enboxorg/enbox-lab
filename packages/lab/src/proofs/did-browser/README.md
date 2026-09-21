# Browser private-DID boundary

`did-browser` starts a fresh digest-pinned Pkarr testnet with random ownership
labels, places the durable publication adapter in front of it, and launches the
selected Chromium executable. A real browser `@enbox/dids` bundle creates, publishes,
and resolves a `did:dht` identity using explicit private-gateway options. The
resolved document must retain its advertised DWN endpoint.

The adapter admits browser traffic only from its configured HTTP origins. The
proof sends a rejected foreign-origin PUT and a rejected originless image GET,
then performs an allowed read against the same live DID. Neither rejected
request may reach the upstream. Preflight permits only GET/PUT and the
`content-type` header.

A typed module service worker receives the gateway from an immutable,
origin-bound page bootstrap before lazily loading `@enbox/dids`. Its bounded
message protocol is bound to the browser-assigned client ID and accepts one
write-once configuration. The proof attributes the exact gateway GET to that
worker through Playwright and the adapter, then verifies that malformed,
unconfigured, same-origin sibling, and foreign-worker paths produce no
unexpected upstream traffic. Worker registrations are explicitly removed
during cleanup. Pinned Playwright 1.55 gates Chromium worker-network events
behind an experimental observation switch, so the driver holds one exclusive
process-scoped instrumentation lease and restores the prior environment value
on every exit path. The switch does not disable or relax browser security.

Run from the repository root:

```sh
bun packages/lab/src/cli.ts did-browser --json
```

This listener is intentionally browser-only when origins are configured;
originless server calls are rejected as well. The separate `did-server` proof
uses the adapter's protected loopback resolver ingress for released-server
authorization. This browser proof does not establish that the default agent,
auth manager, and API constructors all use the same per-instance network. That
gate depends on the released Enbox package cohort containing
[Enbox PR #1726](https://github.com/enboxorg/enbox/pull/1726). The report keeps
that remaining default-runtime path explicit as `unsupported`, and the
standalone CLI returns the unsupported exit code even when every implemented
subcheck passes.
