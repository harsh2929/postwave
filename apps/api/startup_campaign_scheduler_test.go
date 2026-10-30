package main

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/config"
)

func TestCampaignSchedulerStartupRemainsLockedUntilRecoveryQualification(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name string
		cfg  config.Config
	}{
		{name: "zero value"},
		{name: "live dispatch only", cfg: config.Config{CampaignLiveDispatchEnabled: true}},
		{name: "scheduler only", cfg: config.Config{CampaignSchedulerEnabled: true}},
		{name: "both flags are still insufficient", cfg: config.Config{CampaignSchedulerEnabled: true, CampaignLiveDispatchEnabled: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := campaignSchedulerStartupEnabled(tc.cfg); got {
				t.Fatal("legacy scheduler started before durable claim recovery qualification")
			}
		})
	}
}

func TestMainWiresCampaignSchedulerThroughConfigurationHelper(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	text := root.main
	for _, marker := range []string{
		"liveCampaignDispatch := dispatchcontrol.StaticGate{Enabled: cfg.CampaignLiveDispatchEnabled}",
		"ScheduledMaterializationEnabled: cfg.CampaignLiveDispatchEnabled && cfg.CampaignSchedulerEnabled,",
		"if campaignSchedulerStartupEnabled(cfg) {",
		"safego.Go(logger, \"campaign-scheduler\"",
	} {
		if !strings.Contains(text, marker) {
			t.Fatalf("main.go is missing campaign dispatch wiring marker %q", marker)
		}
	}
	startupSource, err := os.ReadFile("startup_configuration.go")
	if err != nil {
		t.Fatalf("read startup_configuration.go: %v", err)
	}
	if !strings.Contains(string(startupSource), "campaigns.LegacySchedulerDurableClaimRecoveryQualified") {
		t.Fatal("scheduler startup helper is not bound to the compile-time recovery qualification")
	}
	for _, forbidden := range []string{
		`os.Getenv("POSTWAVE_ENABLE_CAMPAIGN_LIVE_DISPATCH")`,
		`os.Getenv("POSTWAVE_ENABLE_CAMPAIGN_SCHEDULER")`,
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root bypasses tested campaign configuration with %q", forbidden)
		}
	}
	for label, pattern := range map[string]string{
		"campaign and send-time dependencies":                `\bLiveDispatch:\s+liveCampaignDispatch`,
		"server-composed scheduling and resend dependencies": `\bCampaignLiveDispatch:\s+liveCampaignDispatch`,
	} {
		wiring := regexp.MustCompile(pattern)
		inRun, inRoot := len(wiring.FindAllStringIndex(root.run, -1)), len(wiring.FindAllStringIndex(root.all, -1))
		if inRun != 2 || inRoot != 2 {
			t.Fatalf("%s gate wiring count = %d in run() and %d in the composition root, want 2 and 2",
				label, inRun, inRoot)
		}
	}
}
