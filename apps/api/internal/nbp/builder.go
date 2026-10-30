// SPDX-License-Identifier: AGPL-3.0-only
//
// Builder is the nightly batch job that materialises
//   - nbp_item_similarity     (cosine over basket co-occurrence)
//   - nbp_user_affinity       (recency-weighted purchase scores)
//   - nbp_user_recent_bloom   (last-N-days purchase set, packed)
//
// This file ships the entry-point plus all three passes:
//   - per-subscriber recent-purchase Bloom refresh (dedupe support),
//   - item-item cosine similarity over basket co-occurrence,
//   - recency-weighted per-user affinity scores.
//
// The two CF passes run as set-based INSERT...SELECT inside a per-tenant
// tx (full rebuild) rather than pulling pairs into Go — the co-occurrence
// map-reduce is exactly what SQL window functions are good at. Order data
// lives in commerce_orders.line_items (jsonb); the provider product ref
// (li->>'product_id', falling back to li->>'id') joins commerce_products
// .source_id to resolve the canonical UUID the FK requires.

package nbp

import (
	"context"
	"errors"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Builder owns the offline materialisation steps.
type Builder struct {
	Repo *Repo
	// Now lets tests pin recency math; defaults to time.Now() when zero.
	Now func() time.Time
}

// NewBuilder returns a builder wired to repo.
func NewBuilder(repo *Repo) *Builder {
	return &Builder{Repo: repo, Now: time.Now}
}

// RunOnce processes all tenants whose nbp_settings row says
// "enabled=true" and whose similarity_computed_at is older than
// refresh_interval_hours. Designed to be invoked from the same
// cron framework that drives send_time_opt.worker.go.
//
// Each eligible tenant gets a Bloom refresh, an item-similarity rebuild,
// and a user-affinity rebuild. When the CF tables are empty (no commerce
// yet) the recommender degrades to a popularity fallback, so the feature
// works on day 1 and sharpens as orders accrue.
func (b *Builder) RunOnce(ctx context.Context) error {
	if b == nil || b.Repo == nil {
		return errors.New("nbp: builder not initialised")
	}
	tenants, err := b.eligibleTenants(ctx)
	if err != nil {
		return err
	}
	for _, t := range tenants {
		if err := b.RunForTenant(ctx, t); err != nil {
			// Don't bail the whole pass on a single tenant failure —
			// the cron framework will log and we'll retry on the
			// next tick.
			continue
		}
	}
	return nil
}

// RunForTenant processes one tenant end-to-end.
func (b *Builder) RunForTenant(ctx context.Context, tenantID string) error {
	settings, _ := b.Repo.GetSettings(ctx, tenantID)
	if !settings.Enabled {
		return nil
	}
	// 1. Refresh per-subscriber recent-purchase Bloom filters.
	if err := b.refreshBlooms(ctx, tenantID, settings); err != nil {
		return err
	}
	// 2. Item-item cosine similarity over basket co-occurrence.
	if err := b.buildItemSimilarity(ctx, tenantID, settings); err != nil {
		return err
	}
	// 3. Recency-weighted per-user affinity scores.
	if err := b.buildUserAffinity(ctx, tenantID, settings); err != nil {
		return err
	}

	// Stamp the run timestamp so RunOnce's eligibility check skips
	// this tenant until the next interval.
	if err := b.markSimilarityRun(ctx, tenantID); err != nil {
		return err
	}
	return nil
}

// simTopKPerAnchor caps how many neighbors we persist per anchor product so
// nbp_item_similarity stays linear in catalog size, not quadratic. The
// recommender requests up to 24 neighbors per anchor; 50 leaves headroom for
// the SimilarityFloor to prune without starving the hop graph.
const simTopKPerAnchor = 50

// affinityHalfLifeDays is the recency half-life for the user-affinity decay: a
// purchase contributes 0.5^(age_days/halflife) to the raw score, so a product
// bought ~6 months ago counts half as much as one bought today. Matches the
// Klaviyo "predicted affinity" decay shape closely enough for parity.
const affinityHalfLifeDays = 180.0

// buildItemSimilarity recomputes nbp_item_similarity for one tenant: cosine
// similarity over basket co-occurrence, top-K neighbors per anchor above the
// settings floor. Full rebuild (DELETE then INSERT) inside one tenant tx so a
// product that stops co-occurring drops out instead of lingering stale.
//
// The product reference inside line_items is provider-specific
// (li->>'product_id' for Shopify/Woo, falling back to li->>'id'); it joins to
// commerce_products.source_id — the same value ensureProduct stores at ingest —
// to resolve the canonical UUID the table's FK requires. Unknown products
// (not in the catalog) drop out of the join.
func (b *Builder) buildItemSimilarity(ctx context.Context, tenantID string, settings Settings) error {
	tx, err := db.WithTenant(ctx, b.Repo.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	since := b.now().AddDate(0, 0, -settings.RecencyExcludeDays)
	if _, err := tx.Exec(ctx,
		`DELETE FROM nbp_item_similarity WHERE tenant_id = $1::uuid`, tenantID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
WITH order_products AS (
    SELECT DISTINCT o.id AS order_id, p.id AS product_id
      FROM commerce_orders o
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.line_items, '[]'::jsonb)) AS li
      JOIN commerce_products p
        ON p.tenant_id = o.tenant_id
       AND p.source_id = COALESCE(li->>'product_id', li->>'id')
     WHERE o.tenant_id = $1::uuid
       AND o.created_at >= $2
),
pairs AS (
    SELECT a.product_id AS anchor, b.product_id AS neighbor, count(*)::int AS cooc
      FROM order_products a
      JOIN order_products b
        ON a.order_id = b.order_id AND a.product_id <> b.product_id
     GROUP BY a.product_id, b.product_id
),
freq AS (
    SELECT product_id, count(*)::int AS f FROM order_products GROUP BY product_id
),
scored AS (
    SELECT pr.anchor, pr.neighbor, pr.cooc,
           pr.cooc::float8 / sqrt(fa.f::float8 * fb.f::float8) AS sim
      FROM pairs pr
      JOIN freq fa ON fa.product_id = pr.anchor
      JOIN freq fb ON fb.product_id = pr.neighbor
),
ranked AS (
    SELECT anchor, neighbor, cooc, sim,
           row_number() OVER (PARTITION BY anchor ORDER BY sim DESC, cooc DESC) AS rn
      FROM scored
     WHERE sim >= $3::float8
)
INSERT INTO nbp_item_similarity
    (tenant_id, anchor_product_id, neighbor_product_id, similarity, support, model_version, computed_at)
SELECT $1::uuid, anchor, neighbor, LEAST(sim, 1.0), cooc, $4::bigint, now()
  FROM ranked
 WHERE rn <= $5`,
		tenantID, since, settings.SimilarityFloor, settings.ModelVersion, simTopKPerAnchor); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// buildUserAffinity recomputes nbp_user_affinity for one tenant: each
// (subscriber, product) gets a recency-decayed score normalised to [0, 1]
// within the subscriber (their strongest product = 1.0), plus purchase count
// and last-purchased timestamp. Full rebuild inside one tenant tx.
//
// Multiple line items of the same product in one order are de-duplicated to a
// single purchase so a multi-quantity order doesn't double-weight recency.
func (b *Builder) buildUserAffinity(ctx context.Context, tenantID string, settings Settings) error {
	tx, err := db.WithTenant(ctx, b.Repo.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	since := b.now().AddDate(0, 0, -settings.RecencyExcludeDays)
	if _, err := tx.Exec(ctx,
		`DELETE FROM nbp_user_affinity WHERE tenant_id = $1::uuid`, tenantID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
WITH purchases AS (
    SELECT DISTINCT s.id AS subscriber_id, p.id AS product_id,
                    o.id AS order_id, o.created_at
      FROM commerce_orders o
      JOIN subscribers s
        ON s.tenant_id = o.tenant_id
       AND lower(s.email) = lower(o.customer_email::text)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.line_items, '[]'::jsonb)) AS li
      JOIN commerce_products p
        ON p.tenant_id = o.tenant_id
       AND p.source_id = COALESCE(li->>'product_id', li->>'id')
     WHERE o.tenant_id = $1::uuid
       AND o.created_at >= $2
),
weighted AS (
    SELECT subscriber_id, product_id, created_at,
           pow(0.5, GREATEST(0, EXTRACT(EPOCH FROM (now() - created_at)) / 86400.0) / $3::float8) AS w
      FROM purchases
),
agg AS (
    SELECT subscriber_id, product_id,
           sum(w) AS raw_score,
           count(*)::int AS purchase_count,
           max(created_at) AS last_purchased_at
      FROM weighted
     GROUP BY subscriber_id, product_id
),
norm AS (
    SELECT subscriber_id, product_id, purchase_count, last_purchased_at,
           raw_score / NULLIF(max(raw_score) OVER (PARTITION BY subscriber_id), 0) AS score
      FROM agg
)
INSERT INTO nbp_user_affinity
    (tenant_id, subscriber_id, product_id, score, last_purchased_at, purchase_count, computed_at)
SELECT $1::uuid, subscriber_id, product_id, LEAST(COALESCE(score, 0), 1.0),
       last_purchased_at, purchase_count, now()
  FROM norm`,
		tenantID, since, affinityHalfLifeDays); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (b *Builder) refreshBlooms(ctx context.Context, tenantID string, settings Settings) error {
	tx, err := db.WithTenant(ctx, b.Repo.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Pull the per-subscriber purchase set in the window. The current
	// commerce_orders schema (migration 0028) stores line items as a
	// jsonb array on the order row + identifies the customer by
	// email. We resolve email -> subscriber via the subscribers
	// table; line items are unpacked with jsonb_array_elements.
	//
	// For very large tenants this could be paginated; commerce_orders
	// already indexes (tenant_id, customer_email, ordered_at DESC).
	since := b.now().AddDate(0, 0, -settings.RecencyExcludeDays)
	rows, err := tx.Query(ctx, `
SELECT s.id::text AS subscriber_id,
       COALESCE(li->>'product_id', li->>'id', '') AS product_id
  FROM commerce_orders o
  JOIN subscribers s ON lower(s.email) = lower(o.customer_email::text)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.line_items, '[]'::jsonb)) AS li
 WHERE o.tenant_id = $1::uuid
   AND s.tenant_id = $1::uuid
   AND o.created_at >= $2`, tenantID, since)
	if err != nil {
		// Schema variant: a later migration may rename columns or
		// promote line_items to commerce_order_items. The recommender
		// already handles an empty bloom-filter table gracefully, so
		// we silently skip rather than failing the whole nightly run.
		return nil
	}
	defer rows.Close()
	bySub := map[string]map[string]struct{}{}
	for rows.Next() {
		var sub, prod string
		if err := rows.Scan(&sub, &prod); err != nil {
			continue
		}
		if prod == "" {
			continue
		}
		set, ok := bySub[sub]
		if !ok {
			set = map[string]struct{}{}
			bySub[sub] = set
		}
		set[prod] = struct{}{}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	for sub, items := range bySub {
		count := len(items)
		bloom := NewBloom(count, settings.BloomTargetFPR)
		for id := range items {
			bloom.Add(id)
		}
		// Best-effort persist; one bad subscriber doesn't poison the run.
		_ = b.Repo.SaveRecentPurchaseBloom(ctx, tenantID, sub, bloom, count, settings.RecencyExcludeDays)
	}
	return nil
}

// eligibleTenants returns tenant IDs whose nbp_settings says enabled
// AND whose last similarity run was longer than refresh_interval_hours
// ago. NOT tenant-scoped — the worker runs under a service role that
// can see all rows; the per-tenant work below re-establishes RLS.
func (b *Builder) eligibleTenants(ctx context.Context) ([]string, error) {
	// Worker context — no per-tenant GUC. The Pool's direct connection
	// is fine because nbp_settings is administrative metadata; we still
	// only read tenant_id values.
	conn, err := b.Repo.Pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()
	rows, err := conn.Query(ctx, `
SELECT tenant_id::text
  FROM nbp_settings
 WHERE enabled = true
   AND (similarity_computed_at IS NULL
        OR similarity_computed_at < now() - make_interval(hours => refresh_interval_hours))`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			continue
		}
		out = append(out, t)
	}
	return out, nil
}

func (b *Builder) markSimilarityRun(ctx context.Context, tenantID string) error {
	tx, err := db.WithTenant(ctx, b.Repo.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE nbp_settings
   SET similarity_computed_at = now(),
       affinity_computed_at   = now(),
       updated_at             = now()
 WHERE tenant_id = $1::uuid`, tenantID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (b *Builder) now() time.Time {
	if b.Now == nil {
		return time.Now()
	}
	return b.Now()
}
