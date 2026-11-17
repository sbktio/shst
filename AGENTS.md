<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Repository contract

- Use the pinned tools in `mise.toml`; do not silently change host-level package-manager configuration.
- Let pnpm inherit the effective user npm configuration. Never copy credentials into this repository.
- Keep `.pnpmfile.cjs`, `package.json#pnpmTarballUrlPolicy`, and `pnpm-workspace.yaml#pnpmfile` aligned; run `pnpm run lockfile:check` after lockfile changes.
- Keep applications in `apps/*` and reusable libraries or tooling in `packages/*`.
- Preserve package boundaries and declare workspace dependencies with `workspace:*`.
- Prefer a dedicated worktree for substantive or concurrent work.
- Run `pnpm validate` before claiming a change is complete. Report skipped checks plainly.
- Generated output under `dist/`, `bin/`, and coverage directories is not source and must not be committed.
