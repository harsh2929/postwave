// SPDX-License-Identifier: AGPL-3.0-only
//
// tier1_metrics.go — Prometheus counters + histograms for the
// 2026-05 tier-1 enterprise surfaces (agency, scim, auditsink,
// inbound_email, eqscore, predictenrich, send_time_opt, voice/drift).
//
// Why a separate file: keeping all tier-1 metrics in one place makes
// the dashboards trivially copy-paste-able into Grafana and lets
// operators reason about the "new surfaces" as a single failure
// domain (everything in this file scales together).
//
// Conventions:
//   * Counter names end in `_total`.
//   * Histogram names end in `_seconds` for latency or `_count` for
//     batch sizes.
//   * Every metric carries a `tenant_id` label scrubbed to the slug
//     (NOT the raw UUID) to stay below Prometheus cardinality limits
//     on large fleets; the slug → uuid map lives in the tenants
//     table for join-time lookups.

package observability

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// --- HTTP-level instrumentation (request-count + latency) ---

// Tier1RequestsTotal counts every request to a /api/v1/tier1-surface
// endpoint, labeled by surface and status code class.
var Tier1RequestsTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "postwave_tier1_requests_total",
		Help: "Count of HTTP requests to tier-1 surfaces (agency, scim, auditsink, inbound_routes, eqscore, predict, voice_drift).",
	},
	[]string{"surface", "status_class"},
)

// Tier1RequestLatency is the wall-clock duration histogram per
// surface. Buckets calibrated for the editor-preview path (EQ-score
// is sync-fast, ~2ms p99) up to the predict-enrichment path (one
// DB lookup + one upstream forward, ~50ms p99).
var Tier1RequestLatency = promauto.NewHistogramVec(
	prometheus.HistogramOpts{
		Name:    "postwave_tier1_request_seconds",
		Help:    "Wall-clock duration of tier-1 surface requests.",
		Buckets: []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5},
	},
	[]string{"surface"},
)

// --- Audit-sink delivery worker ---

// AuditSinkDeliveriesTotal counts every batch shipped (or attempted)
// to an external sink, labeled by kind (s3/datadog/splunk/http) and
// outcome (success/failure/auto_disabled).
var AuditSinkDeliveriesTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "postwave_auditsink_deliveries_total",
		Help: "Batches delivered to (or auto-disabled by) the audit-log sinks.",
	},
	[]string{"kind", "outcome"},
)

// AuditSinkBatchRows histograms the row-count of delivered batches.
// Buckets match the worker's BatchSize default (100) and possible
// throttle bumps.
var AuditSinkBatchRows = promauto.NewHistogramVec(
	prometheus.HistogramOpts{
		Name:    "postwave_auditsink_batch_rows",
		Help:    "Number of audit_log rows in each delivery batch.",
		Buckets: []float64{1, 5, 10, 25, 50, 100, 250, 500, 1000},
	},
	[]string{"kind"},
)

// AuditSinkDeliveryLatency captures sink-side wall-clock latency.
// Useful for "is Datadog slow today?" debugging.
var AuditSinkDeliveryLatency = promauto.NewHistogramVec(
	prometheus.HistogramOpts{
		Name:    "postwave_auditsink_delivery_seconds",
		Help:    "Wall-clock time per audit-sink delivery (network + upstream).",
		Buckets: []float64{0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30},
	},
	[]string{"kind"},
)

// AuditSinkConsecutiveFailures is the gauge form of the failure
// counter — Prometheus alerts can fire when this rises above a
// threshold (e.g. >= 10 = "this sink is degrading").
var AuditSinkConsecutiveFailures = promauto.NewGaugeVec(
	prometheus.GaugeOpts{
		Name: "postwave_auditsink_consecutive_failures",
		Help: "Current consecutive_failures count per (tenant, sink). Auto-disable fires at 100.",
	},
	[]string{"sink_id", "kind"},
)

// --- Merkle worker ---

// AuditMerkleRowsHashedTotal counts row_hash backfills the Merkle
// worker performs per tick. Useful to confirm the worker is
// keeping up with the audit_log insert rate.
var AuditMerkleRowsHashedTotal = promauto.NewCounter(
	prometheus.CounterOpts{
		Name: "postwave_audit_merkle_rows_hashed_total",
		Help: "Total audit_log rows backfilled with row_hash by the Merkle worker.",
	},
)

// AuditMerkleRootsTotal counts signed-root insertions to
// audit_merkle_roots. One per (tenant, tick) when there are unhashed
// rows.
var AuditMerkleRootsTotal = promauto.NewCounter(
	prometheus.CounterOpts{
		Name: "postwave_audit_merkle_roots_total",
		Help: "Total signed roots inserted to audit_merkle_roots.",
	},
)

// --- EQ Score persistence ---

// EQScoreGradesTotal counts grades by letter outcome. Lets the
// dashboard show "your tenants are trending toward A-grade content"
// or the reverse.
var EQScoreGradesTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "postwave_eqscore_grades_total",
		Help: "EQ-Score grades persisted to eq_score_history.",
	},
	[]string{"grade"},
)

// EQScoreAvgInjectedTotal counts predict-enrichment hits — i.e.
// times the predictenrich handler successfully looked up the
// rolling-30-day average and injected it into the upstream body.
var EQScoreAvgInjectedTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "postwave_eqscore_avg_injected_total",
		Help: "Count of /api/v1/predict requests where the EQ-history average was injected (vs missing → no-op).",
	},
	[]string{"outcome"}, // injected | no_history | lookup_failed
)

// --- Voice drift ---

// VoiceDriftChecksTotal counts /v1/voice/drift requests by severity
// outcome. Lets operators see "most tenants are ok" vs "we're
// flagging warn/critical 30% of the time."
var VoiceDriftChecksTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "postwave_voice_drift_checks_total",
		Help: "Voice-drift severity verdicts returned to the desktop banner.",
	},
	[]string{"severity"}, // ok | warn | critical | error
)

// --- Inbound routes ---

// InboundRouteMatchesTotal counts route matches per (route_id,
// action_kind). Lets the dashboard show "this route fired 12 times
// in the last hour."
var InboundRouteMatchesTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "postwave_inbound_route_matches_total",
		Help: "Count of inbound emails matched by each route.",
	},
	[]string{"route_id", "action_kind"},
)

// --- SCIM ---

// SCIMAuthRequestsTotal counts SCIM v2 bearer-auth attempts by
// outcome. Useful to detect a misconfigured IdP (lots of 401s) or
// token rotation (a spike of failures followed by success).
var SCIMAuthRequestsTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "postwave_scim_auth_requests_total",
		Help: "SCIM bearer-auth attempts.",
	},
	[]string{"outcome"}, // ok | invalid_token | revoked | missing_header
)

// SCIMProvisioningTotal counts JIT bridge events.
var SCIMProvisioningTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "postwave_scim_provisioning_total",
		Help: "SCIM provisioning operations (user_created, user_updated, group_synced, etc).",
	},
	[]string{"op"},
)

// --- Agency ---

// AgencyChildOpsTotal counts sub-account lifecycle events.
var AgencyChildOpsTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "postwave_agency_child_ops_total",
		Help: "Agency sub-account lifecycle operations (created, linked, unlinked, billing_mode_flipped).",
	},
	[]string{"op"},
)
