//go:build js && wasm

// The browser build: exposes qbTailcatHost and qbTailcatJoin on globalThis.
// Adapted from tailcat's web/main_js.go (BSD-3-Clause), whose conn wrapper
// this keeps: pull-based reads so a fast sender stalls on TCP backpressure.
package main

import (
	"context"
	"errors"
	"io"
	"log"
	"syscall/js"
	"time"

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

func pathValue(p Path) js.Value {
	return js.ValueOf(map[string]any{"direct": p.Direct, "via": p.Via})
}

// jsHost: qbTailcatHost({ derpMapURL, allowRelay, port, onConnection, onRefused, verbose })
// → Promise<{ code, addr, regionId, region, close() }>
func jsHost(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejected(errors.New("qbTailcatHost requires an options object"))
	}
	o := args[0]
	onConnection := o.Get("onConnection")
	onRefused := o.Get("onRefused")
	opts := hostOptions{
		DERPMapURL: optString(o, "derpMapURL"),
		AllowRelay: optBool(o, "allowRelay", true),
		Port:       uint16(optInt(o, "port", 7187)),
		Logf:       optLogf(o),
	}
	return promise(func() (any, error) {
		if onConnection.Type() != js.TypeFunction {
			return nil, errors.New("onConnection is required")
		}
		opts.OnConn = func(c *sessionConn) { onConnection.Invoke(connValue(c, nil)) }
		opts.OnRefused = func(p Path) {
			if onRefused.Type() == js.TypeFunction {
				onRefused.Invoke(pathValue(p))
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		h, err := startHost(ctx, opts)
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
	code := optString(o, "code")
	opts := joinOptions{
		DERPMapURL:    optString(o, "derpMapURL"),
		AllowRelay:    optBool(o, "allowRelay", true),
		Port:          uint16(optInt(o, "port", 7187)),
		DirectTimeout: time.Duration(optInt(o, "directTimeoutMs", 15000)) * time.Millisecond,
		Logf:          optLogf(o),
	}
	return promise(func() (any, error) {
		sc, cl, tm, err := join(context.Background(), code, opts)
		if err != nil {
			return nil, err
		}
		v := connValue(sc, func() { cl.Close() })
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
//	{ port, read(), write(u8), closeWrite(), close(), path(), closeReason() }
func connValue(c *sessionConn, onClose func()) js.Value {
	buf := make([]byte, 64<<10)
	return js.ValueOf(map[string]any{
		"port": 7187,
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
				cw, ok := c.Conn.(interface{ CloseWrite() error })
				if !ok {
					return nil, errors.New("connection does not support half-close")
				}
				return js.Undefined(), cw.CloseWrite()
			})
		}),
		"close": js.FuncOf(func(js.Value, []js.Value) any {
			c.Close()
			if onClose != nil {
				onClose()
			}
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
