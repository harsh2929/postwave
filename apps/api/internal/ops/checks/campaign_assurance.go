// SPDX-License-Identifier: AGPL-3.0-only

package checks

import (
	"context"
	"fmt"
	"time"

	"github.com/postwave/postwave/apps/api/internal/ops"
	"github.com/postwave/postwave/apps/api/internal/ops/views"
)

const (
	assuranceQueueWarnAge = 5 * time.Minute
	assuranceQueueRedAge  = 15 * time.Minute
	assuranceSLOMinSample = int64(20)
)

func init() {
	ops.Register(ops.Check{
		ID:       "campaign-assurance.slo-health",
		Domain:   "campaign-assurance",
		Owner:    "platform",
		Group:    "Sending",
		Title:    "Campaign Assurance lifecycle SLO",
		Why:      "A stalled or incomplete assurance pipeline can leave sends waiting indefinitely or turn missing evidence into an apparently healthy pre-send state.",
		Kind:     ops.KindEvaluated,
		Severity: ops.SevHigh,
		Interval: time.Minute,
		Damping:  2,
		Probe:    probeCampaignAssuranceSLO,
		Remediation: "Open the content-free Campaign Assurance run view, identify orphaned queued runs or expired leases, and follow the worker/queue recovery steps. " +
			"Do not bypass an unavailable gate to restore throughput.",
		Runbook: "docs/runbooks/campaign-assurance-slo.md",
	})
}

func probeCampaignAssuranceSLO(
	ctx context.Context,
	env *ops.Env,
) (ops.Status, string, error) {
	if env == nil || env.Pool == nil {
		return ops.StatusRed, "", fmt.Errorf("Campaign Assurance SLO ops pool is unavailable")
	}
	health, err := (&views.Reader{Pool: env.Pool}).CampaignAssuranceSLOHealth(ctx)
	if err != nil {
		return ops.StatusRed, "", err
	}
	return evaluateCampaignAssuranceSLO(health)
}

func evaluateCampaignAssuranceSLO(
	health views.CampaignAssuranceSLOHealth,
) (ops.Status, string, error) {
	terminal := health.CompleteRuns24h + health.IncompleteRuns24h + health.FailedRuns24h
	nonComplete := health.IncompleteRuns24h + health.FailedRuns24h
	detail := fmt.Sprintf(
		"queued=%d running=%d ready=%d oldest-ready=%s orphaned=%d expired-leases=%d terminal-24h=%d complete=%d incomplete=%d failed=%d blocked=%d",
		health.QueuedRuns,
		health.RunningRuns,
		health.ReadyCommands,
		durationDetail(health.OldestReadyCommandAgeSecond),
		health.OrphanedQueuedRuns,
		health.ExpiredRunningLeases,
		terminal,
		health.CompleteRuns24h,
		health.IncompleteRuns24h,
		health.FailedRuns24h,
		health.BlockedRuns24h,
	)

	switch {
	case health.OrphanedQueuedRuns > 0:
		return ops.StatusRed, detail + "; eligible run has no unfinished command", nil
	case health.ExpiredRunningLeases > 0:
		return ops.StatusRed, detail + "; worker lease recovery is overdue", nil
	case health.OldestReadyCommandAgeSecond > assuranceQueueRedAge.Seconds():
		return ops.StatusRed, detail + "; oldest ready command breached the 15m hard limit", nil
	case terminal >= assuranceSLOMinSample && nonComplete*100 > terminal*5:
		return ops.StatusRed, detail + "; trailing-24h trustworthy completion is below 95%", nil
	case health.OldestReadyCommandAgeSecond > assuranceQueueWarnAge.Seconds():
		return ops.StatusWarn, detail + "; oldest ready command missed the 5m objective", nil
	case terminal >= assuranceSLOMinSample && nonComplete*100 > terminal:
		return ops.StatusWarn, detail + "; trailing-24h trustworthy completion is below 99%", nil
	default:
		return ops.StatusOK, detail, nil
	}
}

func durationDetail(seconds float64) string {
	if seconds <= 0 {
		return "0s"
	}
	return (time.Duration(seconds) * time.Second).Truncate(time.Second).String()
}
