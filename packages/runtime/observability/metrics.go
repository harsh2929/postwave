package observability

import (
	"crypto/sha256"
	"crypto/subtle"
	"net"
	"net/http"
	"strings"
)

// ProtectMetrics permits a scrape only from the direct loopback peer or with
// the dedicated bearer token. Forwarded headers are intentionally ignored:
// only the HTTP server's untouched RemoteAddr is a trust input.
func ProtectMetrics(token string, next http.Handler) http.Handler {
	if next == nil {
		next = http.NotFoundHandler()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if !MetricsRequestAllowed(r, token) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// MetricsRequestAllowed is exported so services can exercise the exact
// access policy without copying it. An empty token makes access loopback-only.
func MetricsRequestAllowed(r *http.Request, token string) bool {
	if r == nil {
		return false
	}
	if isDirectLoopback(r.RemoteAddr) {
		return true
	}
	if token == "" {
		return false
	}
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		return false
	}
	fields := strings.Fields(values[0])
	if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
		return false
	}
	provided := sha256.Sum256([]byte(fields[1]))
	expected := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(provided[:], expected[:]) == 1
}

func isDirectLoopback(remoteAddress string) bool {
	host := strings.TrimSpace(remoteAddress)
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		host = parsedHost
	}
	host = strings.Trim(host, "[]")
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
