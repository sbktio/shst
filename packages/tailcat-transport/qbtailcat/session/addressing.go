package session

import (
	"errors"
	"fmt"
	"strings"
	"unicode"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
)

// An Addressing decides how a host's key is made and what a joiner types
// to reach it.
type Addressing interface {
	// Name identifies the addressing in flags, options and logs.
	Name() string
	// NewHost returns a fresh host key and the text a joiner needs. The key's
	// DERP region is region when the addressing can honour it.
	NewHost(region tailcfg.DERPRegionID) (*tailcat.PrivateKey, string, error)
	// Resolve turns text a joiner typed into the host's address. It returns an
	// error wrapping ErrUnrecognized when text is not in this addressing's
	// format, so Join can try the next one.
	Resolve(text string) (tailcat.Addr, error)
}

// ErrUnrecognized is wrapped by Addressing.Resolve when the text is not in
// that addressing's format.
var ErrUnrecognized = errors.New("not in this addressing's format")

// unrecognized reports err as ErrUnrecognized without changing its message,
// so the messages of the underlying parser reach users as before.
type unrecognized struct{ err error }

func (u unrecognized) Error() string      { return u.err.Error() }
func (u unrecognized) Unwrap() error      { return u.err }
func (unrecognized) Is(target error) bool { return target == ErrUnrecognized }

type wordsAddressing struct{}

// Words is the three-word session code addressing.
var Words Addressing = wordsAddressing{}

func (wordsAddressing) Name() string { return "words" }

func (wordsAddressing) NewHost(region tailcfg.DERPRegionID) (*tailcat.PrivateKey, string, error) {
	words, err := newCode(region)
	if err != nil {
		return nil, "", err
	}
	pk, err := keyForCode(words)
	if err != nil {
		return nil, "", err
	}
	return pk, canonicalCode(words), nil
}

// Resolve owns two judgments that must not depend on chain order:
//
//   - A single whitespace-free token longer than any canonical code that does
//     not start with "tc" is a damaged address. Words, not Addresses, decides
//     this because Addresses only recognizes text starting with "tc" and so
//     cannot tell a truncated-at-the-front address from a bad code; whichever
//     order Join tries them in, Words is the one that has already parsed the
//     text as a code and knows it cannot be one. (Text starting with "tc"
//     stays Addresses' to report, so it is ErrUnrecognized here.)
//   - Exactly three words with a misspelling is a recognized word code with a
//     typo: a plain error, so its message survives. Any other word count is
//     ErrUnrecognized, leaving the text to the other addressings.
func (wordsAddressing) Resolve(text string) (tailcat.Addr, error) {
	text = strings.TrimSpace(text)
	// An address is base64url, which has hyphens, so one can split into three
	// "words". No code word starts with "tc", so leave such text to Addresses.
	if hasTCPrefix(text) {
		return "", unrecognized{errors.New(`a session code does not start with "tc"`)}
	}
	if len(text) > maxCodeLen && !hasTCPrefix(text) && strings.IndexFunc(text, unicode.IsSpace) < 0 {
		return "", errDamagedAddress
	}
	words, err := parseCode(text)
	if err != nil {
		var count wordCountError
		if errors.As(err, &count) {
			return "", unrecognized{err}
		}
		return "", err
	}
	pk, err := keyForCode(words)
	if err != nil {
		return "", err
	}
	return pk.Public.Addr(), nil
}

type addressAddressing struct{}

// Addresses is the raw Tailcat address addressing: random keys and a random
// pre-shared key, far more entropy than a word code, but too long to type.
var Addresses Addressing = addressAddressing{}

func (addressAddressing) Name() string { return "address" }

func (addressAddressing) NewHost(region tailcfg.DERPRegionID) (*tailcat.PrivateKey, string, error) {
	pk := tailcat.NewPrivateKey()
	pk.Public.RegionID = region
	return pk, string(pk.Public.Addr()), nil
}

// errDamagedAddress is reported for text that is too long to be a word code
// but is not a parseable Tailcat address.
var errDamagedAddress = errors.New("that Tailcat address is damaged or incomplete")

// hasTCPrefix reports whether s starts with "tc" in any case.
func hasTCPrefix(s string) bool {
	return len(s) >= 2 && strings.EqualFold(s[:2], "tc")
}

func (addressAddressing) Resolve(text string) (tailcat.Addr, error) {
	text = strings.TrimSpace(text)
	if !hasTCPrefix(text) {
		return "", fmt.Errorf("%w: a Tailcat address starts with \"tc\"", ErrUnrecognized)
	}
	if !strings.HasPrefix(text, "tc") {
		return "", errors.New("a Tailcat address starts with lowercase \"tc\"; it may have been uppercased")
	}
	// Base64url has no whitespace, so any inside is from wrapping the address
	// across lines or splitting it across shell arguments: remove it all.
	text = strings.Join(strings.FieldsFunc(text, unicode.IsSpace), "")
	// No code word starts with "tc", so text that does is a damaged address,
	// not a word code: say so instead of letting Words report a word count.
	ci, err := tailcat.ParseAddr(tailcat.Addr(text))
	if err != nil {
		return "", fmt.Errorf("that Tailcat address is damaged or incomplete: %v", err)
	}
	if ci.ServerPublic.IsZero() {
		return "", errors.New("that Tailcat address names no host key")
	}
	if ci.RegionID == 0 && len(ci.Region) == 0 {
		return "", errors.New("that Tailcat address names no relay region")
	}
	if ci.ServerDiscoPublic.IsZero() {
		return "", errors.New("that Tailcat address is from an older tailcat that this version cannot join")
	}
	return tailcat.Addr(text), nil
}

// DefaultAddressings is the order Join tries when JoinOptions.Addressings is nil.
// Addresses comes first: a "tc…" string that parses is never a word code.
var DefaultAddressings = []Addressing{Addresses, Words}

// AddressingByName returns Words for "words" and Addresses for "address".
func AddressingByName(name string) (Addressing, error) {
	switch name {
	case Words.Name():
		return Words, nil
	case Addresses.Name():
		return Addresses, nil
	}
	return nil, fmt.Errorf("unknown addressing %q; valid names are %q and %q", name, Words.Name(), Addresses.Name())
}

// resolve returns the address text names and the addressing that recognized
// it. The first addressing that does not report ErrUnrecognized decides, even
// when it fails.
func resolve(text string, addressings []Addressing) (tailcat.Addr, Addressing, error) {
	var last error
	for _, a := range addressings {
		addr, err := a.Resolve(text)
		if errors.Is(err, ErrUnrecognized) {
			last = err
			continue
		}
		if err != nil {
			return "", a, err
		}
		return addr, a, nil
	}
	if last == nil {
		return "", nil, errors.New("not a session code or Tailcat address")
	}
	// Keep the last parser's message: for typed words it says what to fix.
	return "", nil, fmt.Errorf("not a session code or Tailcat address: %w", last)
}
