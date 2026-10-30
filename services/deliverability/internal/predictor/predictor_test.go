package predictor

import (
	"context"
	"math"
	"testing"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

func almost(a, b, eps float64) bool { return math.Abs(a-b) < eps }

func TestRiskToPlacement_CalibrationAnchors(t *testing.T) {
	cases := []struct {
		risk    float64
		primary float64
		spam    float64
	}{
		{0.0, 0.85, 0.02},
		{0.5, 0.50, 0.20},
		{1.0, 0.05, 0.65},
	}
	for _, c := range cases {
		got := riskToPlacement(c.risk)
		if !almost(got.Primary, c.primary, 0.01) {
			t.Errorf("risk=%.2f primary=%.3f want %.3f", c.risk, got.Primary, c.primary)
		}
		if !almost(got.Spam, c.spam, 0.01) {
			t.Errorf("risk=%.2f spam=%.3f want %.3f", c.risk, got.Spam, c.spam)
		}
		if !almost(got.Primary+got.Promotions+got.Spam, 1.0, 1e-6) {
			t.Errorf("distribution does not sum to 1: %+v", got)
		}
	}
}

func TestPredict_TableTests(t *testing.T) {
	type tc struct {
		name       string
		content    domain.ContentScan
		rep        domain.Reputation
		hist       HistoricalEngagement
		minPrimary float64
		maxSpam    float64
	}
	high := domain.Reputation{GoogleScore: domain.ReputationHigh, MicrosoftScore: domain.ReputationHigh, SenderScore: 95}
	medium := domain.Reputation{GoogleScore: domain.ReputationMedium, MicrosoftScore: domain.ReputationMedium, SenderScore: 75}
	low := domain.Reputation{GoogleScore: domain.ReputationLow, MicrosoftScore: domain.ReputationLow, SenderScore: 50}
	bl := domain.Reputation{GoogleScore: domain.ReputationLow, MicrosoftScore: domain.ReputationLow, SenderScore: 30, BlacklistHits: []string{"spamhaus_zen"}}

	cleanContent := domain.ContentScan{SpamScore: 0.05, ImageTextRatio: 0.5, LinkReputation: domain.AuthOK}
	mildContent := domain.ContentScan{SpamScore: 0.30, ImageTextRatio: 1.0, LinkReputation: domain.AuthOK}
	imageContent := domain.ContentScan{SpamScore: 0.20, ImageTextRatio: 5.0, LinkReputation: domain.AuthOK}
	badContent := domain.ContentScan{SpamScore: 0.80, ImageTextRatio: 6.0, LinkReputation: domain.AuthFail}

	goodHist := HistoricalEngagement{OpenRate: 0.35, ComplaintRate: 0.0001, BounceRate: 0.005, SendVolume: 5000}
	weakHist := HistoricalEngagement{OpenRate: 0.15, ComplaintRate: 0.001, BounceRate: 0.01, SendVolume: 5000}
	terribleHist := HistoricalEngagement{OpenRate: 0.05, ComplaintRate: 0.005, BounceRate: 0.06, SendVolume: 5000}

	cases := []tc{
		{"clean+high+strong", cleanContent, high, goodHist, 0.80, 0.10},
		{"clean+high+no-history", cleanContent, high, HistoricalEngagement{}, 0.75, 0.10},
		{"mild+medium+weak", mildContent, medium, weakHist, 0.40, 0.30},
		{"image+high+strong", imageContent, high, goodHist, 0.55, 0.20},
		{"image+medium+weak", imageContent, medium, weakHist, 0.25, 0.40},
		{"bad+low+terrible", badContent, low, terribleHist, 0.0, 1.0}, // upper-bound-only
		{"bad+blacklist+terrible", badContent, bl, terribleHist, 0.0, 1.0},
		{"clean+low+strong", cleanContent, low, goodHist, 0.30, 0.40},
		{"clean+blacklist+strong", cleanContent, bl, goodHist, 0.0, 0.65},
		{"mild+high+strong", mildContent, high, goodHist, 0.65, 0.20},
		{"image+low+terrible", imageContent, low, terribleHist, 0.0, 0.85},
		{"clean+medium+weak", cleanContent, medium, weakHist, 0.55, 0.25},
	}
	p := New()
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pp, err := p.Predict(context.Background(), c.content, c.rep, c.hist)
			if err != nil {
				t.Fatal(err)
			}
			sum := pp.Primary + pp.Promotions + pp.Spam
			if !almost(sum, 1.0, 1e-6) {
				t.Fatalf("dist sum=%.3f", sum)
			}
			if pp.Primary < c.minPrimary {
				t.Errorf("primary=%.3f want >= %.2f", pp.Primary, c.minPrimary)
			}
			if pp.Spam > c.maxSpam {
				t.Errorf("spam=%.3f want <= %.2f", pp.Spam, c.maxSpam)
			}
		})
	}
}

func TestRiskToPlacement_Monotonic(t *testing.T) {
	prevPrim := 1.0
	prevSpam := -1.0
	for r := 0.0; r <= 1.0; r += 0.05 {
		p := riskToPlacement(r)
		if p.Primary > prevPrim+1e-9 {
			t.Errorf("primary not monotonically decreasing at r=%.2f", r)
		}
		if p.Spam < prevSpam-1e-9 {
			t.Errorf("spam not monotonically non-decreasing at r=%.2f", r)
		}
		prevPrim = p.Primary
		prevSpam = p.Spam
	}
}

func TestPredictWithAuth_ExposesRiskAssumptions(t *testing.T) {
	p := New()
	content := domain.ContentScan{SpamScore: 0.10, LinkReputation: domain.AuthOK}
	rep := domain.Reputation{GoogleScore: domain.ReputationHigh, MicrosoftScore: domain.ReputationHigh, SenderScore: 90}

	_, breakdown, err := p.PredictWithAuth(context.Background(), content, rep, HistoricalEngagement{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if breakdown.Model.Kind != "heuristic" || breakdown.Model.Trained {
		t.Fatalf("model disclosure=%+v", breakdown.Model)
	}
	if len(breakdown.Assumptions) < 2 {
		t.Fatalf("assumptions=%+v, want auth proxy and no-history assumption", breakdown.Assumptions)
	}

	auth := &domain.AuthCheck{
		Domain: "example.com",
		SPF:    domain.AuthRecord{Status: domain.AuthOK, Detail: "ok"},
		DKIM:   domain.AuthRecord{Status: domain.AuthFail, Detail: "missing"},
		DMARC:  domain.AuthRecord{Status: domain.AuthWarn, Detail: "p=none"},
	}
	_, withAuth, err := p.PredictWithAuth(context.Background(), content, rep,
		HistoricalEngagement{SendVolume: 10, AvgEQScoreLast30d: 80}, auth)
	if err != nil {
		t.Fatal(err)
	}
	if withAuth.Auth <= 0 {
		t.Fatalf("auth risk=%.3f, want explicit auth risk", withAuth.Auth)
	}
	if len(withAuth.Assumptions) != 0 {
		t.Fatalf("assumptions=%+v, want none when auth/history/EQ supplied", withAuth.Assumptions)
	}
}

func TestEngagementRisk_EQHistoryAdjustment(t *testing.T) {
	// Pick a baseline with a small positive risk so the A-grade
	// downward nudge is observable above clamp01's floor. OpenRate
	// in [0.10, 0.20) gives +0.10 risk from the existing rules.
	base := HistoricalEngagement{
		OpenRate:      0.18,
		ComplaintRate: 0.0001,
		BounceRate:    0.005,
		SendVolume:    5000,
	}
	cases := []struct {
		name string
		eq   int
		// Compare against baseline; sign of (got - baseline).
		wantDirection int // -1 lower, 0 equal, +1 higher
	}{
		{"a_grade_lowers_risk", 90, -1},
		{"b_grade_neutral", 75, 0},
		{"c_grade_raises_risk", 60, +1},
		{"d_grade_raises_more", 45, +1},
		{"missing_neutral", 0, 0},
	}
	baseline := engagementRisk(base)
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := base
			h.AvgEQScoreLast30d = c.eq
			got := engagementRisk(h)
			switch c.wantDirection {
			case -1:
				if !(got < baseline) {
					t.Fatalf("eq=%d: got=%.3f baseline=%.3f want lower", c.eq, got, baseline)
				}
			case 0:
				if got != baseline {
					t.Fatalf("eq=%d: got=%.3f baseline=%.3f want equal", c.eq, got, baseline)
				}
			case 1:
				if !(got > baseline) {
					t.Fatalf("eq=%d: got=%.3f baseline=%.3f want higher", c.eq, got, baseline)
				}
			}
		})
	}
	// Out-of-band: D-grade should be bumped MORE than C-grade.
	c := base
	c.AvgEQScoreLast30d = 60
	d := base
	d.AvgEQScoreLast30d = 45
	if engagementRisk(d) <= engagementRisk(c) {
		t.Fatalf("d-grade (45) risk %.3f should exceed c-grade (60) risk %.3f",
			engagementRisk(d), engagementRisk(c))
	}
}
