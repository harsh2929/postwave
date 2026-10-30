// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for SendDomainClient. The HTTP shape is verified against an
// httptest.Server stand-in for apps/api; the cache behavior is
// verified by counting requests received.

package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestSendDomainClient_Hit: a 200 response is parsed and the tenant id
// returned. The request must include the bearer header and the domain
// query parameter.
func TestSendDomainClient_Hit(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		if r.URL.Path != "/api/internal/send-domains/lookup" {
			t.Errorf("path: got %q", r.URL.Path)
		}
		if got := r.URL.Query().Get("domain"); got != "acme.example.com" {
			t.Errorf("domain query: got %q want acme.example.com", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("auth header: got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"tenant_id": "11111111-2222-3333-4444-555555555555",
		})
	}))
	defer srv.Close()

	c := &SendDomainClient{BaseURL: srv.URL, AuthToken: "test-token"}
	got, err := c.LookupTenant(context.Background(), "acme.example.com")
	if err != nil {
		t.Fatalf("LookupTenant: %v", err)
	}
	if got != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("tenant_id: got %q", got)
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("calls: got %d want 1", calls)
	}
}

// TestSendDomainClient_NotFound maps a 404 from the gateway to
// ErrNotFound so callers can distinguish "no claim" from a real error.
func TestSendDomainClient_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "not_found"})
	}))
	defer srv.Close()

	c := &SendDomainClient{BaseURL: srv.URL, AuthToken: "tok"}
	_, err := c.LookupTenant(context.Background(), "unmapped.example.com")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err: got %v want ErrNotFound", err)
	}
}

// TestSendDomainClient_Unauthorized maps 401 to a wrapped error (NOT
// ErrNotFound) so the resolver logs it as a real failure.
func TestSendDomainClient_Unauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := &SendDomainClient{BaseURL: srv.URL, AuthToken: "wrong"}
	_, err := c.LookupTenant(context.Background(), "x.example.com")
	if err == nil {
		t.Fatalf("expected error on 401")
	}
	if errors.Is(err, ErrNotFound) {
		t.Fatalf("auth error must NOT collapse to ErrNotFound")
	}
}

func TestSendDomainClient_CapsSuccessResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("{", int(sendDomainLookupMaxResponseBytes)+1)))
	}))
	defer srv.Close()

	c := &SendDomainClient{BaseURL: srv.URL, AuthToken: "tok"}
	_, err := c.LookupTenant(context.Background(), "x.example.com")
	if err == nil || !strings.Contains(err.Error(), "response body too large") {
		t.Fatalf("LookupTenant err = %v, want response body too large", err)
	}
}

// TestSendDomainClient_CacheHit: a second call within the TTL must not
// reach the server. Counter on the test server is the assertion.
func TestSendDomainClient_CacheHit(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		_ = json.NewEncoder(w).Encode(map[string]string{"tenant_id": "tid-1"})
	}))
	defer srv.Close()

	c := &SendDomainClient{BaseURL: srv.URL, AuthToken: "tok", CacheTTL: time.Minute}
	for i := 0; i < 5; i++ {
		got, err := c.LookupTenant(context.Background(), "cached.example.com")
		if err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
		if got != "tid-1" {
			t.Fatalf("call %d: tenant_id %q", i, got)
		}
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("server hits: got %d want 1 (cache must short-circuit subsequent calls)", got)
	}
}

// TestSendDomainClient_CacheNegative: ErrNotFound is also memoized so
// a noisy unmapped domain doesn't pound the gateway.
func TestSendDomainClient_CacheNegative(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := &SendDomainClient{BaseURL: srv.URL, AuthToken: "tok", CacheTTL: time.Minute}
	for i := 0; i < 3; i++ {
		_, err := c.LookupTenant(context.Background(), "missing.example.com")
		if !errors.Is(err, ErrNotFound) {
			t.Fatalf("call %d: err = %v, want ErrNotFound", i, err)
		}
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("server hits: got %d want 1 (negative cache should hold)", got)
	}
}

// TestSendDomainClient_CacheExpiry: after the TTL elapses we re-fetch.
// Done with a tiny TTL so the test stays fast.
func TestSendDomainClient_CacheExpiry(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		_ = json.NewEncoder(w).Encode(map[string]string{"tenant_id": "tid-1"})
	}))
	defer srv.Close()

	c := &SendDomainClient{BaseURL: srv.URL, AuthToken: "tok", CacheTTL: 25 * time.Millisecond}
	if _, err := c.LookupTenant(context.Background(), "expiring.example.com"); err != nil {
		t.Fatalf("first call: %v", err)
	}
	time.Sleep(60 * time.Millisecond)
	if _, err := c.LookupTenant(context.Background(), "expiring.example.com"); err != nil {
		t.Fatalf("second call: %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("server hits: got %d want 2 (TTL must expire and trigger refetch)", got)
	}
}

// TestSendDomainClient_TransportErrorNotCached: a 5xx is wrapped, NOT
// memoized — retrying on the next report is correct behavior.
func TestSendDomainClient_TransportErrorNotCached(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := &SendDomainClient{BaseURL: srv.URL, AuthToken: "tok", CacheTTL: time.Minute}
	for i := 0; i < 3; i++ {
		_, err := c.LookupTenant(context.Background(), "broken.example.com")
		if err == nil {
			t.Fatalf("call %d: expected error", i)
		}
		if errors.Is(err, ErrNotFound) {
			t.Fatalf("call %d: 5xx must not collapse to ErrNotFound", i)
		}
	}
	if got := atomic.LoadInt32(&calls); got != 3 {
		t.Fatalf("server hits: got %d want 3 (transient errors must not be cached)", got)
	}
}

// TestSendDomainClient_Validation: empty inputs / empty BaseURL fail
// fast without touching the network.
func TestSendDomainClient_Validation(t *testing.T) {
	var c *SendDomainClient
	if _, err := c.LookupTenant(context.Background(), "x.com"); err == nil {
		t.Fatalf("expected error on nil receiver")
	}
	c2 := &SendDomainClient{BaseURL: ""}
	if _, err := c2.LookupTenant(context.Background(), "x.com"); err == nil {
		t.Fatalf("expected error on empty BaseURL")
	}
	c3 := &SendDomainClient{BaseURL: "http://example.invalid"}
	if _, err := c3.LookupTenant(context.Background(), ""); err == nil {
		t.Fatalf("expected error on empty domain")
	}
}

func TestSendDomainLookupURLPreservesBasePathAndRejectsUnsafeBase(t *testing.T) {
	got, err := sendDomainLookupURL("https://api.example.test/postwave/", "acme.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://api.example.test/postwave/api/internal/send-domains/lookup?domain=acme.example.com" {
		t.Fatalf("url = %q", got)
	}

	for _, base := range []string{
		"https://user:pass@api.example.test",
		"https://api.example.test?token=x",
		"https://api.example.test#frag",
		"file:///tmp/api",
	} {
		_, err := sendDomainLookupURL(base, "acme.example.com")
		if err == nil || (!strings.Contains(err.Error(), "unsafe base URL") &&
			!strings.Contains(err.Error(), "invalid base URL") &&
			!strings.Contains(err.Error(), "unsupported base URL scheme")) {
			t.Fatalf("base %q err = %v, want unsafe/invalid", base, err)
		}
	}
}
