// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"net/http"
	"strings"
	"sync"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ProtectPlaygroundResponses installs the simulator's private boundary before
// authentication. Fire receipts may contain submitted payloads, a safe preview
// of receiver output, and a request-bound signature; catalog/auth/error/replay
// outcomes share the same non-cacheable contract so a proxy cannot retain a
// credential-dependent response.
func ProtectPlaygroundResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isPlaygroundPath(r) {
			next.ServeHTTP(w, r)
			return
		}
		protected := &playgroundResponseWriter{ResponseWriter: w}
		preparePlaygroundResponse(protected)
		r.Header.Del("If-None-Match")
		r.Header.Del("If-Modified-Since")
		next.ServeHTTP(protected, r)
	})
}

func isPlaygroundPath(r *http.Request) bool {
	if r == nil || r.URL == nil {
		return false
	}
	path := strings.TrimSuffix(r.URL.Path, "/")
	return path == "/api/v1/outbound-webhooks/playground/events" ||
		path == "/api/v1/outbound-webhooks/playground/fires" ||
		strings.HasPrefix(path, "/api/v1/outbound-webhooks/playground/fires/") ||
		(strings.HasPrefix(path, "/api/v1/outbound-webhooks/") &&
			strings.HasSuffix(path, "/playground/fire"))
}

func preparePlaygroundResponse(w http.ResponseWriter) {
	header := w.Header()
	header.Set("Cache-Control", "private, no-store")
	header.Set("Pragma", "no-cache")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Del("ETag")
	header.Del("Last-Modified")
	header.Del("Expires")
	addPlaygroundVary(header, "Authorization")
	addPlaygroundVary(header, "Cookie")
}

func addPlaygroundVary(header http.Header, value string) {
	for _, line := range header.Values("Vary") {
		for _, existing := range strings.Split(line, ",") {
			if strings.EqualFold(strings.TrimSpace(existing), value) {
				return
			}
		}
	}
	header.Add("Vary", value)
}

type playgroundResponseWriter struct{ http.ResponseWriter }

func (w *playgroundResponseWriter) WriteHeader(status int) {
	preparePlaygroundResponse(w.ResponseWriter)
	w.ResponseWriter.WriteHeader(status)
}

func (w *playgroundResponseWriter) Write(body []byte) (int, error) {
	preparePlaygroundResponse(w.ResponseWriter)
	return w.ResponseWriter.Write(body)
}

func (w *playgroundResponseWriter) Flush() {
	preparePlaygroundResponse(w.ResponseWriter)
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *playgroundResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

type playgroundRateAdmissionContextKey struct{}

// PlaygroundRateGovernor admits an authenticated simulator fire to its
// distributed tenant budget, and to its API-key budget when applicable. It is
// intentionally mounted before step-up and idempotency so rejected callers do
// not make the server retain and hash a request body first. The route-local
// wrapper repeats this check for standalone router compositions and observes
// the context marker to avoid charging the same request twice in the API.
func PlaygroundRateGovernor(
	tenantLimit, apiKeyLimit func(http.Handler) http.Handler,
) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !HandlerOwnedPlaygroundFireReplay(r, nil) {
				next.ServeHTTP(w, r)
				return
			}
			servePlaygroundRateAdmission(w, r, tenantLimit, apiKeyLimit, next)
		})
	}
}

func servePlaygroundRateAdmission(
	w http.ResponseWriter,
	r *http.Request,
	tenantLimit, apiKeyLimit func(http.Handler) http.Handler,
	next http.Handler,
) {
	if playgroundRateAdmitted(r.Context()) {
		next.ServeHTTP(w, r)
		return
	}
	if tenantLimit == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv(
			"playground_rate_limit_unavailable",
			"webhook simulator tenant rate limiting is unavailable",
		))
		return
	}

	admitted := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), playgroundRateAdmissionContextKey{}, true)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
	handler := tenantLimit(admitted)
	if middleware.IsAPIKeyAuth(r.Context()) {
		if middleware.APIKeyIDFromContext(r.Context()) == "" || apiKeyLimit == nil {
			writeJSON(w, http.StatusServiceUnavailable, errEnv(
				"playground_rate_limit_unavailable",
				"webhook simulator API-key rate limiting is unavailable",
			))
			return
		}
		handler = apiKeyLimit(handler)
	}
	handler.ServeHTTP(w, r)
}

func playgroundRateAdmitted(ctx context.Context) bool {
	admitted, _ := ctx.Value(playgroundRateAdmissionContextKey{}).(bool)
	return admitted
}

// PlaygroundConcurrencyLimit is a per-process, per-tenant non-blocking
// semaphore. The distributed fixed-window rate limit bounds the deployment;
// this gate additionally prevents one tenant from occupying every outbound
// connection on a replica at once.
type PlaygroundConcurrencyLimit struct {
	max int
	mu  sync.Mutex
	in  map[string]int
}

func NewPlaygroundConcurrencyLimit(max int) *PlaygroundConcurrencyLimit {
	if max < 1 {
		max = 1
	}
	return &PlaygroundConcurrencyLimit{max: max, in: make(map[string]int)}
}

func (l *PlaygroundConcurrencyLimit) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tenant, ok := middleware.TenantFromContext(r.Context())
		if !ok || tenant == nil || strings.TrimSpace(tenant.ID) == "" {
			writeJSON(w, http.StatusServiceUnavailable, errEnv(
				"playground_concurrency_identity_unavailable",
				"webhook simulator tenant identity is unavailable",
			))
			return
		}
		if !l.acquire(tenant.ID) {
			writePlaygroundConcurrencyDenial(w)
			return
		}
		defer l.release(tenant.ID)
		next.ServeHTTP(w, r)
	})
}

func writePlaygroundConcurrencyDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject:           "webhook_playground",
		Reason:            entitlement.ReasonQuota,
		Code:              "playground_concurrency_limited",
		Message:           "another webhook simulator delivery is still running; retry after it finishes",
		Resource:          "concurrent_simulator_deliveries",
		RetryAfterSeconds: 5,
	})
}

func (l *PlaygroundConcurrencyLimit) acquire(tenantID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.in[tenantID] >= l.max {
		return false
	}
	l.in[tenantID]++
	return true
}

func (l *PlaygroundConcurrencyLimit) release(tenantID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.in[tenantID] <= 1 {
		delete(l.in, tenantID)
		return
	}
	l.in[tenantID]--
}
