// SPDX-License-Identifier: AGPL-3.0-only
package preferences

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// stubFanout captures PublishUnsubscribe calls so the test can assert
// the one-click handler fanned out after a successful suppression.
type stubFanout struct {
	mu    sync.Mutex
	calls []struct{ tenantID, email, source string }
}

func (s *stubFanout) PublishUnsubscribe(tenantID, email, source string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, struct{ tenantID, email, source string }{tenantID, email, source})
}

// stubSuppressor satisfies OneClickSuppressor without a DB so the
// honorOneClick path can be exercised end-to-end without a pool.
type stubSuppressor struct {
	failWith error
	calls    int
	evidence OneClickEvidence
}

func (s *stubSuppressor) Add(_ context.Context, _, _, _ string, evidence OneClickEvidence) error {
	s.calls++
	s.evidence = evidence
	return s.failWith
}

func TestHonorOneClickFanoutPublishesOnSuccess(t *testing.T) {
	fanout := &stubFanout{}
	d := &Deps{
		OneClickSuppressor: &stubSuppressor{},
		UnsubscribeFanout:  fanout,
	}
	req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(""))
	if err := d.honorOneClick(req, "tenant-A", "daisy@example.com"); err != nil {
		t.Fatalf("honorOneClick: %v", err)
	}
	if len(fanout.calls) != 1 {
		t.Fatalf("expected 1 fanout call, got %d", len(fanout.calls))
	}
	got := fanout.calls[0]
	if got.tenantID != "tenant-A" || got.email != "daisy@example.com" || got.source != "one_click" {
		t.Fatalf("unexpected fanout payload: %+v", got)
	}
}

func TestHonorOneClickFanoutNilSafe(t *testing.T) {
	d := &Deps{OneClickSuppressor: &stubSuppressor{}}
	req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(""))
	if err := d.honorOneClick(req, "tenant-A", "daisy@example.com"); err != nil {
		t.Fatalf("nil fanout should not error: %v", err)
	}
}

func TestHonorOneClickFanoutSkippedOnSuppressionFailure(t *testing.T) {
	fanout := &stubFanout{}
	sup := &stubSuppressor{failWith: errSentinel("write failed")}
	d := &Deps{OneClickSuppressor: sup, UnsubscribeFanout: fanout}
	req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(""))
	if err := d.honorOneClick(req, "tenant-A", "daisy@example.com"); err == nil {
		t.Fatal("expected error when suppression fails")
	}
	if len(fanout.calls) != 0 {
		t.Fatalf("fanout must NOT fire when suppression failed (avoids partner-side state drift); got %d calls", len(fanout.calls))
	}
}

type errSentinel string

func (e errSentinel) Error() string { return string(e) }

// TestRequestIsOneClickAcceptsLiteralBody ensures the canonical raw
// body `List-Unsubscribe=One-Click` is recognised regardless of
// Content-Type. Some smaller mailbox providers skip the header.
func TestRequestIsOneClickAcceptsLiteralBody(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost,
		"/api/public/preferences/abc/one-click",
		strings.NewReader("List-Unsubscribe=One-Click"))
	if !requestIsOneClick(req) {
		t.Fatalf("literal RFC 8058 body should be honoured")
	}
}

// TestRequestIsOneClickAcceptsFormEncoded ensures the
// application/x-www-form-urlencoded path Gmail uses is honoured.
func TestRequestIsOneClickAcceptsFormEncoded(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost,
		"/api/public/preferences/abc/one-click",
		strings.NewReader("List-Unsubscribe=One-Click&note=ignored"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if !requestIsOneClick(req) {
		t.Fatalf("form-encoded RFC 8058 body should be honoured")
	}
}

// TestRequestIsOneClickRejectsArbitraryBody guards against
// accidentally honouring crawler or browser POSTs that aren't the
// canonical RFC 8058 marker.
func TestRequestIsOneClickRejectsArbitraryBody(t *testing.T) {
	cases := map[string]string{
		"empty":       "",
		"random":      "{\"foo\":\"bar\"}",
		"wrong-key":   "Unsubscribe=One-Click",
		"wrong-value": "List-Unsubscribe=Yes",
		"prose":       "hello there",
		"trailing-eq": "List-Unsubscribe=",
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost,
				"/api/public/preferences/abc/one-click",
				strings.NewReader(body))
			if requestIsOneClick(req) {
				t.Fatalf("body %q should NOT be honoured", body)
			}
		})
	}
}

// TestRequestIsOneClickCapsBodySize defends against a hostile client
// streaming a multi-megabyte payload. The handler caps at 1 KiB.
func TestRequestIsOneClickCapsBodySize(t *testing.T) {
	huge := strings.Repeat("List-Unsubscribe=One-Click&junk=", 1024)
	req := httptest.NewRequest(http.MethodPost,
		"/api/public/preferences/abc/one-click",
		strings.NewReader(huge))
	if requestIsOneClick(req) {
		t.Fatalf("oversized body should be rejected")
	}
}

// TestPublicOneClickUnsubscribeBlocksMissingToken ensures the public
// endpoint rejects requests with an empty token segment.
func TestPublicOneClickUnsubscribeBlocksMissingToken(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodPost,
		"/api/public/preferences//one-click",
		strings.NewReader("List-Unsubscribe=One-Click"))
	rec := httptest.NewRecorder()
	deps.PublicOneClickUnsubscribe(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "missing_token") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestOneClickOmitsUntrustedProxyRemoteAddressFromEvidence(t *testing.T) {
	suppressor := &stubSuppressor{}
	d := &Deps{OneClickSuppressor: suppressor}
	req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(""))
	req.RemoteAddr = "10.0.42.7:443"
	req.Header.Set("X-Forwarded-For", "198.51.100.23")
	if err := d.honorOneClick(req, "tenant-A", "daisy@example.com"); err != nil {
		t.Fatalf("honorOneClick: %v", err)
	}
	if suppressor.evidence.IP != "" {
		t.Fatalf("untrusted transport address persisted as actor evidence: %q", suppressor.evidence.IP)
	}
}

func TestOneClickUserAgentMetadataCannotBlockOptOut(t *testing.T) {
	for _, unsafe := range []string{
		strings.Repeat("a", 2049),
		"agent\nforged",
		"agent\u202Ehidden",
	} {
		if got := sanitizeOneClickUserAgent(unsafe); got != "" {
			t.Fatalf("unsafe user agent retained: %q", got)
		}
	}
	if got := sanitizeOneClickUserAgent("  mailbox-provider/1.0  "); got != "mailbox-provider/1.0" {
		t.Fatalf("safe user agent = %q", got)
	}
}
