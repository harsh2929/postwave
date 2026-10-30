package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestListmonkProxyStripsUnsafeUpstreamHeaders locks in the audit's Tier-2
// finding: the proxy used to forward every upstream header except
// Content-Length. Forwarding Set-Cookie under our eTLD+1 = Listmonk
// session fixation onto the postwave domain. Forwarding Server / X-*
// fingerprint headers leaks engine internals.
func TestListmonkProxyStripsUnsafeUpstreamHeaders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", `"abc"`)
		// All of these MUST be stripped by the proxy.
		w.Header().Set("Set-Cookie", "listmonk_session=evil; Domain=.example.com; Path=/")
		w.Header().Set("Server", "nginx/1.25.0")
		w.Header().Set("WWW-Authenticate", `Basic realm="listmonk"`)
		w.Header().Set("X-Listmonk-Version", "v4.1.0")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer upstream.Close()

	handler := ListmonkProxy(upstream.URL, "/api/health", "", "")
	req := httptest.NewRequest(http.MethodGet, "/api/listmonk/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}

	allow := []string{"Content-Type", "Etag"}
	deny := []string{"Set-Cookie", "Server", "Www-Authenticate", "X-Listmonk-Version"}

	for _, h := range allow {
		if rec.Header().Get(h) == "" {
			t.Errorf("expected %q to be forwarded, got empty", h)
		}
	}
	for _, h := range deny {
		if got := rec.Header().Get(h); got != "" {
			t.Errorf("forbidden header %q leaked through proxy: %q", h, got)
		}
	}
	if !strings.Contains(rec.Body.String(), `"status":"ok"`) {
		t.Errorf("body lost: %s", rec.Body.String())
	}
}

// TestListmonkProxyRefusesNonAllowlistedPaths is a sanity guard: the
// allowedListmonkPaths map is the gate; constructing a proxy for an
// unlisted path should produce a handler that fails fast.
func TestListmonkProxyRefusesNonAllowlistedPaths(t *testing.T) {
	handler := ListmonkProxy("http://upstream", "/api/admin/users", "", "")
	req := httptest.NewRequest(http.MethodGet, "/proxied", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("non-allowlisted path should fail closed; got %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("content-type = %q, want JSON", ct)
	}
	if !strings.Contains(rec.Body.String(), "path_not_allowed") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestListmonkProxyRejectsUnsafeBaseURL(t *testing.T) {
	handler := ListmonkProxy("javascript:alert(1)", "/api/health", "", "")
	req := httptest.NewRequest(http.MethodGet, "/api/listmonk/health", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "bad_upstream_url") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestListmonkProxyRejectsNonGET(t *testing.T) {
	handler := ListmonkProxy("http://upstream.test", "/api/health", "", "")
	req := httptest.NewRequest(http.MethodPost, "/api/listmonk/health", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
	if rec.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("allow = %q, want GET", rec.Header().Get("Allow"))
	}
	if !strings.Contains(rec.Body.String(), "method_not_allowed") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestRedactURLForLogStripsCredentials(t *testing.T) {
	got := redactURLForLog("https://user:pass@example.com/api?token=abc&ok=1&secret=s")
	if strings.Contains(got, "user") ||
		strings.Contains(got, "pass") ||
		strings.Contains(got, "abc") ||
		strings.Contains(got, "secret=s") {
		t.Fatalf("sensitive URL material leaked: %s", got)
	}
	if !strings.Contains(got, "ok=1") || !strings.Contains(got, "token=%5Bredacted%5D") {
		t.Fatalf("unexpected redacted URL: %s", got)
	}
}
