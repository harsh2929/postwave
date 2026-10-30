// SPDX-License-Identifier: AGPL-3.0-only

// Package checks holds the registered ops checks, one file per group.
package checks

import (
	"context"
	"fmt"
	"time"

	"github.com/postwave/postwave/apps/api/internal/ops"
)

func init() {
	ops.Register(ops.Check{
		ID:       "billing.dlq-depth",
		Domain:   "billing",
		Owner:    "founder",
		Group:    "Billing",
		Title:    "Stripe dead-letter queue",
		Why:      "A dead-lettered checkout.session.completed means a customer paid and never got an account. A dead-lettered subscription.deleted means a churned customer keeps paid access.",
		Kind:     ops.KindEvaluated,
		Severity: ops.SevCritical,
		Interval: 15 * time.Minute,
		Probe:    probeBillingDLQ,
		Remediation: "Inspect the dead events and replay them: POST /api/v1/dlq/{id}/replay. " +
			"Stripe retries for ~9 days (30s/5m/30m/2h/8h/1d/7d) before dead-lettering, so anything here has been failing for over a week.",
		Runbook: "docs/runbooks/common-failures.md",

		// The button. DangerConfirm, not DangerSafe: a replay re-runs
		// checkout.session.completed handlers against live customer state, so
		// the UI must ask before it fires — but it is not destructive enough
		// to be worth type-to-confirm, and a queue nobody replays because the
		// ceremony is annoying is the failure mode this check exists to catch.
		// The runner (checks.DLQReplayRunner) is bound in main.go, where the
		// retry store lives.
		Action: &ops.ActionMeta{
			ID:        "replay-dead-lettered",
			Label:     "Replay dead-lettered",
			Danger:    ops.DangerConfirm,
			InputHint: "attempt id (empty = all, max 50)",
		},
	})
}

func probeBillingDLQ(ctx context.Context, env *ops.Env) (ops.Status, string, error) {
	var dead int64
	var oldest *time.Time

	err := env.Pool.QueryRow(ctx, `SELECT dead_count, oldest_dead_at FROM ops_billing_dlq_depth()`).
		Scan(&dead, &oldest)
	if err != nil {
		return ops.StatusRed, "", err
	}

	if dead == 0 {
		return ops.StatusOK, "no dead-lettered events", nil
	}

	detail := fmt.Sprintf("%d dead-lettered event(s)", dead)
	if oldest != nil {
		detail += fmt.Sprintf(", oldest %s ago", time.Since(*oldest).Truncate(time.Hour))
	}
	return ops.StatusRed, detail, nil
}
