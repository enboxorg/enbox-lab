# Enbox Lab

Enbox Lab is a standalone local network laboratory for creating isolated Enbox environments, running DWNs at selected versions, managing real wallets and identities, and observing browser application flows.

P0 currently provides executable boundary proofs; the complete controller and UI are still in development. See the [development plan](docs/plan.md) and [acceptance ledger](docs/acceptance.md).

Install and validate:

```sh
bun install
bun run setup:browser
bun run lint
bun run typecheck
bun run build
bun run test:node
```

Inspect local prerequisites and the historical source catalog:

```sh
bun packages/lab/src/cli.ts doctor --json
bun packages/lab/src/cli.ts catalog --repository ../enbox --mode source --json
bun packages/lab/src/cli.ts prepare --repository ../enbox --artifact dwn-server-0.1.43 --output /tmp/enbox-lab-artifacts --json
```

Run the live boundary proofs:

```sh
bun packages/lab/src/cli.ts routing --json
bun packages/lab/src/cli.ts connect-browser --json
bun packages/lab/src/cli.ts connect-popup-approved --json
bun packages/lab/src/cli.ts did-browser --json
bun packages/lab/src/cli.ts did-runtime --json
bun packages/lab/src/cli.ts did-server --json
```

Run the complete Linux CI evidence contract against a full Enbox source clone:

```sh
bun run verify:linux --repository ../enbox --evidence /tmp/enbox-lab-evidence
```

This command runs the prerequisite, catalog, routing, browser DID, server DID, browser denial, approved popup, and DID runtime reports. It
requires every established Linux subcheck to pass, accepts only the explicitly
listed remaining unsupported gates, and writes the eight reports plus a
verification summary to the evidence directory.

The Linux routing candidate assigns a distinct `http://localhost:<actor-port>` origin to each actor. The host gateway publishes those ports, while actor-local IPv4/IPv6 forwarders preserve the same URLs inside containers.

The durable Pkarr adapter stores only upstream-accepted signed public packets. It rejects stale or conflicting equal-sequence packets, bounds the journal, replays without request fanout, retains exact bytes and sequence precision, restores before readiness, and never serves resolution from its journal.

Released agent processes can use a separate nonsecret loopback actor ingress for originless GET/PUT while the browser listener remains origin-strict and the server resolver ingress remains read-only. The actor URI is deliberately written into signed DID gateway records and can use a pinned port; browser metadata is rejected, but the route does not authenticate other local processes or replace the eventual canonical all-actor gateway.

The agent-process runtime starts the exact released `@enbox/agent@0.8.48` with an isolated durable data path and `localDwnStrategy: 'off'`. Each vault first reports locked, accepts its password through bounded stdin, publishes only through its assigned actor ingress, and proves a locked shutdown before the same agent DID can be reopened. This is process-backed wallet evidence; browser-native agent configuration still depends on a released Enbox package cohort with the per-instance DID changes.

The process-backed approval seam admits one fixed, unencrypted note-write policy. The released agent installs that protocol on its assigned released DWN server, creates the Records.Write and matching revocation grants, seals the wallet-minted delegate credentials inside the child, and returns only the opaque response JWE. Popup responses use their origin-bound channel; direct-post responses are strengthened with a four-digit relay PIN and exact callback origin. The agent DID is the provisional single profile for this proof. Final controller-to-wallet authentication, browser relay consent, user identities, encrypted records, and outsider denial remain later stack layers.

The popup approval bridge binds an already-opened request to a server-owned one-shot handle. Its three POST routes require the exact wallet Host and Origin, same-origin fetch metadata, bounded JSON, and a 256-bit session credential carried only in a header. Approval consumes the stored snapshot, and delivery retries return the same cached ciphertext without repeating the ceremony.

The approved popup proof drives the official dapp and wallet postMessage transports in managed Chromium, clicks the explicit fixture consent control, calls the bridge, and opens the sealed delegate response in the dapp. It composes one real private Pkarr testnet, the exact released server and agent, and the provisional agent-DID provider. Automation provisions the bridge session for this fixture; the final controller-to-wallet provisioning design remains unfinished.

The browser DID proof uses a frozen actor bootstrap and a typed service worker to make one causally attributed private lookup. It rejects reconfiguration, unconfigured sibling clients, and foreign-worker traffic before unexpected upstream access.

The server DID proof starts two independently owned private Pkarr testnets and the exact released DWN server in isolated child processes. A DID published only in lab A authenticates at A, fails resolution at B, and still resolves before a tampered signature is rejected; resolver observations prove each server used only its assigned ingress.

All proof reports use `pass`, `fail`, and `unsupported`. Unsupported evidence never counts as a passing P0 or release gate.
