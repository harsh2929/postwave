// SPDX-License-Identifier: AGPL-3.0-only

// coverage.go -- checks for four surfaces the board previously admitted it was
// not watching.
//
// Each reads through a SECURITY DEFINER aggregate added in migration 2042, so
// the postwave_ops role still has zero base-table access and the return type
// stays the security boundary: counts and timestamps, never a tenant, a
// subscriber, or a payload.
//
// A NOTE ON THRESHOLDS. Every threshold here is chosen so the check cannot be
// permanently red in a system that is merely quiet. A check that is red from
// the day it ships gets investigated once, snoozed, and then teaches the team
// that its lane is noise -- which costs more than the gap it was written to
// close. Where a defensible threshold does not exist yet (a level that depends
// on traffic we do not have), the check watches a SHAPE instead.
package checks

import (
	"context"
	"fmt"
	"time"

	"github.com/postwave/postwave/apps/api/internal/ops"
)

func init() {
	ops.Register(ops.Check{
		ID:       "sending.pipeline-stalled",
		Group:    "Sending",
		Domain:   "sending",
		Owner:    "platform",
		Title:    "Send pipeline is moving",
		Severity: ops.SevCritical,
		Why: "A recipient claimed for sending and never finished is in limbo: not sent, not failed, and not queued for retry. " +
			"The sender process died between claiming the row and recording the outcome, and nothing about that state produces an error anywhere. " +
			"Queue DEPTH cannot see it — a healthy sender and a dead one look identical at ten thousand pending.",
		Kind:     ops.KindEvaluated,
		Interval: 2 * time.Minute,
		Damping:  2,
		Probe:    probeSendPipeline,
		Remediation: "Stuck claims are supposed to be reclaimed automatically, so this being red means stuck-recovery has failed as well: check queues.worker-fleet for send-guard-stuck-recovery and send-guard-loop before touching any rows. " +
			"Do not blindly re-queue — a claimed recipient may already have been handed to the provider, and re-queueing sends the message twice.",
		Runbook: "docs/runbooks/common-failures.md",
	})

	ops.Register(ops.Check{
		ID:       "webhooks.delivery-backlog",
		Group:    "Data",
		Domain:   "webhooks",
		Owner:    "platform",
		Title:    "Outbound webhook delivery",
		Severity: ops.SevHigh,
		Why: "A dead-lettered webhook is a customer's system permanently out of sync with ours, and the divergence grows until somebody reconciles it by hand. " +
			"Nothing on our side errors: we recorded the event, we tried, we gave up, and only their data is wrong.",
		Kind:     ops.KindEvaluated,
		Interval: 5 * time.Minute,
		Damping:  2,
		Probe:    probeWebhookDelivery,
		Remediation: "Overdue deliveries mean the delivery worker is not draining — check queues.worker-fleet for outbound-webhooks-worker before looking at any endpoint. " +
			"Exhausted deliveries mean a customer endpoint has been failing long enough to spend every retry; the endpoint owner needs telling, because we will not try again.",
		Runbook: "docs/runbooks/common-failures.md",
	})

	ops.Register(ops.Check{
		ID:       "flows.run-backlog",
		Group:    "Data",
		Domain:   "flows",
		Owner:    "platform",
		Title:    "Flow engine drain",
		Severity: ops.SevHigh,
		Why: "A stalled flow engine is invisible to the customer until a welcome series never arrives, and by then the moment it was supposed to catch has passed. " +
			"Silent non-sending looks exactly like nobody qualifying.",
		Kind:     ops.KindEvaluated,
		Interval: 2 * time.Minute,
		Damping:  2,
		Probe:    probeFlowRuns,
		Remediation: "A growing overdue backlog is a worker problem before it is a flow problem: check queues.worker-fleet first. " +
			"A high failure rate with a healthy drain is a flow-definition problem — read the error column on recent failed runs for the node that is throwing.",
		Runbook: "docs/runbooks/common-failures.md",
	})

	ops.Register(ops.Check{
		ID:       "identity.session-reaper",
		Group:    "Legal",
		Domain:   "identity",
		Owner:    "security",
		Title:    "Session reaper is running",
		Severity: ops.SevHigh,
		Why: "Expiry is enforced on read, so a stale row is not itself an open door. But the reaper that removes expired sessions is the same machinery that clears REVOKED ones, " +
			"and after a credential compromise the gap between revoking a session and the row actually going away is the window somebody is trying to use.",
		Kind:     ops.KindEvaluated,
		Interval: time.Hour,
		Probe:    probeSessionReaper,
		Remediation: "The detail line carries the age of the oldest unreaped session. Find the retention sweep for auth_sessions and confirm it is running and not erroring; " +
			"queues.worker-fleet will say whether retention-sweeper is alive at all.",
	})

	ops.Register(ops.Check{
		ID:       "growth.signup-pulse",
		Group:    "Data",
		Domain:   "growth",
		Owner:    "growth",
		Title:    "Signup and import pulse",
		Severity: ops.SevRoutine,
		Why: "A broken signup, form, or import path does not error — it produces a quiet week, which is indistinguishable from a slow market. " +
			"The only cheap way to tell them apart is to notice that a stream which WAS flowing has stopped.",
		Kind:     ops.KindEvaluated,
		Interval: time.Hour,
		Probe:    probeGrowthPulse,
		Remediation: "Confirm signup forms, the double opt-in path, and the import worker are all working before concluding this is demand. " +
			"queues.worker-fleet covers subscriber-import-worker; the Send page covers whether confirmation mail is going out.",
	})
}

func probeSendPipeline(ctx context.Context, env *ops.Env) (ops.Status, string, error) {
	if env == nil || env.Pool == nil {
		return ops.StatusRed, "", fmt.Errorf("send pipeline probe has no database")
	}
	var pending, sending, failed int64
	var oldestClaim *time.Time
	if err := env.Pool.QueryRow(ctx,
		`SELECT pending, sending, failed, oldest_claimed_at FROM ops_send_pipeline_health()`).
		Scan(&pending, &sending, &failed, &oldestClaim); err != nil {
		return ops.StatusRed, "", err
	}

	detail := fmt.Sprintf("pending=%d sending=%d failed=%d", pending, sending, failed)
	if oldestClaim == nil {
		// Nothing is mid-flight. Depth alone is not a fault: a queue with a
		// million pending recipients and nothing claimed is a send that has
		// not started, not a send that is stuck.
		return ops.StatusOK, detail + " (nothing claimed mid-send)", nil
	}

	age := time.Since(*oldestClaim)
	detail += fmt.Sprintf(" oldest-claim=%s ago", age.Truncate(time.Minute))
	switch {
	// The recovery worker is meant to reclaim abandoned rows, so an hour-old
	// claim means the RECOVERY has failed too -- which is why this threshold
	// is generous rather than tight. A large legitimate batch does not hold
	// one claim for an hour.
	case age > time.Hour:
		return ops.StatusRed, detail + "; recipients have been claimed and unfinished for over an hour — the sender died mid-send and stuck-recovery has not reclaimed them", nil
	case age > 15*time.Minute:
		return ops.StatusWarn, detail + "; a claim is older than the 15 minute objective", nil
	default:
		return ops.StatusOK, detail, nil
	}
}

func probeWebhookDelivery(ctx context.Context, env *ops.Env) (ops.Status, string, error) {
	if env == nil || env.Pool == nil {
		return ops.StatusRed, "", fmt.Errorf("webhook delivery probe has no database")
	}
	var pending, overdue, exhausted int64
	var oldestPending *time.Time
	if err := env.Pool.QueryRow(ctx,
		`SELECT pending, overdue, exhausted_24h, oldest_pending_at FROM ops_webhook_delivery_health()`).
		Scan(&pending, &overdue, &exhausted, &oldestPending); err != nil {
		return ops.StatusRed, "", err
	}

	detail := fmt.Sprintf("pending=%d overdue=%d exhausted-24h=%d", pending, overdue, exhausted)
	if oldestPending != nil {
		detail += fmt.Sprintf(" oldest-pending=%s", time.Since(*oldestPending).Truncate(time.Minute))
	}

	switch {
	// A backlog whose OLDEST item is half an hour past due is a stalled
	// worker, not a busy one: a draining queue keeps its head young however
	// deep it gets.
	case overdue > 0 && oldestPending != nil && time.Since(*oldestPending) > 30*time.Minute:
		return ops.StatusRed, detail + "; deliveries are overdue and the head of the queue is not moving", nil
	case exhausted > 50:
		return ops.StatusRed, detail + "; deliveries are being abandoned in bulk", nil
	case overdue > 0:
		return ops.StatusWarn, detail + "; deliveries are past their retry time", nil
	case exhausted > 0:
		return ops.StatusWarn, detail + "; some customer endpoints have spent every retry", nil
	default:
		return ops.StatusOK, detail, nil
	}
}

func probeFlowRuns(ctx context.Context, env *ops.Env) (ops.Status, string, error) {
	if env == nil || env.Pool == nil {
		return ops.StatusRed, "", fmt.Errorf("flow run probe has no database")
	}
	var queued, running, failed, completed int64
	var oldestDue *time.Time
	if err := env.Pool.QueryRow(ctx,
		`SELECT queued, running, failed_24h, completed_24h, oldest_due_at FROM ops_flow_run_health()`).
		Scan(&queued, &running, &failed, &completed, &oldestDue); err != nil {
		return ops.StatusRed, "", err
	}

	terminal := failed + completed
	detail := fmt.Sprintf("queued=%d running=%d failed-24h=%d completed-24h=%d",
		queued, running, failed, completed)
	if oldestDue != nil {
		detail += fmt.Sprintf(" oldest-due=%s", time.Since(*oldestDue).Truncate(time.Minute))
	}

	switch {
	case oldestDue != nil && time.Since(*oldestDue) > 15*time.Minute:
		return ops.StatusRed, detail + "; a run has been due for over 15 minutes and has not started", nil
	// A minimum sample keeps three failures out of four runs from reading as a
	// catastrophe on a quiet morning.
	case terminal >= 20 && failed*100 > terminal*10:
		return ops.StatusRed, detail + "; over a tenth of runs failed in the last 24h", nil
	case oldestDue != nil && time.Since(*oldestDue) > 5*time.Minute:
		return ops.StatusWarn, detail + "; the queue head is older than the 5 minute objective", nil
	case terminal >= 20 && failed*100 > terminal*2:
		return ops.StatusWarn, detail + "; the 24h failure rate is above 2%", nil
	default:
		return ops.StatusOK, detail, nil
	}
}

func probeSessionReaper(ctx context.Context, env *ops.Env) (ops.Status, string, error) {
	if env == nil || env.Pool == nil {
		return ops.StatusRed, "", fmt.Errorf("session reaper probe has no database")
	}
	var active, expired, revoked int64
	var oldestExpired *time.Time
	if err := env.Pool.QueryRow(ctx,
		`SELECT active, expired_unreaped, revoked_unreaped, oldest_expired_at FROM ops_session_health()`).
		Scan(&active, &expired, &revoked, &oldestExpired); err != nil {
		return ops.StatusRed, "", err
	}

	detail := fmt.Sprintf("active=%d expired-unreaped=%d revoked-unreaped=%d", active, expired, revoked)
	if oldestExpired == nil {
		// Nothing has expired yet. That is a real and healthy state on a young
		// deployment, and reporting it as "reaper untested" would be a red row
		// for the absence of a problem.
		return ops.StatusOK, detail + " (nothing has expired yet)", nil
	}

	age := time.Since(*oldestExpired)
	detail += fmt.Sprintf(" oldest-expired=%s ago", age.Truncate(time.Hour))
	switch {
	case age > 30*24*time.Hour:
		return ops.StatusRed, detail + "; nothing has been reaped in a month, so the sweep is not running", nil
	case age > 14*24*time.Hour:
		return ops.StatusWarn, detail + "; the sweep is falling behind", nil
	default:
		return ops.StatusOK, detail, nil
	}
}

func probeGrowthPulse(ctx context.Context, env *ops.Env) (ops.Status, string, error) {
	if env == nil || env.Pool == nil {
		return ops.StatusRed, "", fmt.Errorf("growth probe has no database")
	}
	var day, week, month, tenants24h, tenants30d, tenantsTotal int64
	if err := env.Pool.QueryRow(ctx,
		`SELECT subscribers_24h, subscribers_7d, subscribers_30d,
		        tenants_24h, tenants_30d, tenants_total FROM ops_growth_snapshot()`).
		Scan(&day, &week, &month, &tenants24h, &tenants30d, &tenantsTotal); err != nil {
		return ops.StatusRed, "", err
	}

	detail := fmt.Sprintf("subscribers 24h=%d 7d=%d 30d=%d; tenants 24h=%d 30d=%d total=%d",
		day, week, month, tenants24h, tenants30d, tenantsTotal)

	// The SHAPE, not the level. There is no defensible "signups should exceed
	// N" before launch, and a level threshold would sit permanently red and be
	// snoozed. A stream that was flowing and has stopped needs no threshold at
	// all -- and is correctly silent while there is nothing to measure.
	switch {
	case month == 0:
		return ops.StatusOK, detail + " (no signup traffic yet — nothing to compare against)", nil
	case week == 0:
		return ops.StatusWarn, detail + "; signups ran in the last 30 days and have been zero for 7 — check the intake paths before concluding this is demand", nil
	default:
		return ops.StatusOK, detail, nil
	}
}
