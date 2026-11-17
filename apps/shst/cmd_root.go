package main

import (
	"fmt"
	"log"

	"github.com/spf13/cobra"
	"tailscale.com/types/logger"
)

// Virtual Tailcat ports. A session code only reaches the service that
// listens on the port the joiner dials, so each tool has its own port. That
// keeps a whiteboard code from being mistaken for a pipe, and the reverse.
const (
	portWhiteboard uint16 = 7187 // the whiteboard app; shst never listens here
	portPipe       uint16 = 7188 // shst host / shst join
	portEcho       uint16 = 7189 // shst echo / shst ping
)

var verbose bool

func logf() logger.Logf {
	if verbose {
		return log.Printf
	}
	return logger.Discard
}

func newRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:   "shst",
		Short: "Pipe bytes between two machines over Tailcat",
		Long: fmt.Sprintf(`shst sends a byte stream from one machine to another. No accounts, no
servers to run, no port forwarding.

One side runs "shst host" and gets a three-word code. The other side runs
"shst join <code>". Stdin on each side goes to the peer and the peer's bytes
come out on stdout, like netcat. Data goes to stdout. Status goes to stderr,
so pipes stay clean.

The stream is point to point and encrypted end to end. Tailcat tries a direct
UDP path first and falls back to a DERP relay when none exists. Use
--deny-relay to refuse relayed sessions.

Ports. Both sides must use the same port, which is part of what a code
reaches. Pipes default to %d, echo and ping default to %d, and the
whiteboard app uses %d, so a whiteboard code is never taken for a pipe.

Environment. Set TS_DEBUG_NEVER_DIRECT_UDP=1 on either side to simulate a
network that blocks direct UDP. Set TS_DEBUG_ALWAYS_USE_DERP=1 to force the
relay.`, portPipe, portEcho, portWhiteboard),
		SilenceUsage:      true,
		SilenceErrors:     true,
		CompletionOptions: cobra.CompletionOptions{DisableDefaultCmd: true},
	}
	root.PersistentFlags().BoolVarP(&verbose, "verbose", "v", false, "log tailcat internals to stderr")
	root.AddCommand(newHostCmd(), newJoinCmd(), newEchoCmd(), newPingCmd(), newVersionCmd())
	return root
}

func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the shst version",
		Args:  cobra.NoArgs,
		Run: func(cmd *cobra.Command, _ []string) {
			fmt.Fprintln(cmd.OutOrStdout(), "shst "+version)
		},
	}
}
