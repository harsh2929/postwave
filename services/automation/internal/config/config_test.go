package config

import "testing"

func TestCampaignSchedulingFlagsDefaultClosedAndRequireExplicitTrue(t *testing.T) {
	for _, key := range []string{
		"POSTWAVE_ENABLE_CAMPAIGN_LIVE_DISPATCH",
		"POSTWAVE_ENABLE_CAMPAIGN_SCHEDULER",
	} {
		t.Setenv(key, "")
	}
	cfg := Load()
	if cfg.CampaignLiveDispatchEnabled || cfg.CampaignSchedulerEnabled {
		t.Fatalf("default campaign flags live=%v scheduler=%v, want false/false",
			cfg.CampaignLiveDispatchEnabled, cfg.CampaignSchedulerEnabled)
	}

	t.Setenv("POSTWAVE_ENABLE_CAMPAIGN_LIVE_DISPATCH", "true")
	t.Setenv("POSTWAVE_ENABLE_CAMPAIGN_SCHEDULER", "1")
	cfg = Load()
	if !cfg.CampaignLiveDispatchEnabled || !cfg.CampaignSchedulerEnabled {
		t.Fatalf("explicit campaign flags live=%v scheduler=%v, want true/true",
			cfg.CampaignLiveDispatchEnabled, cfg.CampaignSchedulerEnabled)
	}
}
