// SPDX-License-Identifier: AGPL-3.0-only
//
// G4 (campaigns 2026): multi-armed bandit weight recompute. Given each
// variant's success/trial counts, returns new per-variant weights so the
// dispatcher (which buckets by campaign_variants.weight) shifts the
// remaining audience toward the better arm. Two strategies:
//
//   - thompson:       weight ∝ P(arm is best) via Monte-Carlo over the
//                     arms' Beta(1+succ, 1+fail) posteriors.
//   - epsilon_greedy: the point-estimate best arm gets the bulk; the rest
//                     share the exploration budget.
//
// Both blend with a uniform explore_floor so no arm is fully starved
// (keeps the posteriors learning). "fixed" / unknown returns nil — the
// caller leaves the configured weights untouched.

package abtests

import (
	"context"
	"math/rand"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// WeightHistoryPoint is one recompute's weight for a variant.
type WeightHistoryPoint struct {
	At     time.Time `json:"at"`
	Weight float64   `json:"weight"`
}

// WeightHistorySeries is the allocation-drift series for one arm.
type WeightHistorySeries struct {
	VariantID string               `json:"variant_id"`
	Label     string               `json:"label"`
	Points    []WeightHistoryPoint `json:"points"`
}

// WeightHistory returns the bandit allocation-drift series per variant
// (G4 follow-up) for the A/B Results chart.
func (r *Repo) WeightHistory(ctx context.Context, tenantID, campaignID string) ([]WeightHistorySeries, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT h.variant_id::text, COALESCE(v.variant_label, ''), h.recorded_at, h.weight::float8
  FROM campaign_variant_weight_history h
  LEFT JOIN campaign_variants v ON v.id = h.variant_id
 WHERE h.tenant_id = $1::uuid AND h.campaign_id = $2::uuid
 ORDER BY h.recorded_at`, tenantID, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	idx := map[string]int{}
	out := []WeightHistorySeries{}
	for rows.Next() {
		var vid, label string
		var at time.Time
		var weight float64
		if err := rows.Scan(&vid, &label, &at, &weight); err != nil {
			return nil, err
		}
		i, ok := idx[vid]
		if !ok {
			i = len(out)
			idx[vid] = i
			out = append(out, WeightHistorySeries{VariantID: vid, Label: label})
		}
		out[i].Points = append(out[i].Points, WeightHistoryPoint{At: at, Weight: weight})
	}
	return out, rows.Err()
}

// VariantStat is one arm's observed performance for the recompute.
type VariantStat struct {
	VariantID string
	Successes int // opens or clicks, per winner metric
	Trials    int // recipients sent the variant
}

// VariantWeight is the recomputed weight (0..100) for one arm.
type VariantWeight struct {
	VariantID string
	Weight    float64
}

// thompsonSamples is the Monte-Carlo draw count for the Thompson
// win-share estimate. 2000 keeps the estimate stable while cheap.
const thompsonSamples = 2000

// RecomputeWeights returns new arm weights summing to ~100 for the given
// strategy, or nil for "fixed"/unknown (leave weights as configured).
// exploreFloor in [0,1] is the fraction of mass spread uniformly across
// arms before the strategy allocates the rest.
func RecomputeWeights(strategy string, stats []VariantStat, exploreFloor float64, rng *rand.Rand) []VariantWeight {
	if len(stats) == 0 {
		return nil
	}
	var pref []float64
	switch strategy {
	case "thompson":
		pref = thompsonPreference(stats, rng)
	case "epsilon_greedy":
		pref = epsilonGreedyPreference(stats)
	default:
		return nil
	}
	return blendWithFloor(stats, pref, exploreFloor)
}

// thompsonPreference returns each arm's share of "is best" draws.
func thompsonPreference(stats []VariantStat, rng *rand.Rand) []float64 {
	if rng == nil {
		rng = rand.New(rand.NewSource(1))
	}
	wins := make([]float64, len(stats))
	for s := 0; s < thompsonSamples; s++ {
		best, bestVal := 0, -1.0
		for i, st := range stats {
			// Beta(1+successes, 1+failures) — uniform prior.
			alpha := float64(st.Successes) + 1
			beta := float64(st.Trials-st.Successes) + 1
			if beta < 1 {
				beta = 1
			}
			v := betaSample(rng, alpha, beta)
			if v > bestVal {
				bestVal = v
				best = i
			}
		}
		wins[best]++
	}
	for i := range wins {
		wins[i] /= float64(thompsonSamples)
	}
	return wins
}

// epsilonGreedyPreference puts all preference on the point-estimate best
// arm; the floor blend then gives the others the exploration share.
func epsilonGreedyPreference(stats []VariantStat) []float64 {
	pref := make([]float64, len(stats))
	best, bestRate := 0, -1.0
	for i, st := range stats {
		rate := 0.0
		if st.Trials > 0 {
			rate = float64(st.Successes) / float64(st.Trials)
		}
		if rate > bestRate {
			bestRate = rate
			best = i
		}
	}
	pref[best] = 1.0
	return pref
}

// blendWithFloor mixes the strategy preference with a uniform floor and
// scales to sum 100: weight_i = (floor/k + (1-floor)*pref_i) * 100.
func blendWithFloor(stats []VariantStat, pref []float64, exploreFloor float64) []VariantWeight {
	k := float64(len(stats))
	if exploreFloor < 0 {
		exploreFloor = 0
	}
	if exploreFloor > 1 {
		exploreFloor = 1
	}
	var prefSum float64
	for _, p := range pref {
		prefSum += p
	}
	out := make([]VariantWeight, len(stats))
	for i, st := range stats {
		normPref := 0.0
		if prefSum > 0 {
			normPref = pref[i] / prefSum
		} else {
			normPref = 1.0 / k // no signal yet → uniform
		}
		mix := exploreFloor/k + (1-exploreFloor)*normPref
		out[i] = VariantWeight{VariantID: st.VariantID, Weight: mix * 100}
	}
	return out
}

// RecomputeBanditWeights recomputes campaign_variants.weight for one
// campaign from the current variant results, persists the new weights +
// a weight-history row per arm, and stamps last_recomputed_at. No-op for
// fixed strategy. Because AssignVariant buckets by the weight column,
// updating it re-allocates the remaining audience at the next queue-fill.
func (r *Repo) RecomputeBanditWeights(ctx context.Context, tenantID, campaignID string) error {
	settings, err := r.GetSettings(ctx, tenantID, campaignID)
	if err != nil {
		return err
	}
	if settings.BanditStrategy == "" || settings.BanditStrategy == "fixed" {
		return nil
	}
	if settings.WinningVariantID != nil {
		return nil // winner already locked — stop reallocating
	}
	results, err := r.ListResults(ctx, tenantID, campaignID)
	if err != nil {
		return err
	}
	if len(results) < 2 {
		return nil
	}
	stats := make([]VariantStat, 0, len(results))
	for _, vr := range results {
		trials := vr.Delivered
		if trials == 0 {
			trials = vr.RecipientsCount
		}
		succ := vr.Opens
		if settings.WinnerMetric == WinnerMetricClickRate {
			succ = vr.Clicks
		}
		stats = append(stats, VariantStat{VariantID: vr.VariantID, Successes: succ, Trials: trials})
	}
	weights := RecomputeWeights(settings.BanditStrategy, stats, settings.ExploreFloor, nil)
	if len(weights) == 0 {
		return nil
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, w := range weights {
		if _, err := tx.Exec(ctx,
			`UPDATE campaign_variants SET weight = $3 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
			tenantID, w.VariantID, w.Weight); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO campaign_variant_weight_history (tenant_id, campaign_id, variant_id, weight)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
			tenantID, campaignID, w.VariantID, w.Weight); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx,
		`UPDATE campaign_ab_settings SET last_recomputed_at = now() WHERE campaign_id = $1::uuid`,
		campaignID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
