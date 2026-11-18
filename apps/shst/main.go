// Command shst pipes bytes between two machines over Tailcat.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

// version is overridden at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() { os.Exit(runMain()) }

// runMain executes the command line and returns the exit code. It records which
// signal cancelled the context, so an interrupted command can exit with the
// conventional 128 plus the signal number.
func runMain() int {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigs)
	got := make(chan os.Signal, 1)
	go func() {
		select {
		case s := <-sigs:
			got <- s // record the signal before the cancellation can be seen
			// Restore the default action, so a second Ctrl-C kills a
			// command that is slow to stop.
			signal.Stop(sigs)
			cancel()
		case <-ctx.Done():
		}
	}()
	err := newRootCmd().ExecuteContext(ctx)
	var sig os.Signal
	select {
	case sig = <-got:
	default:
	}
	code := exitCode(err, sig)
	if code == 0 {
		return 0
	}
	if sig != nil && errors.Is(err, context.Canceled) {
		fmt.Fprintln(os.Stderr, "shst: interrupted")
	} else {
		fmt.Fprintln(os.Stderr, "shst: "+err.Error())
	}
	return code
}

// exitCode maps a command's error to a process exit code. sig is the signal
// that cancelled the command, or nil. A command that stopped because of that
// signal exits 128 plus its number (130 for SIGINT, 143 for SIGTERM). Any
// other error exits 1.
func exitCode(err error, sig os.Signal) int {
	if err == nil {
		return 0
	}
	if s, ok := sig.(syscall.Signal); ok && errors.Is(err, context.Canceled) {
		return 128 + int(s)
	}
	return 1
}
