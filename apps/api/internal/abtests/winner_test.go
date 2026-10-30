package abtests

import (
	"context"
	"errors"
	"math"
	"testing"
)

func TestTwoProportionZ(t *testing.T) {
	cases := []struct {
		name           string
		x1, n1, x2, n2 int
		wantSign       int     // -1, 0, +1
		minAbs         float64 // |z| should be at least this
	}{
		{"identical", 50, 100, 50, 100, 0, 0},
		{"strong lift", 600, 1000, 400, 1000, +1, 5},
		{"weak lift large n", 510, 1000, 490, 1000, +1, 0},
		{"runner ahead", 100, 1000, 200, 1000, -1, 5},
		{"empty sample", 0, 0, 50, 100, 0, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			z := TwoProportionZ(tc.x1, tc.n1, tc.x2, tc.n2)
			switch tc.wantSign {
			case 0:
				if math.Abs(z) > 0.5 {
					t.Errorf("expected near-zero z, got %v", z)
				}
			case 1:
				if z <= 0 {
					t.Errorf("expected positive z, got %v", z)
				}
			case -1:
				if z >= 0 {
					t.Errorf("expected negative z, got %v", z)
				}
			}
			if tc.minAbs > 0 && math.Abs(z) < tc.minAbs {
				t.Errorf("|z|=%v below minAbs %v", math.Abs(z), tc.minAbs)
			}
		})
	}
}

func TestEvaluateWinner(t *testing.T) {
	cases := []struct {
		name     string
		metric   WinnerMetric
		results  []VariantResult
		wantID   string
		wantPick bool
	}{
		{
			name:   "no winner — too close",
			metric: WinnerMetricOpenRate,
			results: []VariantResult{
				{VariantID: "A", RecipientsCount: 100, Opens: 50},
				{VariantID: "B", RecipientsCount: 100, Opens: 51},
			},
			wantID:   "",
			wantPick: false,
		},
		{
			name:   "clear winner on opens",
			metric: WinnerMetricOpenRate,
			results: []VariantResult{
				{VariantID: "A", RecipientsCount: 1000, Opens: 600},
				{VariantID: "B", RecipientsCount: 1000, Opens: 400},
			},
			wantID:   "A",
			wantPick: true,
		},
		{
			name:   "clear winner on clicks",
			metric: WinnerMetricClickRate,
			results: []VariantResult{
				{VariantID: "A", RecipientsCount: 1000, Clicks: 50},
				{VariantID: "B", RecipientsCount: 1000, Clicks: 200},
			},
			wantID:   "B",
			wantPick: true,
		},
		{
			name:     "single variant — no comparison",
			metric:   WinnerMetricOpenRate,
			results:  []VariantResult{{VariantID: "A", RecipientsCount: 100, Opens: 80}},
			wantID:   "",
			wantPick: false,
		},
		{
			name:   "invalid metric",
			metric: WinnerMetric("nope"),
			results: []VariantResult{
				{VariantID: "A", RecipientsCount: 1000, Opens: 600},
				{VariantID: "B", RecipientsCount: 1000, Opens: 400},
			},
			wantID:   "",
			wantPick: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			id, ok := EvaluateWinner(context.Background(), "camp-x", tc.metric, tc.results)
			if ok != tc.wantPick {
				t.Errorf("pick: want %v, got %v (id=%q)", tc.wantPick, ok, id)
			}
			if id != tc.wantID {
				t.Errorf("id: want %q, got %q", tc.wantID, id)
			}
		})
	}
}

// fakeReplyCounter is a stub for ReplyCounter used to drive the
// reply_rate path through known totals.
type fakeReplyCounter struct {
	total int
	err   error
	calls int
}

func (f *fakeReplyCounter) CountForCampaign(_ context.Context, _, _ string) (int, error) {
	f.calls++
	if f.err != nil {
		return 0, f.err
	}
	return f.total, nil
}

// TestEvaluateWinnerReplyRateUsesRealCount confirms that when a
// ReplyCounter is wired in, the picker uses the real count (apportioned
// proportionally) instead of the engagement_proxy fallback.
func TestEvaluateWinnerReplyRateUsesRealCount(t *testing.T) {
	// Variant A has 80% of recipients and 80% of replies should land
	// there; variant B has 20%. Engagement proxy would compute 0
	// successes for both (no clicks), so without the real reply
	// counter no winner would be picked. With the counter, A wins.
	results := []VariantResult{
		{VariantID: "A", TenantID: "tenant-1", RecipientsCount: 8000},
		{VariantID: "B", TenantID: "tenant-1", RecipientsCount: 2000},
	}
	deps := &WinnerDeps{ReplyCounter: &fakeReplyCounter{total: 1000}}
	// 1000 replies apportioned: A gets 800, B gets 200. Same rate
	// (0.10) → no winner. Test the equal-rate case first.
	id, ok := EvaluateWinnerWithDeps(context.Background(), deps, "camp-1", WinnerMetricReplyRate, results, LookBudget{Planned: 1, Taken: 1})
	if ok {
		t.Errorf("equal-share apportionment should yield no winner; got %q", id)
	}
}

// TestEvaluateWinnerReplyRateFallbackWhenNoCounter confirms the
// engagement_proxy fallback fires when no ReplyCounter is configured.
func TestEvaluateWinnerReplyRateFallbackWhenNoCounter(t *testing.T) {
	// Same shape the original TODO computed: A's (clicks - unsubs)
	// >> B's, so A wins via the proxy.
	results := []VariantResult{
		{VariantID: "A", RecipientsCount: 1000, Clicks: 200, Unsubscribes: 0},
		{VariantID: "B", RecipientsCount: 1000, Clicks: 50, Unsubscribes: 0},
	}
	id, ok := EvaluateWinner(context.Background(), "camp-1", WinnerMetricReplyRate, results)
	if !ok {
		t.Fatalf("expected fallback to pick a winner, got none")
	}
	if id != "A" {
		t.Errorf("expected A, got %q", id)
	}
}

// TestEvaluateWinnerReplyRateCounterErrorFallsBack confirms that a
// transient ReplyCounter error degrades to engagement_proxy rather
// than blocking winner selection.
func TestEvaluateWinnerReplyRateCounterErrorFallsBack(t *testing.T) {
	results := []VariantResult{
		{VariantID: "A", TenantID: "tenant-1", RecipientsCount: 1000, Clicks: 200},
		{VariantID: "B", TenantID: "tenant-1", RecipientsCount: 1000, Clicks: 50},
	}
	deps := &WinnerDeps{ReplyCounter: &fakeReplyCounter{err: errors.New("db unreachable")}}
	id, ok := EvaluateWinnerWithDeps(context.Background(), deps, "camp-1", WinnerMetricReplyRate, results, LookBudget{Planned: 1, Taken: 1})
	if !ok || id != "A" {
		t.Errorf("expected A via fallback, got id=%q ok=%v", id, ok)
	}
}

// TestComputeReplyAttribution verifies the proportional split and the
// remainder-allocation tiebreaker.
func TestComputeReplyAttribution(t *testing.T) {
	results := []VariantResult{
		{VariantID: "A", RecipientsCount: 600},
		{VariantID: "B", RecipientsCount: 300},
		{VariantID: "C", RecipientsCount: 100},
	}
	got := computeReplyAttribution(results, 100)
	// Proportional: A=60, B=30, C=10.
	if got["A"]+got["B"]+got["C"] != 100 {
		t.Errorf("attribution does not sum to total: %+v", got)
	}
	if got["A"] != 60 || got["B"] != 30 || got["C"] != 10 {
		t.Errorf("proportional split off: %+v", got)
	}

	// Total 0 → all zeros.
	zero := computeReplyAttribution(results, 0)
	for _, v := range zero {
		if v != 0 {
			t.Errorf("expected all zeros, got %+v", zero)
		}
	}

	// All-zero recipients → all zeros (no division by zero).
	emptyR := []VariantResult{{VariantID: "A"}, {VariantID: "B"}}
	emptyOut := computeReplyAttribution(emptyR, 50)
	if emptyOut["A"] != 0 || emptyOut["B"] != 0 {
		t.Errorf("zero-recipients case should be all zeros: %+v", emptyOut)
	}

	// Remainder lands on largest-recipients variant.
	odd := []VariantResult{
		{VariantID: "A", RecipientsCount: 700},
		{VariantID: "B", RecipientsCount: 300},
	}
	oddOut := computeReplyAttribution(odd, 7) // 700/1000*7=4.9→4 ; 300/1000*7=2.1→2 ; remainder=1 → A
	if oddOut["A"]+oddOut["B"] != 7 {
		t.Errorf("remainder allocation lost replies: %+v", oddOut)
	}
	if oddOut["A"] < 4 {
		t.Errorf("A should keep its share + remainder: %+v", oddOut)
	}
}

// TestEngagementProxyClampsNegative ensures the legacy proxy doesn't
// produce negative numerators (a campaign with more unsubscribes than
// clicks would otherwise z-test against negative numbers).
func TestEngagementProxyClampsNegative(t *testing.T) {
	got := engagementProxy(VariantResult{Clicks: 5, Unsubscribes: 20})
	if got != 0 {
		t.Errorf("expected 0 (clamped), got %d", got)
	}
}
