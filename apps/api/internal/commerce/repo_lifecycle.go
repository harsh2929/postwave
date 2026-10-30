// SPDX-License-Identifier: AGPL-3.0-only
package commerce

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// Commerce lifecycle persistence: cart recovery links, back-in-stock
// subscriptions, price-drop watchers, lifecycle trigger evaluation and
// reporting.

func (r *Repo) ListCartRecoveryLinks(ctx context.Context, tenantID, integrationID, status string, limit int, cursor pagination.Cursor) (*CartRecoveryLinksPage, error) {
	status = strings.ToLower(strings.TrimSpace(status))
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureIntegration(ctx, tx, tenantID, integrationID); err != nil {
		return nil, err
	}
	args := []any{tenantID, integrationID, status, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (updated_at, id) < ($5::timestamptz, $6::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT `+cartRecoveryLinkColumns+`
  FROM commerce_cart_recovery_links
 WHERE tenant_id = $1::uuid AND integration_id::text = $2
   AND ($3 = '' OR status = $3)
 `+keyset+`
 ORDER BY updated_at DESC, id DESC
 LIMIT $4`, args...)
	if err != nil {
		return nil, err
	}
	items, err := scanCartRecoveryLinks(rows)
	if err != nil {
		return nil, err
	}
	items, more := pagination.HasMore(items, limit)
	next := ""
	if more {
		last := items[len(items)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.UpdatedAt, ID: last.ID})
	}
	return &CartRecoveryLinksPage{Items: items, NextCursor: next}, tx.Commit(ctx)
}

func (r *Repo) UpsertCartRecoveryLink(ctx context.Context, tenantID, integrationID string, in CartRecoveryLinkInput) (*CartRecoveryLink, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureConnectedIntegration(ctx, tx, tenantID, integrationID); err != nil {
		return nil, err
	}
	orderID := ""
	if strings.TrimSpace(in.CartOrderID) != "" {
		orderID, err = ensureOrder(ctx, tx, tenantID, integrationID, in.CartOrderID)
		if err != nil {
			return nil, err
		}
	}
	metadata, _ := json.Marshal(nonNilMap(in.Metadata))
	row := tx.QueryRow(ctx, `
INSERT INTO commerce_cart_recovery_links (
    tenant_id, integration_id, cart_order_id, source_cart_id, customer_email,
    recovery_url, status, expires_at, metadata
)
VALUES ($1::uuid, $2::uuid, NULLIF($3, '')::uuid, $4, NULLIF($5, ''), $6, $7, $8, $9::jsonb)
ON CONFLICT (tenant_id, integration_id, source_cart_id) DO UPDATE SET
  cart_order_id = EXCLUDED.cart_order_id,
  customer_email = EXCLUDED.customer_email,
  recovery_url = EXCLUDED.recovery_url,
  status = EXCLUDED.status,
  expires_at = EXCLUDED.expires_at,
  metadata = EXCLUDED.metadata,
  updated_at = now()
RETURNING `+cartRecoveryLinkColumns,
		tenantID, integrationID, orderID, strings.TrimSpace(in.SourceCartID),
		strings.ToLower(strings.TrimSpace(in.CustomerEmail)), strings.TrimSpace(in.RecoveryURL),
		defaulted(strings.ToLower(strings.TrimSpace(in.Status)), "active"), in.ExpiresAt,
		string(metadata))
	link, err := scanCartRecoveryLink(row)
	if err != nil {
		return nil, err
	}
	if err := insertCommerceLifecycleEvent(ctx, tx, tenantID, integrationID, "cart_recovery_link_created", link.CustomerEmail, "cart_recovery:"+link.SourceCartID, map[string]any{
		"recovery_link_id": link.ID,
		"source_cart_id":   link.SourceCartID,
		"cart_order_id":    link.CartOrderID,
		"status":           link.Status,
	}); err != nil {
		return nil, err
	}
	return link, tx.Commit(ctx)
}

func (r *Repo) ListBackInStockSubscriptions(ctx context.Context, tenantID, integrationID, status string, limit int, cursor pagination.Cursor) (*BackInStockSubscriptionsPage, error) {
	status = strings.ToLower(strings.TrimSpace(status))
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureIntegration(ctx, tx, tenantID, integrationID); err != nil {
		return nil, err
	}
	args := []any{tenantID, integrationID, status, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (requested_at, id) < ($5::timestamptz, $6::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT `+backInStockSubscriptionColumns+`
  FROM back_in_stock_subscriptions
 WHERE tenant_id = $1::uuid AND integration_id::text = $2
   AND ($3 = '' OR status = $3)
 `+keyset+`
 ORDER BY requested_at DESC, id DESC
 LIMIT $4`, args...)
	if err != nil {
		return nil, err
	}
	items, err := scanBackInStockSubscriptions(rows)
	if err != nil {
		return nil, err
	}
	items, more := pagination.HasMore(items, limit)
	next := ""
	if more {
		last := items[len(items)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.RequestedAt, ID: last.ID})
	}
	return &BackInStockSubscriptionsPage{Items: items, NextCursor: next}, tx.Commit(ctx)
}

func (r *Repo) CreateBackInStockSubscription(ctx context.Context, tenantID, integrationID, productID string, in BackInStockSubscriptionInput) (*BackInStockSubscription, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureConnectedIntegration(ctx, tx, tenantID, integrationID); err != nil {
		return nil, err
	}
	resolvedProductID, err := ensureProduct(ctx, tx, tenantID, integrationID, productID)
	if err != nil {
		return nil, err
	}
	variantID, err := ensureVariant(ctx, tx, tenantID, integrationID, resolvedProductID, in.VariantID)
	if err != nil {
		return nil, err
	}
	metadata, _ := json.Marshal(nonNilMap(in.Metadata))
	row := tx.QueryRow(ctx, `
INSERT INTO back_in_stock_subscriptions (
    tenant_id, integration_id, product_id, variant_id, subscriber_id,
    subscriber_email, expires_at, metadata
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, NULLIF($4, '')::uuid, NULLIF($5, '')::uuid,
    NULLIF($6, ''), $7, $8::jsonb
)
ON CONFLICT (tenant_id, integration_id, product_id,
             COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
             subscriber_email)
    WHERE subscriber_email IS NOT NULL AND status IN ('waiting', 'eligible')
DO UPDATE SET updated_at = now()
RETURNING `+backInStockSubscriptionColumns,
		tenantID, integrationID, resolvedProductID, variantID,
		strings.TrimSpace(in.SubscriberID), strings.ToLower(strings.TrimSpace(in.SubscriberEmail)),
		in.ExpiresAt, string(metadata))
	item, err := scanBackInStockSubscription(row)
	if err != nil {
		return nil, err
	}
	if err := insertCommerceLifecycleEvent(ctx, tx, tenantID, integrationID, "back_in_stock_requested", item.SubscriberEmail, "back_in_stock_request:"+item.ID, map[string]any{
		"subscription_id": item.ID,
		"product_id":      item.ProductID,
		"variant_id":      item.VariantID,
		"status":          item.Status,
	}); err != nil {
		return nil, err
	}
	return item, tx.Commit(ctx)
}

func (r *Repo) ListPriceDropWatchers(ctx context.Context, tenantID, integrationID, status string, limit int, cursor pagination.Cursor) (*PriceDropWatchersPage, error) {
	status = strings.ToLower(strings.TrimSpace(status))
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureIntegration(ctx, tx, tenantID, integrationID); err != nil {
		return nil, err
	}
	args := []any{tenantID, integrationID, status, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (watched_at, id) < ($5::timestamptz, $6::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT `+priceDropWatcherColumns+`
  FROM price_drop_watchers
 WHERE tenant_id = $1::uuid AND integration_id::text = $2
   AND ($3 = '' OR status = $3)
 `+keyset+`
 ORDER BY watched_at DESC, id DESC
 LIMIT $4`, args...)
	if err != nil {
		return nil, err
	}
	items, err := scanPriceDropWatchers(rows)
	if err != nil {
		return nil, err
	}
	items, more := pagination.HasMore(items, limit)
	next := ""
	if more {
		last := items[len(items)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.WatchedAt, ID: last.ID})
	}
	return &PriceDropWatchersPage{Items: items, NextCursor: next}, tx.Commit(ctx)
}

func (r *Repo) CreatePriceDropWatcher(ctx context.Context, tenantID, integrationID, productID string, in PriceDropWatcherInput) (*PriceDropWatcher, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureConnectedIntegration(ctx, tx, tenantID, integrationID); err != nil {
		return nil, err
	}
	resolvedProductID, err := ensureProduct(ctx, tx, tenantID, integrationID, productID)
	if err != nil {
		return nil, err
	}
	variantID, err := ensureVariant(ctx, tx, tenantID, integrationID, resolvedProductID, in.VariantID)
	if err != nil {
		return nil, err
	}
	currentPrice, currentCurrency, err := currentProductPrice(ctx, tx, tenantID, integrationID, resolvedProductID, variantID)
	if err != nil {
		return nil, err
	}
	originalPrice := in.OriginalPriceCents
	if originalPrice <= 0 {
		originalPrice = currentPrice
	}
	currency := strings.ToUpper(strings.TrimSpace(in.Currency))
	if currency == "" {
		currency = currentCurrency
	}
	metadata, _ := json.Marshal(nonNilMap(in.Metadata))
	row := tx.QueryRow(ctx, `
INSERT INTO price_drop_watchers (
    tenant_id, integration_id, product_id, variant_id, subscriber_id,
    subscriber_email, original_price_cents, target_price_cents,
    min_drop_percent, currency, expires_at, metadata
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, NULLIF($4, '')::uuid, NULLIF($5, '')::uuid,
    NULLIF($6, ''), $7, $8, $9, $10, $11, $12::jsonb
)
RETURNING `+priceDropWatcherColumns,
		tenantID, integrationID, resolvedProductID, variantID,
		strings.TrimSpace(in.SubscriberID), strings.ToLower(strings.TrimSpace(in.SubscriberEmail)),
		originalPrice, nullableIntFromPtr(in.TargetPriceCents), nullableIntFromPtr(in.MinDropPercent),
		defaulted(currency, "USD"), in.ExpiresAt, string(metadata))
	item, err := scanPriceDropWatcher(row)
	if err != nil {
		return nil, err
	}
	if err := insertCommerceLifecycleEvent(ctx, tx, tenantID, integrationID, "price_drop_watcher_created", item.SubscriberEmail, "price_drop_watcher:"+item.ID, map[string]any{
		"watcher_id":           item.ID,
		"product_id":           item.ProductID,
		"variant_id":           item.VariantID,
		"original_price_cents": item.OriginalPriceCents,
		"target_price_cents":   item.TargetPriceCents,
		"min_drop_percent":     item.MinDropPercent,
		"currency":             item.Currency,
	}); err != nil {
		return nil, err
	}
	return item, tx.Commit(ctx)
}

func (r *Repo) EvaluateLifecycleTriggers(ctx context.Context, tenantID, integrationID string, now time.Time) (*CommerceLifecycleEvaluationSummary, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureConnectedIntegration(ctx, tx, tenantID, integrationID); err != nil {
		return nil, err
	}
	backInStock, err := markBackInStockEligible(ctx, tx, tenantID, integrationID, now)
	if err != nil {
		return nil, err
	}
	priceDrop, err := markPriceDropEligible(ctx, tx, tenantID, integrationID, now)
	if err != nil {
		return nil, err
	}
	out := &CommerceLifecycleEvaluationSummary{
		BackInStockEligible: backInStock,
		PriceDropEligible:   priceDrop,
		EvaluatedAt:         now.UTC(),
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) LifecycleReport(ctx context.Context, tenantID, integrationID string, now time.Time) (*CommerceLifecycleReport, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureIntegration(ctx, tx, tenantID, integrationID); err != nil {
		return nil, err
	}
	out := &CommerceLifecycleReport{
		IntegrationID:    integrationID,
		GeneratedAt:      now.UTC(),
		CartRecovery:     LifecycleStats{ByStatus: map[string]int{}},
		BackInStock:      LifecycleStats{ByStatus: map[string]int{}},
		PriceDrop:        LifecycleStats{ByStatus: map[string]int{}},
		EventsLast30Days: map[string]int{},
	}
	if err := scanLifecycleStats(ctx, tx, `
SELECT status, count(*)
  FROM commerce_cart_recovery_links
 WHERE tenant_id = $1::uuid AND integration_id::text = $2
 GROUP BY status`, tenantID, integrationID, &out.CartRecovery); err != nil {
		return nil, err
	}
	if err := scanLifecycleStats(ctx, tx, `
SELECT status, count(*)
  FROM back_in_stock_subscriptions
 WHERE tenant_id = $1::uuid AND integration_id::text = $2
 GROUP BY status`, tenantID, integrationID, &out.BackInStock); err != nil {
		return nil, err
	}
	if err := scanLifecycleStats(ctx, tx, `
SELECT status, count(*)
  FROM price_drop_watchers
 WHERE tenant_id = $1::uuid AND integration_id::text = $2
 GROUP BY status`, tenantID, integrationID, &out.PriceDrop); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT event_type, count(*)
  FROM commerce_events
 WHERE tenant_id = $1::uuid
   AND integration_id::text = $2
   AND provider_topic = 'commerce_lifecycle'
   AND at >= $3
 GROUP BY event_type`, tenantID, integrationID, now.UTC().Add(-30*24*time.Hour))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var eventType string
		var count int
		if err := rows.Scan(&eventType, &count); err != nil {
			return nil, err
		}
		out.EventsLast30Days[eventType] = count
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out.EligibleLast30Days = out.EventsLast30Days["back_in_stock_eligible"] + out.EventsLast30Days["price_drop_eligible"]
	out.NotifiedPending = out.BackInStock.ByStatus["eligible"] + out.PriceDrop.ByStatus["eligible"]
	return out, tx.Commit(ctx)
}

func (r *Repo) ListLifecycleEvaluationTargets(ctx context.Context, limit int) ([]LifecycleEvaluationTarget, error) {
	if limit <= 0 {
		limit = 500
	}
	if limit > 2000 {
		limit = 2000
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}
	// SELECT DISTINCT may only ORDER BY what it selects. The select list holds
	// the ::text casts, so ordering by the uuid columns is SQLSTATE 42P10 and
	// failed every tick; order by the selected expressions instead.
	rows, err := tx.Query(ctx, `
SELECT DISTINCT targets.tenant_id::text, targets.integration_id::text
  FROM (
        SELECT tenant_id, integration_id
          FROM back_in_stock_subscriptions
         WHERE status = 'waiting'
           AND (expires_at IS NULL OR expires_at > now())
        UNION ALL
        SELECT tenant_id, integration_id
          FROM price_drop_watchers
         WHERE status = 'watching'
           AND (expires_at IS NULL OR expires_at > now())
  ) targets
  JOIN commerce_integrations ci
    ON ci.tenant_id = targets.tenant_id
   AND ci.id = targets.integration_id
   AND ci.status <> 'disconnected'
 ORDER BY 1, 2
 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LifecycleEvaluationTarget{}
	for rows.Next() {
		var item LifecycleEvaluationTarget
		if err := rows.Scan(&item.TenantID, &item.IntegrationID); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func insertCommerceLifecycleEvent(ctx context.Context, tx pgx.Tx, tenantID, integrationID, eventType, customerEmail, providerEventID string, metadata map[string]any) error {
	raw, _ := json.Marshal(nonNilMap(metadata))
	_, err := tx.Exec(ctx, `
INSERT INTO commerce_events (
    tenant_id, integration_id, event_type, customer_email, metadata,
    provider_event_id, provider_topic
)
VALUES ($1::uuid, $2::uuid, $3, NULLIF($4, ''), $5::jsonb, NULLIF($6, ''), 'commerce_lifecycle')
ON CONFLICT (tenant_id, integration_id, provider_event_id)
WHERE provider_event_id IS NOT NULL
DO NOTHING`,
		tenantID, integrationID, eventType, strings.ToLower(strings.TrimSpace(customerEmail)),
		string(raw), providerEventID)
	return err
}

func markBackInStockEligible(ctx context.Context, tx pgx.Tx, tenantID, integrationID string, now time.Time) (int, error) {
	var count int
	err := tx.QueryRow(ctx, `
WITH eligible AS (
    SELECT
        s.id,
        COALESCE(s.subscriber_email::text, sub.email::text, '') AS customer_email
      FROM back_in_stock_subscriptions s
      LEFT JOIN subscribers sub ON sub.tenant_id = s.tenant_id AND sub.id = s.subscriber_id
     WHERE s.tenant_id = $1::uuid
       AND s.integration_id::text = $2
       AND s.status = 'waiting'
       AND (s.expires_at IS NULL OR s.expires_at > $3)
       AND EXISTS (
           SELECT 1
             FROM commerce_product_variants v
            WHERE v.tenant_id = s.tenant_id
              AND v.integration_id = s.integration_id
              AND v.product_id = s.product_id
              AND v.available = true
              AND (s.variant_id IS NULL OR v.id = s.variant_id)
       )
),
updated AS (
    UPDATE back_in_stock_subscriptions s
       SET status = 'eligible',
           eligible_at = COALESCE(s.eligible_at, $3),
           updated_at = now()
      FROM eligible e
     WHERE s.id = e.id
 RETURNING s.id::text, s.product_id::text, COALESCE(s.variant_id::text, '') AS variant_id, e.customer_email
),
inserted AS (
    INSERT INTO commerce_events (
        tenant_id, integration_id, event_type, customer_email, metadata,
        provider_event_id, provider_topic
    )
    SELECT
        $1::uuid,
        $2::uuid,
        'back_in_stock_eligible',
        NULLIF(customer_email, ''),
        jsonb_build_object(
            'subscription_id', id,
            'product_id', product_id,
            'variant_id', NULLIF(variant_id, '')
        ),
        'back_in_stock_eligible:' || id,
        'commerce_lifecycle'
      FROM updated
    ON CONFLICT (tenant_id, integration_id, provider_event_id)
    WHERE provider_event_id IS NOT NULL
    DO NOTHING
    RETURNING id
)
SELECT count(*) FROM updated`, tenantID, integrationID, now.UTC()).Scan(&count)
	return count, err
}

func markPriceDropEligible(ctx context.Context, tx pgx.Tx, tenantID, integrationID string, now time.Time) (int, error) {
	var count int
	err := tx.QueryRow(ctx, `
WITH candidates AS (
    SELECT
        w.id,
        w.product_id,
        w.variant_id,
        COALESCE(w.subscriber_email::text, sub.email::text, '') AS customer_email,
        w.original_price_cents,
        w.target_price_cents,
        w.min_drop_percent,
        w.currency,
        COALESCE(v.price_cents, p.price_cents) AS current_price_cents,
        COALESCE(NULLIF(v.currency, ''), p.currency, w.currency) AS current_currency
      FROM price_drop_watchers w
      JOIN commerce_products p ON p.tenant_id = w.tenant_id AND p.id = w.product_id
      LEFT JOIN commerce_product_variants v ON v.tenant_id = w.tenant_id AND v.id = w.variant_id
      LEFT JOIN subscribers sub ON sub.tenant_id = w.tenant_id AND sub.id = w.subscriber_id
     WHERE w.tenant_id = $1::uuid
       AND w.integration_id::text = $2
       AND w.status = 'watching'
       AND (w.expires_at IS NULL OR w.expires_at > $3)
),
eligible AS (
    SELECT *
      FROM candidates
     WHERE lower(current_currency) = lower(currency)
       AND (
           (target_price_cents IS NOT NULL AND current_price_cents <= target_price_cents)
           OR (
               min_drop_percent IS NOT NULL
               AND current_price_cents <= ((original_price_cents * (100 - min_drop_percent)) / 100)
           )
       )
),
updated AS (
    UPDATE price_drop_watchers w
       SET status = 'eligible',
           eligible_at = COALESCE(w.eligible_at, $3),
           updated_at = now()
      FROM eligible e
     WHERE w.id = e.id
 RETURNING
        w.id::text,
        w.product_id::text,
        COALESCE(w.variant_id::text, '') AS variant_id,
        e.customer_email,
        e.current_price_cents,
        w.original_price_cents,
        w.target_price_cents,
        w.min_drop_percent,
        w.currency
),
inserted AS (
    INSERT INTO commerce_events (
        tenant_id, integration_id, event_type, customer_email, metadata,
        provider_event_id, provider_topic
    )
    SELECT
        $1::uuid,
        $2::uuid,
        'price_drop_eligible',
        NULLIF(customer_email, ''),
        jsonb_build_object(
            'watcher_id', id,
            'product_id', product_id,
            'variant_id', NULLIF(variant_id, ''),
            'current_price_cents', current_price_cents,
            'original_price_cents', original_price_cents,
            'target_price_cents', target_price_cents,
            'min_drop_percent', min_drop_percent,
            'currency', currency
        ),
        'price_drop_eligible:' || id,
        'commerce_lifecycle'
      FROM updated
    ON CONFLICT (tenant_id, integration_id, provider_event_id)
    WHERE provider_event_id IS NOT NULL
    DO NOTHING
    RETURNING id
)
SELECT count(*) FROM updated`, tenantID, integrationID, now.UTC()).Scan(&count)
	return count, err
}

func scanLifecycleStats(ctx context.Context, tx pgx.Tx, query, tenantID, integrationID string, out *LifecycleStats) error {
	rows, err := tx.Query(ctx, query, tenantID, integrationID)
	if err != nil {
		return err
	}
	defer rows.Close()
	if out.ByStatus == nil {
		out.ByStatus = map[string]int{}
	}
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return err
		}
		out.ByStatus[status] = count
		out.Total += count
	}
	return rows.Err()
}

func scanCartRecoveryLinks(rows pgx.Rows) ([]CartRecoveryLink, error) {
	defer rows.Close()
	out := []CartRecoveryLink{}
	for rows.Next() {
		item, err := scanCartRecoveryLink(rows)
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

func scanCartRecoveryLink(row scanner) (*CartRecoveryLink, error) {
	var item CartRecoveryLink
	var raw []byte
	if err := row.Scan(&item.ID, &item.TenantID, &item.IntegrationID, &item.CartOrderID, &item.SourceCartID, &item.CustomerEmail, &item.RecoveryURL, &item.Status, &item.ExpiresAt, &raw, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(raw, &item.Metadata)
	if item.Metadata == nil {
		item.Metadata = map[string]any{}
	}
	return &item, nil
}

func scanBackInStockSubscriptions(rows pgx.Rows) ([]BackInStockSubscription, error) {
	defer rows.Close()
	out := []BackInStockSubscription{}
	for rows.Next() {
		item, err := scanBackInStockSubscription(rows)
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

func scanBackInStockSubscription(row scanner) (*BackInStockSubscription, error) {
	var item BackInStockSubscription
	var raw []byte
	if err := row.Scan(&item.ID, &item.TenantID, &item.IntegrationID, &item.ProductID, &item.VariantID, &item.SubscriberID, &item.SubscriberEmail, &item.Status, &item.RequestedAt, &item.EligibleAt, &item.NotifiedAt, &item.ExpiresAt, &raw, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(raw, &item.Metadata)
	if item.Metadata == nil {
		item.Metadata = map[string]any{}
	}
	return &item, nil
}

func scanPriceDropWatchers(rows pgx.Rows) ([]PriceDropWatcher, error) {
	defer rows.Close()
	out := []PriceDropWatcher{}
	for rows.Next() {
		item, err := scanPriceDropWatcher(rows)
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

func scanPriceDropWatcher(row scanner) (*PriceDropWatcher, error) {
	var item PriceDropWatcher
	var raw []byte
	var targetPrice, minDrop sql.NullInt64
	if err := row.Scan(&item.ID, &item.TenantID, &item.IntegrationID, &item.ProductID, &item.VariantID, &item.SubscriberID, &item.SubscriberEmail, &item.OriginalPriceCents, &targetPrice, &minDrop, &item.Currency, &item.Status, &item.WatchedAt, &item.EligibleAt, &item.NotifiedAt, &item.ExpiresAt, &raw, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(raw, &item.Metadata)
	item.TargetPriceCents = nullIntPtr(targetPrice)
	item.MinDropPercent = nullIntPtr(minDrop)
	if item.Metadata == nil {
		item.Metadata = map[string]any{}
	}
	return &item, nil
}

const cartRecoveryLinkColumns = `id::text, tenant_id::text, integration_id::text, COALESCE(cart_order_id::text, ''), source_cart_id, COALESCE(customer_email::text, ''), recovery_url, status, expires_at, metadata, created_at, updated_at`

const backInStockSubscriptionColumns = `id::text, tenant_id::text, integration_id::text, product_id::text, COALESCE(variant_id::text, ''), COALESCE(subscriber_id::text, ''), COALESCE(subscriber_email::text, ''), status, requested_at, eligible_at, notified_at, expires_at, metadata, created_at, updated_at`

const priceDropWatcherColumns = `id::text, tenant_id::text, integration_id::text, product_id::text, COALESCE(variant_id::text, ''), COALESCE(subscriber_id::text, ''), COALESCE(subscriber_email::text, ''), original_price_cents, target_price_cents, min_drop_percent, currency, status, watched_at, eligible_at, notified_at, expires_at, metadata, created_at, updated_at`
