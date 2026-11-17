package session

import (
	"context"
	"errors"
	"reflect"
	"time"
	"unsafe"

	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
)

var errDrainUnsupported = errors.New("cannot read the connection's TCP state")

// Drain waits until the peer has acknowledged everything sent on c,
// including the FIN, or until ctx is done.
//
// The whole TCP stack runs in this process, so Write, CloseWrite and Close
// return once bytes are queued, not delivered. A process that exits right
// after the session ends can drop the tail of the stream. Call Drain after
// CloseWrite and the peer's EOF, then Close: closing a joined Conn also
// stops its Tailcat client, and with it any segment still queued. Bound ctx
// with a timeout in case the peer is gone.
//
// Tailcat's Server.DrainTCP waits for every connection in the server's stack
// to reach CLOSED, which blocks on TIME-WAIT when this side closed first.
// This per-connection reflection mirrors Tailcat's unexported
// gonetTCPConnInternals; an exported per-connection drain in the sbktio/tailcat
// fork would replace it. Non-gonet connections return nil: there is no
// in-process TCP stack for this wrapper to drain.
func (c *Conn) Drain(ctx context.Context) error {
	st, ok := tcpState(c.Conn)
	if !ok {
		if _, isGonet := c.Conn.(*gonet.TCPConn); isGonet {
			return errDrainUnsupported
		}
		return nil
	}
	t := time.NewTicker(2 * time.Millisecond)
	defer t.Stop()
	for {
		switch tcp.EndpointState(st.State()) {
		case tcp.StateError:
			return errors.New("the connection failed before the peer acknowledged everything")
		case tcp.StateSynSent, tcp.StateSynRecv, tcp.StateEstablished,
			tcp.StateFinWait1, tcp.StateClosing, tcp.StateCloseWait, tcp.StateLastAck:
		default:
			// FIN-WAIT-2, CLOSED or TIME-WAIT: our FIN was acknowledged. The final ACK
			// we owe the peer leaves asynchronously; give it a moment.
			select {
			case <-time.After(50 * time.Millisecond):
			case <-ctx.Done():
				return ctx.Err()
			}
			return nil
		}
		select {
		case <-t.C:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func tcpState(c any) (interface{ State() uint32 }, bool) {
	g, ok := c.(*gonet.TCPConn)
	if !ok || g == nil {
		return nil, false
	}
	ep := reflect.ValueOf(g).Elem().FieldByName("ep")
	if !ep.IsValid() || (ep.Kind() != reflect.Interface && ep.Kind() != reflect.Pointer) || ep.IsNil() {
		return nil, false
	}
	st, ok := reflect.NewAt(ep.Type(), unsafe.Pointer(ep.UnsafeAddr())).Elem().Interface().(interface{ State() uint32 })
	return st, ok
}
