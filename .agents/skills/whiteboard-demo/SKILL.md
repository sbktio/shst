---
name: whiteboard-demo
description: Build, start, inspect, and stop the repository's managed whiteboard demo.
---

# Whiteboard demo lifecycle

Use the repository lifecycle commands instead of starting Vite, Turborepo, or a
package-manager process directly. The lifecycle script owns the process identity,
readiness check, log, and cleanup.

1. Resolve the repository root with `git rev-parse --show-toplevel`.
2. Run commands with the repository's pinned tools. Replace `<repo-root>` below
   with the resolved absolute path:

   ```sh
   mise exec -C <repo-root> -- pnpm demo:build
   mise exec -C <repo-root> -- pnpm demo:start
   mise exec -C <repo-root> -- pnpm demo:status
   mise exec -C <repo-root> -- pnpm demo:stop
   ```

3. Use `demo:start` when the task needs the app. It runs the existing
   `build:wasm` package script, starts the project-pinned Vite CLI detached,
   waits for HTTP readiness, and prints the URL. A repeated start reuses the
   healthy managed instance.
4. Use `demo:status` to inspect health, process IDs, start time, URL, and log
   location. A nonzero status means the app is not ready or is stopped.
5. On a failure, inspect `.whiteboard-demo/demo.log`. Runtime files under
   `.whiteboard-demo/` are local and gitignored; do not add them to Git.
6. Run `demo:stop` when finished, including after a failed check. Stop is
   idempotent and only asks the authenticated managed process to terminate its
   own process tree.

Do not kill a process based only on a saved PID, launch another server on port
5199 to work around lifecycle errors, copy npm credentials, or change
`~/.npmrc`.
