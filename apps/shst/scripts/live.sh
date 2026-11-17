#!/usr/bin/env bash
# LIVE check over Tailcat's public relays, outside `pnpm test` like the
# whiteboard's test:live. Runs the in-process live tests, then the built
# binary as two processes per case and compares checksums.
set -euo pipefail
exec 3>&1 # verdicts, even from inside redirected commands

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
echo "live check passed"
