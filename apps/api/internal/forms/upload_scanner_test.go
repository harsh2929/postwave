// SPDX-License-Identifier: AGPL-3.0-only

package forms

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestUploadMIMEMatchesIsExactAndFailClosed(t *testing.T) {
	for _, tc := range []struct {
		declared string
		detected string
		want     bool
	}{
		{"image/png", "image/png", true},
		{"text/plain", "text/plain; charset=utf-8", true},
		{"application/pdf", "text/plain", false},
		{"image/png", "application/octet-stream", false},
	} {
		if got := uploadMIMEMatches(tc.declared, tc.detected); got != tc.want {
			t.Fatalf("uploadMIMEMatches(%q,%q)=%v want %v", tc.declared, tc.detected, got, tc.want)
		}
	}
}

func TestClamAVScannerPingAndCleanStream(t *testing.T) {
	listener, listenErr := net.Listen("tcp", "127.0.0.1:0")
	if listenErr != nil {
		t.Fatal(listenErr)
	}
	defer func() { _ = listener.Close() }()
	done := make(chan error, 2)
	go func() {
		for request := 0; request < 2; request++ {
			conn, err := listener.Accept()
			if err != nil {
				done <- err
				return
			}
			if request == 0 {
				command := make([]byte, len("zPING\x00"))
				_, err = io.ReadFull(conn, command)
				if err == nil && string(command) == "zPING\x00" {
					_, err = io.WriteString(conn, "PONG\x00")
				}
			} else {
				command := make([]byte, len("zINSTREAM\x00"))
				_, err = io.ReadFull(conn, command)
				if err == nil && string(command) == "zINSTREAM\x00" {
					var received strings.Builder
					for {
						var size [4]byte
						if _, err = io.ReadFull(conn, size[:]); err != nil {
							break
						}
						n := binary.BigEndian.Uint32(size[:])
						if n == 0 {
							break
						}
						chunk := make([]byte, n)
						if _, err = io.ReadFull(conn, chunk); err != nil {
							break
						}
						received.Write(chunk)
					}
					if err == nil && received.String() == "safe payload" {
						_, err = io.WriteString(conn, "stream: OK\x00")
					}
				}
			}
			_ = conn.Close()
			done <- err
		}
	}()

	scanner := &ClamAVScanner{Network: "tcp", Address: listener.Addr().String(), Timeout: 2 * time.Second}
	if err := scanner.Ping(context.Background()); err != nil {
		t.Fatalf("ping: %v", err)
	}
	verdict, n, detail, listenErr := scanner.Scan(context.Background(), strings.NewReader("safe payload"))
	if listenErr != nil {
		t.Fatalf("scan: %v", listenErr)
	}
	if verdict != ScanClean || n != int64(len("safe payload")) || detail != "clean" {
		t.Fatalf("verdict=%q n=%d detail=%q", verdict, n, detail)
	}
	for i := 0; i < 2; i++ {
		if err := <-done; err != nil {
			t.Fatalf("fake clamd: %v", err)
		}
	}
}

func TestNewClamAVScannerRejectsMissingAddress(t *testing.T) {
	if _, err := NewClamAVScanner("  "); err == nil {
		t.Fatal("missing scanner address accepted")
	}
}
