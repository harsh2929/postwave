package predictive

import (
	"testing"
	"time"
)

func TestComputePredictionUsesOrderCadenceAndChurn(t *testing.T) {
	now := time.Date(2026, 5, 29, 0, 0, 0, 0, time.UTC)
	first := now.AddDate(0, -6, 0)
	last := now.AddDate(0, -1, 0)
	churn := 20

	got := ComputePrediction(ProfileSignals{
		Email:            "Buyer@Example.com",
		HistoricCLVCents: 30000,
		OrderCount:       3,
		FirstOrderAt:     &first,
		LastOrderAt:      &last,
		ChurnScore:       &churn,
	}, now)
	if got.Email != "buyer@example.com" {
		t.Fatalf("email = %q", got.Email)
	}
	if got.HistoricCLVCents != 30000 || got.PredictedCLVCents <= 0 || got.TotalCLVCents <= got.HistoricCLVCents {
		t.Fatalf("bad CLV prediction: %+v", got)
	}
	if got.ChurnRisk != 0.2 {
		t.Fatalf("churn risk = %v, want 0.2", got.ChurnRisk)
	}
	if got.DataSufficiency != "sufficient" || got.Confidence < 0.6 {
		t.Fatalf("confidence/sufficiency = %v/%s", got.Confidence, got.DataSufficiency)
	}
	if got.ExpectedNextOrderAt == nil {
		t.Fatal("expected next order date")
	}
}

func TestComputeRFMScoresSegmentsProfiles(t *testing.T) {
	now := time.Date(2026, 5, 29, 0, 0, 0, 0, time.UTC)
	recent := now.AddDate(0, 0, -3)
	old := now.AddDate(0, -8, 0)
	out := ComputeRFMScores([]ProfileSignals{
		{Email: "champ@example.com", HistoricCLVCents: 90000, OrderCount: 8, LastOrderAt: &recent},
		{Email: "risk@example.com", HistoricCLVCents: 80000, OrderCount: 7, LastOrderAt: &old},
		{Email: "new@example.com", HistoricCLVCents: 5000, OrderCount: 1, LastOrderAt: &recent},
	}, now)
	if len(out) != 3 {
		t.Fatalf("len = %d", len(out))
	}
	segments := map[string]string{}
	for _, item := range out {
		segments[item.Email] = item.SegmentKey
	}
	if segments["champ@example.com"] != "champions" {
		t.Fatalf("champ segment = %q", segments["champ@example.com"])
	}
	if segments["risk@example.com"] != "at_risk_high_value" {
		t.Fatalf("risk segment = %q", segments["risk@example.com"])
	}
}

func TestDataSufficiency(t *testing.T) {
	if dataSufficiency(0) != "insufficient" {
		t.Fatal("0 orders should be insufficient")
	}
	if dataSufficiency(1) != "limited" {
		t.Fatal("1 order should be limited")
	}
	if dataSufficiency(3) != "sufficient" {
		t.Fatal("3 orders should be sufficient")
	}
}

// TestComputePredictionPopulatesChurnDrivers pins SUB-060: a profile that is
// well past its own buying cadence, slowing, AND soft-bouncing surfaces the
// top-3 explainable drivers ordered highest-impact first.
func TestComputePredictionPopulatesChurnDrivers(t *testing.T) {
	now := time.Date(2026, 5, 29, 0, 0, 0, 0, time.UTC)
	// avg cadence ~150 days (2 orders 300 days apart); last order 320 days
	// ago -> recency ratio > 2 -> high. Cadence >= 120 -> slowing/high.
	first := now.AddDate(0, 0, -320)
	last := now.AddDate(0, 0, -20)
	got := ComputePrediction(ProfileSignals{
		Email:            "atrisk@example.com",
		HistoricCLVCents: 40000,
		OrderCount:       3,
		FirstOrderAt:     &first,
		LastOrderAt:      &last,
		SoftBounces30d:   6,
	}, now)

	if len(got.ChurnDrivers) == 0 {
		t.Fatalf("expected churn drivers, got none: %+v", got)
	}
	if len(got.ChurnDrivers) > 3 {
		t.Fatalf("expected at most 3 drivers, got %d: %+v", len(got.ChurnDrivers), got.ChurnDrivers)
	}
	keys := map[string]ChurnDriver{}
	for _, d := range got.ChurnDrivers {
		keys[d.Key] = d
	}
	for _, want := range []string{"recency", "frequency_trend", "soft_bounce_trend"} {
		if _, ok := keys[want]; !ok {
			t.Fatalf("expected driver %q; got %#v", want, keys)
		}
	}
	if keys["soft_bounce_trend"].Impact != "high" {
		t.Fatalf("6 soft bounces should be high impact; got %q", keys["soft_bounce_trend"].Impact)
	}
	// Highest-impact first: the leading driver must be a high-impact one.
	if impactRank(got.ChurnDrivers[0].Impact) < impactRank(got.ChurnDrivers[len(got.ChurnDrivers)-1].Impact) {
		t.Fatalf("drivers not sorted highest-impact first: %+v", got.ChurnDrivers)
	}
}

// TestComputeChurnDriversHealthyProfile pins that a fresh, single-order,
// no-bounce profile yields a non-nil but minimal driver set (only the
// applicable recency driver), never a panic or misleading filler.
func TestComputeChurnDriversHealthyProfile(t *testing.T) {
	now := time.Date(2026, 5, 29, 0, 0, 0, 0, time.UTC)
	recent := now.AddDate(0, 0, -3)
	got := ComputePrediction(ProfileSignals{
		Email:            "healthy@example.com",
		HistoricCLVCents: 5000,
		OrderCount:       1, // single order -> no cadence -> no frequency driver
		LastOrderAt:      &recent,
	}, now)
	if got.ChurnDrivers == nil {
		t.Fatal("churn drivers should be non-nil (empty slice), not nil")
	}
	for _, d := range got.ChurnDrivers {
		if d.Key == "frequency_trend" {
			t.Fatalf("single-order profile should have no frequency_trend driver: %+v", got.ChurnDrivers)
		}
		if d.Key == "soft_bounce_trend" {
			t.Fatalf("no-bounce profile should have no soft_bounce_trend driver: %+v", got.ChurnDrivers)
		}
	}
	// Recent order -> recency driver is low impact.
	for _, d := range got.ChurnDrivers {
		if d.Key == "recency" && d.Impact != "low" {
			t.Fatalf("3-day-old order should be low recency impact; got %q", d.Impact)
		}
	}
}

// TestSortChurnDriversByImpactDesc pins the ordering contract directly.
func TestSortChurnDriversByImpactDesc(t *testing.T) {
	rows := []ChurnDriver{
		{Key: "a", Impact: "low"},
		{Key: "b", Impact: "high"},
		{Key: "c", Impact: "medium"},
	}
	sortChurnDriversByImpactDesc(rows)
	want := []string{"b", "c", "a"}
	for i, w := range want {
		if rows[i].Key != w {
			t.Fatalf("position %d = %q, want %q (full=%+v)", i, rows[i].Key, w, rows)
		}
	}
}
