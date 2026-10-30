// SPDX-License-Identifier: AGPL-3.0-only
//
// admin_ip_allowlist.go — per-tenant IP allowlist for admin-scoped
// requests.
//
// When a tenant configures tenants.admin_ip_allowlist with one or
// more IPs / CIDRs, every admin-scoped request must originate from
// a matching IP. Empty allowlist = no restriction (backward
// compatible). The middleware applies AFTER TenantMiddleware (so
// tenant is on ctx) but BEFORE the route handler.
//
// We deliberately scope this to ADMIN requests only — read-reports
// + send-* scopes still work from anywhere so customers' SDKs
// embedded in their app servers don't break.
//
// The middleware is wired in main.go via:
//
//   r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
//     Use(middleware.AdminIPAllowlist(lookup)).
//     Get("/api/v1/dangerous", handler)
//
// Or globally on the admin sub-router. Either is fine; the
// per-route wrap is preferred to keep the rest of the router
// untouched.

package middleware

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strings"
)

// LookupAdminAllowlist is the function signature the middleware
// takes for fetching the tenant's allowlist. Same pattern as
// regions.LookupTenantRegion — keeps this package free of the db
// import + simplifies tests.
type LookupAdminAllowlist func(ctx context.Context, tenantID string) ([]string, error)

type AdminIPAllowlistOptions struct {
	TrustForwardedIPHeaders bool
	// Applies limits the lookup/enforcement to privileged principals. When nil,
	// the gate applies to every tenant-authenticated request.
	Applies func(context.Context) bool
}

// AdminIPAllowlist returns a middleware that 403s admin requests
// from non-allowlisted IPs.
//
// Empty allowlist = pass through. Lookup error = fail closed with 503.
// Client IP resolution delegates to ResolveClientIP: forwarded headers are
// accepted only from a configured trusted proxy and XFF is walked from the
// right across known proxy hops. Direct callers cannot self-assert an
// allowlisted address in X-Forwarded-For.
func AdminIPAllowlist(lookup LookupAdminAllowlist) func(http.Handler) http.Handler {
	return AdminIPAllowlistWithOptions(lookup, AdminIPAllowlistOptions{})
}

func AdminIPAllowlistWithOptions(lookup LookupAdminAllowlist, opts AdminIPAllowlistOptions) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t, ok := TenantFromContext(r.Context())
			if !ok || t == nil {
				// Unauthenticated request — let the downstream auth
				// chain reject. Don't pre-empt with a 403 here.
				next.ServeHTTP(w, r)
				return
			}
			if opts.Applies != nil && !opts.Applies(r.Context()) {
				next.ServeHTTP(w, r)
				return
			}
			if lookup == nil {
				writeAllowlistErr(w, http.StatusServiceUnavailable,
					"ip_allowlist_unavailable", "IP allowlist enforcement is unavailable")
				return
			}
			allowlist, err := lookup(r.Context(), t.ID)
			if err != nil {
				writeAllowlistErr(w, http.StatusServiceUnavailable,
					"ip_allowlist_lookup_failed", "IP allowlist policy could not be verified")
				return
			}
			if len(allowlist) == 0 {
				next.ServeHTTP(w, r)
				return
			}
			clientIP := ResolveClientIPString(r, opts.TrustForwardedIPHeaders)
			if clientIP == "" {
				writeAllowlistErr(w, http.StatusForbidden,
					"ip_allowlist_no_client_ip",
					"could not resolve request IP for allowlist check")
				return
			}
			if !ipMatches(clientIP, allowlist) {
				writeAllowlistErr(w, http.StatusForbidden,
					"ip_not_allowed",
					"this admin request is not from an allowlisted IP")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// (Removed) ResolveClientIP — the package-wide ResolveClientIP /
// ResolveClientIPString helpers now live in client_ip.go (Phase 1 —
// single source of truth). Callers should use
// middleware.ResolveClientIPString(r, trustHeaders).

// IPMatchesAllowlist is the exported alias of ipMatches. Each entry
// in `allowlist` is either a single IP or a CIDR; malformed entries
// are silently skipped so a typo doesn't lock everyone out.
func IPMatchesAllowlist(clientIP string, allowlist []string) bool {
	return ipMatches(clientIP, allowlist)
}

// ipMatches reports whether the given IP is in the allowlist. Each
// allowlist entry is either a single IP or a CIDR. Invalid entries
// silently skip (so a typo doesn't lock everyone out — but it does
// fail to admit anyone who would otherwise have matched).
func ipMatches(clientIP string, allowlist []string) bool {
	parsed := net.ParseIP(clientIP)
	if parsed == nil {
		return false
	}
	for _, entry := range allowlist {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if strings.Contains(entry, "/") {
			_, cidr, err := net.ParseCIDR(entry)
			if err != nil {
				continue
			}
			if cidr.Contains(parsed) {
				return true
			}
		} else {
			other := net.ParseIP(entry)
			if other == nil {
				continue
			}
			if other.Equal(parsed) {
				return true
			}
		}
	}
	return false
}

func writeAllowlistErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}
