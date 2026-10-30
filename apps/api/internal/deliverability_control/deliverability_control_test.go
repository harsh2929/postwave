package deliverability_control

import "testing"

func TestValidateSetupDefaultsStaticDNSRecords(t *testing.T) {
	setup := DomainSetup{Domain: "Example.COM", SetupMode: "static_dns"}
	got := ValidateSetup(setup)
	if !got.Valid {
		t.Fatalf("expected valid setup, got %#v", got)
	}
	normalizeSetup(&setup)
	if setup.Domain != "example.com" {
		t.Fatalf("domain = %q", setup.Domain)
	}
	if len(setup.DNSRecords) == 0 {
		t.Fatal("expected default DNS records")
	}
}

func TestScanUntrackedLinks(t *testing.T) {
	report := ScanUntrackedLinks(`<a href="https://example.com">A</a><a href="https://x.test" data-pw-no-track="true">B</a><a href="mailto:test@example.com">M</a>`)
	if report.TotalLinks != 3 {
		t.Fatalf("total links = %d", report.TotalLinks)
	}
	if report.TrackedLinks != 1 || report.UntrackedLinks != 2 {
		t.Fatalf("tracked/untracked = %d/%d", report.TrackedLinks, report.UntrackedLinks)
	}
}

func TestNormalizeRoutingRejectsOverMax(t *testing.T) {
	err := normalizeRouting(&RoutingPolicy{
		Strategy:                 "hybrid",
		DedicatedPercentageBP:    8000,
		MaxDedicatedPercentageBP: 5000,
	})
	if err == nil {
		t.Fatal("expected max validation error")
	}
}

func TestHydrateRoutingCalculatesSplit(t *testing.T) {
	policy := RoutingPolicy{
		Strategy:                 "hybrid",
		DedicatedPercentageBP:    2500,
		MaxDedicatedPercentageBP: 10000,
	}
	hydrateRouting(&policy)
	if policy.EffectiveDedicatedPercent != 25 || policy.EffectiveSharedPercent != 75 {
		t.Fatalf("split = %.2f/%.2f", policy.EffectiveDedicatedPercent, policy.EffectiveSharedPercent)
	}
}
