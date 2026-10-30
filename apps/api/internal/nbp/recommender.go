// SPDX-License-Identifier: AGPL-3.0-only
//
// Recommender — the render-time entry point. Loads the subscriber's
// anchors + Bloom filter, walks the precomputed item-item similarity
// table, and returns the top-N candidates.
//
// Cost target (Klaviyo NBP parity): one SQL round-trip for anchors,
// one for the Bloom blob, one batched UUID-array query for neighbors,
// one for product metadata. The Builder amortises the expensive
// cosine pass into the nightly batch so we never touch
// commerce_order_items on the hot path.

package nbp

import (
	"context"
	"sort"
	"time"
)

// Recommender is constructed once at server startup and reused per
// render. It is goroutine-safe — the Repo + db.Pool underneath
// already are.
type Recommender struct {
	Repo *Repo
}

// NewRecommender returns a ready-to-use recommender backed by repo.
func NewRecommender(repo *Repo) *Recommender { return &Recommender{Repo: repo} }

// RecommendForSubscriber is the main entry point. The contract is:
//
//   - never errors out the caller's render path; on any internal
//     failure it falls back to popularity-based recs (or an empty
//     slice when even that fails)
//   - dedupes against the subscriber's recent-purchase Bloom
//     filter (configured per-tenant; default 2-year window)
//   - records an audit row so marketing can trace "why was Alice
//     shown product 42 in the May newsletter?"
//
// The returned slice is sorted score DESC and length-capped to
// in.Limit (falling back to settings.TopNPerUser when in.Limit <= 0).
func (r *Recommender) RecommendForSubscriber(ctx context.Context, in RecommendInput) ([]Recommendation, error) {
	if r == nil || r.Repo == nil {
		return []Recommendation{}, nil
	}
	if in.Now.IsZero() {
		in.Now = time.Now()
	}
	settings, _ := r.Repo.GetSettings(ctx, in.TenantID)
	if !settings.Enabled {
		// Hard kill-switch: even if a campaign references
		// {{ recommended_products }}, we render an empty array
		// when the tenant hasn't enabled the feature. The Liquid
		// helper renders an empty loop instead of an error.
		return []Recommendation{}, nil
	}
	limit := in.Limit
	if limit <= 0 {
		limit = settings.TopNPerUser
	}
	if limit <= 0 {
		limit = 6
	}
	// Keep the core service bounded even when invoked outside the HTTP
	// handler (for example, by a future render integration). The public
	// endpoint rejects larger values; this clamp is the final defence before
	// limit is doubled for the popularity query and used for allocations.
	if limit > maxRecommendationLimit {
		limit = maxRecommendationLimit
	}

	switch settings.RefresherStrategy {
	case StrategyPopularity:
		// Tenant explicitly chose popularity-only. Skip the
		// affinity / similarity reads entirely.
		return r.popularityFallback(ctx, in, settings, limit, StrategyPopularity)
	}

	anchors, _ := r.Repo.TopAffinities(ctx, in.TenantID, in.SubscriberID, 10)
	if len(anchors) == 0 {
		// Cold subscriber — no purchase history. Fall back to
		// catalog popularity. Klaviyo's NBP does the same;
		// otherwise the very first welcome email recommends
		// nothing.
		return r.popularityFallback(ctx, in, settings, limit, StrategyColdStartFallback)
	}

	bloom, _ := r.Repo.LoadRecentPurchaseBloom(ctx, in.TenantID, in.SubscriberID)

	// Aggregate scores across anchors: for each anchor, walk its
	// top similar products and add (anchor.score * neighbor.similarity)
	// into the candidate's running total. This is the standard
	// item-item CF "neighbor-of-neighbor" expansion.
	type candAgg struct {
		score      float64
		anchorList []string
	}
	cands := map[string]*candAgg{}
	for _, a := range anchors {
		neighbors, _ := r.Repo.NeighborsOf(ctx, in.TenantID, a.ProductID, 24, settings.SimilarityFloor)
		for _, nb := range neighbors {
			// Skip the anchor itself if it shows up as its own
			// neighbor (the schema CHECK constraint should
			// prevent this, but belt + braces).
			if nb.NeighborProductID == a.ProductID {
				continue
			}
			// Bloom filter dedupes "bought in last N days".
			if bloom != nil && bloom.Contains(nb.NeighborProductID) {
				continue
			}
			// Skip products that the subscriber's own affinity
			// table already flags as previously-bought, even if
			// they're outside the bloom window — the operator
			// almost never wants "recommend something they've
			// owned for years".
			if hasAffinity(anchors, nb.NeighborProductID) {
				continue
			}
			agg, ok := cands[nb.NeighborProductID]
			if !ok {
				agg = &candAgg{}
				cands[nb.NeighborProductID] = agg
			}
			agg.score += a.Score * nb.Similarity
			agg.anchorList = append(agg.anchorList, a.ProductID)
		}
	}

	if len(cands) == 0 {
		// Similarity table empty or no candidates survived
		// dedupe. Fall back to popularity rather than render an
		// empty block.
		return r.popularityFallback(ctx, in, settings, limit, StrategyColdStartFallback)
	}

	// Sort, cap, then enrich with product metadata.
	type ranked struct {
		id      string
		score   float64
		anchors []string
	}
	ordered := make([]ranked, 0, len(cands))
	for pid, agg := range cands {
		ordered = append(ordered, ranked{id: pid, score: agg.score, anchors: agg.anchorList})
	}
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].score != ordered[j].score {
			return ordered[i].score > ordered[j].score
		}
		return ordered[i].id < ordered[j].id // stable tiebreaker
	})
	if len(ordered) > limit {
		ordered = ordered[:limit]
	}

	ids := make([]string, len(ordered))
	for i, o := range ordered {
		ids[i] = o.id
	}
	meta, _ := r.Repo.LookupProductMeta(ctx, in.TenantID, ids)

	out := make([]Recommendation, 0, len(ordered))
	for _, o := range ordered {
		rec, ok := meta[o.id]
		if !ok {
			// Product was deleted between similarity computation
			// and now. Skip.
			continue
		}
		rec.Score = o.score
		rec.Strategy = StrategyItemItemCF
		rec.Anchors = o.anchors
		out = append(out, rec)
	}

	// Best-effort audit; never block the render on this.
	_ = r.Repo.RecordAudit(ctx, in.TenantID, in.SubscriberID, in.CampaignID, ids, StrategyItemItemCF, settings.ModelVersion)
	return out, nil
}

// popularityFallback returns the catalog's top sellers, optionally
// dropping ones in the subscriber's bloom filter. Used when affinity
// or similarity data is missing.
func (r *Recommender) popularityFallback(ctx context.Context, in RecommendInput, settings Settings, limit int, strategy Strategy) ([]Recommendation, error) {
	bloom, _ := r.Repo.LoadRecentPurchaseBloom(ctx, in.TenantID, in.SubscriberID)
	pop, _ := r.Repo.PopularProducts(ctx, in.TenantID, limit*2, in.Now.AddDate(0, 0, -90))
	out := make([]Recommendation, 0, limit)
	for _, p := range pop {
		if bloom != nil && bloom.Contains(p.ProductID) {
			continue
		}
		p.Strategy = strategy
		out = append(out, p)
		if len(out) >= limit {
			break
		}
	}
	if len(out) == 0 && len(pop) > 0 {
		// Bloom filter ate everything — return raw popularity (the
		// subscriber bought EVERYTHING in the last 2y, which is
		// pathological but the helper still has to return
		// something rather than render an empty section).
		for _, p := range pop {
			p.Strategy = strategy
			out = append(out, p)
			if len(out) >= limit {
				break
			}
		}
	}
	ids := make([]string, len(out))
	for i, o := range out {
		ids[i] = o.ProductID
	}
	_ = r.Repo.RecordAudit(ctx, in.TenantID, in.SubscriberID, in.CampaignID, ids, strategy, settings.ModelVersion)
	return out, nil
}

func hasAffinity(anchors []UserAffinity, productID string) bool {
	for _, a := range anchors {
		if a.ProductID == productID {
			return true
		}
	}
	return false
}
