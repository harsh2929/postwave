// SPDX-License-Identifier: AGPL-3.0-only
//
// pool_reputation.go — per-pool reputation aggregator. The
// dispatcher routes a send by tenant.sender_pool (free,
// paid_standard, paid_pro, paid_reputation, byo); per-IP reputation
// is already aggregated by services/deliverability/internal/
// reputation. This file rolls IP-level signal up to pool-level so
// the dashboard, the auto-rotation engine, and the health-page can
// answer the same question: "how healthy is the entire X pool?"
//
// Two questions one PoolReputation answers:
//
//   1. Should new traffic go to this pool? (route decision)
//   2. Which IP in the pool is the safest right now? (rotation
//      target when an IP halts via the warmup engagement modifier).
//
// Pure functions over input slices — no DB. The dispatcher pulls the
// per-IP snapshots from the existing reputation aggregator and feeds
// them in.

package sending

import "sort"

// IPReputation is one IP's rolled-up snapshot. Mirrors the field set
// the deliverability service's reputation.Aggregator emits, kept
// local so this package doesn't import services/.
type IPReputation struct {
	IP              string
	Pool            string // "free", "paid_standard", ...
	BlocklistHits   int    // count of tier-1 listings (confidence ≥ 0.95)
	BounceRate7d    float64
	ComplaintRate7d float64
	SenderScore     int // 0-100; 0 means unknown
	// Halted is true when the EngagementMultiplier returned 0 for
	// this IP. The dispatcher should NOT route new traffic to a
	// halted IP, full stop.
	Halted bool
}

// PoolReputation is the rolled-up pool snapshot. Health is a 0-100
// score derived from the per-IP fields (see computeHealth below).
// IPRanking is the per-IP order from healthiest to least healthy;
// the rotation engine picks IPRanking[0] when it needs to drain a
// halted IP.
type PoolReputation struct {
	Pool           string
	ActiveIPs      int
	HaltedIPs      int
	BlocklistedIPs int
	WorstIP        string   // the IP with the lowest health (or first halted)
	BestIP         string   // the IP with the highest health (rotation target)
	Health         int      // pool-level health 0-100
	IPRanking      []string // best -> worst
	// IsRoutable reports whether the dispatcher should send NEW
	// traffic to this pool. False when every IP is halted or
	// blocklisted; the dispatcher should fall back to a sibling
	// pool (free -> paid_standard for free-tier overflow, etc.)
	// under the operator's discretion.
	IsRoutable bool
}

// AggregatePool rolls a slice of per-IP reputations into one
// PoolReputation. The poolName is what the dispatcher passes (the
// IPs should all belong to that pool; we don't filter here so the
// caller controls the membership decision).
func AggregatePool(poolName string, ips []IPReputation) PoolReputation {
	out := PoolReputation{Pool: poolName}
	if len(ips) == 0 {
		return out
	}

	type scored struct {
		ip     string
		health int
		halted bool
	}
	scoredIPs := make([]scored, 0, len(ips))
	for _, ip := range ips {
		if ip.Halted {
			out.HaltedIPs++
		} else {
			out.ActiveIPs++
		}
		if ip.BlocklistHits > 0 {
			out.BlocklistedIPs++
		}
		scoredIPs = append(scoredIPs, scored{
			ip:     ip.IP,
			health: computeHealth(ip),
			halted: ip.Halted,
		})
	}

	// Sort best -> worst. Halted IPs always sort to the bottom
	// regardless of underlying health score so the rotation target
	// is never a halted IP.
	sort.SliceStable(scoredIPs, func(i, j int) bool {
		if scoredIPs[i].halted != scoredIPs[j].halted {
			return !scoredIPs[i].halted // non-halted comes first
		}
		return scoredIPs[i].health > scoredIPs[j].health
	})
	out.IPRanking = make([]string, 0, len(scoredIPs))
	for _, s := range scoredIPs {
		out.IPRanking = append(out.IPRanking, s.ip)
	}
	if len(scoredIPs) > 0 {
		out.BestIP = scoredIPs[0].ip
		out.WorstIP = scoredIPs[len(scoredIPs)-1].ip
	}

	// Pool-level health = average of active IPs' health. Halted
	// IPs don't contribute (they're already excluded from routing);
	// a pool with no active IPs reads as health=0 + IsRoutable=false.
	totalHealth := 0
	for _, s := range scoredIPs {
		if !s.halted {
			totalHealth += s.health
		}
	}
	if out.ActiveIPs > 0 {
		out.Health = totalHealth / out.ActiveIPs
	}
	out.IsRoutable = out.ActiveIPs > 0
	return out
}

// computeHealth produces a 0-100 score for one IP. Composition:
//
//   - Halted     → 0 (caller may not have checked Halted; defensive)
//   - Blocklist  → −30 per tier-1 listing (clamped at 0)
//   - Bounces    → −60×(rate above 2%)
//   - Complaints → −80×(rate above 0.1%)
//   - SenderScore → contributes ±10 when present (≥90 → +10, ≤50 → -10)
//
// Calibrated so a clean IP with great SenderScore lands at 100, a
// halted IP at 0, and the slope in between roughly tracks how a
// receiver would treat the IP.
func computeHealth(ip IPReputation) int {
	if ip.Halted {
		return 0
	}
	h := 100
	h -= 30 * ip.BlocklistHits
	if ip.BounceRate7d > 0.02 {
		h -= int((ip.BounceRate7d - 0.02) * 60 * 100) // % above 2%
	}
	if ip.ComplaintRate7d > 0.001 {
		h -= int((ip.ComplaintRate7d - 0.001) * 80 * 100)
	}
	if ip.SenderScore >= 90 {
		h += 10
	} else if ip.SenderScore > 0 && ip.SenderScore <= 50 {
		h -= 10
	}
	if h < 0 {
		h = 0
	}
	if h > 100 {
		h = 100
	}
	return h
}

// PickRotationTarget returns the IP the dispatcher should route to
// when a halted IP needs draining. Returns "" when no healthy
// alternative exists (caller should fall back to a sibling pool).
func PickRotationTarget(pool PoolReputation) string {
	for _, ip := range pool.IPRanking {
		if ip != "" && ip != pool.WorstIP {
			return ip
		}
	}
	if len(pool.IPRanking) > 0 {
		return pool.IPRanking[0]
	}
	return ""
}
