package campaigns

// Tests for the A/B test deterministic split helpers.
//
// All cases are pure (no DB) — they exercise the hash + bucket logic
// directly so we can prove:
//
//   - Each email lands in exactly one variant.
//   - The split is deterministic across runs (same parent + email →
//     same variant).
//   - Different parents yield different splits (no cross-A/B carry).
//   - The 3-way split is roughly uniform across a 1000-email audience
//     (each bucket holds 300–366 entries).

import (
	"fmt"
	"testing"
)

// TestApplyABTestSplit_3WayUniformity asserts that splitting 1000
// synthetic emails 3 ways produces buckets between 300 and 366 each.
// fnv-1a is not cryptographic but its avalanche characteristics are
// good enough for this kind of bucketing.
func TestApplyABTestSplit_3WayUniformity(t *testing.T) {
	const n = 1000
	const variants = 3
	parentID := "00000000-0000-0000-0000-deadbeef0001"

	emails := make([]string, n)
	for i := 0; i < n; i++ {
		emails[i] = fmt.Sprintf("user%04d@example.com", i)
	}

	counts := make([]int, variants)
	for i := 0; i < variants; i++ {
		cfg := ABTestVariantConfig{
			ParentID:      parentID,
			VariantIndex:  i,
			TotalVariants: variants,
		}
		got := ApplyABTestSplit(cfg, emails)
		counts[i] = len(got)
	}

	// Sum must equal n (no email dropped, no email duplicated).
	total := 0
	for _, c := range counts {
		total += c
	}
	if total != n {
		t.Fatalf("variant counts sum to %d, want %d. Got: %v", total, n, counts)
	}

	// Each variant in [300, 366] — generous bounds catch a broken hash
	// while permitting normal jitter.
	for i, c := range counts {
		if c < 300 || c > 366 {
			t.Errorf("variant %d count = %d, want 300..366. All counts: %v", i, c, counts)
		}
	}
}

// TestApplyABTestSplit_DisjointVariants asserts no email appears in
// more than one variant under the same parent_id.
func TestApplyABTestSplit_DisjointVariants(t *testing.T) {
	const n = 1000
	const variants = 3
	parentID := "00000000-0000-0000-0000-deadbeef0002"

	emails := make([]string, n)
	for i := 0; i < n; i++ {
		emails[i] = fmt.Sprintf("user%04d@example.com", i)
	}

	seen := make(map[string]int) // email → variant
	for i := 0; i < variants; i++ {
		cfg := ABTestVariantConfig{
			ParentID:      parentID,
			VariantIndex:  i,
			TotalVariants: variants,
		}
		for _, e := range ApplyABTestSplit(cfg, emails) {
			if prev, dup := seen[e]; dup {
				t.Fatalf("email %s appears in variants %d AND %d", e, prev, i)
			}
			seen[e] = i
		}
	}
	if len(seen) != n {
		t.Fatalf("union of variants holds %d emails, want %d (some emails dropped)", len(seen), n)
	}
}

// TestApplyABTestSplit_Deterministic asserts that running the same
// split twice yields identical results — guards against accidentally
// using a non-deterministic seed.
func TestApplyABTestSplit_Deterministic(t *testing.T) {
	parentID := "00000000-0000-0000-0000-deadbeef0003"
	emails := []string{
		"alpha@example.com", "beta@example.com", "gamma@example.com",
		"delta@example.com", "epsilon@example.com", "zeta@example.com",
	}
	cfg := ABTestVariantConfig{ParentID: parentID, VariantIndex: 1, TotalVariants: 3}

	first := ApplyABTestSplit(cfg, emails)
	second := ApplyABTestSplit(cfg, emails)
	if len(first) != len(second) {
		t.Fatalf("nondeterministic split: first=%v second=%v", first, second)
	}
	for i := range first {
		if first[i] != second[i] {
			t.Fatalf("nondeterministic split at index %d: %q vs %q", i, first[i], second[i])
		}
	}
}

// TestApplyABTestSplit_DifferentParentIDs asserts that two A/B tests
// running over the same audience produce different splits — i.e. the
// parent_id is meaningfully part of the hash key.
func TestApplyABTestSplit_DifferentParentIDs(t *testing.T) {
	const n = 200
	emails := make([]string, n)
	for i := 0; i < n; i++ {
		emails[i] = fmt.Sprintf("user%04d@example.com", i)
	}

	cfgA := ABTestVariantConfig{ParentID: "parent-A", VariantIndex: 0, TotalVariants: 3}
	cfgB := ABTestVariantConfig{ParentID: "parent-B", VariantIndex: 0, TotalVariants: 3}

	splitA := ApplyABTestSplit(cfgA, emails)
	splitB := ApplyABTestSplit(cfgB, emails)

	// We don't expect the splits to be identical — that would imply the
	// parent_id wasn't part of the hash key.
	if len(splitA) == len(splitB) && stringSliceEqual(splitA, splitB) {
		t.Fatalf("splits for different parent_ids are identical (%d emails); parent_id ignored?", len(splitA))
	}
}

// TestApplyABTestSplit_SameParentSameEmailSameBucket — the most
// important determinism contract. Used by re-queue + retry paths to
// guarantee an email never moves between variants for the same A/B test.
func TestApplyABTestSplit_SameParentSameEmailSameBucket(t *testing.T) {
	parentID := "fixed-parent-000"
	email := "stable@example.com"
	first := abVariantBucket(parentID, email, 5)
	for i := 0; i < 100; i++ {
		got := abVariantBucket(parentID, email, 5)
		if got != first {
			t.Fatalf("bucket flipped: first=%d, iter %d=%d", first, i, got)
		}
	}
}

// TestApplyABTestSplit_NoConfigReturnsAll — when total_variants < 2 the
// helper is a passthrough. Guards the no-A/B-test branch in
// QueueCampaign.
func TestApplyABTestSplit_NoConfigReturnsAll(t *testing.T) {
	emails := []string{"a@x.com", "b@x.com", "c@x.com"}

	cases := []ABTestVariantConfig{
		{ /* zero value */ },
		{ParentID: "p", VariantIndex: 0, TotalVariants: 1},
		{ParentID: "", VariantIndex: 0, TotalVariants: 3}, // missing parent
	}
	for i, cfg := range cases {
		got := ApplyABTestSplit(cfg, emails)
		if len(got) != len(emails) {
			t.Errorf("case %d: cfg=%+v split %d emails, want %d", i, cfg, len(got), len(emails))
		}
	}
}

// TestParseABTestVariantConfig_Roundtrip validates both the int + the
// JSON-decoded float64 shapes that turn up in delivery_settings.
func TestParseABTestVariantConfig_Roundtrip(t *testing.T) {
	t.Run("int form", func(t *testing.T) {
		ds := map[string]any{
			"ab_test": map[string]any{
				"parent_id":      "abc",
				"variant_index":  1,
				"total_variants": 3,
			},
		}
		cfg, ok := ParseABTestVariantConfig(ds)
		if !ok {
			t.Fatal("ok=false, want true for valid metadata")
		}
		if cfg.ParentID != "abc" || cfg.VariantIndex != 1 || cfg.TotalVariants != 3 {
			t.Fatalf("cfg=%+v", cfg)
		}
	})
	t.Run("float form", func(t *testing.T) {
		ds := map[string]any{
			"ab_test": map[string]any{
				"parent_id":      "abc",
				"variant_index":  float64(2),
				"total_variants": float64(4),
			},
		}
		cfg, ok := ParseABTestVariantConfig(ds)
		if !ok {
			t.Fatal("ok=false, want true for float-form metadata")
		}
		if cfg.VariantIndex != 2 || cfg.TotalVariants != 4 {
			t.Fatalf("cfg=%+v", cfg)
		}
	})
	t.Run("missing parent_id", func(t *testing.T) {
		ds := map[string]any{
			"ab_test": map[string]any{
				"variant_index":  0,
				"total_variants": 3,
			},
		}
		if _, ok := ParseABTestVariantConfig(ds); ok {
			t.Fatal("ok=true for missing parent_id, want false")
		}
	})
	t.Run("variant_index out of range", func(t *testing.T) {
		ds := map[string]any{
			"ab_test": map[string]any{
				"parent_id":      "abc",
				"variant_index":  5,
				"total_variants": 3,
			},
		}
		if _, ok := ParseABTestVariantConfig(ds); ok {
			t.Fatal("ok=true for out-of-range variant_index, want false")
		}
	})
	t.Run("total_variants < 2", func(t *testing.T) {
		ds := map[string]any{
			"ab_test": map[string]any{
				"parent_id":      "abc",
				"variant_index":  0,
				"total_variants": 1, // not really a split
			},
		}
		if _, ok := ParseABTestVariantConfig(ds); ok {
			t.Fatal("ok=true for total_variants=1, want false")
		}
	})
	t.Run("no ab_test key", func(t *testing.T) {
		ds := map[string]any{"other": "value"}
		if _, ok := ParseABTestVariantConfig(ds); ok {
			t.Fatal("ok=true with no ab_test key, want false")
		}
	})
	t.Run("nil delivery_settings", func(t *testing.T) {
		if _, ok := ParseABTestVariantConfig(nil); ok {
			t.Fatal("ok=true with nil map, want false")
		}
	})
}

// stringSliceEqual is a small helper used only by abtest_test.go.
func stringSliceEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
