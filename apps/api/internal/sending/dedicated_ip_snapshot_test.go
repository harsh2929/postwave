// SPDX-License-Identifier: AGPL-3.0-only
package sending

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// Verify that the EngagementMultiplier→halt decision in the snapshot
// worker matches the canonical thresholds. The worker constructs a
// synthetic EngagementSnapshot with Sent=1000 + computed bounce/complaint
// counts; this test exercises the same arithmetic.

func TestSnapshotHaltDecision_EngagementCritical(t *testing.T) {
	// Complaint rate ≥ 2% triggers halt (mult=0).
	snap := EngagementSnapshot{Sent: 1000, Complained: 20}
	require.Equal(t, 0.0, EngagementMultiplier(snap))

	// Bounce rate ≥ 10% triggers halt.
	snap = EngagementSnapshot{Sent: 1000, Bounced: 100}
	require.Equal(t, 0.0, EngagementMultiplier(snap))
}

func TestSnapshotHaltDecision_HealthyStaysActive(t *testing.T) {
	// Clean IP: low bounce + low complaint + decent opens → 1.0x.
	snap := EngagementSnapshot{Sent: 1000, Bounced: 10, Complained: 0, Opened: 100}
	require.Equal(t, 1.0, EngagementMultiplier(snap))
}

func TestSnapshotHaltDecision_BelowSampleSize(t *testing.T) {
	// <100 sends: no slowdown applied regardless of rate.
	snap := EngagementSnapshot{Sent: 50, Complained: 5}
	require.Equal(t, 1.0, EngagementMultiplier(snap))
}

// Verify ComputeHealth for a halted IP returns 0 — used by the
// dashboard so halted IPs always sort to the bottom of the pool.
func TestComputeHealth_HaltedIs0(t *testing.T) {
	rep := IPReputation{IP: "1.2.3.4", Pool: "paid_pro", Halted: true}
	require.Equal(t, 0, computeHealth(rep))
}

func TestComputeHealth_BlocklistDocksHeavily(t *testing.T) {
	clean := IPReputation{IP: "x"}
	require.Equal(t, 100, computeHealth(clean))

	listed := IPReputation{IP: "x", BlocklistHits: 1}
	require.Equal(t, 70, computeHealth(listed))

	multiListed := IPReputation{IP: "x", BlocklistHits: 4}
	require.Equal(t, 0, computeHealth(multiListed)) // clamped at 0
}

func TestAggregatePool_RanksHealthyOverHalted(t *testing.T) {
	pool := AggregatePool("paid_pro", []IPReputation{
		{IP: "ok-1", Pool: "paid_pro", BounceRate7d: 0.01},
		{IP: "halted-1", Pool: "paid_pro", Halted: true},
		{IP: "ok-2", Pool: "paid_pro", BlocklistHits: 1},
	})
	require.Equal(t, 2, pool.ActiveIPs)
	require.Equal(t, 1, pool.HaltedIPs)
	require.True(t, pool.IsRoutable)
	// First in ranking should NOT be the halted IP.
	require.NotEqual(t, "halted-1", pool.IPRanking[0])
	require.Equal(t, "halted-1", pool.IPRanking[len(pool.IPRanking)-1])
}

func TestAggregatePool_AllHaltedNotRoutable(t *testing.T) {
	pool := AggregatePool("paid_pro", []IPReputation{
		{IP: "h1", Halted: true},
		{IP: "h2", Halted: true},
	})
	require.False(t, pool.IsRoutable)
	require.Equal(t, 0, pool.ActiveIPs)
}

func TestStaticSampler_ReturnsCanned(t *testing.T) {
	s := &StaticSampler{Values: map[string]IPReputation{
		"1.2.3.4": {IP: "1.2.3.4", BounceRate7d: 0.05},
	}}
	rep, err := s.Sample(context.Background(), "1.2.3.4")
	require.NoError(t, err)
	require.Equal(t, 0.05, rep.BounceRate7d)

	rep2, err := s.Sample(context.Background(), "unknown")
	require.NoError(t, err)
	require.Empty(t, rep2.BlocklistHits)
}
