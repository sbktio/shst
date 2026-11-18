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

	"github.com/sbktio/shst/packages/tailcat-transport/qbtailcat/session"
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

func TestAddressingFlagDefaults(t *testing.T) {
	for _, name := range []string{"host", "echo"} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("SHST_ADDRESSING", "")
			t.Setenv("SHST_QR", "")
			c, _, err := newRootCmd().Find([]string{name})
			if err != nil {
				t.Fatal(err)
			}
			if f := c.Flags().Lookup("addressing"); f == nil || f.DefValue != "words" {
				t.Errorf("--addressing = %v, want default words", f)
			}
			if f := c.Flags().Lookup("qr"); f == nil || f.DefValue != "false" {
				t.Errorf("--qr = %v, want default false", f)
			}
		})
	}
}

func TestAddressingEnvFallback(t *testing.T) {
	t.Setenv("SHST_ADDRESSING", "address")
	t.Setenv("SHST_QR", "true")
	for _, name := range []string{"host", "echo"} {
		c, _, err := newRootCmd().Find([]string{name})
		if err != nil {
			t.Fatal(err)
		}
		if f := c.Flags().Lookup("addressing"); f.DefValue != "address" {
			t.Errorf("%s: --addressing default = %q, want address from the environment", name, f.DefValue)
		}
		if f := c.Flags().Lookup("qr"); f.DefValue != "true" {
			t.Errorf("%s: --qr default = %q, want true from the environment", name, f.DefValue)
		}
	}
}

func TestEnvQR(t *testing.T) {
	for _, c := range []struct {
		val  string
		want bool
		bad  bool
	}{
		{"", false, false}, {"  ", false, false},
		{"1", true, false}, {"true", true, false}, {"TRUE", true, false}, {" true ", true, false},
		{"0", false, false}, {"false", false, false}, {"False", false, false},
		{"yes", false, true}, {"on", false, true}, {"2", false, true},
	} {
		t.Setenv("SHST_QR", c.val)
		got, err := envQRDefault()
		if got != c.want || (err != nil) != c.bad {
			t.Errorf("SHST_QR=%q: got %v, %v; want %v, bad=%v", c.val, got, err, c.want, c.bad)
		}
		if err != nil && !strings.Contains(err.Error(), "SHST_QR must be true or false") {
			t.Errorf("SHST_QR=%q: error %q does not name the variable", c.val, err)
		}
	}
}

// qrFlag returns the --qr value of a command built under the current
// environment, and what its flag help shows as the default.
func qrFlag(t *testing.T, name string) (value bool, def string) {
	t.Helper()
	c, _, err := newRootCmd().Find([]string{name})
	if err != nil {
		t.Fatal(err)
	}
	f := c.Flags().Lookup("qr")
	return f.Value.String() == "true", f.DefValue
}

func TestEnvQRSetsFlagDefault(t *testing.T) {
	for _, c := range []struct{ val, def string }{
		{"TRUE", "true"}, {"0", "false"}, {"yes", "false"}, {"", "false"},
	} {
		t.Setenv("SHST_QR", c.val)
		if v, def := qrFlag(t, "host"); def != c.def || v != (c.def == "true") {
			t.Errorf("SHST_QR=%q: flag value %v default %q, want default %q", c.val, v, def, c.def)
		}
	}
}

func TestEnvQRInvalidIsUsageErrorAtRunTime(t *testing.T) {
	t.Setenv("SHST_QR", "yes")
	// Unrelated commands are unaffected.
	if out, _, err := run("version"); err != nil || !strings.HasPrefix(out, "shst ") {
		t.Fatalf("version: out %q err %v", out, err)
	}
	for _, name := range []string{"host", "echo"} {
		_, _, err := run(name)
		if err == nil || !strings.Contains(err.Error(), "SHST_QR must be true or false") {
			t.Errorf("%s: err = %v, want a SHST_QR usage error", name, err)
		}
	}
}

func TestQRFlagOverridesEnv(t *testing.T) {
	t.Setenv("SHST_QR", "1")
	c, _, err := newRootCmd().Find([]string{"host"})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Flags().Parse([]string{"--qr=false"}); err != nil {
		t.Fatal(err)
	}
	if got := c.Flags().Lookup("qr").Value.String(); got != "false" {
		t.Errorf("--qr=false with SHST_QR=1: value %s, want false", got)
	}
	// A bad variable does not matter when the flag is given.
	t.Setenv("SHST_QR", "yes")
	c, _, _ = newRootCmd().Find([]string{"host"})
	if err := c.Flags().Parse([]string{"--qr=false"}); err != nil {
		t.Fatal(err)
	}
	var o hostOptions
	o.qrEnvErr = errors.New("bad")
	if err := o.check(c); err != nil {
		t.Errorf("check with --qr given = %v, want nil", err)
	}
}

func TestEnvAddressingNormalized(t *testing.T) {
	for _, v := range []string{" Address ", "ADDRESS", "address"} {
		t.Setenv("SHST_ADDRESSING", v)
		got, err := envAddressingDefault()
		if err != nil || got != "address" {
			t.Errorf("SHST_ADDRESSING=%q: got %q, %v; want address", v, got, err)
		}
	}
}

func TestEnvAddressingBogusKeepsHelpClean(t *testing.T) {
	t.Setenv("SHST_ADDRESSING", "bogus")
	for _, name := range []string{"host", "echo"} {
		c, _, err := newRootCmd().Find([]string{name})
		if err != nil {
			t.Fatal(err)
		}
		if f := c.Flags().Lookup("addressing"); f.DefValue != "words" {
			t.Errorf("%s: --addressing default = %q, want words", name, f.DefValue)
		}
	}
	// The error appears when the command runs, before any network use, and
	// an explicit flag overrides the bad variable (checked via check).
	for _, name := range []string{"host", "echo"} {
		_, _, err := run(name)
		if err == nil || !strings.Contains(err.Error(), "SHST_ADDRESSING") || !strings.Contains(err.Error(), "bogus") {
			t.Errorf("%s: err = %v, want a SHST_ADDRESSING usage error", name, err)
		}
	}
	if out, _, err := run("version"); err != nil || !strings.HasPrefix(out, "shst ") {
		t.Errorf("version with a bad variable: %q %v", out, err)
	}
}

func TestAnnounceOutput(t *testing.T) {
	h := &session.Host{Code: "amber-tiger-lunar", Addressing: "words", Region: "nyc", RegionID: 1}
	var b bytes.Buffer
	(&hostOptions{}).announce(&b, h, "join with: shst join", false)
	want := "code: amber-tiger-lunar\njoin with: shst join amber-tiger-lunar\nregion: nyc (1), relay allowed\n"
	if b.String() != want {
		t.Errorf("default output = %q, want %q", b.String(), want)
	}
	h.Addressing = "address"
	b.Reset()
	(&hostOptions{qr: true}).announce(&b, h, "ping with: shst ping", true)
	out := b.String()
	if !strings.Contains(out, "\x1b[30;107m") || !strings.Contains(out, "addressing: address\n") ||
		strings.Index(out, "\x1b[0m") > strings.Index(out, "code: ") || !strings.HasSuffix(out, "relay denied\n") {
		t.Errorf("address output = %q", out)
	}
}

func TestAddressingFlagWinsOverEnv(t *testing.T) {
	t.Setenv("SHST_ADDRESSING", "address")
	c, _, err := newRootCmd().Find([]string{"host"})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Flags().Parse([]string{"--addressing", "words"}); err != nil {
		t.Fatal(err)
	}
	o := hostOptions{addressing: c.Flags().Lookup("addressing").Value.String()}
	a, err := o.resolve()
	if err != nil || a.Name() != "words" {
		t.Errorf("resolve = %v, %v; want words", a, err)
	}
}

func TestAddressingInvalid(t *testing.T) {
	for _, args := range [][]string{{"host", "--addressing", "emoji"}, {"echo", "--addressing", "emoji"}} {
		_, _, err := run(args...)
		if err == nil {
			t.Fatalf("%v: want a usage error", args)
		}
		for _, want := range []string{"emoji", `"words"`, `"address"`} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("%v: error %q does not mention %s", args, err, want)
			}
		}
	}
	t.Setenv("SHST_ADDRESSING", "bogus")
	if _, _, err := run("host"); err == nil || !strings.Contains(err.Error(), "bogus") {
		t.Errorf("bad SHST_ADDRESSING: err = %v", err)
	}
}

func TestRootHelpDocumentsEnvironment(t *testing.T) {
	out, _, err := run("--help")
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{"SHST_ADDRESSING", "SHST_QR"} {
		if !strings.Contains(out, v) {
			t.Errorf("root help does not document %s", v)
		}
	}
}
