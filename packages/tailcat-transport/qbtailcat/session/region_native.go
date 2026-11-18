//go:build !js

package session

import (
	"context"

	"tailscale.com/tailcfg"
)

// nearestRegion uses tailcat's own pick, which runs netcheck's STUN probes
// natively (RegionID -1 means "lowest latency").
func nearestRegion(ctx context.Context, derpMapURL string) (*tailcfg.DERPRegion, map[string]int64, error) {
	reg, err := expandRegion(ctx, -1, derpMapURL, true)
	return reg, nil, err
}
