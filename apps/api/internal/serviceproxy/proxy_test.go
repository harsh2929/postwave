package serviceproxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProxyRewritesPathAndOwnsInternalHeaders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/render" {
			t.Fatalf("path = %q, want /v1/render", r.URL.Path)
		}
		if got := r.URL.Query().Get("mode"); got != "preview" {
			t.Fatalf("query mode = %q, want preview", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer internal-secret" {
			t.Fatalf("authorization = %q, want internal bearer", got)
		}
		if got := r.Header.Get("X-Tenant-ID"); got != "tenant-owned" {
			t.Fatalf("tenant header = %q, want gateway-owned value", got)
		}
		if got := r.Header.Get("X-Postwave-Tenant-ID"); got != "tenant-owned" {
			t.Fatalf("postwave tenant header = %q, want gateway-owned value", got)
		}
		if got := r.Header.Get("X-Postwave-Role"); got != "" {
			t.Fatalf("spoofed postwave role leaked upstream: %q", got)
		}
		if got := r.Header.Get("X-Sending-Domain"); got != "owned.example" {
			t.Fatalf("sending domain = %q, want gateway-owned value", got)
		}
		if got := r.Header.Get("X-DKIM-Selector"); got != "default" {
			t.Fatalf("dkim selector = %q, want gateway-owned value", got)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"ok": "true"})
	}))
	defer upstream.Close()

	proxy := New(Options{
		Target:           upstream.URL,
		PublicPrefix:     "/api/v1/render",
		UpstreamPrefix:   "/v1/render",
		InternalAPIToken: "internal-secret",
		AddHeaders: func(_ context.Context, h http.Header) {
			h.Set("X-Tenant-ID", "tenant-owned")
			h.Set("X-Postwave-Tenant-ID", "tenant-owned")
			h.Set("X-Sending-Domain", "owned.example")
			h.Set("X-DKIM-Selector", "default")
		},
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/render?mode=preview", nil)
	req.Header.Set("Authorization", "Bearer caller-token")
	req.Header.Set("X-Tenant-ID", "spoofed-tenant")
	req.Header.Set("X-Postwave-Tenant-ID", "spoofed-postwave-tenant")
	req.Header.Set("X-Postwave-Role", "owner")
	req.Header.Set("X-Sending-Domain", "spoofed.example")
	req.Header.Set("X-DKIM-Selector", "spoofed")
	rec := httptest.NewRecorder()

	proxy.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestProxyRejectsUnsafeTargetURL(t *testing.T) {
	for _, target := range []string{
		"https://user:pass@service.example.test",
		"https://service.example.test?token=x",
		"https://service.example.test#frag",
		"file:///tmp/service",
	} {
		proxy := New(Options{Target: target, PublicPrefix: "/api", UpstreamPrefix: "/v1"})
		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		rec := httptest.NewRecorder()

		proxy.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadGateway {
			t.Fatalf("target %q status = %d, want 502", target, rec.Code)
		}
	}
}

// An environment that does not run a service sets its *_SERVICE_URL to
// "disabled", which configuration reads as no URL. That used to answer 502
// "upstream service URL is not configured", which reads as a fault.
func TestProxyAnswersNotDeployedWithoutATarget(t *testing.T) {
	for _, target := range []string{"", "  "} {
		proxy := New(Options{Target: target, PublicPrefix: "/api/v1/automations", UpstreamPrefix: "/v1/automations"})
		rec := httptest.NewRecorder()
		proxy.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/automations/42/activate", nil))

		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("target %q status = %d, want 503", target, rec.Code)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("Cache-Control = %q, want no-store", got)
		}
		var body struct {
			Error struct {
				Code      string `json:"code"`
				Message   string `json:"message"`
				Retryable *bool  `json:"retryable"`
			} `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode %q: %v", rec.Body.String(), err)
		}
		if body.Error.Code != "service_not_deployed" {
			t.Fatalf("code = %q, want service_not_deployed", body.Error.Code)
		}
		if body.Error.Retryable == nil || *body.Error.Retryable {
			t.Fatalf("retryable = %v, want false", body.Error.Retryable)
		}
		if body.Error.Message != "This feature isn't available in this environment." {
			t.Fatalf("message = %q", body.Error.Message)
		}
	}
}
