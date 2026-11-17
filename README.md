# shst

A pnpm and Turborepo workspace for the collaborative whiteboard, its document
model, and the Tailcat transport with a WebRTC direct-path upgrade. The
repository also pins the full Tailcat source as a Git submodule.

## Clone

Clone the repository and initialize the Tailcat submodule:

```sh
git clone --recurse-submodules https://github.com/sbktio/shst.git
cd shst
```

For an existing checkout, initialize or restore the pinned revision with:

```sh
git submodule update --init --recursive
```

## Workspace

- `apps/whiteboard` — Vite whiteboard application
- `packages/whiteboard` — whiteboard document model, operations, and in-memory service
- `packages/tailcat-transport` — Tailcat relay transport, WebRTC upgrade, and Go-to-Wasm bridge
- `packages/tsconfig` — shared strict TypeScript configuration
- `package/tailcat` — pinned source from the [`sbktio/tailcat`](https://github.com/sbktio/tailcat) fork

## Prerequisites

Tool versions are pinned in `mise.toml`. Automatic installation is disabled,
following the Home repository's isolate-first setup:

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

## Build and run the whiteboard demo

Run these steps from the repository root:

1. Install the pinned tools and project dependencies:

   ```sh
   mise install
   pnpm install
   ```

2. Build the Go/Wasm bridge and the whiteboard application:

   ```sh
   pnpm build
   ```

3. Start the development server:

   ```sh
   pnpm dev
   ```

4. Open <http://localhost:5199/> in two browser windows.

5. In the first window, enter a name and choose **Host**. The app displays a
   three-word connection code.

6. In the second window, enter a name, type the three-word code, and press
   **Enter** to join. Move the pointer over the board to share the cursor, or
   click the board to add a note.

Stop the server with **Ctrl+C**.

## Checks

```sh
# Typecheck and run the TypeScript tests.
pnpm typecheck
pnpm test

# Run the Go tests for the transport wrapper.
pnpm test:go

# Run all checks and build the static application.
pnpm validate
```

See `apps/whiteboard/README.md` and `packages/tailcat-transport/README.md` for
live-test, relay, and WebRTC details.

## Tailcat source

Tailcat provides netcat-like, point-to-point connections over Tailscale's
open-source data plane without requiring the Tailscale control plane. It uses
WireGuard-encrypted tunnels, attempts direct peer-to-peer connectivity, and
falls back to DERP relays when necessary.

The submodule's toolchain version is declared in `package/tailcat/go.mod`. Run
its complete test suite with:

```sh
cd package/tailcat
go test ./...
```

See the submodule's [README](package/tailcat/README.md), [installation guide](package/tailcat/INSTALL.md),
and [security policy](package/tailcat/SECURITY.md) for usage and source-build
details.

## Licenses

The root repository is licensed under the MIT License. Tailcat is distributed
under the BSD 3-Clause License; see `THIRDPARTYLICENSE` and
`package/tailcat/LICENSE`.
