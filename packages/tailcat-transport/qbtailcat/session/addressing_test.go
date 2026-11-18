package session

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
)

func TestWordsRoundTrip(t *testing.T) {
	const region = tailcfg.DERPRegionID(303)
	pk, text, err := Words.NewHost(region)
	if err != nil {
		t.Fatal(err)
	}
	if pk.Public.RegionID != region {
		t.Fatalf("region = %d, want %d", pk.Public.RegionID, region)
	}
	addr, err := Words.Resolve(strings.ToUpper(text))
	if err != nil {
		t.Fatal(err)
	}
	if addr != pk.Public.Addr() {
		t.Fatal("resolved address differs from the host key's address")
	}
}

func TestAddressesRoundTrip(t *testing.T) {
	const region = tailcfg.DERPRegionID(302)
	pk, text, err := Addresses.NewHost(region)
	if err != nil {
		t.Fatal(err)
	}
	if text != string(pk.Public.Addr()) {
		t.Fatal("share text is not the key's address")
	}
	addr, err := Addresses.Resolve("  " + text + "\n")
	if err != nil {
		t.Fatal(err)
	}
	if string(addr) != text {
		t.Fatal("resolved address differs from share text")
	}
	ci, err := tailcat.ParseAddr(addr)
	if err != nil {
		t.Fatal(err)
	}
	if ci.RegionID != region {
		t.Fatalf("region = %d, want %d", ci.RegionID, region)
	}
}

func TestResolveRejectsOtherFormats(t *testing.T) {
	_, text, err := Addresses.NewHost(301)
	if err != nil {
		t.Fatal(err)
	}
	for _, in := range []string{"abacus-abdomen-zoom", "garbage", ""} {
		if _, err := Addresses.Resolve(in); !errors.Is(err, ErrUnrecognized) {
			t.Errorf("Addresses.Resolve(%q) = %v, want ErrUnrecognized", in, err)
		}
	}
	// No code word starts with "tc", so a damaged address is reported as one.
	for _, in := range []string{"tc", "tc!!!", "tcAAAA", text[:len(text)/2]} {
		_, _, err := resolve(in, DefaultAddressings)
		if err == nil || errors.Is(err, ErrUnrecognized) || !strings.Contains(err.Error(), "Tailcat address") {
			t.Errorf("resolve(%q) = %v, want a damaged-address error", in, err)
		}
	}
	if _, err := Words.Resolve(text); !errors.Is(err, ErrUnrecognized) {
		t.Errorf("Words.Resolve(address) = %v, want ErrUnrecognized", err)
	}
}

func TestResolveChain(t *testing.T) {
	_, text, err := Addresses.NewHost(301)
	if err != nil {
		t.Fatal(err)
	}
	addr, a, err := resolve(text, DefaultAddressings)
	if err != nil || a != Addresses || string(addr) != text {
		t.Fatalf("address: got %q, %v, %v", addr, a, err)
	}
	addr, a, err = resolve("abacus abdomen zoom", DefaultAddressings)
	if err != nil || a != Words || addr == "" {
		t.Fatalf("words: got %q, %v, %v", addr, a, err)
	}
	_, a, err = resolve("nonsense", DefaultAddressings)
	if err == nil || a != nil || !strings.Contains(err.Error(), "not a session code or Tailcat address") {
		t.Fatalf("nonsense: got %v, %v", a, err)
	}
	// Three words with a misspelling is a recognized word code: the message
	// names the word, whichever addressing is tried first.
	_, _, err = resolve("abacus abdomen qwertyuiop", DefaultAddressings)
	if err == nil || !strings.Contains(err.Error(), `"qwertyuiop" is not a session code word`) {
		t.Fatalf("bad word: %v", err)
	}
	if _, _, err := resolve("abacus abdomen zoom", []Addressing{Addresses}); err == nil {
		t.Fatal("restricted chain accepted a word code")
	}
	if _, _, err := resolve("x", nil); err == nil {
		t.Fatal("empty chain accepted text")
	}
}

func TestAddressingByName(t *testing.T) {
	for name, want := range map[string]Addressing{"words": Words, "address": Addresses} {
		got, err := AddressingByName(name)
		if err != nil || got != want {
			t.Errorf("AddressingByName(%q) = %v, %v", name, got, err)
		}
		if got.Name() != name {
			t.Errorf("Name() = %q, want %q", got.Name(), name)
		}
	}
	_, err := AddressingByName("emoji")
	if err == nil || !strings.Contains(err.Error(), "words") || !strings.Contains(err.Error(), "address") {
		t.Fatalf("invalid name error = %v", err)
	}
}

func TestMisspelledWordMessageIsOrderIndependent(t *testing.T) {
	const in = "abacus abdomen qwertyuiop"
	var msgs []string
	for _, chain := range [][]Addressing{{Words, Addresses}, {Addresses, Words}, DefaultAddressings} {
		_, _, err := resolve(in, chain)
		if err == nil || errors.Is(err, ErrUnrecognized) {
			t.Fatalf("resolve(%q) = %v, want a plain error", in, err)
		}
		msgs = append(msgs, err.Error())
	}
	if !strings.Contains(msgs[0], `"qwertyuiop" is not a session code word`) {
		t.Fatalf("message = %q", msgs[0])
	}
	for _, m := range msgs[1:] {
		if m != msgs[0] {
			t.Fatalf("messages differ by chain order: %q vs %q", m, msgs[0])
		}
	}
	// A wrong word count stays unrecognized.
	for _, bad := range []string{"abacus abdomen", "abacus abdomen zoom zoom", "nonsense"} {
		if _, err := Words.Resolve(bad); !errors.Is(err, ErrUnrecognized) {
			t.Errorf("Words.Resolve(%q) = %v, want ErrUnrecognized", bad, err)
		}
	}
}

func TestLongTokenIsDamagedAddressInAnyOrder(t *testing.T) {
	_, text, err := Addresses.NewHost(301)
	if err != nil {
		t.Fatal(err)
	}
	damaged := text[2:] // the "tc" prefix was lost
	if len(damaged) <= maxCodeLen {
		t.Fatalf("test token is only %d long", len(damaged))
	}
	var msgs []string
	for _, chain := range [][]Addressing{{Words, Addresses}, {Addresses, Words}, {Words}} {
		_, _, err := resolve(damaged, chain)
		if err == nil || errors.Is(err, ErrUnrecognized) || !strings.Contains(err.Error(), "damaged or incomplete") {
			t.Fatalf("chain %d: resolve = %v", len(chain), err)
		}
		msgs = append(msgs, err.Error())
	}
	if msgs[0] != msgs[1] {
		t.Fatalf("messages differ by chain order: %q vs %q", msgs[0], msgs[1])
	}
	// A longest-possible canonical code is still a code.
	long := strings.Repeat("x", (maxCodeLen-2)/3)
	if _, err := Words.Resolve(strings.Join([]string{long, long, long}, "-")); errors.Is(err, errDamagedAddress) {
		t.Fatal("a code-length token was reported as a damaged address")
	}
	// With whitespace it is several words, not one token.
	if _, err := Words.Resolve(strings.Repeat("a ", maxCodeLen)); !errors.Is(err, ErrUnrecognized) {
		t.Fatalf("spaced text: %v", err)
	}
}

func TestAddressesResolveWhitespaceAndCase(t *testing.T) {
	_, text, err := Addresses.NewHost(301)
	if err != nil {
		t.Fatal(err)
	}
	wrapped := "\n " + text[:50] + "\n" + text[50:100] + " \t" + text[100:] + "\r\n"
	addr, err := Addresses.Resolve(wrapped)
	if err != nil || string(addr) != text {
		t.Fatalf("wrapped: %q, %v", addr, err)
	}
	// Split across shell arguments and joined with spaces, via the chain.
	addr, _, err = resolve(text[:70]+" "+text[70:], DefaultAddressings)
	if err != nil || string(addr) != text {
		t.Fatalf("split: %q, %v", addr, err)
	}
	for _, in := range []string{strings.ToUpper(text), "TC" + text[2:], "Tc" + text[2:]} {
		_, _, err := resolve(in, DefaultAddressings)
		if err == nil || errors.Is(err, ErrUnrecognized) || !strings.Contains(err.Error(), `lowercase "tc"`) {
			t.Errorf("resolve(%.8q) = %v", in, err)
		}
	}
}

func TestAddressesResolveRejectsUnusableAddresses(t *testing.T) {
	pk := tailcat.NewPrivateKey()
	embedded := &tailcfg.DERPRegion{RegionID: 5, RegionCode: "tst", Nodes: []*tailcfg.DERPNode{{Name: "5a", HostName: "derp.example"}}}
	tests := []struct {
		name string
		ci   tailcat.ConnInfo
		want string // empty means accepted
	}{
		{"region id", tailcat.ConnInfo{ServerPublic: pk.Public.ServerPublic, ServerDiscoPublic: pk.Public.ServerDiscoPublic, RegionID: 301}, ""},
		{"embedded region", tailcat.ConnInfo{ServerPublic: pk.Public.ServerPublic, ServerDiscoPublic: pk.Public.ServerDiscoPublic, Region: []*tailcfg.DERPRegion{embedded}}, ""},
		{"no region", tailcat.ConnInfo{ServerPublic: pk.Public.ServerPublic, ServerDiscoPublic: pk.Public.ServerDiscoPublic}, "names no relay region"},
		{"no disco key", tailcat.ConnInfo{ServerPublic: pk.Public.ServerPublic, RegionID: 301}, "older tailcat"},
		{"no host key", tailcat.ConnInfo{ServerDiscoPublic: pk.Public.ServerDiscoPublic, RegionID: 301}, "names no host key"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, err := resolve(string(tt.ci.Addr()), DefaultAddressings)
			if tt.want == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || errors.Is(err, ErrUnrecognized) || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestJoinRegionID(t *testing.T) {
	r := func(id tailcfg.DERPRegionID) []*tailcfg.DERPRegion { return []*tailcfg.DERPRegion{{RegionID: id}} }
	for _, tt := range []struct {
		ci   tailcat.ConnInfo
		want tailcfg.DERPRegionID
	}{
		{tailcat.ConnInfo{RegionID: 302}, 302},
		{tailcat.ConnInfo{Region: r(7)}, 7},
		{tailcat.ConnInfo{RegionID: 302, Region: r(7)}, 302},
		{tailcat.ConnInfo{}, 0},
	} {
		if got := joinRegionID(&tt.ci); got != tt.want {
			t.Errorf("joinRegionID(%+v) = %d, want %d", tt.ci, got, tt.want)
		}
	}
	if got := fmt.Sprintf("DERP(%d)", joinRegionID(&tailcat.ConnInfo{Region: r(7)})); got != "DERP(7)" {
		t.Fatal(got)
	}
}

func TestWordsLeavesHyphenatedAddressesAlone(t *testing.T) {
	// base64url text with exactly two hyphens splits into three fields.
	for _, in := range []string{"tcAbc-dEf-gh1", "TCabc-def-ghi"} {
		if _, err := Words.Resolve(in); !errors.Is(err, ErrUnrecognized) {
			t.Errorf("Words.Resolve(%q) = %v, want ErrUnrecognized", in, err)
		}
	}
	for range 200 {
		_, text, err := Addresses.NewHost(301)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := Words.Resolve(text); !errors.Is(err, ErrUnrecognized) {
			t.Fatalf("Words.Resolve(%q) = %v, want ErrUnrecognized", text, err)
		}
	}
}
