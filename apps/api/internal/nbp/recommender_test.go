// SPDX-License-Identifier: AGPL-3.0-only
//
// Recommender unit tests using in-memory stubs. These don't exercise
// the SQL layer — the e2e tests cover that — but they pin down the
// scoring math + dedupe-against-bloom behaviour so a regression in
// the candidate-aggregation loop fails fast.

package nbp

import (
	"context"
	"testing"
	"time"
)

func TestDefaultSettingsRanges(t *testing.T) {
	d := DefaultSettings()
	if d.RecencyExcludeDays != 730 {
		t.Errorf("recency window drifted from Klaviyo default: %d", d.RecencyExcludeDays)
	}
	if d.TopNPerUser != 6 {
		t.Errorf("top_n_per_user drift: %d", d.TopNPerUser)
	}
	if d.RefresherStrategy != StrategyItemItemCF {
		t.Errorf("default strategy drift: %s", d.RefresherStrategy)
	}
	if d.BloomTargetFPR <= 0 || d.BloomTargetFPR >= 0.5 {
		t.Errorf("bloom target FPR out of CHECK range: %f", d.BloomTargetFPR)
	}
}

func TestHasAffinitySkipsKnownPurchases(t *testing.T) {
	anchors := []UserAffinity{
		{ProductID: "p-1", Score: 0.9},
		{ProductID: "p-2", Score: 0.7},
	}
	if !hasAffinity(anchors, "p-1") {
		t.Error("expected hasAffinity true for anchor p-1")
	}
	if hasAffinity(anchors, "p-99") {
		t.Error("expected hasAffinity false for unrelated product")
	}
}

func TestBoundedLogClampsToUnit(t *testing.T) {
	// Popularity scores must stay within [0, 1] so they sort cleanly
	// against item-item CF scores which live in the same range.
	cases := []int{0, 1, 10, 100, 10000, 1_000_000}
	for _, n := range cases {
		got := boundedLog(n)
		if got < 0 || got > 1 {
			t.Errorf("boundedLog(%d) = %f outside [0,1]", n, got)
		}
	}
}

func TestRecommenderNilSafe(t *testing.T) {
	// The Liquid helper must NEVER block a render — even if the
	// recommender or repo is nil (e.g. the feature isn't wired in a
	// given binary), we should return an empty slice silently.
	var r *Recommender
	out, err := r.RecommendForSubscriber(context.Background(), RecommendInput{
		TenantID:     "t-1",
		SubscriberID: "s-1",
		Now:          time.Now(),
	})
	if err != nil {
		t.Errorf("nil recommender returned error: %v", err)
	}
	if len(out) != 0 {
		t.Errorf("nil recommender returned %d items", len(out))
	}
}

func TestInjectMergeVarsAlwaysSetsKey(t *testing.T) {
	// {% for p in recommended_products %} must never reference a
	// missing variable. Even with a nil recommender, the key must
	// be defined (as an empty array) so the merge engine doesn't
	// surface a "variable not found" warning.
	vars := map[string]any{}
	InjectMergeVars(context.Background(), nil, vars, RecommendInput{})
	v, ok := vars[LiquidHelperName]
	if !ok {
		t.Fatalf("InjectMergeVars did not set %q", LiquidHelperName)
	}
	arr, ok := v.([]map[string]any)
	if !ok || len(arr) != 0 {
		t.Errorf("expected empty []map[string]any, got %T value %v", v, v)
	}
}

func TestSyntaxExampleMentionsHelper(t *testing.T) {
	got := SyntaxExample()
	if len(got) == 0 {
		t.Fatal("SyntaxExample returned empty")
	}
	if !contains(got, LiquidHelperName) {
		t.Errorf("example missing helper name %q: %s", LiquidHelperName, got)
	}
	if !contains(got, "{% for") || !contains(got, "{% endfor %}") {
		t.Errorf("example missing for/endfor tokens: %s", got)
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || indexOf(s, substr) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
