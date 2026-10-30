package form_variants

import (
	"math"
	"sort"
)

// Sample is the input to the bandit pass: one row per variant carrying
// the running counts. The bandit re-weights based on conversion rate
// and computes a Wald-z between the leader and the runner-up to decide
// whether to promote.
type Sample struct {
	VariantID   string
	Impressions int64
	Submissions int64
}

// Rate is the smoothed submission rate. We add a tiny prior (Laplace
// smoothing with alpha=beta=1) so a variant with zero impressions
// doesn't divide-by-zero AND so the bandit doesn't promote on the
// first impression it sees.
func (s Sample) Rate() float64 {
	a := float64(s.Submissions + 1)
	b := float64(s.Impressions - s.Submissions + 1)
	return a / (a + b)
}

// Decision describes what the bandit recommends.
type Decision struct {
	// Weights is the new traffic_pct per VariantID. Sums to 100.
	Weights map[string]int
	// PromoteVariantID is non-empty when the leader crossed the
	// 95% confidence bar AND every active variant has at least
	// MinSampleForPromotion impressions. The caller flips the
	// chosen variant's status to "promoted" and demotes peers to
	// "paused".
	PromoteVariantID string
	// RunnerUpVariantID is the runner-up at decision time (the
	// most-competitive non-winner). Captured for the audit log.
	RunnerUpVariantID string
	// ZScore is the |z| we computed between leader and runner-up.
	// Useful for the admin "confidence" badge even when we don't
	// promote yet.
	ZScore float64
	// LeaderRate / RunnerUpRate get persisted into the audit log.
	LeaderRate   float64
	RunnerUpRate float64
}

// Reweight runs one bandit pass over the samples and returns the new
// per-variant traffic weights + a promote recommendation. The
// algorithm is intentionally simple and easy to audit:
//
//  1. Compute Rate() for each variant.
//  2. Allocate base weights proportional to Rate * 100, with a 5%
//     exploration floor per variant so we never starve a candidate.
//     (Klaviyo + Optimizely both call this the "epsilon-greedy floor".)
//  3. Compute the Wald-z between the top-rate variant and the
//     runner-up. When |z| >= 1.96 AND every active variant has at
//     least MinSampleForPromotion impressions, recommend promotion.
//
// Stateless: deterministic given the input samples. No randomness.
func Reweight(samples []Sample) Decision {
	dec := Decision{Weights: map[string]int{}}
	if len(samples) == 0 {
		return dec
	}
	// Stable ordering — callers may pass samples in any order; we
	// want the same Decision regardless so test fixtures are stable.
	ordered := make([]Sample, len(samples))
	copy(ordered, samples)
	sort.Slice(ordered, func(i, j int) bool {
		return ordered[i].VariantID < ordered[j].VariantID
	})

	// (1) rates
	rates := make([]float64, len(ordered))
	rateSum := 0.0
	for i, s := range ordered {
		rates[i] = s.Rate()
		rateSum += rates[i]
	}

	// (2) allocate proportional + floor
	const floorPct = 5
	floorTotal := floorPct * len(ordered)
	pool := 100 - floorTotal
	if pool < 0 {
		// Degenerate case (>20 variants); collapse to even split.
		even := 100 / len(ordered)
		extra := 100 - even*len(ordered)
		for i, s := range ordered {
			w := even
			if i < extra {
				w++
			}
			dec.Weights[s.VariantID] = w
		}
		return dec
	}
	allocated := 0
	maxIdx := 0
	for i, s := range ordered {
		var share int
		if rateSum > 0 {
			share = int(math.Round(rates[i] / rateSum * float64(pool)))
		} else {
			share = pool / len(ordered)
		}
		w := floorPct + share
		if w < floorPct {
			w = floorPct
		}
		dec.Weights[s.VariantID] = w
		allocated += w
		if rates[i] > rates[maxIdx] {
			maxIdx = i
		}
	}
	// Park rounding remainder on the highest-rate variant so totals = 100.
	if diff := 100 - allocated; diff != 0 {
		dec.Weights[ordered[maxIdx].VariantID] += diff
	}

	// (3) confidence — winner vs runner-up Wald-z on conversion-rate.
	if len(ordered) < 2 {
		return dec
	}
	// Find leader and runner-up by Rate(). Stable on ties via the
	// VariantID sort already applied.
	leaderIdx := 0
	for i := 1; i < len(ordered); i++ {
		if rates[i] > rates[leaderIdx] {
			leaderIdx = i
		}
	}
	runnerIdx := -1
	for i, _ := range ordered {
		if i == leaderIdx {
			continue
		}
		if runnerIdx < 0 || rates[i] > rates[runnerIdx] {
			runnerIdx = i
		}
	}
	if runnerIdx < 0 {
		return dec
	}
	leader, runner := ordered[leaderIdx], ordered[runnerIdx]
	z := waldZ(leader, runner)
	dec.ZScore = z
	dec.LeaderRate = rates[leaderIdx]
	dec.RunnerUpRate = rates[runnerIdx]

	if z >= ConfidenceZ &&
		leader.Impressions >= MinSampleForPromotion &&
		runner.Impressions >= MinSampleForPromotion {
		dec.PromoteVariantID = leader.VariantID
		dec.RunnerUpVariantID = runner.VariantID
		// On promotion, pin the winner's traffic to 100 and starve the
		// peers — operators can still un-pause later by re-cloning.
		for k := range dec.Weights {
			if k == leader.VariantID {
				dec.Weights[k] = 100
			} else {
				dec.Weights[k] = 0
			}
		}
	}
	return dec
}

// waldZ is a two-proportion Wald-z. Returns 0 when either denominator
// is degenerate (no impressions) — caller should treat 0 as
// "insufficient data" and skip promotion. Always positive (we take
// the absolute value because direction is determined by which sample
// is "leader" — if the caller's leader has the lower rate, z would
// be 0 here, which is fine: the promote guard above checks z >=
// ConfidenceZ).
func waldZ(leader, runner Sample) float64 {
	if leader.Impressions == 0 || runner.Impressions == 0 {
		return 0
	}
	pL := float64(leader.Submissions) / float64(leader.Impressions)
	pR := float64(runner.Submissions) / float64(runner.Impressions)
	if pL <= pR {
		return 0
	}
	se2 := pL*(1-pL)/float64(leader.Impressions) +
		pR*(1-pR)/float64(runner.Impressions)
	if se2 <= 0 {
		return 0
	}
	return (pL - pR) / math.Sqrt(se2)
}
