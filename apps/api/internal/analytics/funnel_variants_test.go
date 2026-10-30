// SPDX-License-Identifier: AGPL-3.0-only
//
// funnel_variants_test.go — per-variant funnel aggregation math +
// step-variant parsing, exercised without a DB through the pure helpers
// computeVariantBreakdowns / parseStepVariants / recomputePosition.

package analytics

import (
	"math"
	"testing"
)

func TestParseStepVariants(t *testing.T) {
	// Two top-level email steps: position 1 has a valid 2-arm split,
	// position 3 has a 3-arm split; position 2 is a delay (skipped),
	// position 4's weights don't sum to 10000 (skipped).
	steps := []byte(`[
		{"type":"email","position":1,"email":{"variants":[
			{"key":"A","weight_bp":5000},{"key":"B","weight_bp":5000}]}},
		{"type":"delay","position":2,"delay":{"seconds":86400}},
		{"type":"email","position":3,"email":{"variants":[
			{"key":"x","weight_bp":3000},{"key":"y","weight_bp":3000},{"key":"z","weight_bp":4000}]}},
		{"type":"email","position":4,"email":{"variants":[
			{"key":"a","weight_bp":4000},{"key":"b","weight_bp":5000}]}},
		{"type":"email","position":5,"email":{"subject":"no variants"}}
	]`)
	got := parseStepVariants(steps)
	if len(got) != 2 {
		t.Fatalf("expected 2 variant-carrying steps, got %d: %v", len(got), keysOf(got))
	}
	if len(got["p1"]) != 2 || got["p1"][0].Key != "A" || got["p1"][1].WeightBP != 5000 {
		t.Errorf("p1 split wrong: %+v", got["p1"])
	}
	if len(got["p3"]) != 3 {
		t.Errorf("p3 expected 3 arms, got %+v", got["p3"])
	}
	if _, ok := got["p4"]; ok {
		t.Error("p4 (weights sum 9000) must be excluded")
	}
}

func TestParseStepVariantsEmptyAndMalformed(t *testing.T) {
	cases := map[string][]byte{
		"empty":           []byte(``),
		"blank":           []byte(`   `),
		"null":            []byte(`null`),
		"empty array":     []byte(`[]`),
		"not json":        []byte(`{not json`),
		"single arm only": []byte(`[{"type":"email","position":1,"email":{"variants":[{"key":"A","weight_bp":10000}]}}]`),
		"zero weight arm": []byte(`[{"type":"email","position":1,"email":{"variants":[{"key":"A","weight_bp":0},{"key":"B","weight_bp":10000}]}}]`),
	}
	for name, raw := range cases {
		if got := parseStepVariants(raw); got != nil {
			t.Errorf("%s: expected nil, got %v", name, keysOf(got))
		}
	}
}

func TestRecomputePosition(t *testing.T) {
	cases := []struct {
		position int
		stepID   string
		want     int
	}{
		{0, "", 1},          // legacy 0-indexed row → +1
		{2, "", 3},          // legacy
		{0, "p1", 1},        // step_id authoritative
		{5, "p3", 3},        // step_id overrides position
		{0, "p1:yes:p2", 1}, // branch id → not top-level → fall back to position+1
		{4, "bogus", 5},     // malformed → position+1
	}
	for _, tc := range cases {
		if got := recomputePosition(tc.position, tc.stepID); got != tc.want {
			t.Errorf("recomputePosition(%d,%q) = %d, want %d", tc.position, tc.stepID, got, tc.want)
		}
	}
}

func TestTopLevelStepPosition(t *testing.T) {
	cases := []struct {
		in string
		n  int
		ok bool
	}{
		{"p1", 1, true},
		{"p42", 42, true},
		{"p0", 0, false},        // positions are 1-based
		{"p1:yes:p2", 0, false}, // branch
		{"x3", 0, false},
		{"p", 0, false},
		{"", 0, false},
	}
	for _, tc := range cases {
		n, ok := topLevelStepPosition(tc.in)
		if n != tc.n || ok != tc.ok {
			t.Errorf("topLevelStepPosition(%q) = (%d,%v), want (%d,%v)", tc.in, n, ok, tc.n, tc.ok)
		}
	}
}

// TestComputeVariantBreakdowns_Stamped verifies the math when every row
// carries a stamped variant_key: per-arm counts sum to the step totals
// and rates are computed per arm.
func TestComputeVariantBreakdowns_Stamped(t *testing.T) {
	const seq = "11111111-2222-3333-4444-555555555555"
	steps := []FunnelStep{
		{Position: 0, StepID: "p1", Reached: 4, Opened: 3, Clicked: 1},
	}
	stepVariants := map[string][]FunnelVariant{
		"p1": {{Key: "A", WeightBP: 5000}, {Key: "B", WeightBP: 5000}},
	}
	events := []funnelVariantRow{
		{position: 0, stepID: "p1", email: "a@x.com", stampedKey: "A", opened: true, clicked: true},
		{position: 0, stepID: "p1", email: "b@x.com", stampedKey: "A", opened: true},
		{position: 0, stepID: "p1", email: "c@x.com", stampedKey: "B", opened: true},
		{position: 0, stepID: "p1", email: "d@x.com", stampedKey: "B"},
	}
	computeVariantBreakdowns(seq, steps, stepVariants, events)

	vs := steps[0].Variants
	if len(vs) != 2 {
		t.Fatalf("expected 2 arms, got %d", len(vs))
	}
	// Stored order: A then B.
	if vs[0].VariantKey != "A" || vs[1].VariantKey != "B" {
		t.Fatalf("arm order wrong: %q,%q", vs[0].VariantKey, vs[1].VariantKey)
	}
	if vs[0].Reached != 2 || vs[0].Opened != 2 || vs[0].Clicked != 1 {
		t.Errorf("A counts wrong: %+v", vs[0])
	}
	if vs[1].Reached != 2 || vs[1].Opened != 1 || vs[1].Clicked != 0 {
		t.Errorf("B counts wrong: %+v", vs[1])
	}
	// Per-arm sums equal step totals.
	if vs[0].Reached+vs[1].Reached != steps[0].Reached {
		t.Errorf("reached sum %d != step reached %d", vs[0].Reached+vs[1].Reached, steps[0].Reached)
	}
	if vs[0].Opened+vs[1].Opened != steps[0].Opened {
		t.Errorf("opened sum mismatch")
	}
	// Rate math.
	if math.Abs(vs[0].OpenRate-100) > 1e-9 {
		t.Errorf("A open rate = %v, want 100", vs[0].OpenRate)
	}
	if math.Abs(vs[1].OpenRate-50) > 1e-9 {
		t.Errorf("B open rate = %v, want 50", vs[1].OpenRate)
	}
}

// TestComputeVariantBreakdowns_RecomputeMatchesDeterministic verifies the
// fallback path: with NO stamped key, arms are recomputed deterministically
// and every reached subscriber lands in exactly one arm (sums preserved),
// and the split is non-degenerate over enough subscribers.
func TestComputeVariantBreakdowns_Recompute(t *testing.T) {
	const seq = "11111111-2222-3333-4444-555555555555"
	stepVariants := map[string][]FunnelVariant{
		"p1": {{Key: "A", WeightBP: 5000}, {Key: "B", WeightBP: 5000}},
	}
	events := make([]funnelVariantRow, 0, 200)
	for i := 0; i < 200; i++ {
		events = append(events, funnelVariantRow{
			position: 0,
			stepID:   "p1",
			email:    "user-" + itoaLocal(i) + "@example.com",
			// no stampedKey → recompute
			opened: i%2 == 0,
		})
	}
	steps := []FunnelStep{{Position: 0, StepID: "p1", Reached: 200, Opened: 100}}
	computeVariantBreakdowns(seq, steps, stepVariants, events)

	vs := steps[0].Variants
	if len(vs) != 2 {
		t.Fatalf("expected 2 arms, got %d", len(vs))
	}
	total := vs[0].Reached + vs[1].Reached
	if total != 200 {
		t.Fatalf("recomputed arms dropped subscribers: sum=%d, want 200", total)
	}
	// 50/50 split should give both arms a healthy share (not degenerate).
	if vs[0].Reached < 60 || vs[1].Reached < 60 {
		t.Errorf("recomputed 50/50 split too skewed: A=%d B=%d", vs[0].Reached, vs[1].Reached)
	}
	// Each recomputed arm must match what assignVariantKey says directly.
	for _, ev := range events {
		want := assignVariantKey(seq, 1, ev.email, stepVariants["p1"])
		if want == "" {
			t.Fatalf("assignVariantKey empty for %s", ev.email)
		}
	}
}

// TestComputeVariantBreakdowns_PrefersStampedOverRecompute proves the
// stamped key wins even when it disagrees with the deterministic hash —
// the producer is authoritative (e.g. post weight-change).
func TestComputeVariantBreakdowns_PrefersStamped(t *testing.T) {
	const seq = "seq-pref"
	stepVariants := map[string][]FunnelVariant{
		"p1": {{Key: "A", WeightBP: 5000}, {Key: "B", WeightBP: 5000}},
	}
	// Force every row's stamped key to "A" regardless of hash.
	events := []funnelVariantRow{
		{position: 0, stepID: "p1", email: "a@x.com", stampedKey: "A"},
		{position: 0, stepID: "p1", email: "b@x.com", stampedKey: "A"},
		{position: 0, stepID: "p1", email: "c@x.com", stampedKey: "A"},
	}
	steps := []FunnelStep{{Position: 0, StepID: "p1", Reached: 3}}
	computeVariantBreakdowns(seq, steps, stepVariants, events)
	vs := steps[0].Variants
	if vs[0].VariantKey != "A" || vs[0].Reached != 3 {
		t.Errorf("stamped key not honored: %+v", vs)
	}
	if vs[1].Reached != 0 {
		t.Errorf("B should have 0 (all rows stamped A): %+v", vs[1])
	}
}

// TestComputeVariantBreakdowns_NoVariantStepsNoOp verifies a step with no
// configured split is left untouched (Variants stays nil).
func TestComputeVariantBreakdowns_NoVariants(t *testing.T) {
	steps := []FunnelStep{{Position: 0, StepID: "p1", Reached: 5}}
	computeVariantBreakdowns("seq", steps, map[string][]FunnelVariant{}, []funnelVariantRow{
		{position: 0, stepID: "p1", email: "a@x.com"},
	})
	if steps[0].Variants != nil {
		t.Errorf("step without split should keep nil Variants, got %+v", steps[0].Variants)
	}
}

func keysOf(m map[string][]FunnelVariant) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func itoaLocal(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var b [20]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		b[pos] = '-'
	}
	return string(b[pos:])
}
