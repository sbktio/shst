package session

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
	"tailscale.com/types/logger"
)

// Relay policy
//
// DERP plays two roles for tailcat: a rendezvous (the "meow" handshake and
// disco path discovery) and a fallback data relay that carries WireGuard
// packets when no direct UDP path exists. Tailscale's magicsock has no switch
// that forbids the second role while keeping the first (its knobs are
// TS_DEBUG_ALWAYS_USE_DERP and TS_DEBUG_NEVER_DIRECT_UDP), so with relay denied
// this wrapper enforces it at the session boundary instead:
//
//   - the joiner keeps disco-pinging until a pong arrives on a direct
//     endpoint, and refuses to open the session if none does in time;
//   - the host refuses a session whose peer is not on a direct path;
//   - both re-check periodically and close the session if the path falls
//     back to DERP.
//
// WireGuard handshakes and disco still traverse DERP; no application byte is
// sent until both sides see a direct path, and the session is torn down if the
// path stops being direct.

// Path describes how a peer is reached.
type Path struct {
	Direct bool   `json:"direct"`
	Via    string `json:"via"`
}

// ErrNoDirectPath is returned by Join when relay is denied and no direct
// path to the host appears in time.
var ErrNoDirectPath = errors.New("no direct path to the host; relayed traffic is disabled for this session")

func orDiscard(logf logger.Logf) logger.Logf {
	if logf == nil {
		return logger.Discard
	}
	return logf
}

const pathCheckInterval = 3 * time.Second

// HostOptions configures StartHost.
type HostOptions struct {
	DERPMapURL string
	AllowRelay bool
	// Port is the virtual Tailcat port the host answers on (1-65535).
	Port uint16
	Logf logger.Logf
	// MaxSessions limits concurrent sessions, including those awaiting relay-policy
	// admission. Zero means unlimited. Excess connections are rejected with a TCP RST.
	MaxSessions int
	// OnConn is required and receives each admitted session. It owns conn.
	OnConn func(conn *Conn)
	// OnRefused reports a session refused by the relay policy.
	OnRefused func(path Path)
	// Addressing decides how joiners reach the host. Nil means Words.
	Addressing Addressing
}

// Host is a Tailcat server reachable with Code, accepting sessions up to
// HostOptions.MaxSessions.
type Host struct {
	// Code is the text a joiner needs, in the host's addressing.
	Code string
	// Addressing is the name of the host's addressing.
	Addressing string
	Addr       tailcat.Addr
	RegionID   tailcfg.DERPRegionID
	Region     string
	// RegionProbes is the measured round trip per region, in ms, when the
	// wrapper picked the region itself (browser builds).
	RegionProbes map[string]int64
	srv          *tailcat.Server
}

// Conn is a session's byte stream plus the path it was admitted on.
// Close is idempotent, cancels any path monitor without waiting for it, and
// releases the Tailcat client when the Conn owns one (sessions made by Join).
type Conn struct {
	net.Conn
	path     Path
	pathMu   sync.Mutex
	ctx      context.Context
	cancel   context.CancelFunc
	once     sync.Once
	closeErr error
	reason   string
	onClose  func()
}

func newConn(c net.Conn, p Path) *Conn {
	ctx, cancel := context.WithCancel(context.Background())
	return &Conn{Conn: c, path: p, ctx: ctx, cancel: cancel}
}

// Path reports the most recently observed path to the peer.
func (c *Conn) Path() Path {
	c.pathMu.Lock()
	defer c.pathMu.Unlock()
	return c.path
}

func (c *Conn) setPath(p Path) {
	c.pathMu.Lock()
	c.path = p
	c.pathMu.Unlock()
}

func (c *Conn) closeWithReason(reason string) error {
	c.once.Do(func() {
		// Waiting for the monitor could deadlock a browser JS callback:
		// disco work needs the JS event loop to keep running.
		c.cancel()
		c.pathMu.Lock()
		c.reason = reason
		c.pathMu.Unlock()
		c.closeErr = c.Conn.Close()
		if c.onClose != nil {
			c.onClose()
		}
	})
	return c.closeErr
}

// Close closes the session and, for a joined session, its Tailcat client.
func (c *Conn) Close() error { return c.closeWithReason("") }

// CloseWrite half-closes the session if the underlying conn supports it.
func (c *Conn) CloseWrite() error {
	cw, ok := c.Conn.(interface{ CloseWrite() error })
	if !ok {
		return errors.New("connection does not support half-close")
	}
	return cw.CloseWrite()
}

// Reason says why the wrapper closed the session, or "" if it did not.
func (c *Conn) Reason() string {
	c.pathMu.Lock()
	defer c.pathMu.Unlock()
	return c.reason
}

// monitor calls check every pathCheckInterval until the session closes,
// keeping Path current. When enforce is set (relay denied) it closes the
// session after two consecutive relayed observations.
func (c *Conn) monitor(check func() (Path, error), enforce bool) {
	go func() {
		relayed := 0
		t := time.NewTicker(pathCheckInterval)
		defer t.Stop()
		for {
			select {
			case <-c.ctx.Done():
				return
			case <-t.C:
			}
			p, err := check()
			if err != nil {
				continue
			}
			c.setPath(p)
			if p.Direct || !enforce {
				relayed = 0
				continue
			}
			if relayed++; relayed >= 2 {
				c.closeWithReason("the direct path was lost and relayed traffic is disabled")
				return
			}
		}
	}()
}

func expandRegion(ctx context.Context, regionID tailcfg.DERPRegionID, derpMapURL string, forServer bool) (*tailcfg.DERPRegion, error) {
	ci := &tailcat.ConnInfo{RegionID: regionID}
	var opts []any
	if forServer {
		opts = append(opts, tailcat.ExpandForServer)
	}
	if derpMapURL != "" {
		opts = append(opts, tailcat.DERPMapURL(derpMapURL))
	}
	if err := ci.Expand(ctx, opts...); err != nil {
		return nil, err
	}
	if len(ci.Region) == 0 {
		return nil, errors.New("the address names no relay region")
	}
	return ci.Region[0], nil
}

// hostRegion returns the relay region a host with key info pub serves. An
// addressing may embed the region instead of naming a RegionID; that needs no
// network. Otherwise the region is looked up in the DERP map.
func hostRegion(ctx context.Context, pub *tailcat.ConnInfo, derpMapURL string) (*tailcfg.DERPRegion, error) {
	if pub.RegionID == 0 && len(pub.Region) > 0 {
		ci := &tailcat.ConnInfo{Region: pub.Region}
		// With an embedded region Expand only normalizes IDs; it does not fetch.
		if err := ci.Expand(ctx); err != nil {
			return nil, err
		}
		return ci.Region[0], nil
	}
	return expandRegion(ctx, pub.RegionID, derpMapURL, true)
}

// joinRegionID is the relay region an address names: its RegionID, or the
// embedded region's when RegionID is 0 (addresses from "tailcat resolve").
func joinRegionID(ci *tailcat.ConnInfo) tailcfg.DERPRegionID {
	if ci.RegionID == 0 && len(ci.Region) > 0 {
		return ci.Region[0].RegionID
	}
	return ci.RegionID
}

// StartHost starts a Tailcat server on a fresh session code and admits
// sessions on opts.Port according to the relay policy and session limit.
// ctx bounds startup only; use Close to stop the host.
func StartHost(ctx context.Context, opts HostOptions) (*Host, error) {
	if opts.OnConn == nil {
		return nil, errors.New("OnConn is required")
	}
	if opts.Port == 0 {
		return nil, errors.New("port must be 1-65535")
	}
	logf := orDiscard(opts.Logf)
	nearest, probes, err := nearestRegion(ctx, opts.DERPMapURL)
	if err != nil {
		return nil, fmt.Errorf("finding the nearest relay: %w", err)
	}
	addressing := opts.Addressing
	if addressing == nil {
		addressing = Words
	}
	pk, code, err := addressing.NewHost(nearest.RegionID)
	if err != nil {
		return nil, err
	}
	region, err := hostRegion(ctx, &pk.Public, opts.DERPMapURL)
	if err != nil {
		return nil, fmt.Errorf("loading relay region %v: %w", pk.Public.RegionID, err)
	}
	h := &Host{
		Code:         code,
		Addressing:   addressing.Name(),
		Addr:         pk.Public.Addr(),
		RegionID:     region.RegionID,
		Region:       region.RegionCode,
		RegionProbes: probes,
	}
	var sessions atomic.Int64
	release := func() {
		if opts.MaxSessions > 0 {
			sessions.Add(-1)
		}
	}
	h.srv = &tailcat.Server{
		Key:          pk.Private,
		PresharedKey: pk.Public.PresharedKey,
		Region:       region,
		Logf:         logf,
		OnTCP: func(port uint16) func(net.Conn) {
			if port != opts.Port {
				return nil // RST
			}
			if opts.MaxSessions > 0 && sessions.Add(1) > int64(opts.MaxSessions) {
				sessions.Add(-1)
				return nil // RST, before accepting a stream.
			}
			return func(c net.Conn) { h.admit(c, opts, release) }
		},
	}
	if err := h.srv.StartContext(ctx); err != nil {
		h.srv.Close()
		return nil, err
	}
	return h, nil
}

// peerPath reports the server's current path to the peer at remote.
func (h *Host) peerPath(remote net.Addr) (Path, error) {
	k, ok := h.srv.PeerKey(remote)
	if !ok {
		return Path{}, fmt.Errorf("no peer at %v", remote)
	}
	ps, ok := h.srv.Status().Peer[k]
	if !ok {
		return Path{}, fmt.Errorf("no peer status for %v", remote)
	}
	if ps.CurAddr != "" {
		return Path{Direct: true, Via: ps.CurAddr}, nil
	}
	return Path{Via: "DERP(" + cmp.Or(ps.Relay, "?") + ")"}, nil
}

func (h *Host) admit(c net.Conn, opts HostOptions, onClose func()) {
	path, _ := h.peerPath(c.RemoteAddr())
	if !opts.AllowRelay {
		// The joiner only dials after its own side sees a direct path; give
		// ours a moment to converge before refusing.
		for deadline := time.Now().Add(3 * time.Second); !path.Direct && time.Now().Before(deadline); {
			time.Sleep(100 * time.Millisecond)
			path, _ = h.peerPath(c.RemoteAddr())
		}
		if !path.Direct {
			c.Close()
			onClose()
			if opts.OnRefused != nil {
				opts.OnRefused(path)
			}
			return
		}
	}
	sc := newConn(c, path)
	sc.onClose = onClose
	remote := c.RemoteAddr()
	sc.monitor(func() (Path, error) { return h.peerPath(remote) }, !opts.AllowRelay)
	opts.OnConn(sc)
}

// Close stops the host.
func (h *Host) Close() { h.srv.Close() }

// JoinOptions configures Join.
type JoinOptions struct {
	DERPMapURL    string
	AllowRelay    bool
	Port          uint16
	DirectTimeout time.Duration
	Logf          logger.Logf
	// Addressings are tried in order to understand the text given to Join.
	// Nil means DefaultAddressings.
	Addressings []Addressing
}

// JoinTimings breaks down where joining spends its time.
type JoinTimings struct {
	DeriveMs  int64 `json:"deriveMs"`
	ReachMs   int64 `json:"reachMs"`
	PathMs    int64 `json:"pathMs"`
	DialMs    int64 `json:"dialMs"`
	Attempts  int   `json:"pathProbes"`
	RegionID  int   `json:"regionId"`
	FirstPath Path  `json:"firstPath"`
}

func discoPath(ctx context.Context, cl *tailcat.Client) (Path, error) {
	res, err := cl.DiscoPing(ctx)
	if err != nil {
		return Path{}, err
	}
	if res.Endpoint != "" {
		return Path{Direct: true, Via: res.Endpoint}, nil
	}
	return Path{Via: "DERP(" + cmp.Or(res.DERPRegionCode, res.DERPRegionID.String()) + ")"}, nil
}

// Join dials the host that code names, a word code or a Tailcat address
// (see JoinOptions.Addressings), and returns the session. The returned
// Conn owns the Tailcat client created here; closing the Conn closes both.
// ctx bounds setup only; cancelling it after Join returns does not stop the
// session or its path monitor.
func Join(ctx context.Context, code string, opts JoinOptions) (*Conn, JoinTimings, error) {
	var tm JoinTimings
	if opts.Port == 0 {
		return nil, tm, errors.New("port must be 1-65535")
	}
	addressings := opts.Addressings
	if addressings == nil {
		addressings = DefaultAddressings
	}
	t0 := time.Now()
	addr, _, err := resolve(code, addressings)
	if err != nil {
		return nil, tm, err
	}
	tm.DeriveMs = time.Since(t0).Milliseconds()
	ci, err := tailcat.ParseAddr(addr)
	if err != nil {
		return nil, tm, err
	}
	tm.RegionID = int(joinRegionID(&ci))
	cl := &tailcat.Client{
		Server:     addr,
		Logf:       orDiscard(opts.Logf),
		DERPMapURL: opts.DERPMapURL,
	}
	fail := func(err error) (*Conn, JoinTimings, error) {
		cl.Close()
		return nil, tm, err
	}

	// Reach the host over the relay's rendezvous. A wrong or expired code
	// derives a key nobody is listening on, so this is where it fails.
	t1 := time.Now()
	reachCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	for {
		pctx, pcancel := context.WithTimeout(reachCtx, 5*time.Second)
		_, err := cl.Ping(pctx)
		pcancel()
		if ctx.Err() != nil {
			return fail(ctx.Err())
		}
		if err == nil {
			break
		}
		if reachCtx.Err() != nil {
			return fail(errors.New("no live session is using that code"))
		}
	}
	tm.ReachMs = time.Since(t1).Milliseconds()

	// Path discovery. Disco pings ride DERP and nudge NAT traversal; with
	// relay denied we wait for a pong from a direct endpoint. With relay
	// allowed, nothing waits: the monitor reports the path once it settles.
	// (In a browser a disco pong never arrives at all, so blocking here cost
	// a full probe timeout on every join.)
	t2 := time.Now()
	path := Path{Via: fmt.Sprintf("DERP(%d)", joinRegionID(&ci))}
	deadline := time.Now().Add(cmp.Or(opts.DirectTimeout, 15*time.Second))
	for !opts.AllowRelay {
		tm.Attempts++
		pctx, pcancel := context.WithTimeout(ctx, 5*time.Second)
		p, err := discoPath(pctx, cl)
		pcancel()
		if ctx.Err() != nil {
			return fail(ctx.Err())
		}
		if err == nil {
			path = p
			if tm.Attempts == 1 {
				tm.FirstPath = p
			}
		}
		if path.Direct {
			break
		}
		if time.Now().After(deadline) {
			tm.PathMs = time.Since(t2).Milliseconds()
			return fail(ErrNoDirectPath)
		}
		select {
		case <-ctx.Done():
			return fail(ctx.Err())
		case <-time.After(time.Second):
		}
	}
	tm.PathMs = time.Since(t2).Milliseconds()

	t3 := time.Now()
	c, err := cl.DialTCPPort(ctx, opts.Port)
	if err != nil {
		return fail(err)
	}
	tm.DialMs = time.Since(t3).Milliseconds()
	sc := newConn(c, path)
	sc.onClose = func() { cl.Close() }
	sc.monitor(func() (Path, error) {
		pctx, pcancel := context.WithTimeout(sc.ctx, 5*time.Second)
		defer pcancel()
		return discoPath(pctx, cl)
	}, !opts.AllowRelay)
	return sc, tm, nil
}
