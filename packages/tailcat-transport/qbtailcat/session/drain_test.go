package session

import (
	"context"
	"errors"
	"io"
	"net"
	"testing"
	"time"

	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/link/loopback"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
)

func tcpPair(t *testing.T) (*gonet.TCPConn, *gonet.TCPConn) {
	t.Helper()
	s := stack.New(stack.Options{
		NetworkProtocols:   []stack.NetworkProtocolFactory{ipv4.NewProtocol},
		TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol},
	})
	t.Cleanup(s.Destroy)
	const nic = 1
	if err := s.CreateNIC(nic, loopback.New()); err != nil {
		t.Fatal(err)
	}
	addr := tcpip.AddrFrom4([4]byte{127, 0, 0, 1})
	if err := s.AddProtocolAddress(nic, tcpip.ProtocolAddress{
		Protocol:          ipv4.ProtocolNumber,
		AddressWithPrefix: tcpip.AddressWithPrefix{Address: addr, PrefixLen: 8},
	}, stack.AddressProperties{}); err != nil {
		t.Fatal(err)
	}
	s.SetRouteTable([]tcpip.Route{{Destination: header.IPv4EmptySubnet, NIC: nic}})
	ln, err := gonet.ListenTCP(s, tcpip.FullAddress{NIC: nic, Addr: addr}, ipv4.ProtocolNumber)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(ln.Shutdown)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	client, err := gonet.DialContextTCP(ctx, s, tcpip.FullAddress{
		NIC: nic, Addr: addr, Port: uint16(ln.Addr().(*net.TCPAddr).Port),
	}, ipv4.ProtocolNumber)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	stop := context.AfterFunc(ctx, ln.Shutdown)
	defer stop()
	accepted, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	server := accepted.(*gonet.TCPConn)
	t.Cleanup(func() { server.Close() })
	for _, c := range []*gonet.TCPConn{client, server} {
		if err := c.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	return client, server
}

func drainConn(t *testing.T, c net.Conn) *Conn {
	t.Helper()
	sc := newConn(c, Path{})
	t.Cleanup(func() { sc.Close() })
	return sc
}

func TestTCPStateGonet(t *testing.T) {
	client, _ := tcpPair(t)
	st, ok := tcpState(client)
	if !ok {
		t.Fatal("tcpState cannot read gonet.TCPConn.ep; did gVisor change its internals?")
	}
	if got := tcp.EndpointState(st.State()); got != tcp.StateEstablished {
		t.Fatalf("TCP state = %v, want ESTABLISHED", got)
	}
}

func TestDrainAfterCloseWrite(t *testing.T) {
	client, peer := tcpPair(t)
	c := drainConn(t, client)
	const payload = "the tail of the stream"
	if _, err := io.WriteString(c, payload); err != nil {
		t.Fatal(err)
	}
	if err := c.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(peer)
	if err != nil || string(data) != payload {
		t.Fatalf("peer read = %q, %v; want %q and EOF", data, err, payload)
	}
	if err := peer.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(io.Discard, c); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if err := c.Drain(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestDrainFinWait2(t *testing.T) {
	client, peer := tcpPair(t)
	c := drainConn(t, client)
	if err := c.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(io.Discard, peer); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if err := c.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	st, ok := tcpState(client)
	if !ok || tcp.EndpointState(st.State()) != tcp.StateFinWait2 {
		t.Fatal("Drain did not finish in FIN-WAIT-2 while the peer remained open")
	}
	cancelled, cancelNow := context.WithCancel(t.Context())
	cancelNow()
	if err := c.Drain(cancelled); !errors.Is(err, context.Canceled) {
		t.Fatalf("Drain during grace = %v, want context.Canceled", err)
	}
}

func TestDrainNonGonet(t *testing.T) {
	local, peer := net.Pipe()
	defer peer.Close()
	if err := drainConn(t, local).Drain(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestDrainHonoursContext(t *testing.T) {
	client, _ := tcpPair(t)
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	if err := drainConn(t, client).Drain(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Drain = %v, want context.DeadlineExceeded", err)
	}
}

func TestDrainUnreadableGonetState(t *testing.T) {
	c := newConn(new(gonet.TCPConn), Path{})
	t.Cleanup(c.cancel)
	if err := c.Drain(t.Context()); !errors.Is(err, errDrainUnsupported) {
		t.Fatalf("Drain = %v, want errDrainUnsupported", err)
	}
}

func TestDrainFailedConnection(t *testing.T) {
	client, _ := tcpPair(t)
	c := drainConn(t, client)
	st, ok := tcpState(client)
	if !ok {
		t.Fatal("cannot read TCP state")
	}
	st.(*tcp.Endpoint).Abort()
	if got := tcp.EndpointState(st.State()); got != tcp.StateError {
		t.Fatalf("TCP state after Abort = %v, want ERROR", got)
	}
	if err := c.Drain(t.Context()); err == nil || err.Error() != "the connection failed before the peer acknowledged everything" {
		t.Fatalf("Drain = %v, want connection failure", err)
	}
}
