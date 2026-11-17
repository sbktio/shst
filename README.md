# shst

A pnpm and Turborepo workspace for the collaborative whiteboard, its document model, and the Tailcat transport with a WebRTC direct-path upgrade.

## Workspace

- `apps/whiteboard` — Vite whiteboard application
- `packages/whiteboard` — whiteboard document model, operations, and in-memory service
- `packages/tailcat-transport` — Tailcat relay transport, WebRTC upgrade, and Go-to-Wasm bridge
- `packages/tsconfig` — shared strict TypeScript configuration

## Prerequisites

Tool versions are pinned in `mise.toml`. Automatic installation is disabled, following the Home repository's isolate-first setup:

```sh
mise install
pnpm install
```

pnpm uses the effective user npm configuration, including the registry proxy in
`~/.npmrc`; this repository does not copy or override credentials. The
workspace hook in `.pnpmfile.cjs` strips unstable `pkgs.visualstudio.com` shard
URLs from the lockfile while preserving integrity hashes. If an existing
lockfile contains shard URLs, repair it with:

```sh
pnpm run lockfile:repair
```

## Development

```sh
# Build the Go/Wasm Tailcat bridge, then start Vite on port 5199.
pnpm dev

# Typecheck and run the TypeScript tests.
pnpm typecheck
pnpm test

# Run the Go tests.
pnpm test:go

# Run all checks and build the static application.
pnpm validate
```

See `apps/whiteboard/README.md` and `packages/tailcat-transport/README.md` for live-test, relay, and WebRTC details.
