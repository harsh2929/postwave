package form_variants

import "testing"

func TestReweight_EmptySamples(t *testing.T) {
	dec := Reweight(nil)
	if len(dec.Weights) != 0 {
		t.Fatalf("expected empty weights, got %v", dec.Weights)
	}
	if dec.PromoteVariantID != "" {
		t.Fatalf("expected no promotion, got %q", dec.PromoteVariantID)
	}
}

func TestReweight_NoPromotionBelowMinSample(t *testing.T) {
	// Even with a huge z-score, fewer than MinSampleForPromotion
	// impressions per variant must NOT promote.
	dec := Reweight([]Sample{
		{VariantID: "a", Impressions: 50, Submissions: 5},
		{VariantID: "b", Impressions: 50, Submissions: 25},
	})
	if dec.PromoteVariantID != "" {
		t.Fatalf("must not promote with <%d impressions per arm, got %q",
			MinSampleForPromotion, dec.PromoteVariantID)
	}
	if total := sumW(dec.Weights); total != 100 {
		t.Fatalf("weights must sum to 100, got %d", total)
	}
}

func TestReweight_PromotesWinnerAt95Confidence(t *testing.T) {
	// Big sample sizes, clear winner — should promote and pin
	// winner's traffic to 100, peer to 0.
	dec := Reweight([]Sample{
		{VariantID: "a", Impressions: 1000, Submissions: 50},  // 5% rate
		{VariantID: "b", Impressions: 1000, Submissions: 150}, // 15% rate
	})
	if dec.PromoteVariantID != "b" {
		t.Fatalf("expected b to be promoted, got %q", dec.PromoteVariantID)
	}
	if dec.RunnerUpVariantID != "a" {
		t.Fatalf("expected a as runner-up, got %q", dec.RunnerUpVariantID)
	}
	if dec.Weights["b"] != 100 {
		t.Fatalf("winner should pin to 100, got %d", dec.Weights["b"])
	}
	if dec.Weights["a"] != 0 {
		t.Fatalf("loser should pin to 0, got %d", dec.Weights["a"])
	}
	if dec.ZScore < ConfidenceZ {
		t.Fatalf("z-score should clear %.2f, got %.4f", ConfidenceZ, dec.ZScore)
	}
}

func TestReweight_WeightsFavorHigherRate(t *testing.T) {
	// Below the promotion bar (one arm short on samples), but b's
	// rate is clearly higher. Weight on b should be > weight on a.
	dec := Reweight([]Sample{
		{VariantID: "a", Impressions: 100, Submissions: 5},
		{VariantID: "b", Impressions: 100, Submissions: 25},
	})
	if dec.PromoteVariantID != "" {
		t.Fatalf("should not promote below MinSampleForPromotion: %+v", dec)
	}
	if dec.Weights["b"] <= dec.Weights["a"] {
		t.Fatalf("higher-rate variant should get more weight: a=%d b=%d",
			dec.Weights["a"], dec.Weights["b"])
	}
	if total := sumW(dec.Weights); total != 100 {
		t.Fatalf("weights must sum to 100, got %d", total)
	}
}

func TestReweight_ExplorationFloorRespected(t *testing.T) {
	// While *still exploring* (below MinSampleForPromotion per arm),
	// even a zero-conversion variant retains the 5% exploration floor
	// so the bandit can recover if the metric direction shifts.
	// (After promotion, the loser correctly drops to 0% — see
	// TestReweight_PromotesWinnerAt95Confidence.)
	dec := Reweight([]Sample{
		{VariantID: "a", Impressions: 100, Submissions: 0},
		{VariantID: "b", Impressions: 100, Submissions: 30},
	})
	if dec.PromoteVariantID != "" {
		t.Fatalf("test setup error: should be exploring, not promoting")
	}
	if dec.Weights["a"] < 5 {
		t.Fatalf("exploration floor violated: a=%d", dec.Weights["a"])
	}
}

func TestReweight_DeterministicGivenOrder(t *testing.T) {
	in1 := []Sample{
		{VariantID: "x", Impressions: 300, Submissions: 30},
		{VariantID: "y", Impressions: 300, Submissions: 20},
	}
	in2 := []Sample{
		{VariantID: "y", Impressions: 300, Submissions: 20},
		{VariantID: "x", Impressions: 300, Submissions: 30},
	}
	d1 := Reweight(in1)
	d2 := Reweight(in2)
	if d1.Weights["x"] != d2.Weights["x"] || d1.Weights["y"] != d2.Weights["y"] {
		t.Fatalf("reweight must be order-stable: d1=%+v d2=%+v", d1, d2)
	}
}

func TestAllowedStatusTransition(t *testing.T) {
	cases := []struct {
		from, to Status
		ok       bool
	}{
		{StatusExploring, StatusExploring, true},
		{StatusExploring, StatusPaused, true},
		{StatusExploring, StatusPromoted, true},
		{StatusPaused, StatusExploring, true},
		{StatusPromoted, StatusExploring, false}, // sticky
		{StatusPromoted, StatusPaused, false},    // sticky
		{StatusPaused, StatusPromoted, false},    // must un-pause first
	}
	for _, c := range cases {
		if got := AllowedStatusTransition(c.from, c.to); got != c.ok {
			t.Errorf("AllowedStatusTransition(%s -> %s) = %v, want %v",
				c.from, c.to, got, c.ok)
		}
	}
}

func sumW(w map[string]int) int {
	total := 0
	for _, v := range w {
		total += v
	}
	return total
}
