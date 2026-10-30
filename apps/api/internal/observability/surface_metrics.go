// SPDX-License-Identifier: AGPL-3.0-only
//
// surface_metrics.go — Phase 1a cross-cutting helpers for the
// standardized `pw_<surface>_<action>_total` + `pw_<surface>_duration_seconds`
// metric family.
//
// Background: the Klaviyo/Mailchimp parity audit (Phase 0/1) flagged
// that each new surface (subscribers, segments, campaigns, automations,
// auditsink, etc.) hand-rolls its own Prometheus counter + histogram
// pair using slightly different name conventions. That works for the
// existing tier-1 surfaces (`postwave_tier1_*` in tier1_metrics.go) and
// the STO/archive surfaces (`sto_*`, `archive_*` in sto_archive_metrics.go),
// but it makes Grafana dashboards and burn-rate alerts harder to
// generalize across the platform.
//
// This file ships the cross-cutting helpers that let new surfaces
// register a standardized counter+histogram pair in one line:
//
//	var subsListCounter = observability.MustRegisterSurfaceCounter(
//	    "subscribers", "list", "outcome", "reason",
//	)
//	var subsListLatency = observability.MustRegisterSurfaceHistogram(
//	    "subscribers", "list",
//	)
//
// …and then wire `observability.RecordSurface("subscribers", "list",
// handler)` around the http.Handler to get request-count + duration
// for free, with a consistent `pw_*` naming.
//
// Why a new prefix (`pw_`) instead of reusing `postwave_*`:
//
//   - The existing `postwave_tier1_*` and `sto_*` families are kept
//     intact; nothing in this file rewrites those — that's Phase 1b's
//     job (the per-surface migration sweep).
//   - `pw_` is the short prefix the Phase 1 plan settled on after the
//     gap-audit conversation: every new surface emits `pw_<surface>_*`
//     so a single dashboard regex (`{__name__=~"pw_.*"}`) groups them.
//
// Conventions enforced by this file:
//
//   - Counter names: `pw_<surface>_<action>_total`. Mandatory labels:
//     `outcome` (`ok|error|<custom>`) + `reason` (free-form, low
//     cardinality — e.g. `not_found`, `rate_limited`, `validation`).
//     Additional labels can be appended via the variadic `labelKeys`.
//   - Histogram names: `pw_<surface>_duration_seconds`. Mandatory
//     label: `handler` (the route/handler name — e.g. `list`, `create`,
//     `bulk_update`). One histogram per surface, multiplexed across
//     handlers via the label.
//   - Buckets: a single Prometheus-recommended bucket set tuned for
//     the editor-preview-fast (~1ms) through bulk-update-slow (~2.5s)
//     range. Matches Tier1RequestLatency for cross-dashboard math.
//   - No raw tenant_id labels. Per-tenant attribution lives in the
//     structured log + audit_log table, NOT Prometheus.

package observability

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// SurfaceHistogramBuckets is the canonical bucket set for the
// `pw_<surface>_duration_seconds` histogram family. Calibrated for:
//
//   - 1 ms — editor-preview fast path (EQ-score, cached lookups)
//   - 10 ms — typical read endpoint (a single indexed query)
//   - 100 ms — typical write endpoint (one INSERT + one audit_log row)
//   - 1 s — heavy aggregate (segment counts, analytics rollups)
//   - 2.5 s — bulk operation (CSV import preview, dedupe sweep)
//
// Anything beyond 2.5 s is rolled into the `+Inf` bucket — those are
// long-tail outliers that should be tracked via the per-job worker
// metrics, not the surface latency histogram.
var SurfaceHistogramBuckets = []float64{
	0.001, 0.005, 0.01, 0.025, 0.05,
	0.1, 0.25, 0.5, 1, 2.5,
}

// SurfaceCounterMandatoryLabels are the labels every surface counter
// MUST carry. Callers can append additional labels via the variadic
// `labelKeys` argument to MustRegisterSurfaceCounter, but `outcome`
// and `reason` are reserved as the first two label positions so the
// dashboard query templates can always project them out.
var SurfaceCounterMandatoryLabels = []string{"outcome", "reason"}

// SurfaceHistogramMandatoryLabels are the labels every surface
// histogram MUST carry. Only `handler` for now — adding more later
// is a breaking change (Prometheus rejects label-set mismatches on
// scrape), so we keep it tight.
var SurfaceHistogramMandatoryLabels = []string{"handler"}

// MustRegisterSurfaceCounter registers (or returns) a
// `pw_<surface>_<action>_total` CounterVec with the standardized
// `outcome` + `reason` labels (plus any additional `labelKeys`).
//
// `surface` is the high-level domain (e.g. "subscribers", "segments",
// "campaigns", "automations"). `action` is the verb (e.g. "list",
// "create", "delete", "bulk_update").
//
// Both must be snake_case and Prometheus-name-safe (lowercase letters,
// digits, underscores). Empty values panic — there's no sensible
// default, and a silent fallback would produce a metric like
// `pw__total` that hides the wiring bug.
//
// If a counter with the same name is already registered (e.g. two
// packages call this with the same surface/action pair), the existing
// vector is returned via prometheus.AlreadyRegisteredError. This
// makes the helper safe to call from package-level `var` blocks
// across multiple files in the same surface.
func MustRegisterSurfaceCounter(surface, action string, labelKeys ...string) *prometheus.CounterVec {
	if err := validateNamePart("surface", surface); err != nil {
		panic(err)
	}
	if err := validateNamePart("action", action); err != nil {
		panic(err)
	}

	name := fmt.Sprintf("pw_%s_%s_total", surface, action)
	labels := append([]string{}, SurfaceCounterMandatoryLabels...)
	labels = append(labels, labelKeys...)

	cv := prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: name,
			Help: fmt.Sprintf("Count of %s.%s operations, labelled by outcome and reason.", surface, action),
		},
		labels,
	)

	if err := prometheus.Register(cv); err != nil {
		if are, ok := err.(prometheus.AlreadyRegisteredError); ok {
			if existing, ok := are.ExistingCollector.(*prometheus.CounterVec); ok {
				return existing
			}
		}
		panic(fmt.Errorf("observability: register %s: %w", name, err))
	}
	return cv
}

// MustRegisterSurfaceHistogram registers (or returns) a
// `pw_<surface>_duration_seconds` HistogramVec with a single `handler`
// label and the canonical SurfaceHistogramBuckets.
//
// IMPORTANT: there is one histogram PER SURFACE — not per
// (surface, handler) pair. `handler` is the label that multiplexes
// observations from many handlers into the same time series family.
// This keeps the metric count bounded (one histogram per surface)
// while still letting dashboards drill in by handler name.
//
// The `handler` argument here is the canonical handler name for the
// surface (e.g. "list", "create"). It's used to set the help text and
// to seed the first time-series; subsequent calls with a different
// handler value on the same surface return the same vector. (The
// histogram is keyed only by `<surface>`, not `<surface, handler>`,
// because the label provides the multiplexing — see RecordSurface.)
func MustRegisterSurfaceHistogram(surface, handler string) *prometheus.HistogramVec {
	if err := validateNamePart("surface", surface); err != nil {
		panic(err)
	}
	if err := validateNamePart("handler", handler); err != nil {
		panic(err)
	}

	name := fmt.Sprintf("pw_%s_duration_seconds", surface)
	hv := prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    name,
			Help:    fmt.Sprintf("Wall-clock duration of %s surface handlers, labelled by handler.", surface),
			Buckets: SurfaceHistogramBuckets,
		},
		SurfaceHistogramMandatoryLabels,
	)

	if err := prometheus.Register(hv); err != nil {
		if are, ok := err.(prometheus.AlreadyRegisteredError); ok {
			if existing, ok := are.ExistingCollector.(*prometheus.HistogramVec); ok {
				return existing
			}
		}
		panic(fmt.Errorf("observability: register %s: %w", name, err))
	}
	return hv
}

// RecordSurface wraps an http.Handler with the standardized
// `pw_<surface>_<action>_total` + `pw_<surface>_duration_seconds`
// instrumentation pair.
//
// The action used for the counter is the same as the `handler` label
// on the histogram — i.e. one wrapper call records both metrics in
// lockstep. Outcome is derived from the response status: `ok` for
// 2xx/3xx, `error` for 4xx/5xx. Reason is left empty by default; the
// downstream handler can override it by writing to the
// `surfaceRecorder` via the context key (advanced — most callers just
// accept the default).
//
// For more fine-grained control (e.g. recording a custom reason
// label, or emitting the counter from inside a non-http worker),
// callers should grab the underlying CounterVec/HistogramVec via
// MustRegisterSurfaceCounter / MustRegisterSurfaceHistogram and call
// `.WithLabelValues(...).Inc()` / `.Observe(...)` directly.
func RecordSurface(surface, handler string, next http.Handler) http.Handler {
	counter := MustRegisterSurfaceCounter(surface, handler)
	hist := MustRegisterSurfaceHistogram(surface, handler)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		elapsed := time.Since(start).Seconds()
		hist.WithLabelValues(handler).Observe(elapsed)

		outcome := "ok"
		if rec.status >= 400 {
			outcome = "error"
		}
		counter.WithLabelValues(outcome, "").Inc()
	})
}

// RecordSurfaceFunc is the http.HandlerFunc convenience wrapper around
// RecordSurface — mirrors Tier1HandlerFunc for callers that have a
// HandlerFunc rather than a Handler.
func RecordSurfaceFunc(surface, handler string, h http.HandlerFunc) http.HandlerFunc {
	mw := RecordSurface(surface, handler, h)
	return func(w http.ResponseWriter, r *http.Request) {
		mw.ServeHTTP(w, r)
	}
}

// validateNamePart enforces the Prometheus-safe naming rules on the
// surface/action/handler arguments — lowercase letters, digits, and
// underscores only, must be non-empty. Returns a descriptive error
// rather than panicking so callers can wrap it.
//
// We deliberately reject hyphens and dots: Prometheus accepts them in
// label *values* but not in metric *name* segments, and the helper
// composes the name as `pw_<surface>_<action>_total` directly.
func validateNamePart(kind, value string) error {
	if value == "" {
		return fmt.Errorf("observability: %s is required", kind)
	}
	for i, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '_':
		default:
			return fmt.Errorf("observability: %s %q contains invalid character %q at position %d (lowercase a-z, 0-9, _ only)", kind, value, string(r), i)
		}
	}
	if strings.HasPrefix(value, "_") || strings.HasSuffix(value, "_") {
		return fmt.Errorf("observability: %s %q must not start or end with underscore", kind, value)
	}
	return nil
}
