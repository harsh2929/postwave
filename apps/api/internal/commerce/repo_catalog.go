// SPDX-License-Identifier: AGPL-3.0-only
package commerce

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// Product catalogs and product feeds: catalog upsert and import, feed
// definitions and feed resolution.

func (r *Repo) ListCatalogs(ctx context.Context, tenantID string, limit int, cursor pagination.Cursor) (*CatalogsPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	args := []any{tenantID, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (updated_at, id) < ($3::timestamptz, $4::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT `+catalogColumns+`
  FROM commerce_catalogs
 WHERE tenant_id = $1::uuid
 `+keyset+`
 ORDER BY updated_at DESC, id DESC
 LIMIT $2`, args...)
	if err != nil {
		return nil, err
	}
	items, err := scanCatalogs(rows)
	if err != nil {
		return nil, err
	}
	items, more := pagination.HasMore(items, limit)
	next := ""
	if more {
		last := items[len(items)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.UpdatedAt, ID: last.ID})
	}
	return &CatalogsPage{Items: items, NextCursor: next}, tx.Commit(ctx)
}

func (r *Repo) UpsertCatalog(ctx context.Context, tenantID string, in CatalogInput) (*Catalog, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	settings, _ := json.Marshal(nonNilMap(in.Settings))
	row := tx.QueryRow(ctx, `
INSERT INTO commerce_catalogs (
    tenant_id, integration_id, name, source_type, feed_url, status,
    locale, default_currency, settings
)
VALUES (
    $1::uuid, NULLIF($2, '')::uuid, $3, $4, NULLIF($5, ''), $6,
    NULLIF($7, ''), $8, $9::jsonb
)
ON CONFLICT (tenant_id, name) DO UPDATE SET
  integration_id = EXCLUDED.integration_id,
  source_type = EXCLUDED.source_type,
  feed_url = EXCLUDED.feed_url,
  status = EXCLUDED.status,
  locale = EXCLUDED.locale,
  default_currency = EXCLUDED.default_currency,
  settings = EXCLUDED.settings,
  error_message = NULL,
  updated_at = now()
RETURNING `+catalogColumns,
		tenantID, in.IntegrationID, in.Name, defaulted(in.SourceType, "integration"),
		in.FeedURL, defaulted(in.Status, "active"), in.Locale,
		defaulted(in.DefaultCurrency, "USD"), string(settings))
	catalog, err := scanCatalog(row)
	if err != nil {
		return nil, err
	}
	return catalog, tx.Commit(ctx)
}

func (r *Repo) ImportCatalogProducts(ctx context.Context, tenantID, catalogID string, in CatalogProductImportInput, now time.Time) (*CatalogProductImportSummary, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	catalog, err := getCatalog(ctx, tx, tenantID, catalogID)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(catalog.IntegrationID) == "" {
		return nil, ErrCatalogRequiresIntegration
	}
	if in.Replace {
		if _, err := tx.Exec(ctx, `
DELETE FROM commerce_catalog_items
 WHERE tenant_id = $1::uuid AND catalog_id::text = $2`, tenantID, catalog.ID); err != nil {
			return nil, err
		}
	}
	out := &CatalogProductImportSummary{
		CatalogID:     catalog.ID,
		IntegrationID: catalog.IntegrationID,
		ProductsSeen:  len(in.Products),
		ImportedAt:    now.UTC(),
	}
	for i, item := range in.Products {
		product := catalogImportProductInput(item, catalog.DefaultCurrency)
		if strings.TrimSpace(product.SourceID) == "" || strings.TrimSpace(product.Title) == "" {
			out.ProductsSkipped++
			continue
		}
		productID, err := upsertProduct(ctx, tx, tenantID, catalog.IntegrationID, product)
		if err != nil {
			return nil, err
		}
		out.ProductsUpserted++
		position := item.Position
		if position <= 0 {
			position = i + 1
		}
		if err := upsertCatalogItem(ctx, tx, tenantID, catalog.ID, productID, item.Collection, position, map[string]any{
			"source":    "json_import",
			"source_id": product.SourceID,
		}); err != nil {
			return nil, err
		}
		out.CatalogItemsUpserted++
	}
	if _, err := tx.Exec(ctx, `
UPDATE commerce_catalogs
   SET last_sync_at = $3,
       error_message = NULL,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, catalog.ID, now.UTC()); err != nil {
		return nil, err
	}
	if err := insertCommerceLifecycleEvent(ctx, tx, tenantID, catalog.IntegrationID, "catalog_products_imported", "", "catalog_import:"+catalog.ID+":"+fmt.Sprint(now.UTC().UnixNano()), map[string]any{
		"catalog_id":             catalog.ID,
		"products_seen":          out.ProductsSeen,
		"products_upserted":      out.ProductsUpserted,
		"catalog_items_upserted": out.CatalogItemsUpserted,
		"products_skipped":       out.ProductsSkipped,
		"replace":                in.Replace,
	}); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListProductFeeds(ctx context.Context, tenantID, catalogID string, limit int, cursor pagination.Cursor) (*ProductFeedsPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureCatalog(ctx, tx, tenantID, catalogID); err != nil {
		return nil, err
	}
	args := []any{tenantID, catalogID, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (updated_at, id) < ($4::timestamptz, $5::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT `+productFeedColumns+`
  FROM commerce_product_feeds
 WHERE tenant_id = $1::uuid AND catalog_id::text = $2
 `+keyset+`
 ORDER BY updated_at DESC, id DESC
 LIMIT $3`, args...)
	if err != nil {
		return nil, err
	}
	items, err := scanProductFeeds(rows)
	if err != nil {
		return nil, err
	}
	items, more := pagination.HasMore(items, limit)
	next := ""
	if more {
		last := items[len(items)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.UpdatedAt, ID: last.ID})
	}
	return &ProductFeedsPage{Items: items, NextCursor: next}, tx.Commit(ctx)
}

func (r *Repo) UpsertProductFeed(ctx context.Context, tenantID, catalogID string, in ProductFeedInput) (*ProductFeed, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureCatalog(ctx, tx, tenantID, catalogID); err != nil {
		return nil, err
	}
	criteria, _ := json.Marshal(nonNilMap(in.Criteria))
	fallback, _ := json.Marshal(nonNilMap(in.Fallback))
	maxItems := in.MaxItems
	if maxItems <= 0 {
		maxItems = 3
	}
	excludeOutOfStock := true
	if in.ExcludeOutOfStock != nil {
		excludeOutOfStock = *in.ExcludeOutOfStock
	}
	row := tx.QueryRow(ctx, `
INSERT INTO commerce_product_feeds (
    tenant_id, catalog_id, name, feed_type, status, criteria, fallback,
    max_items, exclude_out_of_stock
)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
ON CONFLICT (tenant_id, name) DO UPDATE SET
  catalog_id = EXCLUDED.catalog_id,
  feed_type = EXCLUDED.feed_type,
  status = EXCLUDED.status,
  criteria = EXCLUDED.criteria,
  fallback = EXCLUDED.fallback,
  max_items = EXCLUDED.max_items,
  exclude_out_of_stock = EXCLUDED.exclude_out_of_stock,
  updated_at = now()
RETURNING `+productFeedColumns,
		tenantID, catalogID, in.Name, defaulted(in.FeedType, "manual"),
		defaulted(in.Status, "draft"), string(criteria), string(fallback),
		maxItems, excludeOutOfStock)
	feed, err := scanProductFeed(row)
	if err != nil {
		return nil, err
	}
	return feed, tx.Commit(ctx)
}

func (r *Repo) ResolveProductFeed(ctx context.Context, tenantID, catalogID, feedID string, in ProductFeedResolveInput) (*ResolvedProductFeed, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT `+productFeedColumns+`
  FROM commerce_product_feeds
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND ($3 = '' OR catalog_id::text = $3)
 LIMIT 1`, tenantID, feedID, strings.TrimSpace(catalogID))
	feed, err := scanProductFeed(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	limit := in.MaxItems
	if limit <= 0 {
		limit = feed.MaxItems
	}
	if limit <= 0 {
		limit = 3
	}
	if limit > 50 {
		limit = 50
	}
	excludeOutOfStock := feed.ExcludeOutOfStock
	if in.ExcludeOutOfStock != nil {
		excludeOutOfStock = *in.ExcludeOutOfStock
	}
	items, err := resolveExplicitProductFeedItems(ctx, tx, tenantID, feed.ID, excludeOutOfStock, limit)
	if err != nil {
		return nil, err
	}
	if len(items) < limit {
		fallback, err := resolveFallbackProductFeedItems(ctx, tx, tenantID, *feed, in, excludeOutOfStock, limit-len(items), len(items))
		if err != nil {
			return nil, err
		}
		items = append(items, fallback...)
	}
	out := &ResolvedProductFeed{
		FeedID:            feed.ID,
		CatalogID:         feed.CatalogID,
		FeedType:          feed.FeedType,
		SubscriberEmail:   strings.ToLower(strings.TrimSpace(in.SubscriberEmail)),
		ExcludeOutOfStock: excludeOutOfStock,
		Items:             items,
		PageInfo:          PageInfo{Total: len(items), Page: 1, PerPage: limit},
	}
	return out, tx.Commit(ctx)
}

func catalogImportProductInput(in CatalogProductImportProduct, defaultCurrency string) ProductInput {
	raw := nonNilMap(in.Raw)
	if len(in.Variants) > 0 {
		variants := make([]any, 0, len(in.Variants))
		for _, variant := range in.Variants {
			variants = append(variants, nonNilMap(variant))
		}
		raw["variants"] = variants
	}
	raw["source"] = "json_import"
	if strings.TrimSpace(in.Collection) != "" {
		raw["collection"] = strings.TrimSpace(in.Collection)
	}
	return ProductInput{
		SourceID:   strings.TrimSpace(in.SourceID),
		Title:      strings.TrimSpace(in.Title),
		URL:        strings.TrimSpace(in.URL),
		ImageURL:   strings.TrimSpace(in.ImageURL),
		PriceCents: in.PriceCents,
		Currency:   defaulted(strings.ToUpper(strings.TrimSpace(in.Currency)), defaultCurrency),
		Raw:        raw,
	}
}

func ensureCatalog(ctx context.Context, tx pgx.Tx, tenantID, catalogID string) error {
	var exists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM commerce_catalogs
   WHERE tenant_id = $1::uuid AND id::text = $2
)`, tenantID, catalogID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}

func getCatalog(ctx context.Context, tx pgx.Tx, tenantID, catalogID string) (*Catalog, error) {
	row := tx.QueryRow(ctx, `
SELECT `+catalogColumns+`
  FROM commerce_catalogs
 WHERE tenant_id = $1::uuid AND id::text = $2
 LIMIT 1`, tenantID, catalogID)
	catalog, err := scanCatalog(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return catalog, nil
}

func upsertCatalogItem(ctx context.Context, tx pgx.Tx, tenantID, catalogID, productID, collection string, position int, metadata map[string]any) error {
	if _, err := tx.Exec(ctx, `
DELETE FROM commerce_catalog_items
 WHERE tenant_id = $1::uuid
   AND catalog_id::text = $2
   AND product_id::text = $3`, tenantID, catalogID, productID); err != nil {
		return err
	}
	raw, _ := json.Marshal(nonNilMap(metadata))
	_, err := tx.Exec(ctx, `
INSERT INTO commerce_catalog_items (
    tenant_id, catalog_id, product_id, collection, position, metadata
)
VALUES ($1::uuid, $2::uuid, $3::uuid, NULLIF($4, ''), $5, $6::jsonb)`,
		tenantID, catalogID, productID, strings.TrimSpace(collection), position, string(raw))
	return err
}

func resolveExplicitProductFeedItems(ctx context.Context, tx pgx.Tx, tenantID, feedID string, excludeOutOfStock bool, limit int) ([]ResolvedProductFeedItem, error) {
	rows, err := tx.Query(ctx, `
SELECT
    p.id::text,
    COALESCE(v.id::text, ''),
    p.source_id,
    COALESCE(v.source_id, ''),
    COALESCE(NULLIF(v.title, ''), p.title),
    COALESCE(NULLIF(v.image_url, ''), p.image_url, ''),
    COALESCE(NULLIF(v.url, ''), p.url, ''),
    COALESCE(v.price_cents, p.price_cents),
    v.compare_at_price_cents,
    COALESCE(NULLIF(v.currency, ''), p.currency, 'USD'),
    COALESCE(v.available, true),
    COALESCE(NULLIF(fi.reason, ''), 'manual'),
    fi.rank,
    fi.metadata
  FROM commerce_product_feed_items fi
  JOIN commerce_products p
    ON p.tenant_id = fi.tenant_id AND p.id = fi.product_id
  LEFT JOIN commerce_product_variants v
    ON v.tenant_id = fi.tenant_id AND v.id = fi.variant_id
 WHERE fi.tenant_id = $1::uuid
   AND fi.feed_id::text = $2
   AND ($3::boolean = false OR COALESCE(v.available, true) = true)
 ORDER BY fi.rank ASC, fi.updated_at DESC
 LIMIT $4`, tenantID, feedID, excludeOutOfStock, limit)
	if err != nil {
		return nil, err
	}
	return scanResolvedProductFeedItems(rows, 0)
}

func resolveFallbackProductFeedItems(ctx context.Context, tx pgx.Tx, tenantID string, feed ProductFeed, in ProductFeedResolveInput, excludeOutOfStock bool, limit, rankOffset int) ([]ResolvedProductFeedItem, error) {
	if limit <= 0 {
		return []ResolvedProductFeedItem{}, nil
	}
	feedType := strings.ToLower(strings.TrimSpace(feed.FeedType))
	reason := "recent_product"
	extraWhere := ""
	orderBy := "p.updated_at DESC"
	switch feedType {
	case "back_in_stock":
		reason = "back_in_stock_available"
		extraWhere = "AND COALESCE(v.available, true) = true"
		orderBy = "COALESCE(v.updated_at, p.updated_at) DESC"
	case "price_drop":
		reason = "price_drop"
		extraWhere = `AND (
            (v.compare_at_price_cents IS NOT NULL AND v.compare_at_price_cents > v.price_cents)
            OR EXISTS (
                SELECT 1
                  FROM commerce_price_history ph
                 WHERE ph.tenant_id = p.tenant_id
                   AND ph.product_id = p.id
                   AND (v.id IS NULL OR ph.variant_id = v.id)
                   AND ph.observed_at > now() - INTERVAL '30 days'
                   AND ph.price_cents > COALESCE(v.price_cents, p.price_cents)
            )
        )`
		orderBy = "COALESCE(v.updated_at, p.updated_at) DESC"
	case "best_sellers":
		reason = "best_seller"
		orderBy = `(SELECT count(*)
                    FROM commerce_orders o
                   WHERE o.tenant_id = p.tenant_id
                     AND o.integration_id = p.integration_id
                     AND o.status <> 'pending'
                     AND o.line_items::text ILIKE '%' || p.source_id || '%') DESC, p.updated_at DESC`
	case "behavioral_recommendation":
		reason = "behavioral_recommendation"
	case "recently_viewed":
		reason = "recently_viewed"
	case "dynamic":
		reason = "dynamic"
	}
	if excludeOutOfStock {
		extraWhere += " AND COALESCE(v.available, true) = true"
	}
	// Personalise behavioural / dynamic feeds with the subscriber's own purchase
	// history: rank by popularity but drop products they've already bought, so
	// recommendations stay fresh — Klaviyo-style. The resolver previously ignored
	// the subscriber entirely (these feeds fell back to plain recency).
	email := strings.ToLower(strings.TrimSpace(in.SubscriberEmail))
	personalize := email != "" && (feedType == "behavioral_recommendation" || feedType == "dynamic")
	if personalize {
		reason = "personalized_recommendation"
		orderBy = `(SELECT count(*) FROM commerce_orders o
                     WHERE o.tenant_id = p.tenant_id AND o.integration_id = p.integration_id
                       AND o.status <> 'pending'
                       AND o.line_items::text ILIKE '%' || p.source_id || '%') DESC, p.updated_at DESC`
		extraWhere += ` AND NOT EXISTS (
            SELECT 1 FROM commerce_orders ob
             WHERE ob.tenant_id = p.tenant_id AND ob.integration_id = p.integration_id
               AND lower(ob.customer_email::text) = $8
               AND ob.line_items::text ILIKE '%' || p.source_id || '%')`
	}
	args := []any{tenantID, feed.CatalogID, feed.ID, excludeOutOfStock, reason, feedType, limit}
	if personalize {
		args = append(args, email)
	}
	query := fmt.Sprintf(`
SELECT
    p.id::text,
    COALESCE(v.id::text, ''),
    p.source_id,
    COALESCE(v.source_id, ''),
    COALESCE(NULLIF(v.title, ''), p.title),
    COALESCE(NULLIF(v.image_url, ''), p.image_url, ''),
    COALESCE(NULLIF(v.url, ''), p.url, ''),
    COALESCE(v.price_cents, p.price_cents),
    v.compare_at_price_cents,
    COALESCE(NULLIF(v.currency, ''), p.currency, 'USD'),
    COALESCE(v.available, true),
    $5,
    0,
    jsonb_build_object('source', 'feed_fallback', 'feed_type', $6)
  FROM commerce_products p
  LEFT JOIN LATERAL (
      SELECT *
        FROM commerce_product_variants candidate
       WHERE candidate.tenant_id = p.tenant_id
         AND candidate.integration_id = p.integration_id
         AND candidate.product_id = p.id
         AND ($4::boolean = false OR candidate.available = true)
       ORDER BY candidate.available DESC, candidate.updated_at DESC
       LIMIT 1
  ) v ON true
 WHERE p.tenant_id = $1::uuid
   AND ($2 = '' OR EXISTS (
       SELECT 1
         FROM commerce_catalog_items ci
        WHERE ci.tenant_id = p.tenant_id
          AND ci.catalog_id::text = $2
          AND ci.product_id = p.id
   ))
   AND NOT EXISTS (
       SELECT 1
         FROM commerce_product_feed_items fi
        WHERE fi.tenant_id = p.tenant_id
          AND fi.feed_id::text = $3
          AND fi.product_id = p.id
   )
   %s
 ORDER BY %s
 LIMIT $7`, extraWhere, orderBy)
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	return scanResolvedProductFeedItems(rows, rankOffset)
}

func scanResolvedProductFeedItems(rows pgx.Rows, rankOffset int) ([]ResolvedProductFeedItem, error) {
	defer rows.Close()
	out := []ResolvedProductFeedItem{}
	for rows.Next() {
		var item ResolvedProductFeedItem
		var compareAt sql.NullInt64
		var raw []byte
		if err := rows.Scan(&item.ProductID, &item.VariantID, &item.SourceID, &item.VariantSourceID, &item.Title, &item.ImageURL, &item.URL, &item.PriceCents, &compareAt, &item.Currency, &item.Available, &item.Reason, &item.Rank, &raw); err != nil {
			return nil, err
		}
		item.CompareAtPriceCents = nullIntPtr(compareAt)
		_ = json.Unmarshal(raw, &item.Metadata)
		if item.Metadata == nil {
			item.Metadata = map[string]any{}
		}
		if item.Rank <= 0 {
			item.Rank = rankOffset + len(out) + 1
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func scanCatalogs(rows pgx.Rows) ([]Catalog, error) {
	defer rows.Close()
	out := []Catalog{}
	for rows.Next() {
		item, err := scanCatalog(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func scanCatalog(row scanner) (*Catalog, error) {
	var item Catalog
	var raw []byte
	if err := row.Scan(&item.ID, &item.TenantID, &item.IntegrationID, &item.Name, &item.SourceType, &item.FeedURL, &item.Status, &item.Locale, &item.DefaultCurrency, &raw, &item.LastSyncAt, &item.ErrorMessage, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(raw, &item.Settings)
	if item.Settings == nil {
		item.Settings = map[string]any{}
	}
	return &item, nil
}

func scanProductFeeds(rows pgx.Rows) ([]ProductFeed, error) {
	defer rows.Close()
	out := []ProductFeed{}
	for rows.Next() {
		item, err := scanProductFeed(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func scanProductFeed(row scanner) (*ProductFeed, error) {
	var item ProductFeed
	var criteriaRaw, fallbackRaw []byte
	if err := row.Scan(&item.ID, &item.TenantID, &item.CatalogID, &item.Name, &item.FeedType, &item.Status, &criteriaRaw, &fallbackRaw, &item.MaxItems, &item.ExcludeOutOfStock, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(criteriaRaw, &item.Criteria)
	_ = json.Unmarshal(fallbackRaw, &item.Fallback)
	if item.Criteria == nil {
		item.Criteria = map[string]any{}
	}
	if item.Fallback == nil {
		item.Fallback = map[string]any{}
	}
	return &item, nil
}

const catalogColumns = `id::text, tenant_id::text, COALESCE(integration_id::text, ''), name, source_type, COALESCE(feed_url, ''), status, COALESCE(locale, ''), default_currency, settings, last_sync_at, COALESCE(error_message, ''), created_at, updated_at`

const productFeedColumns = `id::text, tenant_id::text, COALESCE(catalog_id::text, ''), name, feed_type, status, criteria, fallback, max_items, exclude_out_of_stock, created_at, updated_at`
