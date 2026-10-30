// SPDX-License-Identifier: AGPL-3.0-only

package subject_lab

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/subject_analyzer"
)

// wilson interval sanity: known closed-form values at z=1.645 (90%).
func TestWilsonInterval(t *testing.T) {
	cases := []struct {
		name              string
		successes, trials int64
		wantLow, wantHigh float64
	}{
		// 0 trials => maximally uncertain.
		{"no trials", 0, 0, 0.0, 1.0},
		// 50/100: symmetric-ish band around 0.5, bounded inside (0,1).
		{"half of hundred", 50, 100, 0.4188, 0.5812},
		// 5/10: small n => wide band, still inside (0,1).
		{"half of ten", 5, 10, 0.2693, 0.7307},
		// 0/20: lower bound pinned at 0, upper bound well below 1.
		{"none of twenty", 0, 20, 0.0, 0.1192},
		// 20/20: upper bound pinned at 1, lower bound well above 0.
		{"all of twenty", 20, 20, 0.8808, 1.0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			low, high := wilson(tc.successes, tc.trials, wilsonZ90)
			if math.Abs(low-tc.wantLow) > 0.01 {
				t.Errorf("low = %.4f, want ~%.4f", low, tc.wantLow)
			}
			if math.Abs(high-tc.wantHigh) > 0.01 {
				t.Errorf("high = %.4f, want ~%.4f", high, tc.wantHigh)
			}
			if low < 0 || high > 1 || low > high {
				t.Errorf("interval [%.4f, %.4f] is malformed", low, high)
			}
		})
	}
}

// Tighter band as n grows: 50/100 must be narrower than 5/10 (same p).
func TestWilsonTightensWithN(t *testing.T) {
	lowSmall, highSmall := wilson(5, 10, wilsonZ90)
	lowBig, highBig := wilson(50, 100, wilsonZ90)
	if (highBig - lowBig) >= (highSmall - lowSmall) {
		t.Fatalf("expected larger n to narrow the interval: small=%.3f big=%.3f",
			highSmall-lowSmall, highBig-lowBig)
	}
}

func TestWilsonBoundsImpossibleInputs(t *testing.T) {
	tests := []struct {
		name      string
		successes int64
		trials    int64
		z         float64
		wantLow   float64
		wantHigh  float64
	}{
		{name: "successes above trials clamp to all", successes: 21, trials: 20, z: wilsonZ90, wantLow: 0.8808, wantHigh: 1},
		{name: "negative successes clamp to none", successes: -1, trials: 20, z: wilsonZ90, wantLow: 0, wantHigh: 0.1192},
		{name: "NaN confidence is maximally uncertain", successes: 5, trials: 10, z: math.NaN(), wantLow: 0, wantHigh: 1},
		{name: "infinite confidence is maximally uncertain", successes: 5, trials: 10, z: math.Inf(1), wantLow: 0, wantHigh: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			low, high := wilson(tt.successes, tt.trials, tt.z)
			if math.Abs(low-tt.wantLow) > 0.01 || math.Abs(high-tt.wantHigh) > 0.01 {
				t.Fatalf("wilson = [%.4f, %.4f], want [%.4f, %.4f]", low, high, tt.wantLow, tt.wantHigh)
			}
			if math.IsNaN(low) || math.IsNaN(high) || low < 0 || high > 1 || low > high {
				t.Fatalf("interval [%.4f, %.4f] is not a bounded probability", low, high)
			}
		})
	}
}

// bucketKey groups exchangeable subjects and separates distinct ones.
func TestBucketKey(t *testing.T) {
	// Two short plain questions with different wording share a bucket.
	a := bucketKey(subject_analyzer.Extract("Are you ready?"))
	b := bucketKey(subject_analyzer.Extract("Coming today?"))
	if a != b {
		t.Errorf("expected same bucket for two short questions, got %q vs %q", a, b)
	}
	// A question vs a non-question differ.
	c := bucketKey(subject_analyzer.Extract("Big news inside"))
	if a == c {
		t.Errorf("question and statement should not share a bucket")
	}
	// Personalization flips the bucket.
	d := bucketKey(subject_analyzer.Extract("Hi {{first_name}}, ready?"))
	if d == a {
		t.Errorf("personalized variant should not share the plain bucket")
	}
}

// Below the matched-sample floor (or no bucket) => low_confidence fallback
// to baseline ±15%.
func TestScoreVariantFallback(t *testing.T) {
	v := scoreVariant("Brand new drop today?", 0.40, map[string]*bucketStat{})
	if !v.LowConfidence {
		t.Fatalf("expected low_confidence when no matching bucket")
	}
	if math.Abs(v.PredictedOpen-0.40) > 1e-9 {
		t.Errorf("predicted_open = %.3f, want baseline 0.40", v.PredictedOpen)
	}
	if math.Abs(v.CILow-0.25) > 1e-9 || math.Abs(v.CIHigh-0.55) > 1e-9 {
		t.Errorf("fallback CI = [%.3f, %.3f], want [0.25, 0.55]", v.CILow, v.CIHigh)
	}
	if v.BelowBaseline {
		t.Errorf("fallback must not assert below_baseline")
	}
}

// A populated bucket (≥5 campaigns) drives a real Wilson-backed estimate.
func TestScoreVariantMatched(t *testing.T) {
	subject := "Are you ready?"
	key := bucketKey(subject_analyzer.Extract(subject))
	// 8 campaigns, pooled 80/200 opens => 0.40 point estimate. Tenant
	// baseline far above the band so below_baseline trips.
	buckets := map[string]*bucketStat{
		key: {n: 8, opens: 80, sent: 200},
	}
	v := scoreVariant(subject, 0.70, buckets)
	if v.LowConfidence {
		t.Fatalf("expected high confidence with 8 matched campaigns")
	}
	if v.MatchedN != 8 {
		t.Errorf("matched_n = %d, want 8", v.MatchedN)
	}
	if math.Abs(v.PredictedOpen-0.40) > 1e-9 {
		t.Errorf("predicted_open = %.3f, want 0.40", v.PredictedOpen)
	}
	if !(v.CILow > 0 && v.CIHigh < 1 && v.CILow < v.CIHigh) {
		t.Errorf("Wilson band malformed: [%.3f, %.3f]", v.CILow, v.CIHigh)
	}
	if !v.BelowBaseline {
		t.Errorf("interval high %.3f < baseline 0.70 should set below_baseline", v.CIHigh)
	}
}

// The point estimate and confidence interval must use the exact same pooled
// distinct-recipient denominator. A mean of per-campaign rates could differ
// materially here and would make the displayed estimate inconsistent with its
// own confidence band.
func TestScoreVariantUsesPooledRecipientDenominator(t *testing.T) {
	subject := "Are you ready?"
	key := bucketKey(subject_analyzer.Extract(subject))
	buckets := map[string]*bucketStat{
		key: {n: 5, opens: 1, sent: 10},
	}
	v := scoreVariant(subject, 0.5, buckets)
	if math.Abs(v.PredictedOpen-0.1) > 1e-9 {
		t.Fatalf("predicted_open = %.4f, want pooled 1/10", v.PredictedOpen)
	}
	low, high := wilson(1, 10, wilsonZ90)
	if math.Abs(v.CILow-low) > 1e-9 || math.Abs(v.CIHigh-high) > 1e-9 {
		t.Fatalf("CI = [%.4f, %.4f], want Wilson(1/10) [%.4f, %.4f]", v.CILow, v.CIHigh, low, high)
	}
}

func TestScoreVariantAlwaysReturnsBoundedProbabilities(t *testing.T) {
	subject := "Are you ready?"
	key := bucketKey(subject_analyzer.Extract(subject))
	tests := []struct {
		name     string
		baseline float64
		buckets  map[string]*bucketStat
		want     float64
	}{
		{name: "negative fallback baseline", baseline: -0.5, buckets: map[string]*bucketStat{}, want: 0},
		{name: "oversized fallback baseline", baseline: 2, buckets: map[string]*bucketStat{}, want: 1},
		{name: "NaN fallback baseline", baseline: math.NaN(), buckets: map[string]*bucketStat{}, want: 0},
		{
			name:     "impossible matched counts",
			baseline: math.Inf(1),
			buckets: map[string]*bucketStat{
				key: {n: 5, opens: 11, sent: 10},
			},
			want: 1,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			v := scoreVariant(subject, tt.baseline, tt.buckets)
			if math.Abs(v.PredictedOpen-tt.want) > 1e-9 {
				t.Errorf("predicted_open = %.4f, want %.4f", v.PredictedOpen, tt.want)
			}
			for name, value := range map[string]float64{
				"predicted_open": v.PredictedOpen,
				"ci_low":         v.CILow,
				"ci_high":        v.CIHigh,
			} {
				if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 1 {
					t.Errorf("%s = %v, want finite probability", name, value)
				}
			}
			if v.CILow > v.CIHigh {
				t.Errorf("CI = [%.4f, %.4f] is inverted", v.CILow, v.CIHigh)
			}
		})
	}
}

func TestScoringModelQueryUsesDistinctRecipientOutcomes(t *testing.T) {
	normalized := strings.ToLower(strings.Join(strings.Fields(scoringModelQuery), " "))
	required := []string{
		"lower(btrim(e.subscriber_email::text)) as recipient",
		"bool_or(e.event_type = 'sent') as was_sent",
		"bool_or(e.event_type = 'opened') as was_opened",
		"group by s.id, s.subject, lower(btrim(e.subscriber_email::text))",
		"count(*) filter (where was_sent and was_opened) as opens",
		"count(*) filter (where was_sent) as sent",
		"e.at >= now() - interval '180 days'",
	}
	for _, fragment := range required {
		if !strings.Contains(normalized, fragment) {
			t.Errorf("scoring query lost distinct-recipient contract fragment %q\nquery: %s", fragment, normalized)
		}
	}
	if strings.Contains(normalized, "count(*) filter (where e.event_type = 'opened')") {
		t.Error("scoring query regressed to counting duplicate open events")
	}
}

func TestSubjectLabRoutesRequireWriteCampaigns(t *testing.T) {
	router := chi.NewRouter()
	MountRoutes(router, &Deps{Pool: &db.Pool{}})

	request := func(path string, scopes ...apikeys.Scope) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		ctx := middleware.WithAPIKeyAuth(req.Context())
		ctx = apikeys.WithScopes(ctx, scopes)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req.WithContext(ctx))
		return rec
	}

	for _, path := range []string{
		"/api/v1/subject-lab/variants",
		"/api/v1/subject-lab/score",
	} {
		t.Run(path, func(t *testing.T) {
			readOnly := request(path, apikeys.ScopeReadReports)
			if readOnly.Code != http.StatusForbidden || !strings.Contains(readOnly.Body.String(), "insufficient_scope") {
				t.Fatalf("read:reports reached write route: status=%d body=%q", readOnly.Code, readOnly.Body.String())
			}
			write := request(path, apikeys.ScopeWriteCampaigns)
			if write.Code != http.StatusUnauthorized || !strings.Contains(write.Body.String(), "no_tenant") {
				t.Fatalf("write:campaigns did not reach handler: status=%d body=%q", write.Code, write.Body.String())
			}
		})
	}
}

func TestScoreFailsClosedWhenScoringStoreIsUnavailable(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/subject-lab/score",
		strings.NewReader(`{"subjects":["A complete subject"]}`),
	)
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: "11111111-1111-1111-1111-111111111111",
	}))
	rec := httptest.NewRecorder()

	deps.score(rec, req)

	if rec.Code < 500 {
		t.Fatalf("status=%d body=%q; store failure must not look like a scored baseline", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if strings.Contains(rec.Body.String(), "baseline_open") || strings.Contains(rec.Body.String(), "open scoring transaction") {
		t.Fatalf("response exposed false evidence or internal detail: %q", rec.Body.String())
	}
	if _, ok := body["error"]; !ok {
		t.Fatalf("response lacks generic error envelope: %q", rec.Body.String())
	}
}

func TestScoringModelUnavailableDoesNotReturnSyntheticBaseline(t *testing.T) {
	deps := &Deps{}
	baseline, buckets, recipients, err := deps.scoringModel(
		context.Background(),
		"11111111-1111-1111-1111-111111111111",
	)
	if err == nil || baseline != 0 || buckets != nil || recipients != 0 {
		t.Fatalf("baseline=%v buckets=%v recipients=%d err=%v", baseline, buckets, recipients, err)
	}
}
