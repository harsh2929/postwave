// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/campaignreportprojection"
)

func TestCampaignReportProjectionCompositionPreservesRealNil(t *testing.T) {
	var disabled *campaignreportprojection.Runtime
	disabledValue, err := campaignreportprojection.BuildRuntime(
		context.Background(), campaignreportprojection.RuntimeConfiguration{}, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	for name, assertNil := range map[string]func() bool{
		"nil Listmonk": func() bool { return listmonkCampaignReportProjectorForDeps(disabled) == nil },
		"nil ESP":      func() bool { return espCampaignReportProjectorForDeps(disabled) == nil },
		"nil subscriber": func() bool {
			return subscriberCampaignReportProjectorForDeps(disabled) == nil
		},
		"nil reply": func() bool { return replyCampaignReportProjectorForDeps(disabled) == nil },
		"disabled-value Listmonk": func() bool {
			return listmonkCampaignReportProjectorForDeps(disabledValue) == nil
		},
		"disabled-value ESP": func() bool {
			return espCampaignReportProjectorForDeps(disabledValue) == nil
		},
		"disabled-value subscriber": func() bool {
			return subscriberCampaignReportProjectorForDeps(disabledValue) == nil
		},
		"disabled-value reply": func() bool {
			return replyCampaignReportProjectorForDeps(disabledValue) == nil
		},
	} {
		if !assertNil() {
			t.Errorf("%s projection became a non-nil writer dependency", name)
		}
	}
}

func TestCampaignReportProjectionProductionWiringsAreCompleteAndTypedNilSafe(t *testing.T) {
	root := readAPICompositionRoot(t)
	body := root.main
	if len(body) < 10_000 {
		t.Fatalf("main.go is unexpectedly short (%d bytes); wiring guard would be vacuous", len(body))
	}
	for _, marker := range []string{
		"initializeCampaignReportProjectionRuntime(",
		"CampaignReportProjector: listmonkCampaignReportProjectorForDeps(",
		"CampaignReportProjector: espCampaignReportProjectorForDeps(",
		"CampaignReportProjector: subscriberCampaignReportProjectorForDeps(",
		"CampaignReportProjector: replyCampaignReportProjectorForDeps(",
	} {
		if !strings.Contains(body, marker) {
			t.Errorf("production composition is missing %q", marker)
		}
	}
	if strings.Contains(root.all, "CampaignReportProjector: campaignReportProjectionRuntime,") {
		t.Fatal("bare projection runtime assignment reintroduced the typed-nil failure mode")
	}
}

func TestCampaignReportProjectionInitializerIsDefaultClosedWithoutDatabase(t *testing.T) {
	runtime, err := initializeCampaignReportProjectionRuntime(context.Background(), nil, func(string) string { return "" })
	if err != nil || runtime != nil {
		t.Fatalf("default-closed initializer runtime=%v err=%v", runtime, err)
	}
	_, err = initializeCampaignReportProjectionRuntime(context.Background(), nil, func(key string) string {
		if key == campaignreportprojection.RuntimeFeatureEnvironmentKey {
			return "true"
		}
		return ""
	})
	if !errors.Is(err, campaignreportprojection.ErrRuntimeNotReady) {
		t.Fatalf("enabled initializer without database error=%v", err)
	}
}
