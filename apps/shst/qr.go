package main

import (
	"strings"

	"rsc.io/qr"
)

// qrQuietZone is the width of the blank border around a QR code, in modules.
// The QR specification requires four.
const qrQuietZone = 4

// Every row is drawn in explicit colours, black on bright white, so the code
// looks the same on a dark or a light terminal theme. Dark modules are the
// foreground and light modules and the quiet zone are the background.
const (
	qrStart = "\x1b[30;107m"
	qrReset = "\x1b[0m"
)

// renderQR draws text as a QR code made of Unicode half blocks. Each output
// character covers two vertically stacked modules, so the code is
// size+2*qrQuietZone columns wide and ceil((size+2*qrQuietZone)/2) rows tall.
// A row starts with qrStart, ends with qrReset and then a newline. In a row,
// '█' means both modules are dark, '▀' the top one, '▄' the bottom one and
// ' ' neither.
//
// The error correction level is L, which keeps the code small enough to fit
// a terminal even for a ~154 character Tailcat address.
func renderQR(text string) (string, error) {
	code, err := qr.Encode(text, qr.L)
	if err != nil {
		return "", err
	}
	n := code.Size + 2*qrQuietZone
	dark := func(x, y int) bool { // x and y include the quiet zone
		x, y = x-qrQuietZone, y-qrQuietZone
		if x < 0 || y < 0 || x >= code.Size || y >= code.Size {
			return false
		}
		return code.Black(x, y)
	}
	var b strings.Builder
	for y := 0; y < n; y += 2 {
		b.WriteString(qrStart)
		for x := 0; x < n; x++ {
			top, bottom := dark(x, y), dark(x, y+1)
			switch {
			case top && bottom:
				b.WriteRune('█')
			case top:
				b.WriteRune('▀')
			case bottom:
				b.WriteRune('▄')
			default:
				b.WriteRune(' ')
			}
		}
		b.WriteString(qrReset)
		b.WriteByte('\n')
	}
	return b.String(), nil
}
