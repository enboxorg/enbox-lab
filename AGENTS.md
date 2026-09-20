# Enbox Lab contributor guide

Enbox Lab is a standalone Bun project. Keep Enbox SDK/runtime changes in
[`enboxorg/enbox`](https://github.com/enboxorg/enbox) and consume released
`@enbox/*` packages here.

Use a task branch and pull request for every change. Before pushing, run:

```sh
bun run lint
bun run build
bun run test:node
```

Proofs distinguish `pass`, `fail`, and `unsupported`. Missing platform,
runtime, path, or cache evidence never counts as a pass. Docker cleanup targets
exact random ownership labels and never uses global pruning.

TypeScript uses explicit return types and class visibility, type imports before
value imports, `.js` on relative imports, kebab-case files, and aligned
object-literal colons.
