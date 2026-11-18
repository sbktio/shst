package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/sbktio/shst/packages/tailcat-transport/qbtailcat/session"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

// halfCloser is a byte stream that can close its write side alone, so the
// peer sees EOF while this side keeps reading.
type halfCloser interface {
	io.ReadWriteCloser
	CloseWrite() error
}

// readErrRecorder remembers a non-EOF error from the wrapped reader, so a
// failing stdin can be told apart from a failing connection.
type readErrRecorder struct {
	r   io.Reader
	err error
}

func (e *readErrRecorder) Read(p []byte) (int, error) {
	n, err := e.r.Read(p)
	if err != nil && err != io.EOF {
		e.err = err
	}
	return n, err
}

// onceHalfCloser makes CloseWrite idempotent. Every call after the first
// returns the first call's result without touching the connection, because a
// second half-close of a finished TCP stream can report "not connected" even
// though the stream closed cleanly.
type onceHalfCloser struct {
	halfCloser
	once sync.Once
	err  error
}

func (h *onceHalfCloser) CloseWrite() error {
	h.once.Do(func() { h.err = h.halfCloser.CloseWrite() })
	return h.err
}

// pipe copies stdin to conn and conn to stdout at the same time, like netcat.
// When stdin ends it half-closes conn so the peer sees EOF.
//
// It returns nil once the peer's stream has ended and, if waitStdin is set,
// the stdin copy has finished. It returns early with ctx.Err() when ctx is
// cancelled, and with the error if reading the connection fails.
//
// If waitStdin is set and writing to the connection failed before stdin
// reached EOF, pipe returns that error ("sending: ..."), because bytes the
// user supplied did not arrive. Without waitStdin, nothing was piped in, so a
// failed write is not reported. The error from the half-close after stdin
// ends is not reported here either. It is the caller's to read. pipe does
// not close conn.
func pipe(ctx context.Context, conn halfCloser, stdin io.Reader, stdout io.Writer, waitStdin bool) error {
	in := &readErrRecorder{r: stdin}
	stdinDone := make(chan struct{})
	var sendErr error // set before stdinDone closes
	go func() {
		defer close(stdinDone)
		_, err := io.Copy(conn, in)
		if err != nil && in.err == nil {
			sendErr = err // not a stdin read error, so the connection write failed
		}
		conn.CloseWrite()
	}()

	readDone := make(chan error, 1)
	go func() {
		_, err := io.Copy(stdout, conn)
		readDone <- err
	}()

	select {
	case err := <-readDone:
		if err != nil {
			return err
		}
	case <-ctx.Done():
		return ctx.Err()
	}
	if !waitStdin {
		return nil
	}
	// The peer is done sending. Our side may still have bytes to send.
	select {
	case <-stdinDone:
	case <-ctx.Done():
		return ctx.Err()
	}
	if sendErr != nil {
		return fmt.Errorf("sending: %w", sendErr)
	}
	return in.err
}

// drainTimeout bounds how long a finished session waits for the peer to
// acknowledge the tail of the stream.
const drainTimeout = 10 * time.Second

// runSession pipes stdin and stdout over c and turns the outcome into an
// exit error. A session closed by the relay policy is an error with the
// reason. Cancelling ctx ends the session with ctx.Err().
//
// When stdin is a terminal nothing was piped in, so the session ends as soon
// as the peer finishes sending: `shst join CODE > file` exits after the file
// instead of waiting for Ctrl-D.
//
// After the stream ends it half-closes, then waits for the peer to
// acknowledge everything. A CloseWrite failure is returned only when this is
// the first half-close. If stdin already ended, pipe half-closed the stream
// and onceHalfCloser hands back that result, so a repeat is never a new
// error. A Drain failure is always returned, since the tail of the stream may
// not have arrived.
func runSession(ctx context.Context, c *session.Conn) error {
	defer c.Close()
	hc := &onceHalfCloser{halfCloser: c}
	err := pipe(ctx, hc, os.Stdin, os.Stdout, !isTerminal(os.Stdin))
	if r := c.Reason(); r != "" {
		return errors.New(r)
	}
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return err
	}
	if err := hc.CloseWrite(); err != nil {
		return fmt.Errorf("closing the stream: %w", err)
	}
	dctx, cancel := context.WithTimeout(ctx, drainTimeout)
	defer cancel()
	if err := c.Drain(dctx); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("the peer did not acknowledge the end of the stream: %w", err)
	}
	return nil
}

func isTerminal(f *os.File) bool {
	return term.IsTerminal(int(f.Fd()))
}

// isRefused reports whether a dial failed because the host answered with a
// TCP reset. The in-process gVisor stack wraps an untyped error built from
// the string "connection was refused" in a net.OpError, so there is nothing
// to match with errors.Is. Match the text, and the errno for other stacks.
func isRefused(err error) bool {
	if errors.Is(err, syscall.ECONNREFUSED) {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "connection was refused") || strings.Contains(msg, "connection refused")
}

func newHostCmd() *cobra.Command {
	var port uint16
	var deny bool
	var opts hostOptions
	cmd := &cobra.Command{
		Use:   "host",
		Short: "Print a code and pipe stdin/stdout to the first peer that joins",
		Long: `Start a session and print its code to stderr. By default the code is three
words. With --addressing address it is a raw Tailcat address, which is long
but far harder to guess. --qr also prints it as a QR code. The first peer
to join is admitted and any later one is refused. Stdin goes to the peer and the peer's bytes go to stdout.

When stdin ends the peer sees EOF. Host exits 0 once the peer has finished
sending and stdin is done. If the relay policy closes the session, host
exits 1 with the reason. Ctrl-C exits 130 and SIGTERM exits 143.`,
		Example: `  shst host < file.tar
  tail -f app.log | shst host
  shst host --deny-relay
  shst host --addressing address --qr < secrets.tar`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := opts.check(cmd); err != nil {
				return err
			}
			addressing, err := opts.resolve()
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			conns := make(chan *session.Conn, 1)
			h, err := session.StartHost(ctx, session.HostOptions{
				AllowRelay: !deny,
				Port:       port,
				Logf:       logf(),
				Addressing: addressing,
				// One peer only. The library resets any further connection,
				// so a second joiner's dial fails.
				MaxSessions: 1,
				OnConn: func(c *session.Conn) {
					fmt.Fprintf(os.Stderr, "session admitted via %s\n", c.Path().Via)
					select {
					case conns <- c:
					default:
						c.Close()
					}
				},
				OnRefused: func(p session.Path) {
					fmt.Fprintf(os.Stderr, "session refused: peer is via %s and relay is denied\n", p.Via)
				},
			})
			if err != nil {
				return err
			}
			defer h.Close()
			opts.announce(os.Stderr, h, "join with: shst join", deny)
			select {
			case c := <-conns:
				return runSession(ctx, c)
			case <-ctx.Done():
				return ctx.Err()
			}
		},
	}
	cmd.Flags().Uint16Var(&port, "port", portPipe, "virtual Tailcat port")
	cmd.Flags().BoolVar(&deny, "deny-relay", false, "refuse sessions that are not on a direct path")
	opts.addHostFlags(cmd)
	return cmd
}

func newJoinCmd() *cobra.Command {
	var port uint16
	var deny bool
	var directTimeout time.Duration
	cmd := &cobra.Command{
		Use:   "join CODE|ADDRESS...",
		Short: "Join a host by code or address and pipe stdin/stdout to it",
		Long: `Join the session a host printed. The code is three words, separated by
spaces, hyphens, dots or commas, or a raw Tailcat address that starts with
"tc". Join tells them apart. Stdin goes to the host and the host's bytes go
to stdout.`,
		Example: `  shst join amber-tiger-lunar > file.tar
  shst join amber tiger lunar < message.txt
  shst join tc... > file.tar`,
		Args: cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			c, _, err := session.Join(ctx, strings.Join(args, " "), session.JoinOptions{
				AllowRelay:    !deny,
				Port:          port,
				DirectTimeout: directTimeout,
				Logf:          logf(),
			})
			if err != nil {
				if isRefused(err) {
					return fmt.Errorf("the host refused the session: it already has a peer, or it is not serving port %d (pipes use %d, echo %d): %w",
						port, portPipe, portEcho, err)
				}
				return err
			}
			fmt.Fprintf(os.Stderr, "joined via %s\n", c.Path().Via)
			return runSession(ctx, c)
		},
	}
	cmd.Flags().Uint16Var(&port, "port", portPipe, "virtual Tailcat port")
	cmd.Flags().BoolVar(&deny, "deny-relay", false, "require a direct path")
	cmd.Flags().DurationVar(&directTimeout, "direct-timeout", 15*time.Second, "how long to wait for a direct path with --deny-relay")
	return cmd
}

func relayWord(deny bool) string {
	if deny {
		return "denied"
	}
	return "allowed"
}
