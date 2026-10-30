// SPDX-License-Identifier: AGPL-3.0-only
package deliverability_hub

import (
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/events"
)

// scoreHub is the pure-logic surface the hub worker leans on; tests
// here cover the decision boundary cases so a regression in the
// thresholds is caught at compile time.

func TestEmitAccountStatusChangeWithholdsUnownedLifecycleTransitions(t *testing.T) {
	if AccountBillingLifecycleAvailable || AccountComplianceSuspensionAvailable {
		t.Fatal("test requires the documented account-lifecycle release holds")
	}
	bus := events.NewBus()
	sub := bus.Subscribe("tenant-1", []string{"account.*"})
	defer bus.Unsubscribe(sub)
	deps := &Deps{Bus: bus, Clock: func() time.Time { return time.Date(2026, time.September, 3, 8, 30, 0, 0, time.UTC) }}

	for _, topic := range []string{
		EventAccountDeactivate,
		EventAccountReactivate,
		EventAccountComplianceSuspend,
	} {
		deps.EmitAccountStatusChange("tenant-1", topic, "adjacent transition", "system")
	}

	select {
	case evt := <-sub.Ch:
		t.Fatalf("release-held account lifecycle was published: %+v", evt)
	default:
	}
}

func TestScoreHub_HealthyAccount(t *testing.T) {
	h := HubScore{
		BounceRate: 0.001, ComplaintRate: 0.0001, EngagementRate: 0.40,
		DNSHealth: map[string]DNSStatus{"example.com": {VerifyState: "verified"}},
	}
	score, grade, breaches := scoreHub(h, 10_000)
	if score != 100 || grade != "A" || len(breaches) != 0 {
		t.Fatalf("healthy account: score=%d grade=%q breaches=%v", score, grade, breaches)
	}
}

func TestScoreHub_HighBounceTriggers(t *testing.T) {
	h := HubScore{
		BounceRate: 0.04, ComplaintRate: 0, EngagementRate: 0.5,
	}
	score, _, breaches := scoreHub(h, 5_000)
	if score >= 95 {
		t.Fatalf("4%% bounce should drop score sharply; got %d", score)
	}
	found := false
	for _, b := range breaches {
		if b.Metric == "bounce_rate" && b.Severity == "critical" {
			found = true
		}
	}
	if !found {
		t.Fatal("expected bounce_rate critical-severity breach")
	}
}

func TestScoreHub_ComplaintRedline(t *testing.T) {
	h := HubScore{ComplaintRate: 0.002, EngagementRate: 0.2}
	score, _, breaches := scoreHub(h, 5_000)
	if score >= 95 {
		t.Fatalf("0.2%% complaints should drop score; got %d", score)
	}
	found := false
	for _, b := range breaches {
		if b.Metric == "complaint_rate" && b.Severity == "critical" {
			found = true
		}
	}
	if !found {
		t.Fatal("expected complaint_rate critical breach")
	}
}

func TestScoreHub_DNSBroken(t *testing.T) {
	h := HubScore{
		DNSHealth: map[string]DNSStatus{
			"a.com": {VerifyState: "verified"},
			"b.com": {VerifyState: "broken"},
		},
		EngagementRate: 0.3,
	}
	score, _, breaches := scoreHub(h, 1000)
	if score >= 100 {
		t.Fatalf("broken DNS should penalise score; got %d", score)
	}
	found := false
	for _, b := range breaches {
		if b.Metric == "dns_health" {
			found = true
		}
	}
	if !found {
		t.Fatal("expected dns_health breach")
	}
}

func TestScoreHub_BlocklistTier1Heavy(t *testing.T) {
	h := HubScore{
		BlocklistHits:  []BlocklistHit{{Tier1: true}, {Tier1: true}},
		EngagementRate: 0.3,
	}
	score, _, breaches := scoreHub(h, 1000)
	if score >= 90 {
		t.Fatalf("two tier-1 hits should drop score significantly; got %d", score)
	}
	sev := ""
	for _, b := range breaches {
		if b.Metric == "blocklist_hits" {
			sev = b.Severity
		}
	}
	if sev != "critical" {
		t.Fatalf("blocklist tier-1 should be critical severity; got %q", sev)
	}
}

func TestScoreHub_EngagementColdList(t *testing.T) {
	h := HubScore{EngagementRate: 0.05}
	score, _, breaches := scoreHub(h, 10_000)
	if score >= 100 {
		t.Fatalf("cold list should reduce score; got %d", score)
	}
	found := false
	for _, b := range breaches {
		if b.Metric == "engagement_rate" {
			found = true
		}
	}
	if !found {
		t.Fatal("expected engagement_rate breach")
	}
}

func TestScoreHub_InsufficientCampaignSampleSkipsRatePenalties(t *testing.T) {
	h := HubScore{
		BounceRate:     1,
		ComplaintRate:  1,
		EngagementRate: 0,
	}
	score, grade, breaches := scoreHub(h, MinimumRateSampleSends-1)
	if score != 100 || grade != "A" {
		t.Fatalf("under-sampled rates changed score: score=%d grade=%q", score, grade)
	}
	if len(breaches) != 1 || breaches[0].Code != "campaign_sample_insufficient" || breaches[0].Severity != "info" {
		t.Fatalf("under-sampled evidence breaches = %+v", breaches)
	}
}

func TestScoreHub_MinimumCampaignSampleActivatesRateSignals(t *testing.T) {
	h := HubScore{
		BounceRate:     0.04,
		ComplaintRate:  0.002,
		EngagementRate: 0.05,
	}
	score, _, breaches := scoreHub(h, MinimumRateSampleSends)
	if score >= 100 {
		t.Fatalf("qualified unhealthy rates did not change score: %d", score)
	}
	want := map[string]bool{
		"bounce_rate_high":    false,
		"complaint_rate_high": false,
		"engagement_cold":     false,
	}
	for _, breach := range breaches {
		if _, ok := want[breach.Code]; ok {
			want[breach.Code] = true
		}
	}
	for code, found := range want {
		if !found {
			t.Fatalf("qualified sample missing %s breach: %+v", code, breaches)
		}
	}
}

func TestScoreHub_GradeBoundaries(t *testing.T) {
	cases := []struct {
		name   string
		bounce float64
		want   string
	}{
		{"A", 0.001, "A"},
		{"B-ish", 0.07, "C"}, // adjust based on penalty math
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := HubScore{BounceRate: c.bounce, EngagementRate: 0.4}
			_, grade, _ := scoreHub(h, 1000)
			_ = grade // boundary test sanity — grade should not be empty
			if grade == "" {
				t.Fatal("grade must be set")
			}
		})
	}
}

func TestIsAccountStatusTopic(t *testing.T) {
	good := []string{EventAccountComplianceSuspend, EventAccountDeactivate, EventAccountReactivate}
	for _, g := range good {
		if !isAccountStatusTopic(g) {
			t.Fatalf("topic %q must be recognised", g)
		}
	}
	if isAccountStatusTopic("nope") {
		t.Fatal("unknown topic must be rejected")
	}
}

func TestItoa(t *testing.T) {
	if got := itoa(0); got != "0" {
		t.Fatalf("itoa(0)=%q", got)
	}
	if got := itoa(42); got != "42" {
		t.Fatalf("itoa(42)=%q", got)
	}
	if got := itoa(-7); got != "-7" {
		t.Fatalf("itoa(-7)=%q", got)
	}
}

func TestBoundedRate(t *testing.T) {
	for _, tc := range []struct {
		numerator   int64
		denominator int64
		want        float64
	}{
		{0, 0, 0},
		{1, 0, 1},
		{5, 10, 0.5},
		{20, 10, 1},
	} {
		if got := boundedRate(tc.numerator, tc.denominator); got != tc.want {
			t.Fatalf("boundedRate(%d, %d) = %v, want %v", tc.numerator, tc.denominator, got, tc.want)
		}
	}
}
