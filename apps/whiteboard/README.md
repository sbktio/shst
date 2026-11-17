# Collab Whiteboard

A website for a live, two-window whiteboard that runs peer-to-peer over
Tailcat. One window hosts a board in the browser and shows a three-word code;
another types the code to join. There is no API server: the host tab runs the
whiteboard service in memory, and nothing is kept in browser storage, so a
board lasts as long as the host tab.

Built from two packages: `@shst/whiteboard` (document model,
operations, in-memory service) and `@shst/tailcat-transport`
(Tailcat session, RPC, WebRTC upgrade).

## Run

Build the wasm once (needs Go 1.27+), then start the dev server:

```sh
pnpm --filter @shst/tailcat-transport build:wasm
pnpm whiteboard
```

Open `http://localhost:5199/` in two windows. Enter a name, choose **Host** in
one, then type the three words in the other and press Enter. Move over the
board to share your cursor; click to add a note.

Before a session, the options row sets **Relay** (allow board data, or
signalling only) and **WebRTC** (upgrade, direct on this network, off, or
blocked), and opens the raw state. Each change rewrites the URL (`name`,
`relay`, `rtc`). The row eases away 3 s after connecting and returns when the
session ends. The ping chip shows the round trip (to the relay for the host,
to the host for a joiner); its hover text gives the relay region and the path,
stack and addresses.

`pnpm --filter @shst/whiteboard-app build` writes a static site to
`dist/`, including the wasm when it has been built.

## Live check

Four browser pairs in isolated contexts: relay allowed or denied, each with
WebRTC working or blocked. It needs Chrome or Edge, starts its own dev server
on a free port, and talks to Tailcat's public relays, so it is not part of
`pnpm test` or CI:

```sh
pnpm --filter @shst/whiteboard-app test:live
```

Results are written to `.screenshots/tailcat-spike/results-relay-*-rtc-*.json`
at the repository root. `SPIKE_SECONDS` sets the run length, `SPIKE_BASE_URL`
reuses a server you started, and `SPIKE_MDNS=1` keeps Chrome's mDNS hiding of
LAN addresses (see the transport README).

## Reading the numbers

- `probe`: back-to-back small reads, the transport's round-trip floor.
- `presence`: each cursor or heartbeat round trip (the ping meter's source).
- `change`: one note per 1.5 s. `bulk1MB`: one save carrying about 1 MB.
- `propagationMs` (host): from the joiner sending a save to the host seeing it
  pushed.
- `traffic`: watch answers received and presence updates sent.
- `join.*` (joiner): `deriveMs` for argon2id, `reachMs` to find the host on the
  relay, `pathMs` waiting for a direct path, and `dialMs` to open the stream.
- `regionProbesMs` (host): measured relay round trip per region.
- `transport` (joiner): `webrtc-direct` or `tailcat-relay`. `rtcPath.pair` is
  the selected ICE candidate pair; `rtcPath.gathered` shows whether STUN
  answered (`srflx`). `rtc.*` timings split the upgrade into gathering,
  signalling and connecting.

## Files

| File                            | Role                                                        |
| ------------------------------- | ----------------------------------------------------------- |
| `src/main.ts`                   | Host and join flows, the benchmark run in `?role=` mode     |
| `src/whiteboardHost.ts`         | Route-equivalent validation in front of `WhiteboardService` |
| `src/browserWhiteboardStore.ts` | In-memory store, nothing in browser storage                 |
| `src/liveSync.ts`               | One open watch per participant, paced cursor updates        |
| `src/liveView.ts`               | Board, notes and cursors                                    |
| `src/statusView.ts`             | Status line, ping chip and connection details               |
| `src/controls.ts`               | Options row: name, relay policy, WebRTC mode                |
