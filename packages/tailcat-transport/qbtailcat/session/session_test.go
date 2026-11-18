package session

import (
	"context"
	"net"
	"testing"
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
