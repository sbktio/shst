# @shst/tsconfig

The workspace's shared TypeScript configs. They are strict, and they only check:
every project sets `noEmit`, and Node, Bun or Vite runs the source as written.

| File        | For                                                         | Adds to `base.json`                                                                                      |
| ----------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `base.json` | Every variant; don't extend it directly                     | The strictness flags, `noEmit`, `isolatedModules`, `verbatimModuleSyntax`, ES2024                        |
| `node.json` | Source Node runs by stripping types (`node --test`)         | `NodeNext` resolution, `.ts` import extensions, `erasableSyntaxOnly`, `@types/node`                      |
| `bun.json`  | Source Bun runs or compiles                                 | Bundler resolution with `module: Preserve`, `.ts` import extensions, `@types/bun`                        |
| `vite.json` | Browser code Vite serves and bundles                        | Bundler resolution, `.ts` import extensions, the DOM libraries, `vite/client`                            |

`base.json` explains its non-default choices in comments, including why
`noPropertyAccessFromIndexSignature` is off and unused code is an error.

## Using it

Add the package as a development dependency and extend a variant:

```json
"devDependencies": { "@shst/tsconfig": "workspace:*" }
```

```jsonc
{
  "extends": "@shst/tsconfig/node.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

A project overrides a variant only for what its runtime really differs in, and
says why in a comment. `packages/tailcat-transport` adds the DOM library because
its source also runs in the browser. `apps/whiteboard` adds `@types/node` and
`erasableSyntaxOnly` because its Vite config and live test run in Node.

The variants name ambient types (`node`, `bun`, `vite/client`); each project
installs the matching package itself, since this one has no dependencies.

Type-check with `tsc --noEmit` in the project, or `pnpm turbo run typecheck`.
Turbo's `transit` task makes a change here re-run every dependent project's
`typecheck`.
