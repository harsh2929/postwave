// SPDX-License-Identifier: AGPL-3.0-only
//
// origin_csrf_test.go — coverage for the Origin/CSRF allow-list gate,
// including the native-client (mobile/desktop) header exemption.
//
// Why the exemption is CSRF-safe: a browser cannot attach a custom
// request header (X-Postwave-Client) to a cross-origin request without
// triggering a CORS preflight, and the same origin allow-list governs
// preflight. So a request that carries the trusted client header could
// not have come from a malicious website's form/simple-fetch — it came
// from a native app (RN/Tauri) that has no ambient-cookie CSRF surface.
package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

// sessionPost builds a state-changing request carrying the pw_session
// cookie, with optional Origin and client headers.
func sessionPost(origin, client string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers", nil)
	r.AddCookie(&http.Cookie{Name: "pw_session", Value: "sess-abc"})
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if client != "" {
		r.Header.Set("X-Postwave-Client", client)
	}
	return r
}

func TestAllowedOriginsCSRF_NativeClientHeaderExempt(t *testing.T) {
	mw := AllowedOriginsCSRF([]string{"https://app.moosewave.com"})
	for _, client := range []string{"mobile", "desktop"} {
		rec := httptest.NewRecorder()
		// Native client: session cookie, NO Origin, but trusted client header.
		mw(okHandler()).ServeHTTP(rec, sessionPost("", client))
		if rec.Code != http.StatusOK {
			t.Fatalf("client %q: got %d, want 200 (native client must be exempt from origin gate)", client, rec.Code)
		}
	}
}

func TestAllowedOriginsCSRF_BrowserStillNeedsOrigin(t *testing.T) {
	mw := AllowedOriginsCSRF([]string{"https://app.moosewave.com"})

	// No Origin, no client header → still rejected (browser CSRF surface).
	rec := httptest.NewRecorder()
	mw(okHandler()).ServeHTTP(rec, sessionPost("", ""))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("missing-origin browser request: got %d, want 403", rec.Code)
	}

	// Unknown client header value must NOT open the gate.
	rec = httptest.NewRecorder()
	mw(okHandler()).ServeHTTP(rec, sessionPost("", "evil"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("unknown client header: got %d, want 403", rec.Code)
	}

	// A valid allow-listed Origin still works as before.
	rec = httptest.NewRecorder()
	mw(okHandler()).ServeHTTP(rec, sessionPost("https://app.moosewave.com", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("allow-listed origin: got %d, want 200", rec.Code)
	}
}

func TestAllowedOriginsCSRF_MixedCookieAndForgedBearerStillNeedsOrigin(t *testing.T) {
	mw := AllowedOriginsCSRF([]string{"https://app.moosewave.com"})
	req := sessionPost("", "")
	req.Header.Set("Authorization", "Bearer x")
	rec := httptest.NewRecorder()
	mw(okHandler()).ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("mixed cookie/forged bearer status=%d, want 403", rec.Code)
	}
}

func TestAllowedOriginsCSRF_APIKeyOnlyRequestHasNoAmbientCookie(t *testing.T) {
	mw := AllowedOriginsCSRF([]string{"https://app.moosewave.com"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers", nil)
	req.Header.Set("Authorization", "Bearer pw_test")
	rec := httptest.NewRecorder()
	mw(okHandler()).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("cookie-free API request status=%d, want 200", rec.Code)
	}
}

func TestAllowedOriginsCSRF_WildcardDoesNotDisableCookieProtection(t *testing.T) {
	mw := AllowedOriginsCSRF([]string{"*"})
	rec := httptest.NewRecorder()
	mw(okHandler()).ServeHTTP(rec, sessionPost("https://evil.example", ""))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("wildcard configuration status=%d, want fail-closed 403", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control=%q, want no-store", got)
	}
}

func TestAllowedOriginsCSRF_EmptyConfigurationIsExplicitlyDisabled(t *testing.T) {
	rec := httptest.NewRecorder()
	AllowedOriginsCSRF(nil)(okHandler()).ServeHTTP(rec, sessionPost("", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("empty development configuration status=%d, want 200", rec.Code)
	}
}
