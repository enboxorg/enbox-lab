# Enbox Lab

Enbox Lab is a standalone local network laboratory for creating isolated Enbox environments, running DWNs at selected versions, managing real wallets and identities, and observing browser application flows.

P0 currently provides executable boundary proofs; the complete controller and UI are still in development. See the [development plan](docs/plan.md) and [acceptance ledger](docs/acceptance.md).

Install and validate:

```sh
bun install
bun run setup:browser
bun run lint
bun run build
bun run test:node
```

Inspect local prerequisites and the historical source catalog:

```sh
bun packages/lab/src/cli.ts doctor --json
bun packages/lab/src/cli.ts catalog --repository ../enbox --mode source --json
bun packages/lab/src/cli.ts prepare --repository ../enbox --artifact dwn-server-0.1.43 --output /tmp/enbox-lab-artifacts --json
```

Run the live Docker proofs:

```sh
bun packages/lab/src/cli.ts routing --json
bun packages/lab/src/cli.ts did-runtime --json
```

The Linux routing candidate assigns a distinct `http://localhost:<actor-port>` origin to each actor. The host gateway publishes those ports, while actor-local IPv4/IPv6 forwarders preserve the same URLs inside containers.

The durable Pkarr adapter stores only upstream-accepted signed public packets. It rejects stale or conflicting equal-sequence packets, retains exact bytes and sequence precision, restores before readiness, and never serves resolution from its journal.

All proof reports use `pass`, `fail`, and `unsupported`. Unsupported evidence never counts as a passing P0 or release gate.
