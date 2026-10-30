// SPDX-License-Identifier: AGPL-3.0-only
//
// Repo wraps the SQL surface for the nbp_* tables. All reads /
// writes go through db.WithTenant so the NULLIF GUC RLS idiom
// from migration 0079 stays in force.

package nbp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrNotFound is returned when a single-row lookup misses. Callers
// usually convert to 404 in handlers or apply a default.
var ErrNotFound = errors.New("nbp: not found")

// ErrUnsupportedStrategy prevents retired or unknown recommenders from being
// persisted as if they were executable.
var ErrUnsupportedStrategy = errors.New("nbp: refresher_strategy must be item_item_cf or popularity")

// Repo is the data-access layer.
type Repo struct {
	Pool *db.Pool
}

// GetSettings returns the tenant's settings row, or the default
// settings + ErrNotFound when no row exists yet. The default-on-miss
// behaviour means callers never need to special-case "tenant has
// never opened the Recommendations panel" — they get sane values.
func (r *Repo) GetSettings(ctx context.Context, tenantID string) (Settings, error) {
	def := DefaultSettings()
	def.TenantID = tenantID

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return def, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var s Settings
	s.TenantID = tenantID
	var strategy string
	err = tx.QueryRow(ctx, `
SELECT enabled, recency_exclude_days, top_n_per_user, similarity_floor,
       refresher_strategy, refresh_interval_hours, bloom_target_fpr,
       similarity_computed_at, affinity_computed_at, model_version,
       created_at, updated_at
  FROM nbp_settings
 WHERE tenant_id = $1::uuid`, tenantID).Scan(
		&s.Enabled, &s.RecencyExcludeDays, &s.TopNPerUser, &s.SimilarityFloor,
		&strategy, &s.RefreshIntervalHours, &s.BloomTargetFPR,
		&s.SimilarityComputedAt, &s.AffinityComputedAt, &s.ModelVersion,
		&s.CreatedAt, &s.UpdatedAt,
	)
	if err != nil {
		// Either the row genuinely doesn't exist (pgx.ErrNoRows) or
		// the table is missing (non-commerce tenants). Either way,
		// return defaults so render-time callers fall back gracefully.
		return def, ErrNotFound
	}
	s.RefresherStrategy = Strategy(strategy)
	s.StrategyAvailable = selectableStrategy(s.RefresherStrategy)
	if !s.StrategyAvailable {
		s.Enabled = false
		s.DisabledReason = "stored recommender strategy is not available in this release; save item_item_cf or popularity to re-enable recommendations"
	}
	return s, tx.Commit(ctx)
}

// UpsertSettings creates or updates the tenant's nbp_settings row.
// Validates ranges so a malformed admin POST can't smuggle in an
// out-of-bounds top_n that the CHECK constraints would later reject
// with a cryptic Postgres error.
func (r *Repo) UpsertSettings(ctx context.Context, tenantID string, s Settings) (Settings, error) {
	if tenantID == "" {
		return Settings{}, errors.New("nbp: tenant_id required")
	}
	// Clamp to the CHECK-constraint ranges from 0297.
	if s.RecencyExcludeDays < 0 {
		s.RecencyExcludeDays = 0
	}
	if s.RecencyExcludeDays > 3650 {
		s.RecencyExcludeDays = 3650
	}
	if s.TopNPerUser < 1 {
		s.TopNPerUser = 1
	}
	if s.TopNPerUser > 24 {
		s.TopNPerUser = 24
	}
	if s.SimilarityFloor < 0 {
		s.SimilarityFloor = 0
	}
	if s.SimilarityFloor > 1 {
		s.SimilarityFloor = 1
	}
	if s.RefreshIntervalHours < 1 {
		s.RefreshIntervalHours = 1
	}
	if s.RefreshIntervalHours > 168 {
		s.RefreshIntervalHours = 168
	}
	if s.BloomTargetFPR <= 0 || s.BloomTargetFPR >= 0.5 {
		s.BloomTargetFPR = 0.01
	}
	if s.RefresherStrategy == "" {
		s.RefresherStrategy = StrategyItemItemCF
	} else if !selectableStrategy(s.RefresherStrategy) {
		return Settings{}, ErrUnsupportedStrategy
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return s, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var out Settings
	out.TenantID = tenantID
	var strategy string
	err = tx.QueryRow(ctx, `
INSERT INTO nbp_settings(
    tenant_id, enabled, recency_exclude_days, top_n_per_user, similarity_floor,
    refresher_strategy, refresh_interval_hours, bloom_target_fpr)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (tenant_id) DO UPDATE SET
    enabled                = EXCLUDED.enabled,
    recency_exclude_days   = EXCLUDED.recency_exclude_days,
    top_n_per_user         = EXCLUDED.top_n_per_user,
    similarity_floor       = EXCLUDED.similarity_floor,
    refresher_strategy     = EXCLUDED.refresher_strategy,
    refresh_interval_hours = EXCLUDED.refresh_interval_hours,
    bloom_target_fpr       = EXCLUDED.bloom_target_fpr,
    updated_at             = now()
RETURNING enabled, recency_exclude_days, top_n_per_user, similarity_floor,
          refresher_strategy, refresh_interval_hours, bloom_target_fpr,
          similarity_computed_at, affinity_computed_at, model_version,
          created_at, updated_at`,
		tenantID, s.Enabled, s.RecencyExcludeDays, s.TopNPerUser, s.SimilarityFloor,
		string(s.RefresherStrategy), s.RefreshIntervalHours, s.BloomTargetFPR,
	).Scan(
		&out.Enabled, &out.RecencyExcludeDays, &out.TopNPerUser, &out.SimilarityFloor,
		&strategy, &out.RefreshIntervalHours, &out.BloomTargetFPR,
		&out.SimilarityComputedAt, &out.AffinityComputedAt, &out.ModelVersion,
		&out.CreatedAt, &out.UpdatedAt,
	)
	if err != nil {
		return s, err
	}
	out.RefresherStrategy = Strategy(strategy)
	out.StrategyAvailable = true
	return out, tx.Commit(ctx)
}

// TopAffinities returns the subscriber's strongest historical
// product attractions, sorted score DESC. Used by the recommender
// as the "anchor set" we expand outward from.
func (r *Repo) TopAffinities(ctx context.Context, tenantID, subscriberID string, limit int) ([]UserAffinity, error) {
	if limit <= 0 {
		limit = 20
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT product_id::text, score, last_purchased_at, purchase_count, computed_at
  FROM nbp_user_affinity
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
 ORDER BY score DESC
 LIMIT $3`, tenantID, subscriberID, limit)
	if err != nil {
		// Missing table = no commerce yet. Caller falls back to popularity.
		return nil, nil
	}
	defer rows.Close()
	out := []UserAffinity{}
	for rows.Next() {
		var ua UserAffinity
		ua.SubscriberID = subscriberID
		if err := rows.Scan(&ua.ProductID, &ua.Score, &ua.LastPurchasedAt, &ua.PurchaseCount, &ua.ComputedAt); err != nil {
			continue
		}
		out = append(out, ua)
	}
	return out, tx.Commit(ctx)
}

// NeighborsOf returns the top similar products for an anchor, score
// DESC, capped at limit. Pulls from the precomputed similarity
// matrix; never on the hot path does it compute cosine on the fly.
func (r *Repo) NeighborsOf(ctx context.Context, tenantID, anchorProductID string, limit int, minSim float64) ([]ItemSimilarity, error) {
	if limit <= 0 {
		limit = 20
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT neighbor_product_id::text, similarity, support, model_version, computed_at
  FROM nbp_item_similarity
 WHERE tenant_id = $1::uuid AND anchor_product_id = $2::uuid AND similarity >= $3
 ORDER BY similarity DESC
 LIMIT $4`, tenantID, anchorProductID, minSim, limit)
	if err != nil {
		return nil, nil
	}
	defer rows.Close()
	out := []ItemSimilarity{}
	for rows.Next() {
		var s ItemSimilarity
		s.AnchorProductID = anchorProductID
		if err := rows.Scan(&s.NeighborProductID, &s.Similarity, &s.Support, &s.ModelVersion, &s.ComputedAt); err != nil {
			continue
		}
		out = append(out, s)
	}
	return out, tx.Commit(ctx)
}

// LoadRecentPurchaseBloom hydrates the subscriber's Bloom filter
// from nbp_user_recent_bloom. Returns (nil, nil) when no filter has
// been materialized (cold subscriber); callers treat this as "no
// dedupe applies".
func (r *Repo) LoadRecentPurchaseBloom(ctx context.Context, tenantID, subscriberID string) (*Bloom, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		bits []byte
		m, k int
	)
	err = tx.QueryRow(ctx, `
SELECT bloom_bits, bloom_m, bloom_k
  FROM nbp_user_recent_bloom
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`,
		tenantID, subscriberID,
	).Scan(&bits, &m, &k)
	if err != nil {
		return nil, nil
	}
	if commitErr := tx.Commit(ctx); commitErr != nil {
		return nil, commitErr
	}
	return FromBytes(bits, m, k)
}

// SaveRecentPurchaseBloom persists a Bloom filter for the
// subscriber. The Builder calls this after recomputing the
// purchase set; the recommender reads it on every render.
func (r *Repo) SaveRecentPurchaseBloom(ctx context.Context, tenantID, subscriberID string, b *Bloom, itemCount, windowDays int) error {
	if b == nil {
		return errors.New("nbp: nil bloom filter")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO nbp_user_recent_bloom(
    tenant_id, subscriber_id, bloom_bits, bloom_k, bloom_m, item_count, window_days, refreshed_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, now())
ON CONFLICT (tenant_id, subscriber_id) DO UPDATE SET
    bloom_bits   = EXCLUDED.bloom_bits,
    bloom_k      = EXCLUDED.bloom_k,
    bloom_m      = EXCLUDED.bloom_m,
    item_count   = EXCLUDED.item_count,
    window_days  = EXCLUDED.window_days,
    refreshed_at = now()`,
		tenantID, subscriberID, b.Bits(), b.K(), b.M(), itemCount, windowDays,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RecordAudit appends a row to nbp_recommendation_audit. Best-effort:
// failures are logged by the caller but never fail the render.
func (r *Repo) RecordAudit(ctx context.Context, tenantID, subscriberID, campaignID string, productIDs []string, strategy Strategy, modelVersion int64) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	idsJSON, err := json.Marshal(productIDs)
	if err != nil {
		return err
	}
	subArg := nullIfBlank(subscriberID)
	campArg := nullIfBlank(campaignID)
	if _, err := tx.Exec(ctx, `
INSERT INTO nbp_recommendation_audit(
    tenant_id, subscriber_id, campaign_id, product_ids, model_version, strategy)
VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6)`,
		tenantID, subArg, campArg, string(idsJSON), modelVersion, string(strategy),
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// PopularProducts returns the catalog's top sellers. The cold-start
// fallback walks this list when a subscriber has no affinity data.
// We rank by orders_count over the last 90 days as a rough proxy
// for "still-fresh popularity".
func (r *Repo) PopularProducts(ctx context.Context, tenantID string, limit int, since time.Time) ([]Recommendation, error) {
	if limit <= 0 {
		limit = 6
	}
	if since.IsZero() {
		since = time.Now().AddDate(0, 0, -90)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Popularity proxy: rank products by how many of the tenant's
	// recent orders mention them in line_items. The jsonb @> operator
	// uses the GIN index on commerce_orders.line_items when present;
	// otherwise it falls back to a seq scan bounded by the
	// (tenant_id, ordered_at) index on commerce_orders. Tenants
	// running on the older schema (line_items as a separate
	// commerce_order_items table) get the empty-on-error fallback.
	rows, err := tx.Query(ctx, `
SELECT p.id::text, p.title, COALESCE(p.url,''), COALESCE(p.image_url,''),
       COALESCE(p.price_cents,0), COALESCE(p.currency,''),
       COALESCE((
           SELECT COUNT(*)
             FROM commerce_orders o
            WHERE o.tenant_id = $1::uuid
              AND o.created_at >= $2
              AND o.line_items @> jsonb_build_array(jsonb_build_object('product_id', p.id::text))
       ), 0) AS sales
  FROM commerce_products p
 WHERE p.tenant_id = $1::uuid
 ORDER BY sales DESC, p.updated_at DESC
 LIMIT $3`, tenantID, since, limit)
	if err != nil {
		return []Recommendation{}, nil
	}
	defer rows.Close()
	out := []Recommendation{}
	for rows.Next() {
		var (
			rec   Recommendation
			sales int
		)
		if err := rows.Scan(&rec.ProductID, &rec.Title, &rec.URL, &rec.ImageURL, &rec.PriceCents, &rec.Currency, &sales); err != nil {
			continue
		}
		// Score: log-scale popularity. Bounded to [0, 1] so it sorts
		// cleanly against item-item CF scores.
		rec.Score = boundedLog(sales)
		rec.Strategy = StrategyPopularity
		out = append(out, rec)
	}
	return out, tx.Commit(ctx)
}

// LookupProductMeta enriches a slice of product IDs with title /
// URL / image / price for render-time output. Missing IDs are
// silently dropped from the output (the recommender treats them
// as deleted products).
func (r *Repo) LookupProductMeta(ctx context.Context, tenantID string, productIDs []string) (map[string]Recommendation, error) {
	if len(productIDs) == 0 {
		return map[string]Recommendation{}, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT id::text, title, COALESCE(url,''), COALESCE(image_url,''),
       COALESCE(price_cents,0), COALESCE(currency,'')
  FROM commerce_products
 WHERE tenant_id = $1::uuid AND id::text = ANY($2::text[])`,
		tenantID, productIDs)
	if err != nil {
		return map[string]Recommendation{}, nil
	}
	defer rows.Close()
	out := make(map[string]Recommendation, len(productIDs))
	for rows.Next() {
		var rec Recommendation
		if err := rows.Scan(&rec.ProductID, &rec.Title, &rec.URL, &rec.ImageURL, &rec.PriceCents, &rec.Currency); err != nil {
			continue
		}
		out[rec.ProductID] = rec
	}
	return out, tx.Commit(ctx)
}

func nullIfBlank(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func boundedLog(n int) float64 {
	// log10(n+1) / 6 — keeps popularity scores well below the [0,1]
	// item-item-CF ceiling so a cold-start mix never out-ranks a real
	// CF candidate when both are returned together.
	if n <= 0 {
		return 0
	}
	x := float64(n)
	out := 0.0
	for x >= 10 {
		x /= 10
		out += 1
	}
	out += (x - 1) / 9
	return out / 6.0
}
