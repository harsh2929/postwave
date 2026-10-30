// SPDX-License-Identifier: AGPL-3.0-only
//
// Package nbp implements the "Next Best Product" per-user recommender —
// the Moosewave answer to Klaviyo's Next Best Product, Mailchimp's
// Personalized Product Recommendations, and MoEngage's Smart
// Recommendations on AWS Personalize.
//
// Architecture (Klaviyo-style item-item collaborative filtering):
//
//  1. A nightly Builder reads commerce_order_items, treats each
//     order as one "basket", and computes a cosine-similarity score
//     between every pair of products that have co-occurred at least
//     `minSupport` times. Top-K neighbors per anchor are persisted
//     to nbp_item_similarity.
//
//  2. The same Builder pass materializes a per-subscriber affinity
//     vector (product_id -> recency-weighted purchase score) into
//     nbp_user_affinity. This is the "rower's" anchor set for that
//     subscriber when we expand into recommendations.
//
//  3. For each subscriber, the Builder also writes a compact Bloom
//     filter into nbp_user_recent_bloom — the set of products the
//     subscriber bought in the last `recency_exclude_days` days
//     (Klaviyo defaults to 730d = 2y). At render time the
//     recommender consults this filter to dedupe.
//
//  4. At render time (campaign send + transactional + compose-time
//     preview), Recommender.RecommendForSubscriber loads the
//     subscriber's anchor affinities + their bloom filter, walks
//     the similarity table to expand into a candidate set, drops
//     anchors that are in the bloom filter, and returns the
//     top-N by aggregated score.
//
// This package ships the data structures and the self-hosted recommender.
// The recommender falls back
// gracefully to popularity-based ordering when no similarity data
// has been materialized yet, so campaigns that reference the new
// {{ recommended_products }} Liquid helper render correctly on day 1.
package nbp

import "time"

// Strategy identifies the recommender that produced a result.
// Surfaced through the audit ledger so the marketing team can answer
// "why did Alice get product 42 in the May newsletter?" with the
// exact data path.
type Strategy string

const (
	// StrategyItemItemCF is the self-hosted cosine-similarity
	// recommender. The default.
	StrategyItemItemCF Strategy = "item_item_cf"
	// StrategyPopularity is the cold-start fallback: rank by orders
	// count across the catalog. Used for new tenants whose Builder
	// hasn't produced a similarity table yet.
	StrategyPopularity Strategy = "popularity"
	// StrategyColdStartFallback is the per-subscriber cold-start —
	// the tenant has data but THIS subscriber has no orders, so we
	// fall back to popularity for them specifically.
	StrategyColdStartFallback Strategy = "cold_start_fallback"
)

// Settings is the per-tenant configuration mirrored to nbp_settings.
// Reads happen at render time so updates take effect on the next
// send. The Builder also reads this row on each nightly pass.
type Settings struct {
	TenantID             string     `json:"tenant_id,omitempty"`
	Enabled              bool       `json:"enabled"`
	RecencyExcludeDays   int        `json:"recency_exclude_days"`
	TopNPerUser          int        `json:"top_n_per_user"`
	SimilarityFloor      float64    `json:"similarity_floor"`
	RefresherStrategy    Strategy   `json:"refresher_strategy"`
	RefreshIntervalHours int        `json:"refresh_interval_hours"`
	BloomTargetFPR       float64    `json:"bloom_target_fpr"`
	SimilarityComputedAt *time.Time `json:"similarity_computed_at,omitempty"`
	AffinityComputedAt   *time.Time `json:"affinity_computed_at,omitempty"`
	ModelVersion         int64      `json:"model_version"`
	CreatedAt            time.Time  `json:"created_at,omitempty"`
	UpdatedAt            time.Time  `json:"updated_at,omitempty"`
	// StrategyAvailable is false only when reading a legacy row that names a
	// retired external strategy. Such rows are returned disabled until an
	// operator saves one of the advertised local strategies.
	StrategyAvailable bool   `json:"strategy_available"`
	DisabledReason    string `json:"disabled_reason,omitempty"`
}

// DefaultSettings returns the canonical defaults the SQL CHECK
// constraints expect. Match infra/migrations/0297_next_best_product_recommender.sql.
func DefaultSettings() Settings {
	return Settings{
		Enabled:              false,
		RecencyExcludeDays:   730, // 2y, matches Klaviyo
		TopNPerUser:          6,
		SimilarityFloor:      0.05,
		RefresherStrategy:    StrategyItemItemCF,
		RefreshIntervalHours: 24,
		BloomTargetFPR:       0.01,
		ModelVersion:         1,
		StrategyAvailable:    true,
	}
}

func selectableStrategy(strategy Strategy) bool {
	return strategy == StrategyItemItemCF || strategy == StrategyPopularity
}

// ItemSimilarity is one row of nbp_item_similarity. Top-K rows per
// anchor product define the recommender's hop graph.
type ItemSimilarity struct {
	AnchorProductID   string    `json:"anchor_product_id"`
	NeighborProductID string    `json:"neighbor_product_id"`
	Similarity        float64   `json:"similarity"`
	Support           int       `json:"support"`
	ModelVersion      int64     `json:"model_version"`
	ComputedAt        time.Time `json:"computed_at"`
}

// UserAffinity is one row of nbp_user_affinity — the subscriber's
// historical attraction to a single product.
type UserAffinity struct {
	SubscriberID    string     `json:"subscriber_id"`
	ProductID       string     `json:"product_id"`
	Score           float64    `json:"score"`
	LastPurchasedAt *time.Time `json:"last_purchased_at,omitempty"`
	PurchaseCount   int        `json:"purchase_count"`
	ComputedAt      time.Time  `json:"computed_at"`
}

// Recommendation is the public render-time output — one product the
// recommender wants to surface in a campaign or transactional email.
type Recommendation struct {
	ProductID  string   `json:"product_id"`
	Title      string   `json:"title,omitempty"`
	URL        string   `json:"url,omitempty"`
	ImageURL   string   `json:"image_url,omitempty"`
	PriceCents int      `json:"price_cents,omitempty"`
	Currency   string   `json:"currency,omitempty"`
	Score      float64  `json:"score"`
	Strategy   Strategy `json:"strategy"`
	// Anchors lists the products in the subscriber's history that drove
	// this recommendation — surfaced so the compose-time preview can
	// show "because you bought X, Y" tooltips.
	Anchors []string `json:"anchors,omitempty"`
}

// RecommendInput packages the inputs to RecommendForSubscriber so the
// caller can extend with future signals (locale, device, etc.) without
// breaking the call sites.
type RecommendInput struct {
	TenantID     string
	SubscriberID string
	// Limit caps the returned slice. 0 falls back to Settings.TopNPerUser.
	Limit int
	// CampaignID is recorded in nbp_recommendation_audit so the
	// marketing team can backtrack on "why did this subscriber see
	// these products in this email". Empty for transactional sends.
	CampaignID string
	// Now lets tests pin recency-decay math. Defaults to time.Now()
	// when zero-valued.
	Now time.Time
}
