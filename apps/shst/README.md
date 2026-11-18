# shst

shst pipes bytes between two machines over Tailcat. It is a small Unix tool
in the spirit of pipe.pico.sh. One side prints a three-word code, or a raw
Tailcat address. The other side joins with it. Stdin goes one way and stdout comes out the other.

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
set the exit status. It sends a file both ways with a raw address, pings an
echo host that uses one, and checks interop with the upstream `tailcat` CLI
when `package/tailcat` can be built. Otherwise it prints a skip line.

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

## Raw Tailcat addresses

Use a raw address for anything sensitive. Three words are easy to say and
type, but they are guessable in principle. A raw address carries random
full-strength keys and a pre-shared key, so it is not.

```sh
shst host --addressing address < secrets.tar
```

Host prints the address as its code, about 154 characters starting with `tc`.

```
code: tc...
join with: shst join tc...
addressing: address
```

With the default three-word addressing there is no `addressing:` line.

On the receiver, pass the printed address. Join tells an address from a
three-word code by itself, so it needs no flag.

```sh
shst join tc... > secrets.tar
```

`echo` takes the same flag, and `ping` also accepts an address.

The address is a secret, just like a code. Passing it as `shst join <address>`
puts it in the process list and in your shell history. `--qr` shows it to any
camera or screen recording. For now, type it in a shell with history turned
off, or set `HISTCONTROL=ignorespace` and start the command with a space. A
way to pass it without putting it in argv is a planned follow-up.

## QR codes

`--qr` prints a QR code of exactly the text a joiner needs. It goes to stderr,
before the join hint. It is handy for a long raw address that you would
rather scan than type.

```sh
shst host --addressing address --qr < file.tar
```

The code is drawn with Unicode half blocks in explicit colours, black on
bright white, so it scans the same on a dark or a light terminal theme. It
has the four module quiet zone that the QR specification asks for. Use a
terminal font that has the block characters, and make the window wide enough
that lines do not wrap.

## Configuration

Configuration is flags, with environment variables as their defaults. There
is no config file. A flag on the command line wins over its variable.

| Flag | Variable | Meaning |
| --- | --- | --- |
| `--addressing words\|address` | `SHST_ADDRESSING` | How a joiner reaches `host` or `echo`. Defaults to `words`. |
| `--qr` | `SHST_QR` | Print a QR code. Set the variable to a boolean such as `1` or `true` to turn it on. |

`--qr=false` overrides `SHST_QR=1`. The addressing name is not case sensitive.
An unknown addressing name, or a `SHST_QR` value that is not a boolean, is a
usage error. For a variable it is reported when `host` or `echo` runs, and a
flag on the command line replaces the bad value.

## Interop with the tailcat CLI

shst speaks the same protocol as the `tailcat` command, so the two can talk.

A plain `tailcat` server accepts one connection on any port and writes it to
stdout. It prints its address on stderr. Send a file to it with
`shst join`.

```sh
tailcat > received.bin
shst join <its address> < file
```

A plain `tailcat <address>` client dials port 1. To receive from it, host on
port 1 with a raw address.

```sh
shst host --addressing address --port 1 < file
tailcat <printed address> > received.bin
```

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
