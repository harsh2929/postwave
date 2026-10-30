// SPDX-License-Identifier: AGPL-3.0-only

package sms

import (
	"fmt"
	"testing"
)

func TestParseABVariants(t *testing.T) {
	t.Parallel()

	// nil / missing → no A/B.
	if v := parseABVariants(nil); v != nil {
		t.Fatalf("nil metadata should yield no variants, got %+v", v)
	}
	if v := parseABVariants(map[string]any{"ab_variants": []any{
		map[string]any{"label": "A", "body": "only one"},
	}}); v != nil {
		t.Fatalf("single variant should fall back to no A/B, got %+v", v)
	}

	// Two valid variants with explicit label + weight.
	got := parseABVariants(map[string]any{"ab_variants": []any{
		map[string]any{"label": "A", "body": "hello A", "weight": float64(70)},
		map[string]any{"label": "B", "body": "hello B", "weight": float64(30)},
	}})
	if len(got) != 2 {
		t.Fatalf("expected 2 variants, got %d", len(got))
	}
	if got[0].Label != "A" || got[0].Body != "hello A" || got[0].Weight != 70 {
		t.Fatalf("variant A mismatch: %+v", got[0])
	}
	if got[1].Weight != 30 {
		t.Fatalf("variant B weight mismatch: %+v", got[1])
	}

	// Empty-body entries are dropped; if fewer than 2 remain → no A/B.
	if v := parseABVariants(map[string]any{"ab_variants": []any{
		map[string]any{"label": "A", "body": "kept"},
		map[string]any{"label": "B", "body": "   "},
	}}); v != nil {
		t.Fatalf("blank second body should collapse to no A/B, got %+v", v)
	}

	// Missing labels auto-assign A, B, ...
	auto := parseABVariants(map[string]any{"ab_variants": []any{
		map[string]any{"body": "one"},
		map[string]any{"body": "two"},
	}})
	if len(auto) != 2 || auto[0].Label != "A" || auto[1].Label != "B" {
		t.Fatalf("auto-label mismatch: %+v", auto)
	}
}

func TestPickVariantDeterministicAndDistributes(t *testing.T) {
	t.Parallel()

	variants := []abVariant{
		{Label: "A", Body: "a", Weight: 50},
		{Label: "B", Body: "b", Weight: 50},
	}

	// Deterministic: same phone → same variant every call.
	firstPick := pickVariant(variants, "+14155550123").Label
	for i := 0; i < 100; i++ {
		if pickVariant(variants, "+14155550123").Label != firstPick {
			t.Fatal("pickVariant is not deterministic for a fixed phone")
		}
	}

	// Distribution: across many phones both variants get selected (a stuck
	// bucketer that always returns A would fail this).
	counts := map[string]int{}
	for i := 0; i < 1000; i++ {
		counts[pickVariant(variants, fmt.Sprintf("+1415555%04d", i)).Label]++
	}
	if counts["A"] == 0 || counts["B"] == 0 {
		t.Fatalf("expected both variants selected, got %+v", counts)
	}

	// Zero total weight falls back to an even hash split (no panic, both used).
	zero := []abVariant{{Label: "A", Body: "a", Weight: 0}, {Label: "B", Body: "b", Weight: 0}}
	zc := map[string]int{}
	for i := 0; i < 500; i++ {
		zc[pickVariant(zero, fmt.Sprintf("z%04d", i)).Label]++
	}
	if zc["A"] == 0 || zc["B"] == 0 {
		t.Fatalf("zero-weight fallback should still split, got %+v", zc)
	}

	// A 100/0 weighting sends everyone to A.
	skew := []abVariant{{Label: "A", Body: "a", Weight: 1}, {Label: "B", Body: "b", Weight: 0}}
	for i := 0; i < 200; i++ {
		if pickVariant(skew, fmt.Sprintf("s%04d", i)).Label != "A" {
			t.Fatal("100/0 split should always pick A")
		}
	}
}
