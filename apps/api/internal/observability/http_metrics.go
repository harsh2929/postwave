// SPDX-License-Identifier: AGPL-3.0-only
//
// http_metrics.go — global Prometheus HTTPRequestMetrics middleware.
//
// Emits two metrics for every request that flows through the chi
// router:
//
//   - pw_http_requests_total{method, status_class, route}
//   - pw_http_duration_seconds_bucket{route} (histogram)
//
// `route` is the chi-routed pattern (e.g. "/api/v1/campaigns/{id}"),
// NOT the raw URL.Path. That keeps label cardinality bounded — a
// router with N route templates produces O(N) label combinations
// instead of O(unique-path-strings). Requests that don't match any
// route (404s emitted by r.NotFound) fall back to a single literal
// "__unmatched__" label so we don't accidentally inflate cardinality
// with attacker-provided paths.
//
// Why a SEPARATE middleware from Tier1Middleware: tier-1 is
// surface-scoped (only the new 2026 surfaces). This one is global —
// it's what feeds the platform-wide 5xx-rate alert. Without it, the
// best dashboard signal we have for "is the gateway healthy?" is the
// access-log slog stream, which isn't aggregatable across replicas.

package observability

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// HTTPRequestsTotal counts every request the chi router served,
// labeled by method, status class (2xx/3xx/4xx/5xx) and the matched
// route pattern.
//
// Naming: prefixed `pw_` (Moosewave) so it does not collide with the
// `postwave_` metric family used by tier-1 surface metrics — the two
// live in different dashboards and pw_ is shorter on the wire.
var HTTPRequestsTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "pw_http_requests_total",
		Help: "Total HTTP requests served by the gateway, labeled by method, status class, and matched route pattern.",
	},
	[]string{"method", "status_class", "route"},
)

// HTTPDurationSeconds is the wall-clock duration histogram per route.
// Buckets cover the full gateway spread — sub-ms (cached config
// lookups) up to multi-second (slow upstream forwards / large list
// exports). Match the tier-1 latency histogram on the low end so
// dashboards can overlay them.
var HTTPDurationSeconds = promauto.NewHistogramVec(
	prometheus.HistogramOpts{
		Name:    "pw_http_duration_seconds",
		Help:    "Wall-clock duration of HTTP requests served by the gateway, labeled by matched route pattern.",
		Buckets: []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
	},
	[]string{"route"},
)

// httpStatusRecorder is a minimal http.ResponseWriter shim that
// captures the status code.
//
// It sits BELOW the access-log wrapper — this middleware is mounted on the
// root router, so every handler writes through it — which means the optional
// interfaces the writers underneath provide are only reachable through it.
// Unwrap hands http.ResponseController the next writer, so Flush,
// SetWriteDeadline and Hijack all reach net/http; Flush is declared as well so
// a handler (or a wrapper further in) that asserts http.Flusher still finds
// one. Without both, every Server-Sent Events flush stopped here and the
// stream sat in net/http's buffer until the write timeout killed it.
type httpStatusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (s *httpStatusRecorder) WriteHeader(code int) {
	if !s.wroteHeader {
		s.status = code
		s.wroteHeader = true
	}
	s.ResponseWriter.WriteHeader(code)
}

// Write captures an implicit 200 if WriteHeader was never called.
// net/http does this automatically on the underlying writer; we
// mirror it so the recorder's `status` field is correct even when
// the handler skipped WriteHeader.
func (s *httpStatusRecorder) Write(b []byte) (int, error) {
	if !s.wroteHeader {
		s.status = http.StatusOK
		s.wroteHeader = true
	}
	return s.ResponseWriter.Write(b)
}

// Flush sends buffered bytes to the client. A flush before any write commits
// an implicit 200, so the recorder notes it the same way Write does.
func (s *httpStatusRecorder) Flush() {
	if !s.wroteHeader {
		s.status = http.StatusOK
		s.wroteHeader = true
	}
	_ = http.NewResponseController(s.ResponseWriter).Flush()
}

// Unwrap exposes the wrapped writer to http.ResponseController.
func (s *httpStatusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// HTTPRequestMetrics is a chi-compatible middleware that emits
// pw_http_requests_total and pw_http_duration_seconds for every
// request. Mount it at the router root, BEFORE any route-specific
// middleware, so unhandled panics that bubble up to jsonRecoverer
// still get counted with status 500.
//
// Note on ordering: this MUST be registered AFTER chimiddleware.Recoverer/
// jsonRecoverer so that recovered panics produce a proper status code
// for the recorder to capture. In main.go that's the case — recoverer
// runs above, then the request reaches this middleware which writes
// the final status before returning.
//
// Reading the route pattern AFTER next.ServeHTTP is intentional: chi's
// RouteContext is populated as the router descends, so the pattern
// is only stable at the tail of the chain. See the comment on
// (*chi.Context).RoutePattern() for the official guidance.
func HTTPRequestMetrics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &httpStatusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		elapsed := time.Since(start).Seconds()
		route := routePatternFor(r)
		HTTPRequestsTotal.WithLabelValues(r.Method, statusClass(rec.status), route).Inc()
		HTTPDurationSeconds.WithLabelValues(route).Observe(elapsed)
	})
}

// routePatternFor returns the matched chi route template for the
// request, or "__unmatched__" when the request did not resolve to a
// registered route (e.g. 404s). Falling back to a single literal
// keeps cardinality bounded — without it, a scraper hitting random
// paths could explode the `route` label space.
func routePatternFor(r *http.Request) string {
	rctx := chi.RouteContext(r.Context())
	if rctx == nil {
		return "__unmatched__"
	}
	pattern := rctx.RoutePattern()
	if pattern == "" {
		return "__unmatched__"
	}
	return pattern
}
