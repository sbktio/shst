package main

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/sbktio/shst/packages/tailcat-transport/qbtailcat/session"
	"github.com/spf13/cobra"
)

// Environment variables. Each one is the default of a flag, so a flag on the
// command line always wins. There is no config file.
const (
	envAddressing = "SHST_ADDRESSING" // default for --addressing
	envQR         = "SHST_QR"         // a boolean such as 1 or true turns --qr on
)

// hostOptions holds the flags that host and echo share.
type hostOptions struct {
	addressing string
	qr         bool

	// envErr is why an environment variable could not be used as a flag
	// default. It is reported when the command runs, so an unrelated command
	// is not affected, and only if the flag was not given on the command line.
	addressingEnvErr error
	qrEnvErr         error
}

// envQRDefault reports whether SHST_QR asks for a QR code. Unset or blank
// means no. Anything else must be a boolean that strconv.ParseBool accepts,
// and the error names the variable otherwise.
func envQRDefault() (bool, error) {
	v := strings.TrimSpace(os.Getenv(envQR))
	if v == "" {
		return false, nil
	}
	on, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf("%s must be true or false, not %q", envQR, v)
	}
	return on, nil
}

// envAddressingDefault returns the addressing name from SHST_ADDRESSING, or
// "words" when it is unset or blank. Case and surrounding space are ignored.
func envAddressingDefault() (string, error) {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(envAddressing)))
	if v == "" {
		return session.Words.Name(), nil
	}
	if _, err := session.AddressingByName(v); err != nil {
		return session.Words.Name(), fmt.Errorf("invalid %s: %w", envAddressing, err)
	}
	return v, nil
}

// addHostFlags registers --addressing and --qr on cmd. A bad environment
// value is not shown as a default. The flag defaults to words or false and
// the error is kept for check.
func (o *hostOptions) addHostFlags(cmd *cobra.Command) {
	var addressing string
	var qr bool
	addressing, o.addressingEnvErr = envAddressingDefault()
	qr, o.qrEnvErr = envQRDefault()
	cmd.Flags().StringVar(&o.addressing, "addressing", addressing,
		`how a joiner reaches the host: "words" (three-word code) or "address" (raw Tailcat address) (env `+envAddressing+`)`)
	cmd.Flags().BoolVar(&o.qr, "qr", qr,
		"print a QR code of the code or address (env "+envQR+"=1; --qr=false overrides it)")
}

// check returns the usage error for a bad environment variable that no flag
// overrode. Call it first in RunE.
func (o *hostOptions) check(cmd *cobra.Command) error {
	if o.addressingEnvErr != nil && !cmd.Flags().Changed("addressing") {
		return o.addressingEnvErr
	}
	if o.qrEnvErr != nil && !cmd.Flags().Changed("qr") {
		return o.qrEnvErr
	}
	return nil
}

// resolve turns --addressing into a library addressing. An unknown name is a
// usage error that lists the valid ones.
func (o *hostOptions) resolve() (session.Addressing, error) {
	a, err := session.AddressingByName(strings.ToLower(strings.TrimSpace(o.addressing)))
	if err != nil {
		return nil, fmt.Errorf("invalid --addressing: %w", err)
	}
	return a, nil
}

// announce prints the status lines for a started host: the QR code if asked
// for, the code, then a hint in the form of the given verb ("join with: shst
// join" or "ping with: shst ping").
func (o *hostOptions) announce(w io.Writer, h *session.Host, hint string, deny bool) {
	if o.qr {
		if art, err := renderQR(h.Code); err != nil {
			fmt.Fprintf(w, "qr: cannot draw a QR code: %v\n", err)
		} else {
			fmt.Fprint(w, art)
		}
	}
	fmt.Fprintf(w, "code: %s\n%s %s\n", h.Code, hint, h.Code)
	if h.Addressing != session.Words.Name() {
		fmt.Fprintf(w, "addressing: %s\n", h.Addressing)
	}
	fmt.Fprintf(w, "region: %s (%d), relay %s\n", h.Region, h.RegionID, relayWord(deny))
}
