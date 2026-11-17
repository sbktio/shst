// Command wasmtags prints the build tags that trim Tailscale features the
// browser build does not use, mirroring tailcat's internal/buildtags.WasmTags.
package main

import (
	"fmt"
	"slices"
	"strings"

	"tailscale.com/feature/featuretags"
)

func main() {
	keep := map[featuretags.FeatureTag]bool{}
	for dep := range featuretags.Requires("netstack") {
		keep[dep] = true
	}
	var tags []string
	for ft := range featuretags.Features {
		if ft == "" || !ft.IsOmittable() || keep[ft] {
			continue
		}
		tags = append(tags, ft.OmitTag())
	}
	slices.Sort(tags)
	fmt.Print(strings.Join(tags, ","))
}
