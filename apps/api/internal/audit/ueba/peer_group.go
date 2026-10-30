// SPDX-License-Identifier: AGPL-3.0-only

package ueba

import (
	"context"
	"fmt"
	"hash/fnv"
	"math"
	"sort"
)

// PeerGroupDetector clusters actors per tenant on their action-frequency
// vectors, then flags actors whose vector is >sigma*stddev from their
// cluster centroid.
//
// We implement a deterministic k-means++ here rather than pulling in
// gonum: the dimensionality is small (top-N actions, default 10) and
// the cohort sizes are small (hundreds of actors at most per tenant),
// so the in-package implementation keeps the audit/ueba dependency
// surface to stdlib + jackc/pgx.
//
// Determinism: the random seed is fnv64(tenant_id + day_iso), so the
// same cohort + day always yields the same cluster assignment. This
// avoids the "clusters churn every night even though behaviour is
// stable" anti-pattern.
type PeerGroupDetector struct {
	// K is the target cluster count. Default 3 (low/medium/high
	// activity bands).
	K int
	// Sigma is the deviation threshold above which we emit a reason.
	// Default 2.0 (95% confidence interval for normal distribution).
	Sigma float64
	// TopActions is the dimensionality of the action-frequency vector.
	// Default 10. Larger = more discriminative but slower clustering.
	TopActions int
}

func (d *PeerGroupDetector) Name() string { return "peer_group" }

// Detect against the actor's own baseline. We use the baseline's
// pre-computed cluster_id + the mean activity vector for that
// cluster (passed via Baseline.TypicalActions) to score the actor's
// current event against the peer cohort norm.
//
// The full clustering pass happens in BuildClusters (called from the
// daily Worker tick); Detect itself is the cheap per-event check.
func (d *PeerGroupDetector) Detect(_ context.Context, ev AuditEvent, base *Baseline, _ *AuditEvent) []DetectorReason {
	if base == nil || base.ClusterID == nil || len(base.TypicalActions) == 0 {
		return nil
	}
	// Score the current event's action against the actor's own
	// frequency map. If the actor has never performed this action
	// (or performs it <1% of the time) and the cluster also doesn't
	// favour it, flag the divergence.
	total := 0
	for _, c := range base.TypicalActions {
		total += c
	}
	if total == 0 {
		return nil
	}
	count := base.TypicalActions[ev.Action]
	share := float64(count) / float64(total)
	sigma := d.sigma()
	// "Unusual for this actor": <1% historical share + high
	// action sensitivity.
	sens := actionSensitivity(ev.Action)
	if share >= 0.01 || sens < 0.5 {
		return nil
	}
	confidence := clamp01((1.0 - share*sigma) * sens)
	if confidence < 0.5 {
		return nil
	}
	return []DetectorReason{{
		Type: d.Name(),
		Reason: fmt.Sprintf(
			"action %q is %.2f%% of historical activity for peer-cluster %d (sensitivity %.2f)",
			ev.Action, share*100, *base.ClusterID, sens,
		),
		Confidence: confidence,
		Mitre:      MitreFor(d.Name()),
	}}
}

func (d *PeerGroupDetector) k() int {
	if d.K > 0 {
		return d.K
	}
	return 3
}

func (d *PeerGroupDetector) sigma() float64 {
	if d.Sigma > 0 {
		return d.Sigma
	}
	return 2.0
}

func (d *PeerGroupDetector) topN() int {
	if d.TopActions > 0 {
		return d.TopActions
	}
	return 10
}

// ComputeFrequencyVector projects an actor's typical_actions onto the
// shared action vocabulary. Returns a fixed-length vector aligned to
// vocab, normalised so each element is the action's share of total
// activity. Exported so tests can pin the projection.
func ComputeFrequencyVector(actions map[string]int, vocab []string) []float64 {
	vec := make([]float64, len(vocab))
	total := 0
	for _, c := range actions {
		total += c
	}
	if total == 0 {
		return vec
	}
	for i, a := range vocab {
		vec[i] = float64(actions[a]) / float64(total)
	}
	return vec
}

// KMeansClustering runs deterministic k-means++ on a slice of
// frequency vectors. Returns one cluster assignment per input vector.
// All vectors must share length (caller's responsibility).
//
// Determinism: seedKey feeds fnv64; the same seedKey + same inputs
// always yield the same assignment. Pass tenant_id+day_iso so the
// cluster IDs are stable day-over-day for unchanged cohorts.
func KMeansClustering(vectors [][]float64, k int, seedKey string) []int {
	if len(vectors) == 0 || k <= 0 {
		return nil
	}
	if k >= len(vectors) {
		// Trivial: one cluster per vector.
		out := make([]int, len(vectors))
		for i := range out {
			out[i] = i
		}
		return out
	}
	dim := len(vectors[0])
	rng := newDeterministicRNG(seedKey)
	// k-means++ init: first centroid random; subsequent centroids
	// proportional to squared distance from nearest existing centroid.
	centroids := make([][]float64, 0, k)
	first := rng.intN(len(vectors))
	centroids = append(centroids, copyVec(vectors[first]))
	for len(centroids) < k {
		dists := make([]float64, len(vectors))
		var sum float64
		for i, v := range vectors {
			dists[i] = math.Inf(1)
			for _, c := range centroids {
				d := sqDist(v, c)
				if d < dists[i] {
					dists[i] = d
				}
			}
			sum += dists[i]
		}
		if sum == 0 {
			centroids = append(centroids, copyVec(vectors[rng.intN(len(vectors))]))
			continue
		}
		target := rng.float64() * sum
		var running float64
		for i, dd := range dists {
			running += dd
			if running >= target {
				centroids = append(centroids, copyVec(vectors[i]))
				break
			}
		}
	}
	assign := make([]int, len(vectors))
	for iter := 0; iter < 20; iter++ {
		changed := false
		for i, v := range vectors {
			best := 0
			bestDist := math.Inf(1)
			for c, cv := range centroids {
				d := sqDist(v, cv)
				if d < bestDist {
					bestDist = d
					best = c
				}
			}
			if assign[i] != best {
				assign[i] = best
				changed = true
			}
		}
		// Recompute centroids.
		counts := make([]int, k)
		sums := make([][]float64, k)
		for i := range sums {
			sums[i] = make([]float64, dim)
		}
		for i, v := range vectors {
			c := assign[i]
			counts[c]++
			for j, x := range v {
				sums[c][j] += x
			}
		}
		for c := range centroids {
			if counts[c] == 0 {
				continue
			}
			for j := range centroids[c] {
				centroids[c][j] = sums[c][j] / float64(counts[c])
			}
		}
		if !changed {
			break
		}
	}
	return assign
}

func sqDist(a, b []float64) float64 {
	var sum float64
	for i := range a {
		d := a[i] - b[i]
		sum += d * d
	}
	return sum
}

func copyVec(v []float64) []float64 {
	out := make([]float64, len(v))
	copy(out, v)
	return out
}

// BuildVocabulary picks the top-N action labels by aggregate count
// across the cohort. Sorted lexicographically within ties so the
// vocabulary is deterministic for unit tests.
func BuildVocabulary(cohort []Baseline, n int) []string {
	totals := map[string]int{}
	for _, b := range cohort {
		for a, c := range b.TypicalActions {
			totals[a] += c
		}
	}
	type kv struct {
		k string
		v int
	}
	pairs := make([]kv, 0, len(totals))
	for k, v := range totals {
		pairs = append(pairs, kv{k, v})
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].v != pairs[j].v {
			return pairs[i].v > pairs[j].v
		}
		return pairs[i].k < pairs[j].k
	})
	if n > len(pairs) {
		n = len(pairs)
	}
	out := make([]string, n)
	for i := 0; i < n; i++ {
		out[i] = pairs[i].k
	}
	return out
}

// detRNG is a tiny deterministic LCG seeded from fnv64. Sufficient
// for k-means++ centroid selection — we don't need crypto quality.
type detRNG struct {
	state uint64
}

func newDeterministicRNG(key string) *detRNG {
	h := fnv.New64a()
	_, _ = h.Write([]byte(key))
	return &detRNG{state: h.Sum64()}
}

func (r *detRNG) next() uint64 {
	// xorshift64*
	r.state ^= r.state >> 12
	r.state ^= r.state << 25
	r.state ^= r.state >> 27
	return r.state * 2685821657736338717
}

func (r *detRNG) intN(n int) int {
	if n <= 0 {
		return 0
	}
	return int(r.next() % uint64(n))
}

func (r *detRNG) float64() float64 {
	return float64(r.next()&((1<<53)-1)) / float64(1<<53)
}

// ClusterCohort runs the full peer-grouping pipeline on a tenant's
// baselines: build vocabulary, project each actor's vector, k-means
// cluster, write the cluster_id back onto each baseline. Returns the
// mutated slice so the caller can persist.
func (d *PeerGroupDetector) ClusterCohort(cohort []Baseline, seedKey string) []Baseline {
	if len(cohort) == 0 {
		return cohort
	}
	vocab := BuildVocabulary(cohort, d.topN())
	vectors := make([][]float64, len(cohort))
	for i := range cohort {
		vectors[i] = ComputeFrequencyVector(cohort[i].TypicalActions, vocab)
	}
	assign := KMeansClustering(vectors, d.k(), seedKey)
	for i := range cohort {
		c := assign[i]
		cohort[i].ClusterID = &c
	}
	return cohort
}
