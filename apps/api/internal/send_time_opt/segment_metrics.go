// SPDX-License-Identifier: AGPL-3.0-only
//
// segment_metrics.go — Prometheus counter for segment-cache fallback
// engagement. Lives in its own file so segment_membership.go has no
// transitive `prometheus` import, and so tests can stub the counter
// out via interface if they ever need to.

package send_time_opt

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

func stoSegmentFallbackCounter() *prometheus.CounterVec {
	return promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "sto_segment_fallback_engaged_total",
		Help: "Segment STO queries that fell back to compiling segments.query_ast inline because the materialised cache was unavailable.",
	}, []string{"reason", "surface"})
}
