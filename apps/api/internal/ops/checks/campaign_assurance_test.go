// SPDX-License-Identifier: AGPL-3.0-only

package checks

import (
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/ops"
	"github.com/postwave/postwave/apps/api/internal/ops/views"
)

func TestEvaluateCampaignAssuranceSLO(t *testing.T) {
	tests := []struct {
		name   string
		health views.CampaignAssuranceSLOHealth
		want   ops.Status
		text   string
	}{
		{name: "idle is healthy", want: ops.StatusOK, text: "terminal-24h=0"},
		{name: "ordinary backlog is healthy", health: views.CampaignAssuranceSLOHealth{
			QueuedRuns: 2, RunningRuns: 1, ReadyCommands: 1,
			OldestReadyCommandAgeSecond: 30, CompleteRuns24h: 40,
		}, want: ops.StatusOK, text: "oldest-ready=30s"},
		{name: "orphan is red", health: views.CampaignAssuranceSLOHealth{
			OrphanedQueuedRuns: 1,
		}, want: ops.StatusRed, text: "no unfinished command"},
		{name: "expired lease is red", health: views.CampaignAssuranceSLOHealth{
			ExpiredRunningLeases: 1,
		}, want: ops.StatusRed, text: "lease recovery"},
		{name: "queue warning", health: views.CampaignAssuranceSLOHealth{
			OldestReadyCommandAgeSecond: assuranceQueueWarnAge.Seconds() + 1,
		}, want: ops.StatusWarn, text: "5m objective"},
		{name: "queue red", health: views.CampaignAssuranceSLOHealth{
			OldestReadyCommandAgeSecond: assuranceQueueRedAge.Seconds() + 1,
		}, want: ops.StatusRed, text: "15m hard limit"},
		{name: "small terminal sample does not page", health: views.CampaignAssuranceSLOHealth{
			CompleteRuns24h: 17, FailedRuns24h: 2,
		}, want: ops.StatusOK, text: "terminal-24h=19"},
		{name: "completion warning", health: views.CampaignAssuranceSLOHealth{
			CompleteRuns24h: 99, IncompleteRuns24h: 1, FailedRuns24h: 1,
		}, want: ops.StatusWarn, text: "below 99%"},
		{name: "completion red", health: views.CampaignAssuranceSLOHealth{
			CompleteRuns24h: 90, IncompleteRuns24h: 6, FailedRuns24h: 4,
		}, want: ops.StatusRed, text: "below 95%"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			status, detail, err := evaluateCampaignAssuranceSLO(test.health)
			if err != nil || status != test.want || !strings.Contains(detail, test.text) {
				t.Fatalf("status=%q detail=%q err=%v, want %q containing %q", status, detail, err, test.want, test.text)
			}
			for _, forbidden := range []string{"tenant_id", "campaign_id", "run_id", "subject", "model_output", "recipient"} {
				if strings.Contains(strings.ToLower(detail), forbidden) {
					t.Errorf("SLO detail leaked %q: %s", forbidden, detail)
				}
			}
		})
	}
}

func TestCampaignAssuranceSLOCheckIsAlertableAndHasRunbook(t *testing.T) {
	check, ok := ops.Get("campaign-assurance.slo-health")
	if !ok {
		t.Fatal("Campaign Assurance SLO check is not registered")
	}
	if check.Kind != ops.KindEvaluated || check.Severity != ops.SevHigh ||
		check.Interval <= 0 || check.Damping < 2 || check.Runbook == "" {
		t.Fatalf("Campaign Assurance SLO check is not production-alertable: %+v", check)
	}
}
