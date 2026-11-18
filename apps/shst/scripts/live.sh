#!/usr/bin/env bash
# LIVE check over Tailcat's public relays, outside `pnpm test` like the
# whiteboard's test:live. Runs the in-process live tests, then the built
# binary as two processes per case and compares checksums.
set -euo pipefail
exec 3>&1 # verdicts, even from inside redirected commands

# The environment must not change the defaults under test.
unset SHST_ADDRESSING SHST_QR

here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"
SHST_LIVE=1 go test -run Live -count=1 ./...
go build -o bin/shst .
shst="$here/bin/shst"

work=$(mktemp -d)
hostpid=
extrapid=
cleanup() {
  [[ -n $hostpid ]] && kill "$hostpid" 2>/dev/null || true
  [[ -n $extrapid ]] && kill "$extrapid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

head -c 3000000 /dev/urandom > "$work/send.bin"
sum() { shasum -a 256 "$1" | cut -d' ' -f1; }

code_from() { # <host stderr file>
  for _ in $(seq 1 100); do
    if grep -q '^code: ' "$1"; then sed -n 's/^code: //p' "$1"; return; fi
    sleep 0.2
  done
  echo "no code in $1" >&2; cat "$1" >&2; exit 1
}

bounded() { # <seconds> <command...>: fail instead of hanging
  local secs=$1; shift
  "$@" <&0 & local pid=$!
  for _ in $(seq 1 $((secs * 5))); do
    if ! kill -0 "$pid" 2>/dev/null; then wait "$pid" && return; echo "FAIL exit $?: $*" >&3; exit 1; fi
    sleep 0.2
  done
  kill "$pid" 2>/dev/null || true
  echo "FAIL timed out after ${secs}s: $*" >&3; exit 1
}

host_exits() { # the host must exit 0 within 30s
  for _ in $(seq 1 150); do
    if ! kill -0 "$hostpid" 2>/dev/null; then wait "$hostpid"; return; fi
    sleep 0.2
  done
  echo "FAIL host did not exit" >&3; exit 1
}

bounded_fails() { # <seconds> <command...>: must exit non-zero in time
  local secs=$1; shift
  "$@" <&0 & local pid=$!
  for _ in $(seq 1 $((secs * 5))); do
    if ! kill -0 "$pid" 2>/dev/null; then
      if wait "$pid"; then echo "FAIL expected a failure: $*" >&3; exit 1; fi
      return 0
    fi
    sleep 0.2
  done
  kill "$pid" 2>/dev/null || true
  echo "FAIL timed out after ${secs}s: $*" >&3; exit 1
}

exits_with() { # <want code> <pid> <seconds> <label>: wait for the pid, check its status
  local want=$1 pid=$2 secs=$3 rc=0
  for _ in $(seq 1 $((secs * 5))); do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" || rc=$?
      if [[ $rc -eq $want ]]; then echo "ok   $4"; return 0; fi
      echo "FAIL $4: exit $rc, want $want" >&3; exit 1
    fi
    sleep 0.2
  done
  echo "FAIL $4: still running after ${secs}s" >&3; exit 1
}

check() { # <label> <want sum> <got file>
  if [[ $(sum "$3") == "$2" ]]; then echo "ok   $1"; else echo "FAIL $1"; exit 1; fi
}

"$shst" host < "$work/send.bin" > /dev/null 2> "$work/h1.err" & hostpid=$!
code=$(code_from "$work/h1.err")
bounded 30 "$shst" join "$code" < /dev/null > "$work/got1.bin" 2> "$work/j1.err"
host_exits
check "host sends 3 MB, joiner receives" "$(sum "$work/send.bin")" "$work/got1.bin"

"$shst" host < /dev/null > "$work/got2.bin" 2> "$work/h2.err" & hostpid=$!
code=$(code_from "$work/h2.err")
bounded 30 "$shst" join "$code" < "$work/send.bin" > /dev/null 2> "$work/j2.err"
host_exits
check "joiner sends 3 MB, host receives" "$(sum "$work/send.bin")" "$work/got2.bin"

"$shst" host < "$work/send.bin" > /dev/null 2> "$work/h3.err" & hostpid=$!
code=$(code_from "$work/h3.err")
# A terminal stdin: the joiner must exit after the file, without Ctrl-D.
# script(1) passes EOF on its own stdin to the terminal, so feed it a pipe
# that stays open.
sleep 60 | script -q /dev/null sh -c "'$shst' join $code > '$work/got3.bin' 2> '$work/j3.err'" > /dev/null &
jp=$!
for _ in $(seq 1 150); do kill -0 "$jp" 2>/dev/null || break; sleep 0.2; done
if kill -0 "$jp" 2>/dev/null; then kill "$jp"; echo "FAIL joiner on a terminal did not exit"; exit 1; fi
host_exits
check "joiner on a terminal exits after the file" "$(sum "$work/send.bin")" "$work/got3.bin"

"$shst" echo > /dev/null 2> "$work/e.err" & hostpid=$!
code=$(code_from "$work/e.err")
"$shst" ping "$code" -n 10 --duration 2s
if "$shst" ping "$code" -n 5 --duration 1s --json | grep -q '"groups"'; then
  echo "ok   ping --json"
else
  echo "FAIL ping --json did not print a groups object" >&3; exit 1
fi

# Ctrl-C in the middle of a measurement exits 130.
"$shst" ping "$code" -n 1000 --duration 60s > /dev/null 2> "$work/p.err" & extrapid=$!
for _ in $(seq 1 100); do grep -q '^joined via' "$work/p.err" && break; sleep 0.2; done
kill -INT "$extrapid"
exits_with 130 "$extrapid" 10 "ping interrupted mid-measurement exits 130"
extrapid=

# Echo is a server, so Ctrl-C is its normal stop.
kill -INT "$hostpid"
exits_with 0 "$hostpid" 10 "echo stopped with SIGINT exits 0"

"$shst" host --deny-relay < /dev/null > /dev/null 2> "$work/d.err" & hostpid=$!
code=$(code_from "$work/d.err")
if out=$(TS_DEBUG_NEVER_DIRECT_UDP=1 "$shst" join --deny-relay --direct-timeout 5s "$code" < /dev/null 2>&1); then
  echo "FAIL --deny-relay joined without a direct path: $out" >&3; exit 1
fi
if grep -q 'no direct path' <<< "$out"; then
  echo "ok   --deny-relay refuses a relayed session"
else
  echo "FAIL --deny-relay error does not say no direct path: $out" >&3; exit 1
fi
kill "$hostpid"; wait "$hostpid" 2>/dev/null || true

# A host interrupted while it waits for a peer exits 130.
"$shst" host < /dev/null > /dev/null 2> "$work/i.err" & hostpid=$!
code_from "$work/i.err" > /dev/null
kill -INT "$hostpid"
exits_with 130 "$hostpid" 10 "host interrupted while waiting exits 130"

# SIGTERM exits 143.
"$shst" host < /dev/null > /dev/null 2> "$work/t.err" & hostpid=$!
code_from "$work/t.err" > /dev/null
kill -TERM "$hostpid"
exits_with 143 "$hostpid" 10 "host terminated while waiting exits 143"

# A second joiner is refused while the first session is active. The host
# reads a fifo that stays open, so the first session does not end by itself.
mkfifo "$work/hin"
exec 4<>"$work/hin"
# The children must not inherit fd 4, or they would hold the fifo open.
"$shst" host < "$work/hin" > /dev/null 2> "$work/h5.err" 4>&- & hostpid=$!
code=$(code_from "$work/h5.err")
"$shst" join "$code" < /dev/null > /dev/null 2> "$work/j5a.err" 4>&- & extrapid=$!
for _ in $(seq 1 150); do grep -q '^session admitted' "$work/h5.err" && break; sleep 0.2; done
if ! grep -q '^session admitted' "$work/h5.err"; then
  echo "FAIL host never admitted the first joiner" >&3; exit 1
fi
bounded_fails 30 "$shst" join "$code" < /dev/null > /dev/null 2> "$work/j5b.err"
if grep -q refused "$work/j5b.err"; then
  echo "ok   a second joiner is refused"
else
  echo "FAIL second joiner stderr does not say refused: $(cat "$work/j5b.err")" >&3; exit 1
fi
exec 4>&- # EOF for the host's stdin, so the first session can finish
host_exits
exits_with 0 "$extrapid" 30 "first joiner finishes after the refusal"
extrapid=
# --qr prints ANSI colour QR lines before the code line.
"$shst" host --qr --addressing address < /dev/null > /dev/null 2> "$work/q.err" & hostpid=$!
code_from "$work/q.err" > /dev/null
qrlines=$(grep -c $'^\x1b\\[30;107m.*\x1b\\[0m$' "$work/q.err" || true)
firstqr=$(grep -n $'^\x1b\\[30;107m' "$work/q.err" | head -n 1 | cut -d: -f1)
codeline=$(grep -n '^code: ' "$work/q.err" | head -n 1 | cut -d: -f1)
if [[ $qrlines -ge 27 && -n $firstqr && $firstqr -lt $codeline ]]; then
  echo "ok   host --qr prints $qrlines ANSI QR lines before the code"
else
  echo "FAIL host --qr printed $qrlines ANSI QR lines (want >= 27, before code:)" >&3; exit 1
fi
kill -INT "$hostpid"
exits_with 130 "$hostpid" 10 "host --qr stopped with SIGINT exits 130"

# Raw Tailcat addresses, both directions. The host's code line is the address,
# so it must start with "tc".
"$shst" host --addressing address < "$work/send.bin" > /dev/null 2> "$work/a1.err" & hostpid=$!
addr=$(code_from "$work/a1.err")
if [[ $addr == tc* ]] && grep -q '^addressing: address$' "$work/a1.err"; then
  echo "ok   host --addressing address prints a tc address"
else
  echo "FAIL host --addressing address printed: $addr" >&3; exit 1
fi
bounded 30 "$shst" join "$addr" < /dev/null > "$work/gota1.bin" 2> "$work/ja1.err"
host_exits
check "address: host sends 3 MB, joiner receives" "$(sum "$work/send.bin")" "$work/gota1.bin"

"$shst" host --addressing address < /dev/null > "$work/gota2.bin" 2> "$work/a2.err" & hostpid=$!
addr=$(code_from "$work/a2.err")
bounded 30 "$shst" join "$addr" < "$work/send.bin" > /dev/null 2> "$work/ja2.err"
host_exits
check "address: joiner sends 3 MB, host receives" "$(sum "$work/send.bin")" "$work/gota2.bin"

# ping against an echo host that uses an address.
"$shst" echo --addressing address > /dev/null 2> "$work/ae.err" & hostpid=$!
addr=$(code_from "$work/ae.err")
if [[ $addr != tc* ]]; then echo "FAIL echo --addressing address printed: $addr" >&3; exit 1; fi
bounded 40 "$shst" ping "$addr" -n 5 --duration 1s
echo "ok   ping against an echo host with an address"
kill -INT "$hostpid"
exits_with 0 "$hostpid" 10 "echo --addressing address stopped with SIGINT exits 0"

# Interop with the upstream tailcat CLI, built from the submodule if present.
# A server with no arguments prints "# ... Server listening with new address:
# <tc address>" on stderr, accepts one connection on any port and writes it to
# stdout. A client "tailcat <address>" dials port 1 and copies stdin and stdout.
tcsrc="$here/../../package/tailcat"
tc="$work/tailcat"
tcskip=
if [[ ! -f $tcsrc/go.mod ]]; then
  tcskip="no source at $tcsrc (submodule not checked out)"
elif ! (cd "$tcsrc" && go build -o "$tc" ./cmd/tailcat) > "$work/tcbuild.log" 2>&1; then
  # The source is here, so a build failure is a real failure, not a skip.
  echo "FAIL tailcat interop: build of $tcsrc failed: $(tail -n 5 "$work/tcbuild.log")" >&3; exit 1
fi
if [[ -n $tcskip ]]; then
  echo "skip tailcat interop: $tcskip"
else
  "$tc" > "$work/tcgot.bin" 2> "$work/tcs.err" < /dev/null & hostpid=$!
  taddr=
  for _ in $(seq 1 100); do
    taddr=$(sed -n 's/^# .*Server listening with new address: //p' "$work/tcs.err" | head -n 1)
    [[ -n $taddr ]] && break
    sleep 0.2
  done
  if [[ $taddr != tc* ]]; then
    echo "FAIL no address from the upstream tailcat server: $(cat "$work/tcs.err")" >&3; exit 1
  fi
  bounded 40 "$shst" join "$taddr" < "$work/send.bin" > /dev/null 2> "$work/tcj.err"
  host_exits
  check "interop: shst join sends 3 MB to a tailcat server" "$(sum "$work/send.bin")" "$work/tcgot.bin"

  "$shst" host --addressing address --port 1 < "$work/send.bin" > /dev/null 2> "$work/tch.err" & hostpid=$!
  addr=$(code_from "$work/tch.err")
  bounded 40 "$tc" "$addr" < /dev/null > "$work/tcgot2.bin" 2> "$work/tcc.err"
  host_exits
  check "interop: a tailcat client receives 3 MB from shst host" "$(sum "$work/send.bin")" "$work/tcgot2.bin"
fi
echo "live check passed"
