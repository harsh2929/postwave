// Package internalauth protects sidecar-only HTTP routes.
//
// Token rotation: tokens is a comma-separated list of accepted bearer
// tokens. To rotate, deploy with "old,new" so both work, switch callers
// to "new", then deploy with "new" alone. Zero-downtime.
package internalauth

import (
	"context"
	"crypto/subtle"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

type authModeKey struct{}

const (
	modeBearer   = "bearer"
	modeLoopback = "loopback"
)

// Middleware requires POSTWAVE_INTERNAL_API_TOKEN-style bearer auth when
// the token list is non-empty. tokens may be a single token or a CSV of
// active + previous tokens to support overlap rotation. When the list is
// empty, non-health routes only accept loopback so local dev still works.
func Middleware(tokens string) func(http.Handler) http.Handler {
	accepted := parseTokens(tokens)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if isHealthRoute(r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}
			if len(accepted) > 0 {
				if !hasAcceptedBearerToken(r.Header.Get("Authorization"), accepted) {
					unauthorized(w)
					return
				}
				next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), authModeKey{}, modeBearer)))
				return
			}
			if !isLoopbackRequest(r) {
				unauthorized(w)
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), authModeKey{}, modeLoopback)))
		})
	}
}

// IsInternalBearerAuth reports whether the request passed the configured
// internal bearer token. Gateway routes apply their own user/admin checks
// before forwarding with this token.
func IsInternalBearerAuth(ctx context.Context) bool {
	mode, _ := ctx.Value(authModeKey{}).(string)
	return mode == modeBearer
}

// parseTokens splits a CSV token list and trims/dedups. Empty entries are
// dropped so trailing commas don't accidentally accept the empty string.
func parseTokens(raw string) [][]byte {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	seen := map[string]struct{}{}
	out := make([][]byte, 0, 2)
	for _, p := range strings.Split(raw, ",") {
		t := strings.TrimSpace(p)
		if t == "" {
			continue
		}
		if _, dup := seen[t]; dup {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, []byte(t))
	}
	return out
}

func hasAcceptedBearerToken(header string, accepted [][]byte) bool {
	parts := strings.Fields(header)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return false
	}
	provided := []byte(parts[1])
	// Constant-time compare against every accepted token. We always walk
	// the full list (no short-circuit) so a network observer cannot infer
	// which token matched from response timing.
	matched := 0
	for _, want := range accepted {
		if subtle.ConstantTimeCompare(provided, want) == 1 {
			matched = 1
		}
	}
	return matched == 1
}

func isHealthRoute(path string) bool {
	path = strings.TrimRight(path, "/")
	return path == "/health" || strings.HasSuffix(path, "/health")
}

func isLoopbackRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	return addr.Unmap().IsLoopback()
}

func unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", "Bearer")
	http.Error(w, "unauthorized", http.StatusUnauthorized)
}
