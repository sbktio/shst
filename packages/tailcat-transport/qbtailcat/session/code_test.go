package session

import (
	"strings"
	"testing"
)

func TestParseCodeAcceptsSeparatorsAndCase(t *testing.T) {
	want := "abacus-abdomen-zoom"
	for _, in := range []string{"abacus-abdomen-zoom", "Abacus Abdomen ZOOM", " abacus.abdomen,zoom\n"} {
		words, err := parseCode(in)
		if err != nil {
			t.Fatalf("parseCode(%q): %v", in, err)
		}
		if got := canonicalCode(words); got != want {
			t.Fatalf("parseCode(%q) = %q, want %q", in, got, want)
		}
	}
	for _, bad := range []string{"abacus abdomen", "abacus abdomen zoom zoom", "abacus abdomen qwertyuiop"} {
		if _, err := parseCode(bad); err == nil {
			t.Fatalf("parseCode(%q) accepted a bad code", bad)
		}
	}
}

func TestWordListHasNoSeparators(t *testing.T) {
	if len(wordList) != 7772 {
		t.Fatalf("word list has %d words, want 7772", len(wordList))
	}
	for _, w := range wordList {
		if strings.ContainsAny(w, " -.,") {
			t.Fatalf("word %q contains a separator", w)
		}
	}
}

func TestKeyForCodeIsDeterministicAndSpecific(t *testing.T) {
	a, err := keyForCode([]string{"abacus", "abdomen", "zoom"})
	if err != nil {
		t.Fatal(err)
	}
	again, _ := keyForCode([]string{"abacus", "abdomen", "zoom"})
	other, _ := keyForCode([]string{"abacus", "abdomen", "zone"})
	if a.Public.Addr() != again.Public.Addr() {
		t.Fatal("the same code derived different addresses")
	}
	if a.Public.Addr() == other.Public.Addr() || a.Public.PresharedKey.Equal(other.Public.PresharedKey) {
		t.Fatal("different codes derived the same identity")
	}
	if a.Public.ServerPublic.NodePublic != a.Private.Public() {
		t.Fatal("public key does not match the derived private key")
	}
	t.Logf("3-word code expands to a %d-character tailcat address", len(a.Public.Addr()))
}

func TestNewCodeMatchesRequestedRegion(t *testing.T) {
	for _, region := range codeRegions {
		words, err := newCode(region)
		if err != nil {
			t.Fatal(err)
		}
		if got := regionForCode(words); got != region {
			t.Fatalf("newCode(%v) = %v mapping to %v", region, words, got)
		}
	}
}

// The resolve chain treats text starting with "tc" as a Tailcat address, so no
// code word may start with it.
func TestNoWordStartsWithTC(t *testing.T) {
	for _, w := range wordList {
		if strings.HasPrefix(strings.ToLower(w), "tc") {
			t.Fatalf("word %q starts with \"tc\"", w)
		}
	}
}

func TestMaxCodeLen(t *testing.T) {
	longest := 0
	for _, w := range wordList {
		longest = max(longest, len(w))
	}
	if want := 3*longest + 2; maxCodeLen != want {
		t.Fatalf("maxCodeLen = %d, want %d", maxCodeLen, want)
	}
}
