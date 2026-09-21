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

Run from the repository root:

```sh
bun packages/lab/src/cli.ts did-browser --json
```

This listener is intentionally browser-only when origins are configured;
originless server calls are rejected as well. The separate `did-server` proof
uses the adapter's protected loopback resolver ingress for released-server
authorization. This browser proof does not establish that the default agent,
auth manager, API, and service-worker constructors all use the same per-instance
network. That gate depends on the released Enbox package cohort containing
[Enbox PR #1726](https://github.com/enboxorg/enbox/pull/1726). The report keeps
the remaining default-runtime and service-worker paths explicit as
`unsupported`, and the standalone CLI returns the unsupported exit code even
when every implemented subcheck passes.
