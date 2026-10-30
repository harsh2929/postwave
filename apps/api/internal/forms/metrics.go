// SPDX-License-Identifier: AGPL-3.0-only
//
// metrics.go — p4d-recordsurface-wire-others (forms surface).
//
// Forms is unique among the surfaces wired in this task: the public
// submit endpoint (POST /api/public/forms/{slug}/submit) is the
// highest-volume mutating route in the gateway — embedded snippets on
// public marketing pages fan out into thousands of submissions per
// minute during a campaign launch. The default
// `SurfaceHistogramBuckets` (1ms → 2.5s) covers the dynamic range, but
// we want EXTRA bucket resolution below 50 ms so the p99 alert on
// public ingest doesn't bucket-coalesce a 5 ms baseline into the same
// observation as a 49 ms one.
//
// To get custom buckets without forking RecordSurface, we pre-register
// the `pw_forms_duration_seconds` HistogramVec with our tighter bucket
// set BEFORE main.go calls observability.RecordSurfaceFunc("forms",
// ...). Prometheus's collector registry returns the existing collector
// via AlreadyRegisteredError on the second call, so
// MustRegisterSurfaceHistogram becomes a no-op for "forms" and the
// custom buckets win.
//
// The init() runs at package import time which is before main.go wires
// the routes, so the ordering is guaranteed by Go's package
// initialization rules.

package forms

import (
	"fmt"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/observability"
)

// formsHistogramBuckets is the forms-surface-specific bucket override.
// Extra resolution below 50 ms (the public-submit hot path) vs the
// default observability.SurfaceHistogramBuckets. The upper tail
// matches the default so cross-surface dashboard math still works.
var formsHistogramBuckets = []float64{
	0.001, 0.0025, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.025, 0.05,
	0.1, 0.25, 0.5, 1, 2.5,
}

var signupVerificationDecisions = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "postwave_forms_signup_verification_total",
	Help: "Public form signup verification decisions by a closed non-PII outcome; degraded_allowed and error_allowed are fail-open admissions that require operator attention.",
}, []string{"outcome"})

func observeSignupVerificationDecision(outcome string) {
	switch outcome {
	case "bypassed", "allowed", "blocked", "degraded_allowed", "degraded_blocked", "error_allowed":
	default:
		outcome = "error_allowed"
	}
	signupVerificationDecisions.WithLabelValues(outcome).Inc()
}

func init() {
	// Pre-register the forms histogram with the custom buckets. Subsequent
	// MustRegisterSurfaceHistogram("forms", ...) calls return this
	// collector via AlreadyRegisteredError.
	//
	// The Help string MUST be byte-identical to the one
	// MustRegisterSurfaceHistogram generates
	// ("Wall-clock duration of <surface> surface handlers, labelled by handler.")
	// — Prometheus folds Help into the descriptor identity, so any divergence
	// turns the intended AlreadyRegistered no-op into a hard "different help
	// string" registration error that panics the API on boot. Only the buckets
	// (not part of the Desc) may differ; we keep the tighter <50ms buckets for
	// the public-submit hot path here.
	hv := prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "pw_forms_duration_seconds",
			Help:    "Wall-clock duration of forms surface handlers, labelled by handler.",
			Buckets: formsHistogramBuckets,
		},
		observability.SurfaceHistogramMandatoryLabels,
	)
	if err := prometheus.Register(hv); err != nil {
		if _, ok := err.(prometheus.AlreadyRegisteredError); !ok {
			panic(fmt.Errorf("forms: register pw_forms_duration_seconds: %w", err))
		}
	}
}
