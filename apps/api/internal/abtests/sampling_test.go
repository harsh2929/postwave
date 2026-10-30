package abtests

import (
	"fmt"
	"math"
	"testing"
)

func TestAssignVariant_Deterministic(t *testing.T) {
	variants := []Variant{
		{VariantLabel: "A", Weight: 50},
		{VariantLabel: "B", Weight: 50},
	}
	const camp = "camp-1"
	for i := 0; i < 200; i++ {
		sub := fmt.Sprintf("sub-%d", i)
		first := AssignVariant(sub, camp, variants)
		for k := 0; k < 5; k++ {
			again := AssignVariant(sub, camp, variants)
			if again != first {
				t.Fatalf("non-deterministic: %s vs %s for %s", first, again, sub)
			}
		}
	}
}

func TestAssignVariant_RespectsWeights(t *testing.T) {
	cases := []struct {
		name     string
		variants []Variant
	}{
		{
			name: "even split",
			variants: []Variant{
				{VariantLabel: "A", Weight: 50},
				{VariantLabel: "B", Weight: 50},
			},
		},
		{
			name: "skewed split",
			variants: []Variant{
				{VariantLabel: "A", Weight: 80},
				{VariantLabel: "B", Weight: 20},
			},
		},
		{
			name: "three-way uneven",
			variants: []Variant{
				{VariantLabel: "A", Weight: 60},
				{VariantLabel: "B", Weight: 30},
				{VariantLabel: "C", Weight: 10},
			},
		},
	}
	const N = 10000
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			counts := map[string]int{}
			for i := 0; i < N; i++ {
				lbl := AssignVariant(fmt.Sprintf("sub-%d", i), "camp-x", tc.variants)
				counts[lbl]++
			}
			var total float64
			for _, v := range tc.variants {
				total += v.Weight
			}
			for _, v := range tc.variants {
				want := v.Weight / total
				got := float64(counts[v.VariantLabel]) / float64(N)
				// Generous tolerance: ±3% of N is well within sampling noise.
				if math.Abs(got-want) > 0.03 {
					t.Errorf("variant %s: want ~%.3f, got %.3f", v.VariantLabel, want, got)
				}
			}
		})
	}
}

func TestAssignVariant_Edges(t *testing.T) {
	if got := AssignVariant("s", "c", nil); got != "" {
		t.Errorf("nil variants: want \"\", got %q", got)
	}
	zero := []Variant{
		{VariantLabel: "A", Weight: 0},
		{VariantLabel: "B", Weight: 0},
	}
	got := AssignVariant("s", "c", zero)
	if got != "A" && got != "B" {
		t.Errorf("zero weights should still pick a label, got %q", got)
	}
}
