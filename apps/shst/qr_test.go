package main

import (
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"

	"rsc.io/qr"
)

var ansiRE = regexp.MustCompile("\x1b\\[[0-9;]*m")

// qrRows splits renderQR output into rows, checking and removing the colour
// escapes that wrap each one.
func qrRows(t *testing.T, out string) []string {
	t.Helper()
	var rows []string
	for _, l := range strings.Split(strings.TrimSuffix(out, "\n"), "\n") {
		if !strings.HasPrefix(l, "\x1b[30;107m") || !strings.HasSuffix(l, "\x1b[0m") {
			t.Fatalf("row is not wrapped in black on bright white: %q", l)
		}
		inner := strings.TrimSuffix(strings.TrimPrefix(l, "\x1b[30;107m"), "\x1b[0m")
		if ansiRE.MatchString(inner) {
			t.Fatalf("unexpected escape inside a row: %q", l)
		}
		rows = append(rows, inner)
	}
	return rows
}

func TestRenderQRDimensions(t *testing.T) {
	if qrQuietZone != 4 {
		t.Fatalf("qrQuietZone = %d, the specification requires 4", qrQuietZone)
	}
	for _, text := range []string{"amber-tiger-lunar", strings.Repeat("tc", 77)} {
		code, err := qr.Encode(text, qr.L)
		if err != nil {
			t.Fatal(err)
		}
		out, err := renderQR(text)
		if err != nil {
			t.Fatal(err)
		}
		again, _ := renderQR(text)
		if out != again {
			t.Errorf("%q: output is not deterministic", text)
		}
		wantCols := code.Size + 2*qrQuietZone
		wantRows := (wantCols + 1) / 2
		lines := qrRows(t, out)
		if len(lines) != wantRows {
			t.Errorf("%q: %d rows, want %d", text, len(lines), wantRows)
		}
		for i, l := range lines {
			if n := utf8.RuneCountInString(l); n != wantCols {
				t.Errorf("%q: row %d has %d columns, want %d", text, i, n, wantCols)
			}
		}
	}
}

func TestRenderQRDecodesBack(t *testing.T) {
	// Redraw the matrix from the output and compare it to the encoder's.
	for _, text := range []string{"amber-tiger-lunar", strings.Repeat("tc", 77)} {
		code, _ := qr.Encode(text, qr.L)
		out, _ := renderQR(text)
		lines := qrRows(t, out)
		for y := 0; y < code.Size; y++ {
			row := []rune(lines[(y+qrQuietZone)/2])
			for x := 0; x < code.Size; x++ {
				r := row[x+qrQuietZone]
				top := r == '█' || r == '▀' // dark upper half
				bottom := r == '█' || r == '▄'
				got := top
				if (y+qrQuietZone)%2 == 1 {
					got = bottom
				}
				if got != code.Black(x, y) {
					t.Fatalf("%q: module (%d,%d): drawn dark=%v, encoder says %v", text, x, y, got, code.Black(x, y))
				}
			}
		}
	}
}

func TestRenderQRQuietZone(t *testing.T) {
	// Every module within qrQuietZone of the edge is light, which is a space.
	for _, text := range []string{"amber-tiger-lunar", strings.Repeat("tc", 77)} {
		code, _ := qr.Encode(text, qr.L)
		out, _ := renderQR(text)
		lines := qrRows(t, out)
		cols := code.Size + 2*qrQuietZone
		// Rows 0 .. qrQuietZone/2-1 hold only quiet zone modules.
		for i := 0; i < qrQuietZone/2; i++ {
			if strings.Trim(lines[i], " ") != "" {
				t.Errorf("%q: row %d should be blank: %q", text, i, lines[i])
			}
		}
		// The last quiet zone rows, whatever the parity of the size.
		for i := (qrQuietZone + code.Size + 1) / 2; i < len(lines); i++ {
			if strings.Trim(lines[i], " ") != "" {
				t.Errorf("%q: row %d should be blank: %q", text, i, lines[i])
			}
		}
		for i, l := range lines {
			r := []rune(l)
			edge := append(append([]rune{}, r[:qrQuietZone]...), r[cols-qrQuietZone:]...)
			if strings.Trim(string(edge), " ") != "" {
				t.Errorf("%q: row %d has dark modules in the side quiet zone: %q", text, i, l)
			}
		}
	}
}
