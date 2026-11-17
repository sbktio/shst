package session

import (
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"errors"
	"fmt"
	"math/big"
	"slices"
	"strings"

	"github.com/tailscale/tailcat"
	"go4.org/mem"
	"golang.org/x/crypto/argon2"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

// A session code is three words from the EFF large wordlist. Everything a
// joiner needs to reach the host's tab is derived from those words, so the
// 160-character tailcat address never has to be shared:
//
//	words ──argon2id──► seed ──HKDF──► node key, WireGuard pre-shared key
//	words ──SHA-256───► relay region (one of the pinned regions)
//
// Entropy: log2(7772^3) ≈ 38.8 bits, less 2 because the host only accepts
// codes that map to its nearest of the four regions. The derived node key is
// the host's identity on the relay, so a guesser needs the words; argon2id
// makes deriving a candidate's key deliberately slow so they cannot cheaply
// enumerate the code space and probe the relay for live hosts.
//
// Anyone holding the code can also *be* the host (the keys are derived, not
// random). That is the same trust model as sharing the room link, and why the
// host generates the words: people must never choose them.

//go:embed words.txt
var wordsFile string

var (
	wordList  = loadWords()
	wordIndex = func() map[string]bool {
		m := make(map[string]bool, len(wordList))
		for _, w := range wordList {
			m[w] = true
		}
		return m
	}()
)

func loadWords() []string {
	var out []string
	for _, line := range strings.Split(wordsFile, "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "#") {
			out = append(out, line)
		}
	}
	return out
}

const codeWordCount = 3

// codeRegions pins which relay a code points at. Host and joiner must agree
// without talking, so this list cannot follow the live DERP map; changing it
// is a protocol version change.
var codeRegions = []tailcfg.DERPRegionID{301, 302, 303, 304}

// codeVersion is mixed into every derivation so a future scheme cannot
// collide with this one.
const codeVersion = "shst live session code v1"

// parseCode accepts words separated by spaces, hyphens, dots or commas, in
// any case, and returns them canonicalized.
func parseCode(s string) ([]string, error) {
	fields := strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return r == ' ' || r == '-' || r == '.' || r == ',' || r == '\t' || r == '\n' || r == '\r'
	})
	if len(fields) != codeWordCount {
		return nil, fmt.Errorf("a session code is %d words; got %d", codeWordCount, len(fields))
	}
	for _, w := range fields {
		if !wordIndex[w] {
			return nil, fmt.Errorf("%q is not a session code word; check the spelling", w)
		}
	}
	return fields, nil
}

func canonicalCode(words []string) string { return strings.Join(words, "-") }

func regionForCode(words []string) tailcfg.DERPRegionID {
	h := sha256.Sum256([]byte(codeVersion + " region\x00" + canonicalCode(words)))
	// len(codeRegions) divides 256, so this is uniform.
	return codeRegions[int(h[0])%len(codeRegions)]
}

func randomWord() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(int64(len(wordList))))
	if err != nil {
		return "", err
	}
	return wordList[n.Int64()], nil
}

// newCode returns fresh random words whose derived region is region. A
// quarter of codes match each region, so this needs about four tries.
func newCode(region tailcfg.DERPRegionID) ([]string, error) {
	if !slices.Contains(codeRegions, region) {
		region = codeRegions[0]
	}
	for range 1000 {
		words := make([]string, codeWordCount)
		for i := range words {
			w, err := randomWord()
			if err != nil {
				return nil, err
			}
			words[i] = w
		}
		if regionForCode(words) == region {
			return words, nil
		}
	}
	return nil, errors.New("could not generate a session code")
}

// Argon2id cost. Each derivation takes roughly a second in a browser's
// single-threaded wasm, paid once per host or join.
const (
	argonTime    = 2
	argonMemory  = 32 * 1024 // KiB
	argonThreads = 1
)

// keyForCode derives the host's tailcat identity from the code words.
func keyForCode(words []string) (*tailcat.PrivateKey, error) {
	seed := argon2.IDKey([]byte(canonicalCode(words)), []byte(codeVersion), argonTime, argonMemory, argonThreads, 32)
	nodeRaw, err := hkdf.Key(sha256.New, seed, nil, codeVersion+" node key", 32)
	if err != nil {
		return nil, err
	}
	pskRaw, err := hkdf.Key(sha256.New, seed, nil, codeVersion+" preshared key", 32)
	if err != nil {
		return nil, err
	}
	// Clamp as a Curve25519 private scalar, as key.NewNode does.
	nodeRaw[0] &= 248
	nodeRaw[31] &= 127
	nodeRaw[31] |= 64
	priv := key.NodePrivateFromRaw32(mem.B(nodeRaw))
	pk := &tailcat.PrivateKey{Private: priv}
	pk.Public.ServerPublic = tailcat.NodePublic{NodePublic: priv.Public()}
	pk.Public.ServerDiscoPublic = tailcat.DiscoPublicForNode(priv)
	copy(pk.Public.PresharedKey[:], pskRaw)
	if pk.Public.PresharedKey.IsZero() {
		return nil, errors.New("derived an empty pre-shared key")
	}
	pk.Public.RegionID = regionForCode(words)
	return pk, nil
}
