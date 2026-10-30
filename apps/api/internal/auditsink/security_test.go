// SPDX-License-Identifier: AGPL-3.0-only
package auditsink

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type auditRoundTripFunc func(*http.Request) (*http.Response, error)

func (f auditRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestPostJSONRejectsUnsafeDestinationsBeforeTransport(t *testing.T) {
	var calls atomic.Int32
	d := &Deps{
		HTTP: &http.Client{Transport: auditRoundTripFunc(func(*http.Request) (*http.Response, error) {
			calls.Add(1)
			return nil, errors.New("transport must not be reached")
		})},
		httpClientHardened: true,
	}

	for _, rawURL := range []string{
		"http://example.com/sink",
		"https://localhost/sink",
		"https://127.0.0.1/sink",
		"https://10.0.0.1/sink",
		"https://169.254.169.254/latest/meta-data",
		"https://[::1]/sink",
		"https://user:password@example.com/sink",
	} {
		t.Run(rawURL, func(t *testing.T) {
			err := d.postJSON(context.Background(), rawURL, nil, []byte(`{"test":true}`))
			if !errors.Is(err, errAuditSinkDestination) {
				t.Fatalf("postJSON(%q) error = %v, want destination rejection", rawURL, err)
			}
		})
	}
	if got := calls.Load(); got != 0 {
		t.Fatalf("unsafe destinations reached transport %d time(s)", got)
	}
}

func TestAuditSinkClientUsesCanonicalDNSAndProxySafeTransport(t *testing.T) {
	client := newAuditSinkHTTPClient(time.Second)
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport type = %T, want canonical *http.Transport", client.Transport)
	}
	if transport.Proxy != nil {
		t.Fatal("audit sink transport must not consult ambient proxy settings")
	}
	if transport.DialContext == nil {
		t.Fatal("audit sink transport must install the canonical dial-time DNS/IP guard")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if conn, err := transport.DialContext(ctx, "tcp", "localhost:443"); err == nil {
		_ = conn.Close()
		t.Fatal("canonical dialer accepted a loopback hostname")
	}
}

func TestPostJSONDoesNotFollowRedirects(t *testing.T) {
	const upstreamBody = "upstream-oracle-secret"
	var calls atomic.Int32
	client := newAuditSinkHTTPClientWithTransport(time.Second, auditRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls.Add(1)
		return &http.Response{
			StatusCode: http.StatusTemporaryRedirect,
			Header: http.Header{
				"Location": []string{"https://169.254.169.254/latest/meta-data"},
			},
			Body:    io.NopCloser(strings.NewReader(upstreamBody)),
			Request: req,
		}, nil
	}))
	d := &Deps{HTTP: client, httpClientHardened: true}

	err := d.postJSON(context.Background(), "https://hooks.example.test/audit", nil, []byte(`{"test":true}`))
	if !errors.Is(err, errAuditSinkRedirect) {
		t.Fatalf("redirect error = %v, want %v", err, errAuditSinkRedirect)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("transport calls = %d, redirect was followed", got)
	}
	if strings.Contains(err.Error(), upstreamBody) || strings.Contains(err.Error(), "169.254.169.254") {
		t.Fatalf("redirect error leaked upstream data: %q", err)
	}
}

func TestDeliveryErrorsNeverExposeUpstreamResponseBodies(t *testing.T) {
	const secretBody = "customer-controlled-secret-response-body"
	client := newAuditSinkHTTPClientWithTransport(time.Second, auditRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusBadGateway,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(secretBody)),
			Request:    req,
		}, nil
	}))
	d := &Deps{HTTP: client, httpClientHardened: true}

	tests := []struct {
		name string
		run  func() error
	}{
		{
			name: "generic HTTP",
			run: func() error {
				return d.postJSON(context.Background(), "https://hooks.example.test/audit", nil, []byte(`{}`))
			},
		},
		{
			name: "S3 JSONL",
			run: func() error {
				return s3PutObject(context.Background(), client, "us-east-1", "audit-bucket", "tenant/batch.jsonl", "access", "secret", []byte("row\n"))
			},
		},
		{
			name: "S3 Object Lock",
			run: func() error {
				return s3PutObjectWithLock(context.Background(), client, "us-east-1", "audit-bucket", "tenant/batch.parquet", "access", "secret", []byte("PAR1"), "COMPLIANCE", false, time.Now().Add(24*time.Hour))
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.run()
			if err == nil {
				t.Fatal("expected non-2xx delivery error")
			}
			if strings.Contains(err.Error(), secretBody) {
				t.Fatalf("delivery error exposed upstream body: %q", err)
			}
			if !strings.Contains(err.Error(), "502") {
				t.Fatalf("delivery error = %q, want status-only diagnostic", err)
			}
		})
	}
}

func TestProductionSourcesDoNotConstructRawHTTPClients(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		raw, err := os.ReadFile(filepath.Clean(entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{"&http.Client{", "http.DefaultClient"} {
			if bytes.Contains(raw, []byte(forbidden)) {
				t.Errorf("%s constructs forbidden raw HTTP client %q", entry.Name(), forbidden)
			}
		}
	}
}
