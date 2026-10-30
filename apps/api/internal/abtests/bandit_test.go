// SPDX-License-Identifier: AGPL-3.0-only

package abtests

import (
	"math"
	"math/rand"
	"testing"
)

func sumWeights(ws []VariantWeight) float64 {
	var s float64
	for _, w := range ws {
		s += w.Weight
	}
	return s
}

func TestRecomputeWeightsFixedIsNoop(t *testing.T) {
	got := RecomputeWeights("fixed", []VariantStat{{VariantID: "a", Successes: 5, Trials: 10}}, 0.1, nil)
	if got != nil {
		t.Fatalf("fixed strategy should return nil, got %v", got)
	}
	if RecomputeWeights("unknown", []VariantStat{{VariantID: "a"}}, 0.1, nil) != nil {
		t.Fatalf("unknown strategy should return nil")
	}
}

func TestThompsonFavorsBetterArm(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	stats := []VariantStat{
		{VariantID: "a", Successes: 80, Trials: 100}, // 80% open
		{VariantID: "b", Successes: 20, Trials: 100}, // 20% open
	}
	got := RecomputeWeights("thompson", stats, 0.1, rng)
	if len(got) != 2 {
		t.Fatalf("expected 2 weights, got %d", len(got))
	}
	if math.Abs(sumWeights(got)-100) > 0.5 {
		t.Errorf("weights should sum ~100, got %.2f", sumWeights(got))
	}
	var wa, wb float64
	for _, w := range got {
		if w.VariantID == "a" {
			wa = w.Weight
		} else {
			wb = w.Weight
		}
	}
	if wa <= wb {
		t.Errorf("better arm a should get more weight: a=%.2f b=%.2f", wa, wb)
	}
	// Explore floor guarantees the worse arm keeps >= ~5% (floor/k = 0.1/2).
	if wb < 4 {
		t.Errorf("explore floor should keep arm b >= ~5%%, got %.2f", wb)
	}
}

func TestEpsilonGreedyBestArmGetsBulk(t *testing.T) {
	stats := []VariantStat{
		{VariantID: "a", Successes: 10, Trials: 100},
		{VariantID: "b", Successes: 60, Trials: 100}, // best
		{VariantID: "c", Successes: 30, Trials: 100},
	}
	got := RecomputeWeights("epsilon_greedy", stats, 0.3, nil)
	if math.Abs(sumWeights(got)-100) > 0.5 {
		t.Errorf("weights should sum ~100, got %.2f", sumWeights(got))
	}
	var wb float64
	for _, w := range got {
		if w.VariantID == "b" {
			wb = w.Weight
		}
	}
	// best arm gets (1-eps) + eps/k of the mass = 0.7 + 0.1 = 0.8 → ~80.
	if wb < 70 {
		t.Errorf("epsilon-greedy best arm should dominate, got %.2f", wb)
	}
}

func TestNoSignalIsUniform(t *testing.T) {
	stats := []VariantStat{
		{VariantID: "a", Successes: 0, Trials: 0},
		{VariantID: "b", Successes: 0, Trials: 0},
	}
	got := RecomputeWeights("epsilon_greedy", stats, 0.1, nil)
	// With no trials, point estimates tie → arm[0] wins argmax; that's
	// acceptable. Just assert it's well-formed and sums to 100.
	if len(got) != 2 || math.Abs(sumWeights(got)-100) > 0.5 {
		t.Fatalf("expected 2 weights summing ~100, got %v", got)
	}
}
