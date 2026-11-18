package session

import (
	"context"
	"net"
	"testing"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
)

type closeHookConn struct {
	net.Conn
	closeHook func()
}

func (c closeHookConn) Close() error {
	c.closeHook()
	return c.Conn.Close()
}

func TestConnCloseCancelsLifetimeFirst(t *testing.T) {
	local, peer := net.Pipe()
	defer peer.Close()
	var c *Conn
	underlyingClosed := false
	c = newConn(closeHookConn{Conn: local, closeHook: func() {
		if c.ctx.Err() != context.Canceled {
			t.Error("underlying Close ran before lifetime cancellation")
		}
		underlyingClosed = true
	}}, Path{})
	callbacks := 0
	c.onClose = func() {
		if c.ctx.Err() != context.Canceled || !underlyingClosed {
			t.Error("onClose ran before lifetime cancellation or underlying Close")
		}
		callbacks++
	}
	for range 2 {
		if err := c.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if callbacks != 1 {
		t.Fatalf("onClose called %d times, want 1", callbacks)
	}
}

func TestStartHostRequiresOnConn(t *testing.T) {
	_, err := StartHost(t.Context(), HostOptions{Port: 22})
	if err == nil || err.Error() != "OnConn is required" {
		t.Fatalf("StartHost without OnConn = %v, want OnConn is required", err)
	}
}

func TestExpandRegionEmptyIsAnError(t *testing.T) {
	// RegionID 0 with nothing embedded expands to no region, without network.
	if r, err := expandRegion(context.Background(), 0, "", true); err == nil {
		t.Fatalf("expandRegion(0) = %v, want an error", r)
	}
}

func TestHostRegionUsesEmbeddedRegion(t *testing.T) {
	embedded := &tailcfg.DERPRegion{RegionID: 9, RegionCode: "tst", Nodes: []*tailcfg.DERPNode{{Name: "9a", HostName: "derp.example"}}}
	got, err := hostRegion(context.Background(), &tailcat.ConnInfo{Region: []*tailcfg.DERPRegion{embedded}}, "")
	if err != nil || got != embedded {
		t.Fatalf("hostRegion = %v, %v", got, err)
	}
	if _, err := hostRegion(context.Background(), &tailcat.ConnInfo{}, ""); err == nil {
		t.Fatal("a key naming no region was accepted")
	}
}
