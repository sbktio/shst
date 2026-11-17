# shst

A pnpm and Turborepo workspace for the collaborative whiteboard, its document
model, the Tailcat transport with a WebRTC direct-path upgrade, and `shst`, a
command-line tool that pipes bytes between two machines over the same
transport. The repository also pins the full Tailcat source as a Git
submodule. The Go modules pin the same fork commit, and `pnpm validate`
checks that the two agree.

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

The transport knows nothing about the whiteboard. Dependencies point one way:
the apps use the protocol and transport packages, and the protocol package
uses the transport and the document model.

| Path | What it is |
| --- | --- |
| `apps/whiteboard` | Vite whiteboard application |
| `apps/shst` | Cobra CLI for pipes, echo and round-trip checks over Tailcat |
| `packages/whiteboard` | Whiteboard document model, operations, and in-memory service |
| `packages/whiteboard-tailcat` | The whiteboard's protocol over the transport: handshake, RPC API, sync pacing |
| `packages/tailcat-transport` | Byte streams over Tailcat, frames, RPC, WebRTC upgrade, and the Go session library with its wasm build |
| `packages/tsconfig` | Shared strict TypeScript configuration |
| `package/tailcat` | Pinned source from the [`sbktio/tailcat`](https://github.com/sbktio/tailcat) fork |

## macOS prerequisites

You do not need to install Node.js, pnpm, or Go separately. Their versions are
pinned in `mise.toml`, and mise installs them for this repository. This project
requires **pnpm 12.18.0**.

1. If Homebrew is not installed, follow the instructions at
   <https://brew.sh/>.
2. Install mise:

   ```sh
   brew install mise
   ```

3. From the repository root, install the pinned Node.js, pnpm, and Go versions:

   ```sh
   mise install
   ```

The commands below use `mise exec --` so they work without changing the shell
configuration. If mise is already activated in your shell, that prefix is
optional.

pnpm uses the effective user npm configuration, including the registry proxy in
`~/.npmrc`; this repository does not copy or override credentials. The
workspace hook in `.pnpmfile.cjs` strips unstable `pkgs.visualstudio.com` shard
URLs from the lockfile while preserving integrity hashes. If an existing
lockfile contains shard URLs, repair it with:

```sh
mise exec -- pnpm run lockfile:repair
```

## Build and run the whiteboard demo

Run these steps from the repository root:

1. Install the project dependencies:

   ```sh
   mise exec -- pnpm install
   ```

2. Build the Go/Wasm bridge and the whiteboard application:

   ```sh
   mise exec -- pnpm demo:build
   ```

3. Start the development server in the background. The command waits for HTTP
   readiness and prints the URL:

   ```sh
   mise exec -- pnpm demo:start
   ```

4. Inspect or stop the managed server from any terminal:

   ```sh
   mise exec -- pnpm demo:status
   mise exec -- pnpm demo:stop
   ```

   Runtime metadata and logs stay in the gitignored `.whiteboard-demo/`
   directory. Repeated start and stop commands are safe.

5. Open <http://localhost:5199/> in two browser windows.

6. In the first window, enter a name and choose **Host**. The app displays a
   three-word connection code.

7. In the second window, enter a name, type the three-word code, and press
   **Enter** to join. Move the pointer over the board to share the cursor, or
   click the board to add a note.

To use another port, set it when starting the managed server:

```sh
WHITEBOARD_DEMO_PORT=5200 mise exec -- pnpm demo:start
```

### Coding-agent skill

The repository includes a provider-neutral `whiteboard-demo` skill that tells a
coding agent to use the managed lifecycle instead of launching or killing Vite
directly. Ask Claude Code, Codex CLI, or Copilot CLI to use the
`whiteboard-demo` skill to build, start, inspect, or stop the app. For example:

```text
Use the whiteboard-demo skill to start the demo and tell me its URL.
Use the whiteboard-demo skill to check whether the demo is healthy.
Use the whiteboard-demo skill to stop the demo.
```

Claude Code also exposes it as `/whiteboard-demo`. The canonical workflow is in
`.agents/skills/whiteboard-demo/SKILL.md`; compatibility entry points live in
`.claude/skills/whiteboard-demo/` and `.github/skills/whiteboard-demo/`.
Agents should run `demo:stop` when their task is finished so no background demo
process remains.

## Use the shst CLI

Build it, then run one side on each machine:

```sh
mise exec -- pnpm --filter @shst/cli build
apps/shst/bin/shst host < notes.tar        # prints a three-word code
apps/shst/bin/shst join <code> > notes.tar # on the other machine
```

`shst echo` and `shst ping <code>` measure a link. See
`apps/shst/README.md` for more, and run
`mise exec -- pnpm --filter @shst/cli test:live` to check it
end to end over the public relays.

## Checks

```sh
# Typecheck and run the TypeScript tests.
mise exec -- pnpm typecheck
mise exec -- pnpm test

# Run the Go tests for the session library and the shst CLI.
mise exec -- pnpm test:go

# Run all checks and build the static application.
mise exec -- pnpm validate
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
mise exec -- go test ./...
```

See the submodule's [README](package/tailcat/README.md), [installation guide](package/tailcat/INSTALL.md),
and [security policy](package/tailcat/SECURITY.md) for usage and source-build
details.

## Licenses

The root repository is licensed under the MIT License. Tailcat is distributed
under the BSD 3-Clause License; see `THIRDPARTYLICENSE` and
`package/tailcat/LICENSE`.
