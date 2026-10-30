// SPDX-License-Identifier: AGPL-3.0-only
//
// sto_archive_metrics.go — Prometheus counters for the send-time-opt
// (STO) and archive surfaces.
//
// Background: the gap-audit (sto-instrumentation, P1) flagged that
// neither STO nor the archive admin/publish path emitted any
// Prometheus metrics. Operators couldn't answer questions like:
//
//   * "how often does the archive pixel actually fire?"
//   * "what's the publish-archive 5xx rate right now?"
//   * "which tenant ran schedule-by-best-time today?"
//   * "what fraction of STO computes find enough data?"
//
// The metrics here close that loop. They live in a separate file so the
// dashboards can reason about "STO + archive" as one operational
// domain — distinct from the tier-1 enterprise surfaces in
// tier1_metrics.go — and so a future split is a file move, not a
// surgical extraction.
//
// Conventions match the rest of the observability package:
//   * Counter names end in `_total`.
//   * `outcome` is the canonical success/failure label (ok|error|*).
//   * No raw tenant_id labels — Prometheus cardinality stays bounded
//     even on a 100k-tenant fleet. Per-tenant attribution lives in the
//     structured log + audit_log table instead.

package observability

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// --- Send-time-opt ---

// STOComputeRunsTotal counts every call to send_time_opt.Repo.Compute,
// labelled by outcome:
//   - "computed"     — the subscriber crossed the weighted-sample
//     floor (>= MinOpens) and a best_send_hour was persisted.
//   - "cold"         — the subscriber's weighted sample was below the
//     floor; nothing was written.
//   - "error"        — the compute failed (DB error, RLS context
//     missing, etc).
//
// Operators use this to answer "how often is the modal-hour worker
// crossing the data floor for our tenants?" — i.e. the proportion of
// cold subscribers in the fleet.
var STOComputeRunsTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "sto_compute_runs_total",
		Help: "Calls to the per-subscriber best-send-hour compute path, partitioned by outcome (computed|cold|error).",
	},
	[]string{"outcome"},
)

// STOScheduleByBestTimeTotal counts every successful invocation of the
// POST /campaigns/{id}/schedule-by-best-time endpoint, labelled by the
// resolved `strategy` (per_recipient | modal_hour | unspecified) and
// `outcome` (scheduled | error).
//
// Why labelled by strategy: the gap audit specifically asked "which
// tenant ran schedule-by-best-time" — strategy is the highest-value
// follow-up because it distinguishes the per-recipient surface from
// the modal-hour surface. Per-tenant attribution still lives in the
// audit_log row the handler emits in parallel.
var STOScheduleByBestTimeTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "sto_schedule_by_best_time_total",
		Help: "Calls to /api/v1/campaigns/{id}/schedule-by-best-time, partitioned by strategy and outcome.",
	},
	[]string{"strategy", "outcome"},
)

// STOSegmentEndpoint500Total counts 5xx responses on the segment-aware
// surfaces (GET /api/v1/send-time-opt and GET /api/v1/send-time-opt/heatmap).
// A 5xx rate above zero is the primary indicator that the segment
// query path is broken (e.g. segment_subscribers missing, RLS GUC
// unset, query timeout).
//
// 2xx and 4xx outcomes are NOT counted here — they're covered by the
// generic Tier1RequestsTotal histogram once the router wraps the
// endpoint with Tier1Middleware. Keeping this counter focused on 5xx
// only makes the burn-rate alerting trivially simple.
var STOSegmentEndpoint500Total = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "sto_segment_endpoint_500_total",
		Help: "Server errors (5xx) emitted by the segment-aware send-time-opt endpoints.",
	},
	[]string{"endpoint"}, // segment_best | heatmap
)

// --- Archive ---

// ArchiveViewRecordedTotal counts archive pixel views successfully
// recorded by the public PublicViewPixel handler — i.e. the pixel
// fired AND we enqueued the view for persistence. Separate from
// archive_view_record_total (the worker-side INSERT counter): this is
// the handler-side success signal that exists even when the worker is
// asleep.
//
// The gap audit's question — "how often does the pixel fire?" — maps
// directly to this counter.
var ArchiveViewRecordedTotal = promauto.NewCounter(
	prometheus.CounterOpts{
		Name: "archive_view_recorded_total",
		Help: "Archive pixel fetches that were recorded by the public pixel handler (handler-side success signal).",
	},
)

// ArchiveViewDroppedTotal counts pixel fetches that were rejected at
// the handler layer BEFORE the recorder enqueue — e.g. the campaign
// slug didn't resolve, the tenant didn't exist, or the request was a
// bot we explicitly filter (no UA, known bot UA).
//
// This is intentionally separate from the worker-side
// archive_view_dropped_total counter inside view_recorder.go. The two
// counters answer different questions:
//
//   - THIS counter: "did the pixel fetch even get accepted?"
//   - worker counter: "did the row land in archive_views?"
//
// Both must be near-zero in a healthy fleet.
var ArchiveViewDroppedTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "archive_view_recorded_dropped_total",
		Help: "Archive pixel fetches dropped by the handler before the recorder enqueue (reason=not_found|bot|missing_tenant).",
	},
	[]string{"reason"},
)

// ArchivePublishTotal counts every invocation of the
// /api/v1/campaigns/{id}/publish-archive (and unpublish-archive)
// endpoints, labelled by action (publish | unpublish) and outcome
// (ok | bad_request | not_found | error).
//
// Operators use this to spot publish flapping (publish + unpublish on
// the same campaign within minutes — usually a mistake) and to
// monitor the 5xx rate as a release health signal.
var ArchivePublishTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "archive_publish_total",
		Help: "Calls to /publish-archive and /unpublish-archive partitioned by action and outcome.",
	},
	[]string{"action", "outcome"},
)
