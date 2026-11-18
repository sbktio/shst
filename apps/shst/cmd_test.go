package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestSummarizeGroupsByPath(t *testing.T) {
	d := func(n int) time.Duration { return time.Duration(n) * time.Millisecond }
	var samples []rttSample
	for i := 1; i <= 4; i++ { // starts relayed
		samples = append(samples, rttSample{Via: "DERP(nyc)", RTT: d(100 * i)})
	}
	for i := 1; i <= 100; i++ { // then direct
		samples = append(samples, rttSample{Via: "1.2.3.4:5", Direct: true, RTT: d(101 - i)})
	}
	g := summarize(samples)
	if len(g) != 2 {
		t.Fatalf("got %d groups, want 2", len(g))
	}
	if g[0].Path != "DERP(nyc)" || g[0].Direct || g[0].Count != 4 || g[0].label() != "relayed DERP(nyc)" {
		t.Errorf("relayed group: %+v", g[0])
	}
	if g[0].p50 != d(300) || g[0].max != d(400) {
		t.Errorf("relayed stats: p50 %v max %v", g[0].p50, g[0].max)
	}
	if !g[1].Direct || g[1].Count != 100 || g[1].label() != "direct 1.2.3.4:5" {
		t.Errorf("direct group: %+v", g[1])
	}
	// sorted 1..100 ms: p50 is index 50 (51ms), p95 index 95 (96ms), max 100ms
	if g[1].p50 != d(51) || g[1].p95 != d(96) || g[1].max != d(100) {
		t.Errorf("direct stats: p50 %v p95 %v max %v", g[1].p50, g[1].p95, g[1].max)
	}
	if g[1].P50Ms != 51 || g[1].MaxMs != 100 {
		t.Errorf("json ms: %+v", g[1])
	}
	if summarize(nil) == nil || len(summarize(nil)) != 0 {
		t.Error("empty input should give an empty, non-nil slice")
	}
}

func run(args ...string) (string, string, error) {
	cmd := newRootCmd()
	var out, errb bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&errb)
	cmd.SetArgs(args)
	err := cmd.Execute()
	return out.String(), errb.String(), err
}

func TestJoinRequiresCode(t *testing.T) {
	if _, _, err := run("join"); err == nil {
		t.Fatal("join with no args should fail")
	}
}

func TestHelpListsCommands(t *testing.T) {
	out, _, err := run("--help")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"host", "join", "echo", "ping", "version"} {
		if !strings.Contains(out, "\n  "+name+" ") {
			t.Errorf("help does not list %q:\n%s", name, out)
		}
	}
}

func TestDefaultPorts(t *testing.T) {
	want := map[string]string{"host": "7188", "join": "7188", "echo": "7189", "ping": "7189"}
	root := newRootCmd()
	for name, port := range want {
		c, _, err := root.Find([]string{name})
		if err != nil {
			t.Fatal(err)
		}
		f := c.Flags().Lookup("port")
		if f == nil || f.DefValue != port {
			t.Errorf("%s: default port = %v, want %s", name, f, port)
		}
	}
	if portWhiteboard != 7187 {
		t.Errorf("whiteboard port = %d", portWhiteboard)
	}
}

func TestVersion(t *testing.T) {
	out, _, err := run("version")
	if err != nil || !strings.HasPrefix(out, "shst ") {
		t.Fatalf("out %q err %v", out, err)
	}
}

func TestExitCode(t *testing.T) {
	wrapped := fmt.Errorf("after 3 round trips: %w", context.Canceled)
	for _, c := range []struct {
		name string
		err  error
		sig  os.Signal
		want int
	}{
		{"success", nil, nil, 0},
		{"success after a signal", nil, syscall.SIGINT, 0},
		{"plain error", errors.New("boom"), nil, 1},
		{"cancelled without a signal", context.Canceled, nil, 1},
		{"SIGINT", context.Canceled, syscall.SIGINT, 130},
		{"SIGTERM", context.Canceled, syscall.SIGTERM, 143},
		{"wrapped cancel", wrapped, syscall.SIGINT, 130},
		{"other error after a signal", errors.New("boom"), syscall.SIGINT, 1},
		{"os.Interrupt", context.Canceled, os.Interrupt, 130},
	} {
		if got := exitCode(c.err, c.sig); got != c.want {
			t.Errorf("%s: exitCode = %d, want %d", c.name, got, c.want)
		}
	}
}

func TestIsRefused(t *testing.T) {
	refused := &net.OpError{Op: "connect", Net: "tcp", Err: errors.New("connection was refused")}
	if !isRefused(refused) || !isRefused(fmt.Errorf("dial: %w", refused)) {
		t.Error("a connection refused dial error was not detected")
	}
	if !isRefused(syscall.ECONNREFUSED) {
		t.Error("ECONNREFUSED was not detected")
	}
	if isRefused(errors.New("i/o timeout")) || isRefused(context.Canceled) {
		t.Error("an unrelated error was reported as a refusal")
	}
}

func TestPingRejectsBadCount(t *testing.T) {
	for _, n := range []string{"0", "-3"} {
		_, _, err := run("ping", "-n", n, "amber", "tiger", "lunar")
		if err == nil || !strings.Contains(err.Error(), "at least 1") {
			t.Errorf("-n %s: err = %v, want a usage error", n, err)
		}
	}
}
