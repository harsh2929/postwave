// SPDX-License-Identifier: AGPL-3.0-only
package compat

import "testing"

func TestPickWeightedLanding(t *testing.T) {
	t.Run("nil on empty / all-zero-weight", func(t *testing.T) {
		if pickWeightedLanding(nil, 5) != nil {
			t.Fatal("empty should pick nil")
		}
		if pickWeightedLanding([]landingVariantCandidate{{ID: "a", Weight: 0}}, 5) != nil {
			t.Fatal("all-zero-weight should pick nil")
		}
	})

	t.Run("deterministic cumulative selection", func(t *testing.T) {
		cands := []landingVariantCandidate{
			{ID: "a", Weight: 30},
			{ID: "b", Weight: 20},
			{ID: "c", Weight: 50},
		}
		// total 100; pct = rand % 100. Boundaries: a=[0,30) b=[30,50) c=[50,100).
		cases := map[int]string{0: "a", 29: "a", 30: "b", 49: "b", 50: "c", 99: "c", 100: "a", 149: "b"}
		for rnd, want := range cases {
			got := pickWeightedLanding(cands, rnd)
			if got == nil || got.ID != want {
				t.Fatalf("rand %d -> %v, want %s", rnd, got, want)
			}
		}
	})

	t.Run("skips zero-weight arms", func(t *testing.T) {
		cands := []landingVariantCandidate{
			{ID: "paused", Weight: 0},
			{ID: "live", Weight: 10},
		}
		// Every pick must land on the only positive-weight arm.
		for rnd := 0; rnd < 20; rnd++ {
			got := pickWeightedLanding(cands, rnd)
			if got == nil || got.ID != "live" {
				t.Fatalf("rand %d picked %v, want live", rnd, got)
			}
		}
	})

	t.Run("handles negative rand", func(t *testing.T) {
		cands := []landingVariantCandidate{{ID: "a", Weight: 1}}
		if got := pickWeightedLanding(cands, -7); got == nil || got.ID != "a" {
			t.Fatalf("negative rand picked %v, want a", got)
		}
	})

	t.Run("roughly honors the split over many draws", func(t *testing.T) {
		cands := []landingVariantCandidate{{ID: "a", Weight: 80}, {ID: "b", Weight: 20}}
		counts := map[string]int{}
		for rnd := 0; rnd < 1000; rnd++ {
			counts[pickWeightedLanding(cands, rnd).ID]++
		}
		// With rand = 0..999 uniformly mod 100, a≈800 b≈200.
		if counts["a"] != 800 || counts["b"] != 200 {
			t.Fatalf("split over 1000 sequential draws = %v, want a=800 b=200", counts)
		}
	})
}
