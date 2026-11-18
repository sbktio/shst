//go:build js && wasm

package session

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"tailscale.com/tailcfg"
)

// nearestRegion picks the code's relay region for a browser host.
//
// tailcat's js build cannot run netcheck's STUN probes and picks an arbitrary
// region (PickBestRegion is a stub), which in testing put a US host in Tokyo
// or Frankfurt and multiplied every round trip. Since the code pins the region
// for the whole session, measure instead: time three HTTPS round trips to each
// region's relay and keep the fastest. no-cors keeps the probe from needing
// CORS headers; the opaque response still resolves after a full round trip.
func nearestRegion(ctx context.Context, derpMapURL string) (*tailcfg.DERPRegion, map[string]int64, error) {
	type result struct {
		region *tailcfg.DERPRegion
		best   time.Duration
	}
	results := make(chan result, len(codeRegions))
	for _, id := range codeRegions {
		go func() {
			reg, err := expandRegion(ctx, id, derpMapURL, true)
			if err != nil || len(reg.Nodes) == 0 {
				results <- result{}
				return
			}
			var best time.Duration
			for i := range 3 {
				d, err := probeRelay(ctx, reg.Nodes[0].HostName, i)
				if err == nil && (best == 0 || d < best) {
					best = d
				}
			}
			results <- result{reg, best}
		}()
	}
	probes := map[string]int64{}
	var pick result
	for range codeRegions {
		r := <-results
		if r.region == nil || r.best == 0 {
			continue
		}
		probes[r.region.RegionCode] = r.best.Milliseconds()
		if pick.region == nil || r.best < pick.best {
			pick = r
		}
	}
	if pick.region == nil {
		reg, err := expandRegion(ctx, -1, derpMapURL, true)
		return reg, probes, err
	}
	return pick.region, probes, nil
}

func probeRelay(ctx context.Context, host string, attempt int) (time.Duration, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	url := fmt.Sprintf("https://%s/derp/latency-check?probe=%d-%d", host, time.Now().UnixNano(), attempt)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("js.fetch:mode", "no-cors")
	t := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return time.Since(t), nil
}
