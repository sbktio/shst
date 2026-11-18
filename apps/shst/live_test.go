package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"io"
	"os"
	"testing"
	"time"

	"github.com/sbktio/shst/packages/tailcat-transport/qbtailcat/session"
)

func requireLive(t *testing.T) {
	t.Helper()
	if os.Getenv("SHST_LIVE") != "1" {
		t.Skip("set SHST_LIVE=1 to run against the public relay")
	}
}

func TestLivePipe(t *testing.T) {
	requireLive(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	conns := make(chan *session.Conn, 1)
	h, err := session.StartHost(ctx, session.HostOptions{
		AllowRelay: true,
		Port:       portPipe,
		Logf:       logf(),
		OnConn:     func(c *session.Conn) { conns <- c },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	t.Logf("code: %s", h.Code)

	jc, _, err := session.Join(ctx, h.Code, session.JoinOptions{AllowRelay: true, Port: portPipe, Logf: logf()})
	if err != nil {
		t.Fatal(err)
	}
	defer jc.Close()
	var hc *session.Conn
	select {
	case hc = <-conns:
	case <-ctx.Done():
		t.Fatal("host never admitted the joiner")
	}
	defer hc.Close()

	payload := make([]byte, 1<<20)
	rand.Read(payload)
	line := []byte("hello from the joiner\n")
	var hostOut, joinOut bytes.Buffer

	hostDone := make(chan error, 1)
	joinDone := make(chan error, 1)
	go func() { hostDone <- pipe(ctx, hc, bytes.NewReader(payload), &hostOut, true) }()
	go func() { joinDone <- pipe(ctx, jc, bytes.NewReader(line), &joinOut, true) }()

	for _, d := range []chan error{hostDone, joinDone} {
		select {
		case err := <-d:
			if err != nil {
				t.Fatalf("pipe: %v", err)
			}
		case <-ctx.Done():
			t.Fatal("timed out waiting for the pipes to finish")
		}
	}
	if !bytes.Equal(joinOut.Bytes(), payload) {
		t.Errorf("joiner received %d bytes, want %d (equal=false)", joinOut.Len(), len(payload))
	}
	if !bytes.Equal(hostOut.Bytes(), line) {
		t.Errorf("host received %q, want %q", hostOut.Bytes(), line)
	}
}

func TestLiveEchoPing(t *testing.T) {
	requireLive(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	h, err := startEcho(ctx, portEcho, false, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	c, tm, err := session.Join(ctx, h.Code, session.JoinOptions{AllowRelay: true, Port: portEcho, Logf: logf()})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	t.Logf("joined via %s, timings %+v", c.Path().Via, tm)

	samples, err := measure(ctx, c, 5, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) < 5 {
		t.Fatalf("got %d round trips, want at least 5", len(samples))
	}
	for _, g := range summarize(samples) {
		t.Logf("%s over %d: p50 %v p95 %v max %v", g.label(), g.Count, g.p50, g.p95, g.max)
	}
}
