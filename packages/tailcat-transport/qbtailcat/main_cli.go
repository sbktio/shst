//go:build !js

// The native build, for relay-policy experiments a browser cannot run
// (browsers have no UDP, so they can never hold a direct path today).
//
//	qbtailcat host [-deny-relay]               print a code; echo sessions
//	qbtailcat join [-deny-relay] [-n 50] CODE  measure echo round trips
//
// Set TS_DEBUG_NEVER_DIRECT_UDP=1 on either side to simulate a network that
// blocks direct UDP, or TS_DEBUG_ALWAYS_USE_DERP=1 to force the relay.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"slices"
	"strings"
	"time"

	"tailscale.com/types/logger"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: qbtailcat host|join [flags] [CODE]")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "host":
		err = runHost(os.Args[2:])
	case "join":
		err = runJoin(os.Args[2:])
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func cliLogf(verbose bool) logger.Logf {
	if verbose {
		return log.Printf
	}
	return logger.Discard
}

func runHost(args []string) error {
	fs := flag.NewFlagSet("host", flag.ExitOnError)
	deny := fs.Bool("deny-relay", false, "refuse sessions that are not on a direct path")
	verbose := fs.Bool("v", false, "verbose tailcat logs")
	fs.Parse(args)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	h, err := startHost(ctx, hostOptions{
		AllowRelay: !*deny,
		Port:       7187,
		Logf:       cliLogf(*verbose),
		OnConn: func(c *sessionConn) {
			fmt.Printf("session admitted via %s\n", c.Path().Via)
			go func() {
				io.Copy(c, c)
				if r := c.Reason(); r != "" {
					fmt.Printf("session closed: %s\n", r)
				}
				c.Close()
			}()
		},
		OnRefused: func(p Path) { fmt.Printf("session refused: peer is via %s and relay is denied\n", p.Via) },
	})
	if err != nil {
		return err
	}
	defer h.Close()
	fmt.Printf("code: %s\nregion: %s (%d)\naddress length: %d\nrelay: %s\n",
		h.Code, h.Region, h.RegionID, len(h.Addr), map[bool]string{true: "denied", false: "allowed"}[*deny])
	<-ctx.Done()
	return nil
}

func runJoin(args []string) error {
	fs := flag.NewFlagSet("join", flag.ExitOnError)
	deny := fs.Bool("deny-relay", false, "require a direct path")
	n := fs.Int("n", 20, "minimum echo round trips to measure")
	duration := fs.Duration("duration", 8*time.Second, "keep measuring for at least this long")
	timeout := fs.Duration("direct-timeout", 15*time.Second, "how long to wait for a direct path")
	verbose := fs.Bool("v", false, "verbose tailcat logs")
	fs.Parse(args)
	code := strings.Join(fs.Args(), " ")
	t0 := time.Now()
	c, cl, tm, err := join(context.Background(), code, joinOptions{
		AllowRelay:    !*deny,
		Port:          7187,
		DirectTimeout: *timeout,
		Logf:          cliLogf(*verbose),
	})
	if err != nil {
		out, _ := json.Marshal(tm)
		fmt.Printf("join failed after %v: %v\ntimings: %s\n", time.Since(t0).Round(time.Millisecond), err, out)
		return err
	}
	defer cl.Close()
	defer c.Close()
	out, _ := json.Marshal(tm)
	fmt.Printf("joined via %s in %v\ntimings: %s\n", c.Path().Via, time.Since(t0).Round(time.Millisecond), out)
	msg := make([]byte, 64)
	got := make([]byte, 64)
	// Group round trips by the path in use when each was sent, so a session
	// that starts relayed and upgrades to direct shows both.
	byPath := map[string][]time.Duration{}
	var order []string
	end := time.Now().Add(*duration)
	for i := 0; i < *n || time.Now().Before(end); i++ {
		p := c.Path()
		label := "relayed " + p.Via
		if p.Direct {
			label = "direct " + p.Via
		}
		s := time.Now()
		if _, err := c.Write(msg); err != nil {
			return fmt.Errorf("after %d round trips: %w (%s)", i, err, c.Reason())
		}
		if _, err := io.ReadFull(c, got); err != nil {
			return fmt.Errorf("after %d round trips: %w (%s)", i, err, c.Reason())
		}
		if _, ok := byPath[label]; !ok {
			order = append(order, label)
		}
		byPath[label] = append(byPath[label], time.Since(s))
		time.Sleep(50 * time.Millisecond)
	}
	for _, label := range order {
		rtts := byPath[label]
		slices.Sort(rtts)
		fmt.Printf("echo rtt %s over %d: p50 %v p95 %v max %v\n", label, len(rtts),
			rtts[len(rtts)/2].Round(10*time.Microsecond), rtts[len(rtts)*95/100].Round(10*time.Microsecond),
			rtts[len(rtts)-1].Round(10*time.Microsecond))
	}
	return nil
}
