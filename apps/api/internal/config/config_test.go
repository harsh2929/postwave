package config

import (
	"reflect"
	"testing"
)

func TestEnvClientVersions(t *testing.T) {
	cases := []struct {
		name, raw string
		want      map[string]string
	}{
		{"unset", "", nil},
		{"single", "web:1.2.0", map[string]string{"web": "1.2.0"}},
		{
			"multi + whitespace + case",
			" Web:1.2.0 , mobile:1.1.0 ",
			map[string]string{"web": "1.2.0", "mobile": "1.1.0"},
		},
		{"missing colon skipped", "web,mobile:1.1.0", map[string]string{"mobile": "1.1.0"}},
		{"empty version skipped", "web:,mobile:1.1.0", map[string]string{"mobile": "1.1.0"}},
		{"all malformed → nil", "garbage,also-garbage", nil},
		{"last-wins on dup key", "web:1.0.0,web:2.0.0", map[string]string{"web": "2.0.0"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("POSTWAVE_MIN_CLIENT_VERSIONS", c.raw)
			got := envClientVersions("POSTWAVE_MIN_CLIENT_VERSIONS")
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("envClientVersions(%q) = %#v, want %#v", c.raw, got, c.want)
			}
		})
	}
}

func TestLoadClientIPTrustBoundary(t *testing.T) {
	t.Setenv("POSTWAVE_TRUST_FORWARDED_IP_HEADERS", "true")
	t.Setenv("POSTWAVE_TRUSTED_PROXY_CIDRS", "10.0.0.0/8, 2001:db8::/32")
	t.Setenv("POSTWAVE_DIRECT_CLIENT_CONNECTIONS", "1")

	cfg := Load()
	if !cfg.TrustForwardedIPHeaders {
		t.Fatal("trusted-forwarded-header flag was not loaded")
	}
	if !cfg.DirectClientConnections {
		t.Fatal("direct-client assertion was not loaded")
	}
	if len(cfg.TrustedProxyCIDRs) != 2 || cfg.TrustedProxyCIDRs[0] != "10.0.0.0/8" || cfg.TrustedProxyCIDRs[1] != "2001:db8::/32" {
		t.Fatalf("TrustedProxyCIDRs = %#v", cfg.TrustedProxyCIDRs)
	}
}

func TestLoadPIIFingerprintKey(t *testing.T) {
	pepper := "dedicated-pii-fingerprint-pepper-at-least-32-bytes"
	t.Setenv("POSTWAVE_PII_FINGERPRINT_PEPPER", pepper)
	t.Setenv("POSTWAVE_PII_FINGERPRINT_KEY_VERSION", "prod-2026-07")

	cfg := Load()
	if string(cfg.PIIFingerprintPepper) != pepper {
		t.Fatalf("PIIFingerprintPepper was not loaded")
	}
	if cfg.PIIFingerprintKeyVersion != "prod-2026-07" {
		t.Fatalf("PIIFingerprintKeyVersion=%q", cfg.PIIFingerprintKeyVersion)
	}
}

func TestLoadCampaignDispatchInterlocksDefaultClosedAndOptIn(t *testing.T) {
	t.Setenv("POSTWAVE_ENABLE_CAMPAIGN_LIVE_DISPATCH", "")
	t.Setenv("POSTWAVE_ENABLE_CAMPAIGN_SCHEDULER", "")
	t.Setenv("POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_SEND_GATE", "")
	t.Setenv("POSTWAVE_CAMPAIGN_ASSURANCE_GATE_ROLLOUT", "")
	t.Setenv("POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_RUNTIME", "")

	cfg := Load()
	if cfg.CampaignLiveDispatchEnabled || cfg.CampaignSchedulerEnabled || cfg.CampaignAssuranceSendGateEnabled ||
		cfg.CampaignAssuranceRuntimeEnabled {
		t.Fatalf("campaign dispatch interlocks must default closed: %+v", cfg)
	}

	t.Setenv("POSTWAVE_ENABLE_CAMPAIGN_LIVE_DISPATCH", "true")
	t.Setenv("POSTWAVE_ENABLE_CAMPAIGN_SCHEDULER", "1")
	t.Setenv("POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_SEND_GATE", "true")
	t.Setenv("POSTWAVE_CAMPAIGN_ASSURANCE_GATE_ROLLOUT", "block")
	t.Setenv("POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_RUNTIME", "true")
	cfg = Load()
	if !cfg.CampaignLiveDispatchEnabled || !cfg.CampaignSchedulerEnabled || !cfg.CampaignAssuranceSendGateEnabled ||
		!cfg.CampaignAssuranceRuntimeEnabled {
		t.Fatalf("explicit campaign dispatch opt-ins were not loaded: %+v", cfg)
	}
	if cfg.CampaignAssuranceGateRolloutMode != "block" {
		t.Fatalf("campaign assurance rollout mode=%q, want block", cfg.CampaignAssuranceGateRolloutMode)
	}
}
