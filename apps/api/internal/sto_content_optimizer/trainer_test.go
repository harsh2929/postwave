// SPDX-License-Identifier: AGPL-3.0-only

package sto_content_optimizer

import (
	"math"
	"testing"
)

func TestArmKey_CanonicalOrder(t *testing.T) {
	// Map order is irrelevant; the key uses the fixed slot order.
	k := armKey(map[string]string{"cta": "c1", "subject": "s1", "header": "h1"})
	if k != "subject=s1;header=h1;cta=c1" {
		t.Fatalf("armKey = %q, want canonical fixed-order key", k)
	}
	// Round-trips with the existing decoder.
	got := armComponentIDsFromKey(k)
	if got["subject"] != "s1" || got["header"] != "h1" || got["cta"] != "c1" {
		t.Fatalf("round-trip mismatch: %v", got)
	}
	if armKey(nil) != "" {
		t.Fatalf("empty component ids should yield empty key")
	}
}

func TestComputeTraining_PosteriorsAndAllocation(t *testing.T) {
	arms := []OptimizerArm{
		{ID: "arm-a", ComponentIDs: map[string]string{"subject": "s1"}, Impressions: 1000, Conversions: 100}, // 10%
		{ID: "arm-b", ComponentIDs: map[string]string{"subject": "s2"}, Impressions: 1000, Conversions: 400}, // 40%
	}
	res := computeTraining(arms, 0.0, 0, StatusExploring)

	// Posteriors: Beta(1+conv, 1+misses).
	pByArm := map[string]armPosterior{}
	for _, p := range res.posteriors {
		pByArm[p.armID] = p
	}
	if pByArm["arm-a"].alpha != 101 || pByArm["arm-a"].beta != 901 {
		t.Fatalf("arm-a posterior = %+v, want alpha=101 beta=901", pByArm["arm-a"])
	}
	if pByArm["arm-b"].alpha != 401 || pByArm["arm-b"].beta != 601 {
		t.Fatalf("arm-b posterior = %+v, want alpha=401 beta=601", pByArm["arm-b"])
	}

	// Allocation: the stronger arm (s2, 40%) should get the larger share, and
	// the weights should sum to ~1.
	aA := res.allocation["subject=s1"]
	aB := res.allocation["subject=s2"]
	if aB <= aA {
		t.Fatalf("better arm should get more traffic: s1=%v s2=%v", aA, aB)
	}
	if sum := aA + aB; math.Abs(sum-1.0) > 1e-6 {
		t.Fatalf("allocation should sum to 1, got %v", sum)
	}
}

func TestComputeTraining_PhaseTransition(t *testing.T) {
	// One arm clearly dominant + both past min impressions → exploit.
	arms := []OptimizerArm{
		{ID: "a", ComponentIDs: map[string]string{"subject": "s1"}, Impressions: 5000, Conversions: 50},   // 1%
		{ID: "b", ComponentIDs: map[string]string{"subject": "s2"}, Impressions: 5000, Conversions: 2500}, // 50%
	}
	res := computeTraining(arms, 0.0, 1000, StatusExploring)
	if res.newStatus != StatusExploiting {
		t.Fatalf("dominant leader past min impressions should exploit, got %q (alloc %v)", res.newStatus, res.allocation)
	}

	// Below min impressions → stay exploring even with a leader.
	arms2 := []OptimizerArm{
		{ID: "a", ComponentIDs: map[string]string{"subject": "s1"}, Impressions: 10, Conversions: 0},
		{ID: "b", ComponentIDs: map[string]string{"subject": "s2"}, Impressions: 10, Conversions: 9},
	}
	if res2 := computeTraining(arms2, 0.0, 1000, StatusExploring); res2.newStatus != StatusExploring {
		t.Fatalf("below min impressions should stay exploring, got %q", res2.newStatus)
	}
}

func TestComputeTraining_Empty(t *testing.T) {
	res := computeTraining(nil, 0.1, 100, StatusExploring)
	if len(res.allocation) != 0 || res.newStatus != StatusExploring {
		t.Fatalf("empty arms should yield empty allocation + unchanged status")
	}
}
