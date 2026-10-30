// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/postwave/postwave/apps/api/internal/campaignassurancegate"
	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/presend"
)

func TestResolveCampaignAssuranceGateRolloutKeepsOneUnambiguousPolicy(t *testing.T) {
	tests := []struct {
		name    string
		cfg     config.Config
		want    campaignassurancegate.RolloutMode
		wantErr bool
	}{
		{name: "default off", want: campaignassurancegate.RolloutOff},
		{name: "legacy boolean means block", cfg: config.Config{CampaignAssuranceSendGateEnabled: true}, want: campaignassurancegate.RolloutBlock},
		{name: "explicit shadow", cfg: config.Config{CampaignAssuranceGateRolloutMode: " SHADOW "}, want: campaignassurancegate.RolloutShadow},
		{name: "explicit warn", cfg: config.Config{CampaignAssuranceGateRolloutMode: "warn"}, want: campaignassurancegate.RolloutWarn},
		{name: "explicit block plus alias", cfg: config.Config{CampaignAssuranceGateRolloutMode: "block", CampaignAssuranceSendGateEnabled: true}, want: campaignassurancegate.RolloutBlock},
		{name: "conflicting controls", cfg: config.Config{CampaignAssuranceGateRolloutMode: "warn", CampaignAssuranceSendGateEnabled: true}, wantErr: true},
		{name: "invalid", cfg: config.Config{CampaignAssuranceGateRolloutMode: "permissive"}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := resolveCampaignAssuranceGateRollout(test.cfg)
			if (err != nil) != test.wantErr || (!test.wantErr && got != test.want) {
				t.Fatalf("mode=%q err=%v, want mode=%q err=%v", got, err, test.want, test.wantErr)
			}
		})
	}
}

func TestCampaignAssuranceGateConvergenceDefaultsOffWithoutDependencies(t *testing.T) {
	composition, err := initializeCampaignAssuranceGateConvergence(nil, "", nil)
	if err != nil {
		t.Fatalf("initialize disabled convergence: %v", err)
	}
	if composition.Rollout != nil {
		t.Fatalf("disabled rollout = %#v, want nil", composition.Rollout)
	}

	campaignDeps := &campaigns.Deps{}
	preSendDeps := &presend.Deps{}
	composition.applyCampaignQueue(campaignDeps)
	composition.applyPreSend(preSendDeps)
	if campaignDeps.AssuranceGate != nil || campaignDeps.AssuranceGateEnabled || preSendDeps.CampaignAssurance != nil {
		t.Fatalf("disabled composition mutated dependencies: campaigns=%+v presend=%+v", campaignDeps, preSendDeps)
	}
}

func TestCampaignAssuranceGateConvergenceRejectsInvalidOrIncompleteActivation(t *testing.T) {
	if _, err := initializeCampaignAssuranceGateConvergence(nil, "invalid", prometheus.NewRegistry()); err == nil {
		t.Fatal("invalid rollout mode was accepted")
	}
	if _, err := initializeCampaignAssuranceGateConvergence(nil, "shadow", prometheus.NewRegistry()); err == nil {
		t.Fatal("active rollout without database was accepted")
	}
	if _, err := initializeCampaignAssuranceGateConvergence(new(db.Pool), "warn", nil); err == nil {
		t.Fatal("active rollout without telemetry was accepted")
	}
}

func TestCampaignAssuranceGateConvergenceSharesOneRolloutAcrossQueueAndPreSend(t *testing.T) {
	composition, err := initializeCampaignAssuranceGateConvergence(
		new(db.Pool),
		string(campaignassurancegate.RolloutShadow),
		prometheus.NewRegistry(),
	)
	if err != nil {
		t.Fatalf("initialize active convergence: %v", err)
	}
	if composition.Rollout == nil || composition.Rollout.RolloutMode() != campaignassurancegate.RolloutShadow {
		t.Fatalf("rollout = %#v", composition.Rollout)
	}

	campaignDeps := &campaigns.Deps{}
	preSendDeps := &presend.Deps{}
	composition.applyCampaignQueue(campaignDeps)
	composition.applyPreSend(preSendDeps)
	if campaignDeps.AssuranceGate != composition.Rollout || !campaignDeps.AssuranceGateEnabled {
		t.Fatalf("queue composition did not receive rollout: %+v", campaignDeps)
	}
	if preSendDeps.CampaignAssurance != composition.Rollout {
		t.Fatalf("pre-send evaluator = %T, want shared rollout", preSendDeps.CampaignAssurance)
	}
}

func TestCampaignAssuranceGateConvergenceBlocksDispatchOnlyInBlockMode(t *testing.T) {
	for _, mode := range []campaignassurancegate.RolloutMode{
		campaignassurancegate.RolloutShadow,
		campaignassurancegate.RolloutWarn,
		campaignassurancegate.RolloutBlock,
	} {
		composition, err := initializeCampaignAssuranceGateConvergence(
			new(db.Pool), string(mode), prometheus.NewRegistry(),
		)
		if err != nil {
			t.Fatalf("initialize %s: %v", mode, err)
		}
		if got := composition.blocksDispatch(); got != (mode == campaignassurancegate.RolloutBlock) {
			t.Fatalf("mode=%s blocks_dispatch=%v", mode, got)
		}
	}
}

func TestProductionCompositionSharesOneRolloutAcrossEverySendBoundary(t *testing.T) {
	root := readAPICompositionRoot(t)
	// Each marker is asserted once in run() and once in the whole composition
	// root: a boundary that leaves run() for a helper, or gains a second
	// application beside it, is outside what this test reviewed.
	for _, required := range []string{
		"campaignAssuranceGateConvergence.applyCampaignQueue(campaignDeps)",
		"campaignAssuranceGateConvergence.applyPreSend(preSendDeps)",
		"campaignAssuranceGateConvergence.Rollout,",
		"sendGuard.RequireAssuranceBinding = campaignAssuranceGateConvergence.blocksDispatch()",
	} {
		if inRun, inRoot := strings.Count(root.run, required), strings.Count(root.all, required); inRun != 1 || inRoot != 1 {
			t.Errorf("production convergence marker %q count = %d in run() and %d in the composition root, "+
				"want 1 and 1", required, inRun, inRoot)
		}
	}
	if strings.Contains(root.all, "AssuranceGate: &campaignassurancegate.Gate") {
		t.Fatal("production queue still constructs a second Campaign Assurance authority")
	}
}
