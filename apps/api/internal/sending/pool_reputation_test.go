// SPDX-License-Identifier: AGPL-3.0-only
package sending

import "testing"

func TestAggregatePool_EmptyPool(t *testing.T) {
	got := AggregatePool("paid_standard", nil)
	if got.Pool != "paid_standard" {
		t.Errorf("pool name lost: %q", got.Pool)
	}
	if got.ActiveIPs != 0 || got.IsRoutable {
		t.Errorf("empty pool should be non-routable, got %+v", got)
	}
	if got.Health != 0 {
		t.Errorf("empty pool health = %d, want 0", got.Health)
	}
}

func TestAggregatePool_AllHealthy(t *testing.T) {
	ips := []IPReputation{
		{IP: "10.0.0.1", BounceRate7d: 0.01, ComplaintRate7d: 0.0005, SenderScore: 95},
		{IP: "10.0.0.2", BounceRate7d: 0.005, ComplaintRate7d: 0.0001, SenderScore: 92},
		{IP: "10.0.0.3", BounceRate7d: 0.015, ComplaintRate7d: 0.0008, SenderScore: 88},
	}
	got := AggregatePool("paid_standard", ips)
	if got.ActiveIPs != 3 || got.HaltedIPs != 0 || got.BlocklistedIPs != 0 {
		t.Errorf("expected 3 active / 0 halted / 0 blocklisted, got %+v", got)
	}
	if !got.IsRoutable {
		t.Errorf("all-healthy pool must be routable")
	}
	if got.Health < 90 {
		t.Errorf("all-healthy pool health = %d, want ≥90", got.Health)
	}
	// BestIP should be the one with the highest SenderScore (10.0.0.1).
	if got.BestIP != "10.0.0.1" {
		t.Errorf("best IP = %q, want 10.0.0.1 (highest SenderScore)", got.BestIP)
	}
}

func TestAggregatePool_HaltedIPsSinkToBottomRegardlessOfScore(t *testing.T) {
	ips := []IPReputation{
		{IP: "10.0.0.1", Halted: true, SenderScore: 100}, // halted; goes to bottom
		{IP: "10.0.0.2", BounceRate7d: 0.05, SenderScore: 70},
		{IP: "10.0.0.3", BounceRate7d: 0.01, SenderScore: 95},
	}
	got := AggregatePool("paid_standard", ips)
	if got.HaltedIPs != 1 {
		t.Errorf("HaltedIPs = %d, want 1", got.HaltedIPs)
	}
	if got.WorstIP != "10.0.0.1" {
		t.Errorf("worst IP = %q, want 10.0.0.1 (halted always last)", got.WorstIP)
	}
	if got.BestIP != "10.0.0.3" {
		t.Errorf("best IP = %q, want 10.0.0.3", got.BestIP)
	}
	if got.IPRanking[len(got.IPRanking)-1] != "10.0.0.1" {
		t.Errorf("halted IP must be at bottom of IPRanking, got %v", got.IPRanking)
	}
}

func TestAggregatePool_AllHaltedPoolNotRoutable(t *testing.T) {
	ips := []IPReputation{
		{IP: "10.0.0.1", Halted: true},
		{IP: "10.0.0.2", Halted: true},
	}
	got := AggregatePool("paid_pro", ips)
	if got.IsRoutable {
		t.Errorf("all-halted pool must NOT be routable")
	}
	if got.ActiveIPs != 0 || got.HaltedIPs != 2 {
		t.Errorf("expected 0 active / 2 halted, got %+v", got)
	}
}

func TestComputeHealth_BlocklistPenalty(t *testing.T) {
	clean := computeHealth(IPReputation{BounceRate7d: 0.01, ComplaintRate7d: 0.0001})
	listed := computeHealth(IPReputation{BlocklistHits: 1, BounceRate7d: 0.01, ComplaintRate7d: 0.0001})
	if clean-listed != 30 {
		t.Errorf("blocklist penalty = %d, want 30", clean-listed)
	}
}

func TestComputeHealth_HaltedIsZero(t *testing.T) {
	got := computeHealth(IPReputation{
		Halted:       true,
		SenderScore:  100, // would otherwise be boosted
		BounceRate7d: 0,
	})
	if got != 0 {
		t.Errorf("halted IP must score 0 regardless of other signal, got %d", got)
	}
}

func TestComputeHealth_BoundedToZero(t *testing.T) {
	got := computeHealth(IPReputation{
		BlocklistHits:   10,   // -300
		BounceRate7d:    0.5,  // -28.8
		ComplaintRate7d: 0.10, // -7.92
		SenderScore:     30,
	})
	if got != 0 {
		t.Errorf("over-penalised IP must clamp to 0, got %d", got)
	}
}

func TestComputeHealth_BoundedTo100(t *testing.T) {
	got := computeHealth(IPReputation{
		SenderScore: 100, // +10 above 100 would overflow; must clamp
	})
	if got != 100 {
		t.Errorf("clean IP with sender-score boost must clamp at 100, got %d", got)
	}
}

func TestPickRotationTarget_PrefersNonWorst(t *testing.T) {
	pool := PoolReputation{
		IPRanking: []string{"10.0.0.3", "10.0.0.2", "10.0.0.1"},
		BestIP:    "10.0.0.3",
		WorstIP:   "10.0.0.1",
	}
	got := PickRotationTarget(pool)
	if got != "10.0.0.3" {
		t.Errorf("rotation target = %q, want 10.0.0.3 (best, not worst)", got)
	}
}

func TestPickRotationTarget_EmptyPool(t *testing.T) {
	if got := PickRotationTarget(PoolReputation{}); got != "" {
		t.Errorf("empty pool rotation target = %q, want \"\"", got)
	}
}

func TestPickRotationTarget_OnlyWorst(t *testing.T) {
	// Edge case: a single-IP pool where the only IP IS the worst.
	// The function should still return SOMETHING (the only available
	// IP) rather than empty — the caller knows it's degraded but
	// can use this for "best-effort" routing.
	pool := PoolReputation{
		IPRanking: []string{"10.0.0.1"},
		BestIP:    "10.0.0.1",
		WorstIP:   "10.0.0.1",
	}
	got := PickRotationTarget(pool)
	if got != "10.0.0.1" {
		t.Errorf("single-IP rotation must return that IP, got %q", got)
	}
}
