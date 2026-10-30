// SPDX-License-Identifier: AGPL-3.0-only
//
// origin_csrf.go — defense-in-depth Origin allow-list for mutating
// state-changing routes.
//
// The primary CSRF defense is `pw_session` cookie's
// `SameSite=Lax` attribute, which makes modern browsers omit the
// cookie on cross-site POST/PUT/PATCH/DELETE. This middleware adds a
// second layer: any state-changing request that DOES carry the
// pw_session cookie AND whose `Origin` header isn't in the allow-list
// is rejected with 403. The two layers cover slightly different
// attacker capabilities:
//
//   - SameSite=Lax catches the simple form-submit / image-src attack.
//   - Origin allow-list catches a misconfigured client that copies
//     cookies into a hostile origin, OR a future change that
//     accidentally drops SameSite (regression coverage).
//
// Routes NOT affected:
//
//   - Pure GET / HEAD / OPTIONS — no state change.
//   - API-key-only requests without a session cookie — CSRF does not apply.
//     A raw Authorization header is deliberately not an exemption: until the
//     API-key middleware verifies it, it is only attacker-controlled text.
//   - Webhook ingest paths under /api/internal/webhooks/* and
//     /api/public/* — these are intentionally cross-origin and have
//     their own signature/auth gates.

package middleware

import (
	"net/http"
	"strings"
)

// AllowedOriginsCSRF returns a middleware that rejects state-changing
// requests with a session cookie whose `Origin` header isn't in
// allowed. Empty allowed disables the check (dev convenience).
//
// The caller passes the same origin list used for CORS — so the gate
// has the same "what's a legitimate browser origin" definition as the
// CORS layer.
func AllowedOriginsCSRF(allowed []string) func(http.Handler) http.Handler {
	allowSet := make(map[string]struct{}, len(allowed))
	enabled := false
	for _, o := range allowed {
		o = strings.TrimSpace(o)
		if o != "" {
			enabled = true
		}
		if o != "" && o != "*" {
			allowSet[o] = struct{}{}
		}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !enabled {
				next.ServeHTTP(w, r)
				return
			}
			// Only gate state-changing methods.
			switch r.Method {
			case http.MethodGet, http.MethodHead, http.MethodOptions:
				next.ServeHTTP(w, r)
				return
			}
			// Skip routes that are intentionally cross-origin or auth'd
			// by token rather than cookie.
			path := r.URL.Path
			if strings.HasPrefix(path, "/api/public/") ||
				strings.HasPrefix(path, "/api/internal/webhooks/") {
				next.ServeHTTP(w, r)
				return
			}
			if isTrustedNativeClient(r) {
				// Native app (RN mobile / Tauri desktop) authenticating
				// with the pw_session cookie. These clients can't send
				// an Origin (RN's fetch omits it), but they ARE CSRF-safe:
				// a malicious website cannot attach the X-Postwave-Client
				// custom header to a cross-origin request without a CORS
				// preflight, which the same allow-list governs. So the
				// header's presence proves the request did not originate
				// from a browser form / simple-fetch. The value is not a
				// secret — the protection is the browser preflight rule.
				next.ServeHTTP(w, r)
				return
			}
			// At this point: state-changing, not webhook, not bearer.
			// If there's a session cookie present, require a known origin.
			if !hasOriginCSRFSessionCookie(r) {
				next.ServeHTTP(w, r)
				return
			}
			origin := strings.TrimSpace(r.Header.Get("Origin"))
			if origin == "" {
				// Some browsers omit Origin on same-origin POSTs
				// (legacy). Fall back to Referer host.
				if ref := r.Header.Get("Referer"); ref != "" {
					origin = stripPathFromOrigin(ref)
				}
			}
			if origin == "" {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.Header().Set("Cache-Control", "no-store")
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"error":{"code":"missing_origin","message":"state-changing requests with a session cookie must carry an Origin header from a known web origin"}}`))
				return
			}
			if _, ok := allowSet[origin]; !ok {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.Header().Set("Cache-Control", "no-store")
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"error":{"code":"forbidden_origin","message":"origin not allowed for state-changing dashboard requests"}}`))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// trustedNativeClients are the X-Postwave-Client values our first-party
// native apps send. The value is not a secret; the CSRF protection is
// that browsers can't set a custom header cross-origin without a CORS
// preflight (governed by the same origin allow-list).
var trustedNativeClients = map[string]struct{}{
	"mobile":  {},
	"desktop": {},
}

// isTrustedNativeClient reports whether the request carries a recognised
// first-party native-client header, which exempts it from the browser
// Origin/CSRF gate.
func isTrustedNativeClient(r *http.Request) bool {
	c := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Postwave-Client")))
	_, ok := trustedNativeClients[c]
	return ok
}

// hasOriginCSRFSessionCookie reports whether `pw_session` is present.
// Named distinctly from any other hasSessionCookie that may live in
// the package to avoid symbol collision.
func hasOriginCSRFSessionCookie(r *http.Request) bool {
	c, err := r.Cookie("pw_session")
	return err == nil && c != nil && strings.TrimSpace(c.Value) != ""
}

// stripPathFromOrigin reduces "https://app.example.com/some/page?x=1"
// to "https://app.example.com". Used to derive an Origin-equivalent
// from a Referer header.
func stripPathFromOrigin(s string) string {
	idx := strings.Index(s, "://")
	if idx < 0 {
		return ""
	}
	rest := s[idx+3:]
	if slash := strings.Index(rest, "/"); slash >= 0 {
		rest = rest[:slash]
	}
	return s[:idx+3] + rest
}
