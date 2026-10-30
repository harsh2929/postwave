// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-function tests for the A/B winner auto-rollout. The dispatcher
// itself touches the DB and is exercised via the abtests scheduler's
// integration tests; this file covers the math + parsing.

package campaigns

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/abtests"
	"github.com/postwave/postwave/packages/runtime/campaigndispatch"
)

func TestABRolloutCannotMaterializeScheduledCampaignBeforeQualification(t *testing.T) {
	t.Parallel()

	for _, runtimeEnabled := range []bool{false, true} {
		_, err := (&ABRolloutDeps{RuntimeEnabled: runtimeEnabled}).CreateRollout(
			context.Background(), abtests.RolloutInput{},
		)
		if !errors.Is(err, campaigndispatch.ErrSchedulingUnqualified) {
			t.Fatalf("runtimeEnabled=%v error=%v, want compile-time scheduling lock before repository access",
				runtimeEnabled, err)
		}
	}
}

func TestApplyABRolloutHeldBack_Disjoint(t *testing.T) {
	// Disjointness invariant: for any parent_id + sample_pct, the
	// subscribers selected by the ORIGINAL test split (buckets <
	// sample_pct) must not overlap with the rollout (buckets >=
	// sample_pct). Without this, the same subscriber could receive
	// both the sample variant and the rollout winner.
	parentID := "00000000-0000-0000-0000-000000000abc"
	samplePct := float64(30)

	emails := make([]string, 0, 1000)
	for i := 0; i < 1000; i++ {
		emails = append(emails, fmt.Sprintf("user-%d@example.com", i))
	}

	rollout := ApplyABRolloutHeldBack(parentID, samplePct, emails)
	seen := map[string]bool{}
	for _, e := range rollout {
		seen[e] = true
	}
	// Sample emails: those whose percent_bucket < 30
	for _, e := range emails {
		bkt := percentBucket(parentID, e)
		if got, want := abtests.IsInSample(e, parentID, samplePct), bkt < int(samplePct); got != want {
			t.Fatalf("sample partition drift for %s: IsInSample=%v bucket=%d", e, got, bkt)
		}
		isInRollout := seen[e]
		if isInRollout && bkt < int(samplePct) {
			t.Fatalf("email %s with bucket %d landed in rollout (sample_pct=%v) — overlap!", e, bkt, samplePct)
		}
		if !isInRollout && bkt >= int(samplePct) {
			t.Fatalf("email %s with bucket %d MISSED the rollout (sample_pct=%v)", e, bkt, samplePct)
		}
	}
}

func TestApplyABRolloutHeldBack_ApproximatelyProportional(t *testing.T) {
	parentID := "test-parent"
	emails := make([]string, 0, 10000)
	for i := 0; i < 10000; i++ {
		emails = append(emails, fmt.Sprintf("u%d@x.com", i))
	}
	rollout := ApplyABRolloutHeldBack(parentID, 30, emails)
	// Expect ~70% of 10000 = ~7000. Allow ±200 (2%) for hash
	// distribution noise.
	if len(rollout) < 6800 || len(rollout) > 7200 {
		t.Errorf("rollout count = %d, expected ~7000 (±200) for sample_pct=30", len(rollout))
	}
}

func TestApplyABRolloutHeldBack_Deterministic(t *testing.T) {
	parentID := "abc"
	emails := []string{"a@x.com", "b@x.com", "c@x.com", "d@x.com"}
	first := ApplyABRolloutHeldBack(parentID, 50, emails)
	second := ApplyABRolloutHeldBack(parentID, 50, emails)
	if len(first) != len(second) {
		t.Fatalf("non-deterministic: %d vs %d", len(first), len(second))
	}
	for i := range first {
		if first[i] != second[i] {
			t.Errorf("at %d: %q vs %q", i, first[i], second[i])
		}
	}
}

func TestApplyABRolloutHeldBack_EdgeCases(t *testing.T) {
	cases := []struct {
		name     string
		parentID string
		pct      float64
		emails   []string
		wantNil  bool
		wantAll  bool
	}{
		{"empty parent", "", 30, []string{"a@x.com"}, true, false},
		{"sample_pct=0 means no test", "p", 0, []string{"a@x.com"}, true, false},
		{"sample_pct>=100 means full sample, no rollout", "p", 100, []string{"a@x.com"}, true, false},
		{"sample_pct=110 garbage clamps to nil", "p", 110, []string{"a@x.com"}, true, false},
		{"empty emails returns empty", "p", 30, []string{}, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ApplyABRolloutHeldBack(tc.parentID, tc.pct, tc.emails)
			if tc.wantNil && got != nil {
				t.Errorf("want nil, got %v", got)
			}
			if !tc.wantNil && got == nil {
				t.Errorf("want non-nil, got nil")
			}
		})
	}
}

func TestParseABRolloutConfig(t *testing.T) {
	t.Run("happy path with float64 sample_pct (json default)", func(t *testing.T) {
		delivery := map[string]any{
			"ab_test_rollout": map[string]any{
				"parent_id":          "abc",
				"winning_variant_id": "win",
				"sample_pct":         float64(30),
			},
		}
		pid, pct, ok := ParseABRolloutConfig(delivery)
		if !ok {
			t.Fatal("ok=false, want true")
		}
		if pid != "abc" {
			t.Errorf("parent_id=%q want abc", pid)
		}
		if pct != 30 {
			t.Errorf("sample_pct=%v want 30", pct)
		}
	})

	t.Run("int sample_pct also accepted", func(t *testing.T) {
		delivery := map[string]any{
			"ab_test_rollout": map[string]any{
				"parent_id":  "abc",
				"sample_pct": 30,
			},
		}
		_, pct, ok := ParseABRolloutConfig(delivery)
		if !ok || pct != 30 {
			t.Errorf("got pct=%v ok=%v", pct, ok)
		}
	})

	cases := []struct {
		name     string
		delivery map[string]any
	}{
		{"nil delivery", nil},
		{"missing block", map[string]any{"other": "x"}},
		{"non-map block", map[string]any{"ab_test_rollout": "string"}},
		{"missing parent_id", map[string]any{"ab_test_rollout": map[string]any{"sample_pct": 30}}},
		{"empty parent_id", map[string]any{"ab_test_rollout": map[string]any{"parent_id": "", "sample_pct": 30}}},
		{"missing sample_pct", map[string]any{"ab_test_rollout": map[string]any{"parent_id": "abc"}}},
		{"sample_pct=0", map[string]any{"ab_test_rollout": map[string]any{"parent_id": "abc", "sample_pct": float64(0)}}},
		{"sample_pct=100", map[string]any{"ab_test_rollout": map[string]any{"parent_id": "abc", "sample_pct": float64(100)}}},
		{"sample_pct as string", map[string]any{"ab_test_rollout": map[string]any{"parent_id": "abc", "sample_pct": "30"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, ok := ParseABRolloutConfig(tc.delivery)
			if ok {
				t.Errorf("ok=true, want false")
			}
		})
	}
}

// percent_bucket / variant_bucket disjointness: a subscriber's variant
// bucket and percent bucket are derived from the same hash but mod
// different denominators. We don't need them to agree — we need them
// to be RELATED such that the rollout audience strictly excludes the
// sample audience. The test above proves the practical invariant.
func TestPercentBucket_BoundedRange(t *testing.T) {
	for i := 0; i < 1000; i++ {
		b := percentBucket("p", fmt.Sprintf("u%d@x.com", i))
		if b < 0 || b >= 100 {
			t.Fatalf("bucket %d out of [0,100) for u%d", b, i)
		}
	}
}
