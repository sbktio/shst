package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/sbktio/shst/packages/tailcat-transport/qbtailcat/session"
	"github.com/spf13/cobra"
)

// startEcho hosts an echo server that serves any number of sessions at once.
// Status lines go to status.
func startEcho(ctx context.Context, port uint16, deny bool, status io.Writer) (*session.Host, error) {
	return session.StartHost(ctx, session.HostOptions{
		AllowRelay: !deny,
		Port:       port,
		Logf:       logf(),
		OnConn: func(c *session.Conn) {
			fmt.Fprintf(status, "session admitted via %s\n", c.Path().Via)
			go func() {
				io.Copy(c, c)
				reason := c.Reason()
				if reason == "" {
					reason = "peer closed"
				}
				fmt.Fprintf(status, "session closed: %s\n", reason)
				c.Close()
			}()
		},
		OnRefused: func(p session.Path) {
			fmt.Fprintf(status, "session refused: peer is via %s and relay is denied\n", p.Via)
		},
	})
}

func newEchoCmd() *cobra.Command {
	var port uint16
	var deny bool
	cmd := &cobra.Command{
		Use:   "echo",
		Short: "Host an echo server and print its code (pair with ping)",
		Long: `Host a server that sends back every byte it receives, for any number of
sessions at once. Use "shst ping CODE" from another machine to measure
round trips. Runs until interrupted.`,
		Example: `  shst echo
  shst echo --deny-relay`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			h, err := startEcho(ctx, port, deny, os.Stderr)
			if err != nil {
				return err
			}
			defer h.Close()
			fmt.Fprintf(os.Stderr, "code: %s\nping with: shst ping %s\n", h.Code, h.Code)
			fmt.Fprintf(os.Stderr, "region: %s (%d), relay %s\n", h.Region, h.RegionID, relayWord(deny))
			<-ctx.Done()
			return nil
		},
	}
	cmd.Flags().Uint16Var(&port, "port", portEcho, "virtual Tailcat port")
	cmd.Flags().BoolVar(&deny, "deny-relay", false, "refuse sessions that are not on a direct path")
	return cmd
}

// rttSample is one measured round trip and the path in use when it was sent.
type rttSample struct {
	Via    string
	Direct bool
	RTT    time.Duration
}

// rttGroup summarizes the round trips that shared a path.
type rttGroup struct {
	Path   string  `json:"path"`
	Direct bool    `json:"direct"`
	Count  int     `json:"count"`
	P50Ms  float64 `json:"p50Ms"`
	P95Ms  float64 `json:"p95Ms"`
	MaxMs  float64 `json:"maxMs"`

	p50, p95, max time.Duration
}

// label names the group for humans: "direct 1.2.3.4:5" or "relayed DERP(nyc)".
func (g rttGroup) label() string {
	if g.Direct {
		return "direct " + g.Path
	}
	return "relayed " + g.Path
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

// summarize groups samples by path, in order of first appearance, so a
// session that starts relayed and upgrades to direct shows both.
func summarize(samples []rttSample) []rttGroup {
	type key struct {
		via    string
		direct bool
	}
	byKey := map[key][]time.Duration{}
	var order []key
	for _, s := range samples {
		k := key{s.Via, s.Direct}
		if _, ok := byKey[k]; !ok {
			order = append(order, k)
		}
		byKey[k] = append(byKey[k], s.RTT)
	}
	groups := make([]rttGroup, 0, len(order))
	for _, k := range order {
		rtts := slices.Clone(byKey[k])
		slices.Sort(rtts)
		g := rttGroup{
			Path: k.via, Direct: k.direct, Count: len(rtts),
			p50: rtts[len(rtts)/2], p95: rtts[len(rtts)*95/100], max: rtts[len(rtts)-1],
		}
		g.P50Ms, g.P95Ms, g.MaxMs = ms(g.p50), ms(g.p95), ms(g.max)
		groups = append(groups, g)
	}
	return groups
}

// measure sends 64-byte messages 50 ms apart over an echo session until it
// has n round trips and duration has passed.
func measure(ctx context.Context, c *session.Conn, n int, duration time.Duration) ([]rttSample, error) {
	// Unblock a Write or ReadFull stuck on a silent peer when ctx is cancelled.
	stop := context.AfterFunc(ctx, func() { c.Close() })
	defer stop()
	fail := func(i int, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("after %d round trips: %w (%s)", i, err, c.Reason())
	}
	msg := make([]byte, 64)
	got := make([]byte, 64)
	var samples []rttSample
	end := time.Now().Add(duration)
	for i := 0; i < n || time.Now().Before(end); i++ {
		if err := ctx.Err(); err != nil {
			return samples, err
		}
		p := c.Path()
		s := time.Now()
		if _, err := c.Write(msg); err != nil {
			return samples, fail(i, err)
		}
		if _, err := io.ReadFull(c, got); err != nil {
			return samples, fail(i, err)
		}
		samples = append(samples, rttSample{Via: p.Via, Direct: p.Direct, RTT: time.Since(s)})
		select {
		case <-ctx.Done():
			return samples, ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	return samples, nil
}

func newPingCmd() *cobra.Command {
	var port uint16
	var deny, asJSON bool
	var n int
	var duration, directTimeout time.Duration
	cmd := &cobra.Command{
		Use:   "ping CODE...",
		Short: "Measure round trips to an echo host",
		Long: `Join an echo host (shst echo) and measure round trips with 64-byte
messages 50 ms apart. Results are grouped by the path in use, so a session
that starts on the relay and upgrades to a direct path shows both. Results
go to stdout. Status goes to stderr.`,
		Example: `  shst ping amber-tiger-lunar
  shst ping amber tiger lunar -n 50 --json`,
		Args: cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if n < 1 {
				return fmt.Errorf("invalid --count %d: it must be at least 1", n)
			}
			ctx := cmd.Context()
			t0 := time.Now()
			c, tm, err := session.Join(ctx, strings.Join(args, " "), session.JoinOptions{
				AllowRelay:    !deny,
				Port:          port,
				DirectTimeout: directTimeout,
				Logf:          logf(),
			})
			if err != nil {
				out, _ := json.Marshal(tm)
				fmt.Fprintf(os.Stderr, "join failed after %v\ntimings: %s\n", time.Since(t0).Round(time.Millisecond), out)
				return err
			}
			defer c.Close()
			joinMs := time.Since(t0).Milliseconds()
			out, _ := json.Marshal(tm)
			fmt.Fprintf(os.Stderr, "joined via %s in %dms\ntimings: %s\n", c.Path().Via, joinMs, out)
			samples, err := measure(ctx, c, n, duration)
			if err != nil {
				return err
			}
			groups := summarize(samples)
			w := cmd.OutOrStdout()
			if asJSON {
				enc := json.NewEncoder(w)
				return enc.Encode(struct {
					JoinMs  int64               `json:"joinMs"`
					Timings session.JoinTimings `json:"timings"`
					Groups  []rttGroup          `json:"groups"`
				}{joinMs, tm, groups})
			}
			for _, g := range groups {
				fmt.Fprintf(w, "echo rtt %s over %d: p50 %v p95 %v max %v\n", g.label(), g.Count,
					g.p50.Round(10*time.Microsecond), g.p95.Round(10*time.Microsecond), g.max.Round(10*time.Microsecond))
			}
			return nil
		},
	}
	cmd.Flags().Uint16Var(&port, "port", portEcho, "virtual Tailcat port")
	cmd.Flags().BoolVar(&deny, "deny-relay", false, "require a direct path")
	cmd.Flags().IntVarP(&n, "count", "n", 20, "minimum round trips to measure")
	cmd.Flags().DurationVar(&duration, "duration", 8*time.Second, "keep measuring for at least this long")
	cmd.Flags().DurationVar(&directTimeout, "direct-timeout", 15*time.Second, "how long to wait for a direct path with --deny-relay")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print one JSON object instead of text")
	return cmd
}
