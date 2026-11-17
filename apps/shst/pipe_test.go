package main

import (
	"bytes"
	"context"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// tcpPair returns two connected loopback TCP conns.
func tcpPair(t *testing.T) (a, b *net.TCPConn) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	type res struct {
		c   net.Conn
		err error
	}
	ch := make(chan res, 1)
	go func() {
		c, err := ln.Accept()
		ch <- res{c, err}
	}()
	c1, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	r := <-ch
	if r.err != nil {
		t.Fatal(r.err)
	}
	t.Cleanup(func() { c1.Close(); r.c.Close() })
	return c1.(*net.TCPConn), r.c.(*net.TCPConn)
}

func TestPipeBidirectionalHalfClose(t *testing.T) {
	ours, theirs := tcpPair(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	sent := bytes.Repeat([]byte("hello from stdin\n"), 10000)
	reply := []byte("reply from the peer\n")
	var stdout bytes.Buffer

	done := make(chan error, 1)
	go func() { done <- pipe(ctx, ours, bytes.NewReader(sent), &stdout, true) }()

	// The peer reads until EOF, which only arrives if pipe half-closed.
	got, err := io.ReadAll(theirs)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, sent) {
		t.Fatalf("peer got %d bytes, want %d", len(got), len(sent))
	}
	select {
	case err := <-done:
		t.Fatalf("pipe returned before the peer finished: %v", err)
	case <-time.After(100 * time.Millisecond):
	}

	// The peer can still write after seeing EOF, then closes.
	if _, err := theirs.Write(reply); err != nil {
		t.Fatal(err)
	}
	theirs.Close()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("pipe: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("pipe did not return after the peer closed")
	}
	if !bytes.Equal(stdout.Bytes(), reply) {
		t.Fatalf("stdout = %q, want %q", stdout.Bytes(), reply)
	}
}

func TestPipeWaitsForStdinAfterPeerEOF(t *testing.T) {
	ours, theirs := tcpPair(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pr, pw := io.Pipe()
	var stdout bytes.Buffer
	done := make(chan error, 1)
	go func() { done <- pipe(ctx, ours, pr, &stdout, true) }()

	theirs.CloseWrite() // the peer has nothing to send
	select {
	case <-done:
		t.Fatal("pipe returned while stdin was still open")
	case <-time.After(200 * time.Millisecond):
	}
	pw.Write([]byte("late data"))
	pw.Close()
	got, _ := io.ReadAll(theirs)
	if string(got) != "late data" {
		t.Fatalf("peer got %q", got)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestPipeContextCancel(t *testing.T) {
	ours, _ := tcpPair(t)
	ctx, cancel := context.WithCancel(context.Background())
	pr, _ := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- pipe(ctx, ours, pr, io.Discard, true) }()
	cancel()
	select {
	case err := <-done:
		if err != context.Canceled {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("pipe ignored cancellation")
	}
}

func TestPipeEndsOnPeerEOFWithoutWaitingForStdin(t *testing.T) {
	ours, theirs := tcpPair(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pr, _ := io.Pipe()
	var stdout bytes.Buffer
	done := make(chan error, 1)
	go func() { done <- pipe(ctx, ours, pr, &stdout, false) }()

	theirs.Write([]byte("the file"))
	theirs.CloseWrite()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("pipe kept waiting for an open stdin after the peer finished")
	}
	if stdout.String() != "the file" {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestPipeFailsWhenTheSendCannotFinish(t *testing.T) {
	ours, theirs := tcpPair(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// The peer closes outright while stdin still has far more data than the
	// socket buffers hold. Whether the reset surfaces first on the send or the
	// read side depends on scheduling; either way pipe must not report success.
	theirs.Close()
	stdin := bytes.NewReader(make([]byte, 64<<20))
	done := make(chan error, 1)
	go func() { done <- pipe(ctx, ours, stdin, io.Discard, true) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("pipe reported success for a send the peer never received")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("pipe did not return after the peer closed")
	}
}

func TestPipeIgnoresSendFailureWithoutWaitStdin(t *testing.T) {
	ours, theirs := tcpPair(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Nothing was piped in, so a peer that closes without reading is not a
	// failed send. The read side ends cleanly.
	theirs.Close()
	done := make(chan error, 1)
	go func() { done <- pipe(ctx, ours, strings.NewReader(""), io.Discard, false) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("pipe: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("pipe did not return")
	}
}
