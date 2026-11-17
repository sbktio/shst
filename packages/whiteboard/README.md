# @shst/whiteboard

The whiteboard's document model and the rules that change it, with no runtime
dependencies. It runs in Node and in the browser: `apps/whiteboard` runs the
service inside the host's browser tab.

| File                       | Role                                                                 |
| -------------------------- | -------------------------------------------------------------------- |
| `src/types.ts`             | Documents, objects, people, profiles, leases, operations             |
| `src/operations.ts`        | `applyWhiteboardOperations`: validates and applies a batch of edits  |
| `src/whiteboardService.ts` | Revisions, presence, editing leases and 30-day expiry over a store   |
| `src/whiteboardStore.ts`   | The storage interface the service needs                              |
| `src/api.ts`               | `WhiteboardApi`, the client contract a transport implements          |
| `src/errors.ts`            | `PersistenceError`, carrying the status a host should answer with    |

Operations are untrusted input: `applyWhiteboardOperations` bounds every
field, takes authorship and voter names from the acting person rather than
the payload, checks media by its magic bytes, and caps a board at 24 MB.
Strokes keep 2–512 normalized points and a width of 1–12.

TypeScript source is the package entry point. Only erasable syntax is allowed
(`erasableSyntaxOnly`), so Node runs the tests and Vite bundles the source with
no build step.

```sh
pnpm --filter @shst/whiteboard test
pnpm --filter @shst/whiteboard typecheck
```
