// Send-loop guard observability — Prometheus instrumentation for Guard.
//
// Why this file exists: until this file landed, sendloop.go ran as a
// goroutine inside the API gateway with zero observability. If the loop
// silently died, sends stalled and operators only noticed via the
// downstream "campaigns stuck in 'sending' for hours" alert (which
// nobody had wired). With the metrics here:
//
//   - postwave_sendloop_iterations_total                — counter, total RunOnce calls
//   - postwave_sendloop_recipients_drained_total{result} — counter,
//                                                          result ∈ {sent, failed, skipped, cancelled}
//   - postwave_sendloop_quiet_hours_skips_total          — counter, increments
//                                                          per skip-batch (NOT per row)
//   - postwave_sendloop_rate_limit_denials_total         — counter
//   - postwave_sendloop_iteration_duration_seconds       — histogram
//   - postwave_sendloop_last_success_timestamp           — gauge, unix seconds
//                                                          (alert: time() - this > 300s)
//
// Cardinality discipline: we deliberately do NOT label by tenant_id on
// per-row counters. A 10k-tenant deployment with a per-tenant counter
// fires once per message and would balloon Prometheus's local TSDB. The
// "result" label is the only dimension; aggregation by tenant happens at
// the application/audit-log layer instead.
//
// Registration: `promauto` registers on the default global registry at
// package-init time. `promhttp.Handler()` reads from the same registry.
// Multiple init() executions of this package would panic on duplicate
// registration; Go guarantees init runs exactly once per package import,
// so this is safe.
//
// The metrics are package-level vars (not Guard fields) so call sites in
// sendloop.go can increment them without threading a *Metrics through
// every method. This keeps the tests untouched (they construct Guard
// directly and never see the metrics).

package sending

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Metric names use the postwave_sendloop_ prefix so a single Prometheus
// scrape covers every send-related counter without colliding with
// reserved go_* / process_* names from the runtime collector that
// promhttp.Handler() bundles by default.
var (
	sendLoopIterations = promauto.NewCounter(prometheus.CounterOpts{
		Name: "postwave_sendloop_iterations_total",
		Help: "Total RunOnce invocations across all tenants.",
	})

	sendLoopRecipientsDrained = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_sendloop_recipients_drained_total",
		Help: "Total recipients drained from the send queue, partitioned by terminal status.",
	}, []string{"result"})

	sendLoopQuietHoursSkips = promauto.NewCounter(prometheus.CounterOpts{
		Name: "postwave_sendloop_quiet_hours_skips_total",
		Help: "Total batches the send loop converted to 'skipped' because quiet hours were active. NOT labeled by tenant — see metrics.go for cardinality rationale. DEPRECATED: kept for dashboard back-compat; observeQuietHoursDeferred is the live signal now.",
	})

	sendLoopQuietHoursDeferred = promauto.NewCounter(prometheus.CounterOpts{
		Name: "postwave_sendloop_quiet_hours_deferred_total",
		Help: "Total send-loop ticks where the per-tenant quiet-hours policy blocked the batch. Rows remain pending and resume processing after the window ends; this counter tracks the deferred-loop volume so operators can see the queue is paused (not dropped).",
	})

	sendLoopRateLimitDenials = promauto.NewCounter(prometheus.CounterOpts{
		Name: "postwave_sendloop_rate_limit_denials_total",
		Help: "Total times the per-tenant rate limiter denied a send during a batch drain.",
	})

	// assuranceDispatchBlocks is the global provider-boundary interlock signal.
	// Its closed reason vocabulary contains no tenant, campaign, recipient,
	// finding, or upstream detail, so it remains safe and bounded at fleet scale.
	assuranceDispatchBlocks = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_sendloop_assurance_dispatch_blocks_total",
		Help: "Recipients withheld by the assurance provider-boundary interlock, partitioned by a closed non-PII reason code.",
	}, []string{"reason"})

	// sendLoopWarmupDeferred counts the recipients pushed back to
	// 'pending' because the warmup cap was reached mid-batch. High
	// values during a campaign launch on a newly-warming IP are
	// EXPECTED; sustained values past day 30 indicate either a
	// stuck warmup_started_at or a misconfigured tier_limit.
	sendLoopWarmupDeferred = promauto.NewCounter(prometheus.CounterOpts{
		Name: "postwave_sendloop_warmup_deferred_total",
		Help: "Recipients reverted from 'sending' back to 'pending' because the per-day warmup cap was reached. NOT labeled by tenant (cardinality).",
	})

	// recipientsSuppressed is the deliverability-loop hit counter. The
	// `reason` label is bounded by the canonical suppression taxonomy
	// plus "unknown" so cardinality stays flat at scale; we deliberately do
	// NOT label by tenant_id, mirroring the per-result counter above.
	recipientsSuppressed = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_sendloop_recipients_suppressed_total",
		Help: "Total recipients short-circuited by the per-row suppression check before dispatch, partitioned by suppression reason.",
	}, []string{"reason"})

	// suppressionDecisionUnavailable counts recipients withheld because the
	// required suppression boundary could not prove a clear/suppressed result.
	// Labels are a fixed internal enum; tenant/email labels are deliberately
	// excluded for both cardinality and PII safety.
	suppressionDecisionUnavailable = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_sendloop_suppression_decision_unavailable_total",
		Help: "Unavailable required send-time suppression decisions. Post-claim reasons add affected recipients; pre-claim unconfigured adds one per blocked tenant drain attempt.",
	}, []string{"reason"})

	// recipientHealthGateDecisions makes the additional verification-health
	// boundary independently observable without tenant or recipient labels. The
	// reason vocabulary is closed in observeRecipientHealthGate.
	recipientHealthGateDecisions = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postwave_sendloop_recipient_health_gate_total",
		Help: "Recipient verification-health blocks and unavailable decisions at the final campaign-send boundary, partitioned by a closed non-PII reason code.",
	}, []string{"reason"})

	sendLoopIterationDuration = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "postwave_sendloop_iteration_duration_seconds",
		Help: "Wall-clock duration of a single Guard.RunOnce invocation.",
		// Tail buckets reach 30s because a slow Listmonk response inside
		// a hot batch is the failure mode this histogram catches.
		Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30},
	})

	sendLoopLastSuccess = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "postwave_sendloop_last_success_timestamp",
		Help: "Unix timestamp (seconds) of the last RunOnce that completed without a terminal error. Alert when time() - this > 300s.",
	})

	// postmarkTokenEnvelopeWrites tracks which encryption backend the
	// provisioner used when persisting a per-tenant Postmark token. The
	// `backend` label is one of {"kms","static"}; both are bounded so
	// cardinality stays flat. The lazy KMS migration is "done" when the
	// `static` rate over a 24h window is zero across the fleet.
	postmarkTokenEnvelopeWrites = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "postmark_token_envelope_writes_total",
		Help: "Postmark per-tenant token writes partitioned by encryption backend (kms|static). Track the lazy migration to KMS by alerting when backend=static stays > 0 after rollout.",
	}, []string{"backend"})
)

// observePostmarkTokenWrite records which backend wrote a Postmark token.
// Exported (capitalised) so callers in this package can drive it from
// the provisioner without exposing the metric var directly.
func observePostmarkTokenWrite(backend string) {
	if backend == "" {
		backend = "static"
	}
	postmarkTokenEnvelopeWrites.WithLabelValues(backend).Inc()
}

// observeIteration records a successful RunOnce iteration. Called from
// Guard.RunOnce on the success path.
func observeIteration(start time.Time) {
	sendLoopIterations.Inc()
	sendLoopIterationDuration.Observe(time.Since(start).Seconds())
	sendLoopLastSuccess.Set(float64(time.Now().Unix()))
}

// observeRecipient bumps the per-result counter. result is one of
// "sent", "failed", "skipped", "cancelled".
func observeRecipient(result string) {
	sendLoopRecipientsDrained.WithLabelValues(result).Inc()
}

// observeQuietHoursSkip records that a batch was skipped due to quiet
// hours. Called once per skipBatch — NOT per row, by design.
//
// Deprecated: the send loop no longer flips rows to 'skipped' inside
// quiet hours (the flip was permanent and silently dropped 36k
// recipients/hr of in-flight work). Kept exported because the
// skipBatch helper still exists in case an operator runbook wants to
// manually drain a stuck queue. Live callers should use
// observeQuietHoursDeferred instead.
func observeQuietHoursSkip(rowsSkipped int) {
	if rowsSkipped <= 0 {
		return
	}
	sendLoopQuietHoursSkips.Inc()
	// Account each skipped row in the recipients counter under the
	// "skipped" label too, so the dashboard's "recipients by outcome"
	// stack adds up to the total queue throughput.
	for i := 0; i < rowsSkipped; i++ {
		observeRecipient("skipped")
	}
}

// observeQuietHoursDeferred records a send-loop tick where the
// tenant's quiet-hours policy blocked the batch. Unlike the
// deprecated *Skip* path, deferring is non-destructive: pending
// rows stay pending. tenantID is accepted for future per-tenant
// labels but currently dropped (cardinality control).
func observeQuietHoursDeferred(_ string) {
	sendLoopQuietHoursDeferred.Inc()
}

// observeRateLimitDenial records a rate-limit-driven batch deferral.
func observeRateLimitDenial() {
	sendLoopRateLimitDenials.Inc()
}

func observeAssuranceDispatchBlock(reason string) {
	switch reason {
	case boundReasonAssuranceRequired, boundReasonRuntimeUnconfigured,
		boundReasonUnsubscribeUnavailable, boundReasonInvalidResult:
	default:
		reason = boundReasonInvalidResult
	}
	assuranceDispatchBlocks.WithLabelValues(reason).Inc()
}

// observeWarmupDeferred records the count of rows reverted from
// 'sending' back to 'pending' because the warmup cap was hit.
// tenantID is accepted for future per-tenant labels but dropped
// today (cardinality control, matches observeQuietHoursDeferred).
func observeWarmupDeferred(_ string, n int) {
	if n <= 0 {
		return
	}
	sendLoopWarmupDeferred.Add(float64(n))
}

// observeRecipientSuppressed records a per-row suppression hit. reason
// MUST be one of suppressions.Reason values so the cardinality stays
// bounded; "unknown" is acceptable as a fallback for rows where the
// hit row could not be hydrated. Also bumps the unified
// recipients_drained{result="suppressed"} counter so the dashboard
// stack still adds up to the queue throughput.
func observeRecipientSuppressed(reason string) {
	switch reason {
	case "hard_bounce", "spam_complaint", "manual_unsubscribe", "list_manual",
		"global_unsubscribe", "soft_bounce_threshold", "dsar_deletion",
		"role_address", "invalid_email", "blocklist_auto", "soft_bounce",
		"complaint", "list_unsub_header", "spamtrap", "role_account",
		"dns_failure", "invalid_address":
	default:
		reason = "unknown"
	}
	recipientsSuppressed.WithLabelValues(reason).Inc()
	observeRecipient("suppressed")
}

func observeSuppressionDecisionUnavailable(reason string, n int) {
	if n <= 0 {
		return
	}
	switch reason {
	case "unconfigured", "batch_error", "batch_incomplete", "recipient_error":
	default:
		reason = "recipient_error"
	}
	suppressionDecisionUnavailable.WithLabelValues(reason).Add(float64(n))
}

func observeRecipientHealthGate(reason string) {
	switch reason {
	case "verification_invalid", "verification_spamtrap", "verification_abuse",
		"verification_do_not_mail", "hard_bounce", "hard_complaint",
		"recent_negative", "error", "incomplete":
	default:
		reason = "error"
	}
	recipientHealthGateDecisions.WithLabelValues(reason).Inc()
}

// SmokeObserveRecipient is an exported wrapper for cmd/metrics-smoke
// that lets the smoke binary force a CounterVec sample so /metrics
// emits the family. Not used at runtime; kept exported only so the
// smoke binary (which lives outside this package) can call into it.
func SmokeObserveRecipient(result string) { observeRecipient(result) }
