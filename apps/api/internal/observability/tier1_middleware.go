// SPDX-License-Identifier: AGPL-3.0-only
//
// tier1_middleware.go — instrument tier-1 surface handlers.

package observability

import (
	"net/http"
	"strconv"
	"time"
)

// statusRecorder captures the response status so the middleware can
// label its counter. We don't sniff the body — just the status code,
// which is enough for the dashboards we care about.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Flush forwards through the writer chain so instrumented streaming
// handlers still reach the client.
func (s *statusRecorder) Flush() {
	_ = http.NewResponseController(s.ResponseWriter).Flush()
}

// Unwrap exposes the wrapped writer to http.ResponseController.
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// Tier1Middleware wraps an http.Handler with Prometheus
// request-count + latency instrumentation. `surface` is the stable
// metric label (e.g. "agency", "scim", "auditsink", "predict_enrich").
// Avoid using the full URL path — Prometheus cardinality blows up
// fast otherwise.
func Tier1Middleware(surface string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		elapsed := time.Since(start).Seconds()
		Tier1RequestLatency.WithLabelValues(surface).Observe(elapsed)
		Tier1RequestsTotal.WithLabelValues(surface, statusClass(rec.status)).Inc()
	})
}

// Tier1HandlerFunc is the http.HandlerFunc convenience wrapper.
func Tier1HandlerFunc(surface string, h http.HandlerFunc) http.HandlerFunc {
	mw := Tier1Middleware(surface, h)
	return func(w http.ResponseWriter, r *http.Request) {
		mw.ServeHTTP(w, r)
	}
}

// statusClass collapses HTTP statuses into "2xx" / "3xx" / "4xx" /
// "5xx" so the label cardinality stays bounded at 4 even when the
// handler emits dozens of distinct status codes.
func statusClass(code int) string {
	switch {
	case code >= 500:
		return "5xx"
	case code >= 400:
		return "4xx"
	case code >= 300:
		return "3xx"
	case code >= 200:
		return "2xx"
	default:
		return strconv.Itoa(code)
	}
}
