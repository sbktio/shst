# @shst/whiteboard-tailcat

Runs the whiteboard API peer-to-peer over
[`@shst/tailcat-transport`](../tailcat-transport). There is no
tunnel URL and no API server: the host runs `WhiteboardService` from
`@shst/whiteboard` in memory, shows a three-word code, and a
joiner dials the code and drives the same `WhiteboardApi`. Board data moves
to a WebRTC data channel when a direct path exists.

## Pieces

| File                          | Role                                       |
| ----------------------------- | ------------------------------------------ |
| `src/tailcatWhiteboardApi.ts` | Handshake plus a `WhiteboardApi` over RPC  |
| `src/syncPacing.ts`           | Watch deadlines, cursor pacing and backoff |

The handshake is one `hello` frame from the joiner and one `welcome` frame
from the host, both tagged `shst-whiteboard/1`. The host assigns the peer
identity; the joiner cannot pick it. After the handshake the frame channel
carries RPC.

The app passes `WHITEBOARD_TAILCAT_PORT` (7187) as the transport's `port` and
`WHITEBOARD_RTC_CHANNEL_LABEL` (`whiteboard`) as its `channelLabel`.

## Sync: pushed, not polled

There is no poll interval (`src/syncPacing.ts`, and `liveSync.ts` in apps/whiteboard):

- **Watch.** Every participant keeps one `watch` request open. The host
  answers it as soon as the board or someone else's presence changes, or after
  20 s with nothing new, so a dead connection is noticed. A participant's own
  cursor never wakes their own watch.
- **Cursor.** Sent only when it changes, with one update in flight, spaced by
  the measured round trip (33–250 ms), so about 30 updates per second on a
  direct link and never faster than a relay can answer. Otherwise a heartbeat
  every 2 s (5 s while hidden) keeps the participant present.
- **Failures** back off from 250 ms to 5 s.

Measured in the live check: a save reaches the other side in 1–2 ms direct,
or about 24 ms relayed (it was up to 1 s with polling). An idle room sends only
heartbeats.

## Test

```sh
pnpm --filter @shst/whiteboard-tailcat test
pnpm --filter @shst/whiteboard-tailcat typecheck
```
