# shst

shst pipes bytes between two machines over Tailcat. It is a small Unix tool
in the spirit of pipe.pico.sh. One side prints a three-word code. The other
side joins with it. Stdin goes one way and stdout comes out the other.

Data goes to stdout. Status goes to stderr. Pipes stay clean.

Tailcat tries a direct UDP path first. When none exists it falls back to a
DERP relay. The stream is point to point and encrypted end to end.

## Build

```sh
mise exec -- pnpm --filter @shst/cli build
```

This writes `apps/shst/bin/shst`. To stamp a version:

```sh
cd apps/shst
mise exec -- go build -ldflags "-X main.version=1.2.3" -o bin/shst .
```

Run the tests with `mise exec -- go test ./...` in `apps/shst`. To check it
end to end over the public relays, run
`mise exec -- pnpm --filter @shst/cli test:live`. It sends
3 MB each way between two processes, checks a joiner whose stdin is a
terminal, pings an echo host, and confirms `--deny-relay` refuses a relayed
session. It also checks that a second joiner is refused and that interrupts
set the exit status.

## Send a file

On the sender:

```sh
shst host < file.tar
```

It prints a code and a join hint to stderr:

```
code: amber-tiger-lunar
join with: shst join amber-tiger-lunar
```

On the receiver:

```sh
shst join amber-tiger-lunar > file.tar
```

Both sides exit 0 when the transfer is done. The receiver's stdin is a
terminal, so it exits as soon as the file ends, without waiting for Ctrl-D.
When stdin is redirected, each side also waits for its own stdin to end.

A terminal user's session ends when the peer finishes sending. If the peer
runs with `< /dev/null`, it finishes at once, so your session ends at once
too. Redirect stdin yourself if you want to keep sending after the peer is
done.

A host takes one peer. A second joiner is refused. Its `shst join` exits 1
with "the host refused the session". The same message appears when the code
is right but the host is not serving that port.

## Chat

No stdin redirect. Type lines. Ctrl-D on either side ends the session, and
the other side exits once it has your last line.

```sh
shst host
shst join amber-tiger-lunar
```

## Pipe command output

```sh
tail -f app.log | shst host
shst join amber-tiger-lunar | grep ERROR
```

Bytes sent before the peer joins wait in the pipe.

## Measure a link

```sh
shst echo
shst ping amber-tiger-lunar -n 50 --duration 10s
```

`echo` serves any number of sessions until you press Ctrl-C. `ping` sends
64-byte messages 50 ms apart and groups round trips by the path in use. A
session that starts on the relay and upgrades to a direct path shows both
lines.

```
echo rtt relayed DERP(nyc) over 3: p50 41ms p95 44ms max 44ms
echo rtt direct 203.0.113.5:41641 over 61: p50 9ms p95 14ms max 21ms
```

Add `--json` for one JSON object with `joinMs`, `timings` and `groups`.

## Relay policy

`--deny-relay` makes a session direct-only. The host refuses peers that are
not on a direct path. The joiner waits up to `--direct-timeout` (default 15s)
for one and fails if none appears. A session that falls back to the relay
later is closed, and `host` exits 1 with the reason.

```sh
shst host --deny-relay
shst join amber-tiger-lunar --deny-relay --direct-timeout 20s
```

To test a network that blocks direct UDP, set an environment variable on
either side:

```sh
TS_DEBUG_NEVER_DIRECT_UDP=1 shst join amber-tiger-lunar --deny-relay
TS_DEBUG_ALWAYS_USE_DERP=1 shst ping amber-tiger-lunar
```

The first should fail with a no direct path error. The second should show
only relayed paths.

## Ports

Both sides must use the same port. Pipes default to 7188. `echo` and `ping`
default to 7189. The whiteboard app uses 7187, so a whiteboard code is not
mistaken for a pipe. Change it with `--port`.

## Exit status

- 0 means success. The stream ended on both sides and the peer acknowledged it.
- 1 means an error. This covers a refused session, a transfer that failed
  partway, a peer that did not acknowledge the end of the stream, and a
  session closed by the relay policy.
- 130 means SIGINT (Ctrl-C) stopped `host`, `join` or `ping`. 143 means
  SIGTERM did. This holds while waiting for a peer, during a transfer and
  during a measurement. `shst` prints `shst: interrupted` to stderr.
- `echo` is a server. Stopping it with Ctrl-C or SIGTERM is normal, so it
  exits 0.

A second Ctrl-C ends the process at once if the first one is slow to take
effect.

## Flags

`-v` logs Tailcat internals to stderr. Every command accepts it.
