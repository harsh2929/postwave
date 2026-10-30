// SPDX-License-Identifier: AGPL-3.0-only

package pii_scanner

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	piiCoverageIntentsClaimed = promauto.NewCounter(prometheus.CounterOpts{
		Name: "postwave_pii_coverage_intents_claimed_total",
		Help: "Total durable shadow-PII scan intents claimed by workers.",
	})
	piiCoverageIntentOutcomes = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_pii_coverage_intent_outcomes_total",
		Help: "Total durable shadow-PII intent completions by closed worker outcome.",
	}, []string{"outcome"})
	piiCoverageIntentDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "postwave_pii_coverage_intent_duration_seconds",
		Help:    "Shadow-PII durable intent processing latency by closed outcome.",
		Buckets: prometheus.DefBuckets,
	}, []string{"outcome"})
	piiCoverageSnapshotFields = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "postwave_pii_coverage_snapshot_fields",
		Help:    "Number of bounded current-profile fields transported for a shadow-PII scan.",
		Buckets: []float64{1, 10, 25, 50, 100, 250, 500, 501},
	})
	piiCoverageSnapshotBytes = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "postwave_pii_coverage_snapshot_bytes",
		Help:    "Bytes transported for one bounded current-profile shadow-PII snapshot.",
		Buckets: []float64{1024, 16 << 10, 64 << 10, 256 << 10, 1 << 20, 2 << 20, 4 << 20},
	})
	piiCoverageSnapshotTruncated = promauto.NewCounter(prometheus.CounterOpts{
		Name: "postwave_pii_coverage_snapshot_truncated_total",
		Help: "Current-profile snapshots quarantined by a field, byte, or storage projection bound.",
	})
	piiCoverageReconciliations = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_pii_coverage_reconciliations_total",
		Help: "Total bounded shadow-PII reconciliation pages by resulting status.",
	}, []string{"status"})
	piiCoverageReconciliationDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "postwave_pii_coverage_reconciliation_duration_seconds",
		Help:    "Shadow-PII reconciliation page latency by resulting status.",
		Buckets: prometheus.DefBuckets,
	}, []string{"status"})
	piiCoverageUnavailable = promauto.NewCounter(prometheus.CounterOpts{
		Name: "postwave_pii_coverage_unavailable_total",
		Help: "Worker ticks skipped because the dedicated shadow-PII detector key was unavailable.",
	})
)

// prometheusCoverageMetrics uses only closed outcome/status labels; tenant and
// subscriber identifiers never enter metrics, keeping cardinality and privacy
// bounded.
type prometheusCoverageMetrics struct{}

func (prometheusCoverageMetrics) IntentClaimed(count int) {
	if count > 0 {
		piiCoverageIntentsClaimed.Add(float64(count))
	}
}

func (prometheusCoverageMetrics) IntentFinished(outcome string, elapsed time.Duration) {
	piiCoverageIntentOutcomes.WithLabelValues(outcome).Inc()
	piiCoverageIntentDuration.WithLabelValues(outcome).Observe(elapsed.Seconds())
}

func (prometheusCoverageMetrics) SnapshotLoaded(fields int, bytes int, truncated bool) {
	piiCoverageSnapshotFields.Observe(float64(fields))
	piiCoverageSnapshotBytes.Observe(float64(bytes))
	if truncated {
		piiCoverageSnapshotTruncated.Inc()
	}
}

func (prometheusCoverageMetrics) ReconciliationFinished(status string, elapsed time.Duration) {
	piiCoverageReconciliations.WithLabelValues(status).Inc()
	piiCoverageReconciliationDuration.WithLabelValues(status).Observe(elapsed.Seconds())
}

func (prometheusCoverageMetrics) QueueUnavailable() {
	piiCoverageUnavailable.Inc()
}
