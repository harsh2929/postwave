// SPDX-License-Identifier: AGPL-3.0-only
//
// Package apidocs serves the bundled OpenAPI spec from the API
// gateway so the dashboard's in-app playground can render an
// interactive explorer (Swagger-UI-style) without shipping the
// spec into the desktop bundle.
//
// The spec is generated at build time from chi route discovery
// (packages/openapi/scripts/regenerate.go); we mirror the canonical
// JSON into this binary via go:embed and serve it at
// /api/v1/openapi.json behind tenant authentication with a private,
// no-store cache boundary.
//
// Why mirror instead of read-from-disk: the API container ships
// without the source tree mounted; embedding makes the endpoint
// work in production without filesystem assumptions.

package apidocs

import (
	_ "embed"
	"net/http"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// SpecJSON is the canonical OpenAPI spec bundled at build time.
// Mirrored from packages/openapi/openapi.json via a build script
// (see packages/openapi/scripts/regenerate.go for the generator;
// the regenerator writes both .yaml + .json, and we embed the json).
//
//go:embed openapi.json
var SpecJSON []byte

const specPath = "/api/v1/openapi.json"

const (
	// SessionRateLimitPerMinute is shared by every cookie-session user in the
	// resolved tenant. The artifact is build-wide, so a tenant bucket avoids one
	// browser identity multiplying downloads through many sessions.
	SessionRateLimitPerMinute = 10
	// APIKeyRateLimitPerMinute is the route-local fallback for every verified API
	// key. It is additional to the key's configured global limit, which may be
	// stricter or unset, and is keyed by API-key ID rather than tenant.
	APIKeyRateLimitPerMinute = 30
)

// Deps wires the spec handler. SessionRateLimit is mounted only for
// cookie-session callers. APIKeyRateLimit is a route-local per-key fallback
// mounted in addition to the authenticated stack's configured per-key limiter;
// API keys are never charged against the tenant session bucket.
type Deps struct {
	APIKeyRateLimit  func(http.Handler) http.Handler
	SessionRateLimit func(http.Handler) http.Handler
}

// Mount registers /api/v1/openapi.json on a chi.Router. Caller is
// expected to have applied a tenant gate upstream — the spec itself
// has no tenant data, but rate-limiting via the existing chain keeps
// abuse manageable.
func (d *Deps) Mount(mux interface {
	Get(string, http.HandlerFunc)
}) {
	mux.Get(specPath, d.GetSpec)
}

// ProtectResponses stamps the private artifact boundary before authentication,
// tenant resolution, per-key metering, or route authorization can refuse the
// request. It is deliberately path-scoped so unrelated authenticated responses
// retain their own cache policy.
func ProtectResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isSpecPath(r) {
			next.ServeHTTP(w, r)
			return
		}
		protected := &responseWriter{ResponseWriter: w}
		prepareResponse(protected)
		// This artifact is never revalidated. Removing conditional validators also
		// prevents a generic cache layer from replacing an authenticated body with
		// a credential-dependent 304.
		r.Header.Del("If-None-Match")
		r.Header.Del("If-Modified-Since")
		next.ServeHTTP(protected, r)
	})
}

func isSpecPath(r *http.Request) bool {
	if r == nil || r.URL == nil {
		return false
	}
	return strings.TrimSuffix(r.URL.Path, "/") == specPath
}

// GetSpec serves the embedded JSON spec. The document is large enough that a
// signed-in browser repeatedly fetching it needs a route-local availability
// boundary. API-key requests retain their configured outer limit and cross the
// route-local key fallback below; they never consume the session tenant bucket.
func (d *Deps) GetSpec(w http.ResponseWriter, r *http.Request) {
	handler := http.HandlerFunc(d.serveSpec)
	if middleware.IsAPIKeyAuth(r.Context()) {
		if middleware.APIKeyIDFromContext(r.Context()) == "" {
			writeRateLimitUnavailable(w, "api_docs_rate_limit_identity_unavailable", "API-key rate-limit identity unavailable")
			return
		}
		if d == nil || d.APIKeyRateLimit == nil {
			writeRateLimitUnavailable(w, "api_docs_rate_limit_unavailable", "API-key route limit unavailable")
			return
		}
		d.APIKeyRateLimit(handler).ServeHTTP(w, r)
		return
	}
	if d == nil || d.SessionRateLimit == nil {
		writeRateLimitUnavailable(w, "api_docs_rate_limit_unavailable", "session route limit unavailable")
		return
	}
	d.SessionRateLimit(handler).ServeHTTP(w, r)
}

func writeRateLimitUnavailable(w http.ResponseWriter, code, message string) {
	prepareResponse(w)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = w.Write([]byte(`{"error":{"code":"` + code + `","message":"` + message + `"}}`))
}

func (d *Deps) serveSpec(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	// The document exposes the build-wide route surface and is mounted behind
	// tenant authentication. Never let a shared cache replay one authenticated
	// caller's response to an anonymous request or a different workspace.
	prepareResponse(w)
	if len(SpecJSON) == 0 {
		http.Error(w, `{"error":{"code":"spec_missing","message":"openapi.json was not bundled into this build"}}`,
			http.StatusInternalServerError)
		return
	}
	// The authenticated stack's generic conditional middleware buffers ordinary
	// GETs before it discovers this handler's no-store policy. Flush the headers
	// first so the multi-megabyte build artifact streams through that boundary
	// instead of being copied into a second in-memory response buffer.
	_ = http.NewResponseController(w).Flush()
	_, _ = w.Write(SpecJSON)
}

func prepareResponse(w http.ResponseWriter) {
	header := w.Header()
	header.Set("Cache-Control", "private, no-store")
	header.Set("Pragma", "no-cache")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Del("ETag")
	header.Del("Last-Modified")
	header.Del("Expires")
	addVaryDimensions(header, "Authorization", "Cookie")
}

// responseWriter reasserts the artifact policy at commit time. Shared auth and
// error writers are allowed to set their content type/status, but cannot weaken
// the no-store or credential-variance boundary.
type responseWriter struct{ http.ResponseWriter }

func (w *responseWriter) WriteHeader(status int) {
	prepareResponse(w.ResponseWriter)
	w.ResponseWriter.WriteHeader(status)
}

func (w *responseWriter) Write(body []byte) (int, error) {
	prepareResponse(w.ResponseWriter)
	return w.ResponseWriter.Write(body)
}

func (w *responseWriter) Flush() {
	prepareResponse(w.ResponseWriter)
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *responseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func addVaryDimensions(header http.Header, dimensions ...string) {
	existing := make([]string, 0, len(dimensions)+1)
	seen := make(map[string]struct{}, len(dimensions)+1)
	for _, line := range header.Values("Vary") {
		for _, raw := range strings.Split(line, ",") {
			value := strings.TrimSpace(raw)
			if value == "" {
				continue
			}
			key := strings.ToLower(value)
			if _, duplicate := seen[key]; duplicate {
				continue
			}
			seen[key] = struct{}{}
			existing = append(existing, value)
		}
	}
	for _, value := range dimensions {
		key := strings.ToLower(value)
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		existing = append(existing, value)
	}
	header.Set("Vary", strings.Join(existing, ", "))
}
