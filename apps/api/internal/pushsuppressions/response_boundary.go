// SPDX-License-Identifier: AGPL-3.0-only

package pushsuppressions

import (
	"net/http"
	"strings"
)

// ProtectRoute43Responses stamps the complete Route43 path family before
// credential parsing, tenant resolution, CSRF, client-version, idempotency,
// body-limit, or exact-admin middleware can refuse the request. Route-local
// ProtectResponses remains mounted as defense in depth for standalone routers.
func ProtectRoute43Responses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isRoute43Path(r) {
			next.ServeHTTP(w, r)
			return
		}
		protected := &privateResponseWriter{ResponseWriter: w}
		preparePrivateResponse(protected)
		// Restamp while unwinding so a recoverer outside this guard cannot
		// accidentally commit weaker cache metadata for an inner panic.
		defer preparePrivateResponse(w)
		next.ServeHTTP(protected, r)
	})
}

func isRoute43Path(r *http.Request) bool {
	if r == nil || r.URL == nil {
		return false
	}
	const base = "/api/v1/push/suppressions"
	path := strings.TrimSuffix(r.URL.Path, "/")
	return path == base || strings.HasPrefix(path, base+"/")
}
