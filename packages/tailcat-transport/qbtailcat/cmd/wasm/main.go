//go:build js && wasm

// The browser build: exposes qbTailcatHost and qbTailcatJoin on globalThis.
// Adapted from tailcat's web/main_js.go (BSD-3-Clause), whose conn wrapper
// this keeps: pull-based reads so a fast sender stalls on TCP backpressure.
package main

import (
	"cmp"
	"context"
	"errors"
	"io"
	"log"
	"syscall/js"
	"time"

	"github.com/sbktio/shst/packages/tailcat-transport/qbtailcat/session"
	"tailscale.com/types/logger"
)

func main() {
	js.Global().Set("qbTailcatHost", js.FuncOf(jsHost))
	js.Global().Set("qbTailcatJoin", js.FuncOf(jsJoin))
	if f := js.Global().Get("onTailcatReady"); f.Type() == js.TypeFunction {
		f.Invoke()
	}
	select {}
}

func optString(v js.Value, name string) string {
	if p := v.Get(name); p.Type() == js.TypeString {
		return p.String()
	}
	return ""
}

func optBool(v js.Value, name string, def bool) bool {
	if p := v.Get(name); p.Type() == js.TypeBoolean {
		return p.Bool()
	}
	return def
}

func optInt(v js.Value, name string, def int) int {
	if p := v.Get(name); p.Type() == js.TypeNumber {
		return p.Int()
	}
	return def
}

func optLogf(v js.Value) logger.Logf {
	if v.Get("verbose").Truthy() {
		return log.Printf
	}
	return logger.Discard
}

// requiredPort reads the virtual Tailcat port the host answers on.
func requiredPort(v js.Value) (uint16, error) {
	p := optInt(v, "port", 0)
	if p < 1 || p > 65535 {
		return 0, errors.New("port must be 1-65535")
	}
	return uint16(p), nil
}

func pathValue(p session.Path) js.Value {
	return js.ValueOf(map[string]any{"direct": p.Direct, "via": p.Via})
}

// jsHost: qbTailcatHost({ derpMapURL, allowRelay, port, addressing, onConnection, onRefused, verbose })
// → Promise<{ code, addr, addressing, regionId, region, close() }>
// addressing is "words" (default) or "address".
func jsHost(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejected(errors.New("qbTailcatHost requires an options object"))
	}
	o := args[0]
	port, err := requiredPort(o)
	if err != nil {
		return rejected(err)
	}
	addressing, err := session.AddressingByName(cmp.Or(optString(o, "addressing"), "words"))
	if err != nil {
		return rejected(err)
	}
	onConnection := o.Get("onConnection")
	onRefused := o.Get("onRefused")
	opts := session.HostOptions{
		DERPMapURL: optString(o, "derpMapURL"),
		AllowRelay: optBool(o, "allowRelay", true),
		Port:       port,
		Addressing: addressing,
		Logf:       optLogf(o),
	}
	return promise(func() (any, error) {
		if onConnection.Type() != js.TypeFunction {
			return nil, errors.New("onConnection is required")
		}
		opts.OnConn = func(c *session.Conn) { onConnection.Invoke(connValue(c)) }
		opts.OnRefused = func(p session.Path) {
			if onRefused.Type() == js.TypeFunction {
				onRefused.Invoke(pathValue(p))
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		h, err := session.StartHost(ctx, opts)
		if err != nil {
			return nil, err
		}
		probes := map[string]any{}
		for region, ms := range h.RegionProbes {
			probes[region] = ms
		}
		return map[string]any{
			"code":         h.Code,
			"addr":         string(h.Addr),
			"addressing":   h.Addressing,
			"regionId":     int(h.RegionID),
			"region":       h.Region,
			"regionProbes": probes,
			"close": js.FuncOf(func(js.Value, []js.Value) any {
				h.Close()
				return nil
			}),
		}, nil
	})
}

// jsJoin: qbTailcatJoin({ code, derpMapURL, allowRelay, port, directTimeoutMs, verbose })
// → Promise<conn & { timings }>
func jsJoin(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejected(errors.New("qbTailcatJoin requires an options object"))
	}
	o := args[0]
	port, err := requiredPort(o)
	if err != nil {
		return rejected(err)
	}
	code := optString(o, "code")
	opts := session.JoinOptions{
		DERPMapURL:    optString(o, "derpMapURL"),
		AllowRelay:    optBool(o, "allowRelay", true),
		Port:          port,
		DirectTimeout: time.Duration(optInt(o, "directTimeoutMs", 15000)) * time.Millisecond,
		Logf:          optLogf(o),
	}
	return promise(func() (any, error) {
		sc, tm, err := session.Join(context.Background(), code, opts)
		if err != nil {
			return nil, err
		}
		v := connValue(sc)
		v.Set("timings", js.ValueOf(map[string]any{
			"deriveMs":   tm.DeriveMs,
			"reachMs":    tm.ReachMs,
			"pathMs":     tm.PathMs,
			"dialMs":     tm.DialMs,
			"pathProbes": tm.Attempts,
			"regionId":   tm.RegionID,
		}))
		return v, nil
	})
}

// connValue wraps a session as
//
//	{ read(), write(u8), closeWrite(), close(), path(), closeReason() }
func connValue(c *session.Conn) js.Value {
	buf := make([]byte, 64<<10)
	return js.ValueOf(map[string]any{
		"read": js.FuncOf(func(js.Value, []js.Value) any {
			return promise(func() (any, error) {
				n, err := c.Read(buf)
				if n > 0 {
					u8 := js.Global().Get("Uint8Array").New(n)
					js.CopyBytesToJS(u8, buf[:n])
					return u8, nil
				}
				if err == nil || errors.Is(err, io.EOF) || c.Reason() != "" {
					return js.Null(), nil
				}
				return nil, err
			})
		}),
		"write": js.FuncOf(func(_ js.Value, args []js.Value) any {
			if len(args) != 1 {
				return rejected(errors.New("write requires a Uint8Array"))
			}
			b := make([]byte, args[0].Get("length").Int())
			js.CopyBytesToGo(b, args[0])
			return promise(func() (any, error) {
				if _, err := c.Write(b); err != nil {
					if r := c.Reason(); r != "" {
						return nil, errors.New(r)
					}
					return nil, err
				}
				return js.Undefined(), nil
			})
		}),
		"closeWrite": js.FuncOf(func(js.Value, []js.Value) any {
			return promise(func() (any, error) {
				return js.Undefined(), c.CloseWrite()
			})
		}),
		"close": js.FuncOf(func(js.Value, []js.Value) any {
			c.Close()
			return nil
		}),
		"path":        js.FuncOf(func(js.Value, []js.Value) any { return pathValue(c.Path()) }),
		"closeReason": js.FuncOf(func(js.Value, []js.Value) any { return c.Reason() }),
	})
}

func promise(f func() (any, error)) js.Value {
	handler := js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			if res, err := f(); err == nil {
				resolve.Invoke(res)
			} else {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
			}
		}()
		return nil
	})
	return js.Global().Get("Promise").New(handler)
}

func rejected(err error) js.Value {
	return js.Global().Get("Promise").Call("reject", js.Global().Get("Error").New(err.Error()))
}
