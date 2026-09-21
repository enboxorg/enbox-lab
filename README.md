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
bun packages/lab/src/cli.ts did-browser --json
bun packages/lab/src/cli.ts did-runtime --json
bun packages/lab/src/cli.ts did-server --json
```

Run the complete Linux CI evidence contract against a full Enbox source clone:

```sh
bun run verify:linux --repository ../enbox --evidence /tmp/enbox-lab-evidence
```

This command runs the prerequisite, catalog, routing, browser DID, server DID, browser connect, and DID runtime reports. It
requires every established Linux subcheck to pass, accepts only the explicitly
listed remaining unsupported gates, and writes the seven reports plus a
verification summary to the evidence directory.

The Linux routing candidate assigns a distinct `http://localhost:<actor-port>` origin to each actor. The host gateway publishes those ports, while actor-local IPv4/IPv6 forwarders preserve the same URLs inside containers.

The durable Pkarr adapter stores only upstream-accepted signed public packets. It rejects stale or conflicting equal-sequence packets, bounds the journal, replays without request fanout, retains exact bytes and sequence precision, restores before readiness, and never serves resolution from its journal.

The browser DID proof uses a frozen actor bootstrap and a typed service worker to make one causally attributed private lookup. It rejects reconfiguration, unconfigured sibling clients, and foreign-worker traffic before unexpected upstream access.

The server DID proof starts two independently owned private Pkarr testnets and the exact released DWN server in isolated child processes. A DID published only in lab A authenticates at A, fails resolution at B, and still resolves before a tampered signature is rejected; resolver observations prove each server used only its assigned ingress.

All proof reports use `pass`, `fail`, and `unsupported`. Unsupported evidence never counts as a passing P0 or release gate.
