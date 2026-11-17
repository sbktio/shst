# @shst/tailcat-transport

Runs the whiteboard API peer-to-peer over
[Tailcat](https://github.com/tailscale/tailcat). There is no tunnel URL and no
API server: the host runs `WhiteboardService` from
`@shst/whiteboard` in memory, shows a three-word code, and a
joiner dials the code and drives the same `WhiteboardApi`. Board data moves to
a WebRTC data channel when a direct path exists.

This is a prototype. It uses Tailcat's public DERP relays, so nothing here is
exercised against the network in CI; the unit tests use in-memory pipes.

## Pieces

| File                          | Role                                                          |
| ----------------------------- | ------------------------------------------------------------- |
| `src/frames.ts`               | Length-prefixed JSON frames, serialized writes                |
| `src/rpc.ts`                  | Multiplexed request/response with abort and timeout           |
| `src/memoryPipe.ts`           | In-memory byte stream pair, for the host's own session        |
| `src/tailcatWhiteboardApi.ts` | Handshake plus a `WhiteboardApi` over RPC                     |
| `src/tailcatRuntime.ts`       | Loads the wasm and types `qbTailcatHost` and `qbTailcatJoin`  |
| `src/rtcUpgrade.ts`           | WebRTC offer/answer signalled over the Tailcat session        |
| `src/rtcStream.ts`            | RTCDataChannel as a byte stream, with backpressure            |
| `src/rtcDiagnostics.ts`       | Candidate and pair narration, plain-language failure verdicts |
| `src/syncPacing.ts`           | Watch deadlines, cursor pacing and backoff                    |
| `qbtailcat/`                  | Go wrapper over Tailcat: word codes, relay policy, wasm + CLI |

TypeScript source is the package entry point; there is no build step for it.

## Build the wasm

Requires Go 1.27 or later. The wrapper pins `github.com/tailscale/tailcat`
v0.7.0 in `qbtailcat/go.mod`.

```sh
pnpm --filter @shst/tailcat-transport build:wasm
pnpm --filter @shst/tailcat-transport test:go
```

The script writes `main.wasm`, a gzip copy, `wasm_exec.js` and a native
`bin/qbtailcat` to `dist/`, which is git-ignored. `apps/whiteboard` serves the
wasm from there.

## Test

```sh
pnpm --filter @shst/tailcat-transport test
```

## Three-word codes

A Tailcat address is 154 characters because it carries the host's 32-byte
WireGuard key, a 32-byte discovery key and a 32-byte pre-shared key. The
wrapper derives all three from the words instead, so the address never needs
sharing:

```text
words ──argon2id──► seed ──HKDF──► node key, pre-shared key ──► tailcat address
words ──SHA-256───► relay region (one of the four public regions)
```

- **Words.** From the [EFF large wordlist](https://www.eff.org/dice) (CC BY 3.0
  US), minus four hyphenated words: 7,772 words, about 38.8 bits for three. The
  host only accepts codes that map to its nearest region, which costs 2 bits.
- **Typing.** Spaces, hyphens, dots or commas, in any case.
- **Who holds the code.** Anyone with the words can join, and can also act as
  the host, because the keys are derived rather than random. That is the
  room-link trust model. It is also why the host always generates the words.
- **Guessing.** A wrong code derives a key that nobody is listening on, so the
  host never sees the attempt. Argon2id makes deriving each candidate's key
  slow, so the code space can't be cheaply enumerated and probed on the relay.
  Three words is a deliberate trade-off for a short-lived session; a fourth word
  adds about 13 bits. A PAKE handshake would make each guess a single online
  attempt that the host can count.
- **Region.** The browser build of Tailcat cannot measure relay latency and
  picks an arbitrary region. The wrapper times three HTTPS round trips to each
  region's relay and picks the fastest.

## Relay policy

Tailcat uses its DERP relay for two things: setting up the connection (the
handshake and path discovery), and carrying traffic when no direct UDP path
exists. Tailscale's networking layer has switches to force the relay or to
forbid direct UDP, but none to forbid relayed data while still using the relay
for setup. With `allowRelay: false` (`?relay=deny`, or `-deny-relay` on the CLI)
the wrapper enforces that at the session boundary:

- the joiner keeps probing until a reply arrives on a direct path, and refuses
  to open the session if none does within the timeout;
- the host refuses any session whose peer is not on a direct path;
- both re-check every few seconds and close the session if it falls back to the
  relay.

Handshakes and path discovery still go through the relay. Application data
does not.

That is the native (CLI) behaviour. A browser has no UDP socket, so its
Tailcat session is always relayed; browsers get a direct path through WebRTC
instead, below.

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

## Direct path for browsers: WebRTC

After joining over Tailcat, the joiner moves board data to a WebRTC data
channel (`rtcUpgrade.ts`, `rtcStream.ts`). In the page, the board is usable on
the relay at once and switches over when the channel opens.

1. The joiner sends a WebRTC offer as an `rtcOffer` call on the Tailcat
   session; the host returns its answer. ICE is non-trickle, so this is one
   round trip. Gathering settles 500 ms after the last new address.
2. Both SDPs carry DTLS certificate fingerprints and travel inside the
   WireGuard tunnel the code authenticated, so the data channel can only
   complete with the peer holding the session. No separate signalling server.
3. Once the channel opens, the same frame/RPC protocol runs over it, served
   with the same peer identity. The Tailcat session stays open for signalling.

No TURN server is configured, so an open data channel is always peer-to-peer.
If the upgrade fails, board data stays on the relay, or with
`?relay=deny` the session is refused and the relay only ever carried
signalling.

STUN (for each side's public address) uses public Cloudflare and Google
servers. Tailcat's relay nodes do not answer STUN. STUN never sees board data.

**Diagnostics.** Each negotiation is narrated in the console
(`[Collab Whiteboard] WebRTC …`, `rtcDiagnostics.ts`): every address each side
offered, labelled LAN, VPN, hidden or public; ICE state changes; the
connectivity checks; and on failure a plain-language verdict.

**Why two browsers on one network often fail, and the fix.** Without camera
or microphone permission, Chromium-based browsers offer only the default
route and hide LAN addresses behind mDNS `.local` names. On a machine where a
VPN carries the browser's traffic (Edge with the Azure VPN here), the default
route is the VPN tunnel, which does not carry traffic between devices, and
the corporate public address does not route back to itself. So every check
goes unanswered. Once the page holds media permission, the browser offers
every interface with its real address and the connection opens over the LAN.
The **Direct on this network** option (`?rtc=lan`) asks for microphone
permission when you host or join, releases the microphone at once without
recording, and logs why. Both sides need it. Measured in Edge: direct over
the LAN in about 0.7 s.

`?rtc=blocked` forces ICE to relay-only with no TURN servers, which leaves no
usable candidates and simulates a network that blocks UDP. `?rtc=off` skips
the upgrade. The live check (apps/whiteboard) exposes LAN addresses for its headless
same-machine runs; `SPIKE_MDNS=1` keeps Chrome's default hiding.

## Native CLI

Native relay experiments, which can hold a direct path:

```sh
packages/tailcat-transport/dist/bin/qbtailcat host [-deny-relay]
packages/tailcat-transport/dist/bin/qbtailcat join [-deny-relay] word word word
TS_DEBUG_NEVER_DIRECT_UDP=1 packages/tailcat-transport/dist/bin/qbtailcat join ...   # simulate blocked UDP
```
