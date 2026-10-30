// SPDX-License-Identifier: AGPL-3.0-only
package commerce

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Per-provider backfill target discovery for the background sync workers.

func (r *Repo) ListShopifyBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]ShopifyBackfillTarget, error) {
	if limit <= 0 {
		limit = 25
	}
	if limit > 250 {
		limit = 250
	}
	if staleBefore.IsZero() {
		staleBefore = time.Now().UTC().Add(-time.Hour)
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text,
       id::text,
       COALESCE(sync_cursor, ''),
       last_sync_at,
       COALESCE(error_message, '')
  FROM commerce_integrations
 WHERE provider = $1
   AND status IN ('connected', 'error')
   AND COALESCE(sync_cursor, '') <> $2
   AND COALESCE(sync_cursor, '') NOT LIKE $5
   AND (
        last_sync_at IS NULL
        OR last_sync_at < $3
        OR status = 'error'
   )
   AND (
        access_token_envelope IS NOT NULL
        OR settings ? 'access_token'
        OR settings ? 'access_token_present'
   )
 ORDER BY
       CASE WHEN status = 'error' THEN 0 ELSE 1 END,
       last_sync_at NULLS FIRST,
       updated_at ASC
 LIMIT $4`, ProviderShopify, shopifyBackfillCursorComplete, staleBefore.UTC(), limit, shopifyBulkOperationCursorPrefix+"%")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ShopifyBackfillTarget{}
	for rows.Next() {
		var item ShopifyBackfillTarget
		if err := rows.Scan(&item.TenantID, &item.IntegrationID, &item.Cursor, &item.LastSyncAt, &item.ErrorMessage); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListShopifyBulkOperationTargets(ctx context.Context, limit int, staleBefore time.Time) ([]ShopifyBackfillTarget, error) {
	if limit <= 0 {
		limit = 25
	}
	if limit > 250 {
		limit = 250
	}
	if staleBefore.IsZero() {
		staleBefore = time.Now().UTC().Add(-time.Hour)
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text,
       id::text,
       COALESCE(sync_cursor, ''),
       last_sync_at,
       COALESCE(error_message, '')
  FROM commerce_integrations
 WHERE provider = $1
   AND status IN ('connected', 'error')
   AND COALESCE(sync_cursor, '') LIKE $2
   AND (
        last_sync_at IS NULL
        OR last_sync_at < $3
        OR status = 'error'
   )
   AND (
        access_token_envelope IS NOT NULL
        OR settings ? 'access_token'
        OR settings ? 'access_token_present'
   )
 ORDER BY
       CASE WHEN status = 'error' THEN 0 ELSE 1 END,
       last_sync_at NULLS FIRST,
       updated_at ASC
 LIMIT $4`, ProviderShopify, shopifyBulkOperationCursorPrefix+"%", staleBefore.UTC(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ShopifyBackfillTarget{}
	for rows.Next() {
		var item ShopifyBackfillTarget
		if err := rows.Scan(&item.TenantID, &item.IntegrationID, &item.Cursor, &item.LastSyncAt, &item.ErrorMessage); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListWooCommerceBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]WooCommerceBackfillTarget, error) {
	if limit <= 0 {
		limit = 25
	}
	if limit > 250 {
		limit = 250
	}
	if staleBefore.IsZero() {
		staleBefore = time.Now().UTC().Add(-time.Hour)
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text,
       id::text,
       COALESCE(sync_cursor, ''),
       last_sync_at,
       COALESCE(error_message, '')
  FROM commerce_integrations
 WHERE provider = $1
   AND status IN ('connected', 'error')
   AND COALESCE(sync_cursor, '') <> $2
   AND (
        last_sync_at IS NULL
        OR last_sync_at < $3
        OR status = 'error'
   )
   AND NULLIF(COALESCE(settings->>'credential_ref', settings->>'credentials_ref'), '') IS NOT NULL
 ORDER BY
       CASE WHEN status = 'error' THEN 0 ELSE 1 END,
       last_sync_at NULLS FIRST,
       updated_at ASC
 LIMIT $4`, ProviderWooCommerce, woocommerceCursorComplete, staleBefore.UTC(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WooCommerceBackfillTarget{}
	for rows.Next() {
		var item WooCommerceBackfillTarget
		if err := rows.Scan(&item.TenantID, &item.IntegrationID, &item.Cursor, &item.LastSyncAt, &item.ErrorMessage); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListBigCommerceBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]BigCommerceBackfillTarget, error) {
	if limit <= 0 {
		limit = 25
	}
	if limit > 250 {
		limit = 250
	}
	if staleBefore.IsZero() {
		staleBefore = time.Now().UTC().Add(-time.Hour)
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text,
       id::text,
       COALESCE(sync_cursor, ''),
       last_sync_at,
       COALESCE(error_message, '')
  FROM commerce_integrations
 WHERE provider = $1
   AND status IN ('connected', 'error')
   AND COALESCE(sync_cursor, '') <> $2
   AND (
        last_sync_at IS NULL
        OR last_sync_at < $3
        OR status = 'error'
   )
   AND NULLIF(COALESCE(settings->>'credential_ref', settings->>'credentials_ref'), '') IS NOT NULL
 ORDER BY
       CASE WHEN status = 'error' THEN 0 ELSE 1 END,
       last_sync_at NULLS FIRST,
       updated_at ASC
 LIMIT $4`, ProviderBigCommerce, bigCommerceCursorComplete, staleBefore.UTC(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BigCommerceBackfillTarget{}
	for rows.Next() {
		var item BigCommerceBackfillTarget
		if err := rows.Scan(&item.TenantID, &item.IntegrationID, &item.Cursor, &item.LastSyncAt, &item.ErrorMessage); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListStripeBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]StripeBackfillTarget, error) {
	if limit <= 0 {
		limit = 25
	}
	if limit > 250 {
		limit = 250
	}
	if staleBefore.IsZero() {
		staleBefore = time.Now().UTC().Add(-time.Hour)
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text,
       id::text,
       COALESCE(sync_cursor, ''),
       last_sync_at,
       COALESCE(error_message, '')
  FROM commerce_integrations
 WHERE provider = $1
   AND status IN ('connected', 'error')
   AND COALESCE(sync_cursor, '') <> $2
   AND (
        last_sync_at IS NULL
        OR last_sync_at < $3
        OR status = 'error'
   )
   AND NULLIF(COALESCE(settings->>'credential_ref', settings->>'credentials_ref'), '') IS NOT NULL
 ORDER BY
       CASE WHEN status = 'error' THEN 0 ELSE 1 END,
       last_sync_at NULLS FIRST,
       updated_at ASC
 LIMIT $4`, ProviderStripe, stripeCursorComplete, staleBefore.UTC(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []StripeBackfillTarget{}
	for rows.Next() {
		var item StripeBackfillTarget
		if err := rows.Scan(&item.TenantID, &item.IntegrationID, &item.Cursor, &item.LastSyncAt, &item.ErrorMessage); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListSquareBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]SquareBackfillTarget, error) {
	if limit <= 0 {
		limit = 25
	}
	if limit > 250 {
		limit = 250
	}
	if staleBefore.IsZero() {
		staleBefore = time.Now().UTC().Add(-time.Hour)
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text,
       id::text,
       COALESCE(sync_cursor, ''),
       last_sync_at,
       COALESCE(error_message, '')
  FROM commerce_integrations
 WHERE provider = $1
   AND status IN ('connected', 'error')
   AND COALESCE(sync_cursor, '') <> $2
   AND (
        last_sync_at IS NULL
        OR last_sync_at < $3
        OR status = 'error'
   )
   AND NULLIF(COALESCE(settings->>'credential_ref', settings->>'credentials_ref'), '') IS NOT NULL
 ORDER BY
       CASE WHEN status = 'error' THEN 0 ELSE 1 END,
       last_sync_at NULLS FIRST,
       updated_at ASC
 LIMIT $4`, ProviderSquare, squareCursorComplete, staleBefore.UTC(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SquareBackfillTarget{}
	for rows.Next() {
		var item SquareBackfillTarget
		if err := rows.Scan(&item.TenantID, &item.IntegrationID, &item.Cursor, &item.LastSyncAt, &item.ErrorMessage); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListRazorpayBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]RazorpayBackfillTarget, error) {
	if limit <= 0 {
		limit = 25
	}
	if limit > 250 {
		limit = 250
	}
	if staleBefore.IsZero() {
		staleBefore = time.Now().UTC().Add(-time.Hour)
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text,
       id::text,
       COALESCE(sync_cursor, ''),
       last_sync_at,
       COALESCE(error_message, '')
  FROM commerce_integrations
 WHERE provider = $1
   AND status IN ('connected', 'error')
   AND COALESCE(sync_cursor, '') <> $2
   AND (
        last_sync_at IS NULL
        OR last_sync_at < $3
        OR status = 'error'
   )
   AND NULLIF(COALESCE(settings->>'credential_ref', settings->>'credentials_ref'), '') IS NOT NULL
 ORDER BY
       CASE WHEN status = 'error' THEN 0 ELSE 1 END,
       last_sync_at NULLS FIRST,
       updated_at ASC
 LIMIT $4`, ProviderRazorpay, razorpayCursorComplete, staleBefore.UTC(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RazorpayBackfillTarget{}
	for rows.Next() {
		var item RazorpayBackfillTarget
		if err := rows.Scan(&item.TenantID, &item.IntegrationID, &item.Cursor, &item.LastSyncAt, &item.ErrorMessage); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListPayPalBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]PayPalBackfillTarget, error) {
	if limit <= 0 {
		limit = 25
	}
	if limit > 250 {
		limit = 250
	}
	if staleBefore.IsZero() {
		staleBefore = time.Now().UTC().Add(-time.Hour)
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text,
       id::text,
       COALESCE(sync_cursor, ''),
       last_sync_at,
       COALESCE(error_message, '')
  FROM commerce_integrations
 WHERE provider = $1
   AND status IN ('connected', 'error')
   AND COALESCE(sync_cursor, '') <> $2
   AND (
        last_sync_at IS NULL
        OR last_sync_at < $3
        OR status = 'error'
   )
   AND NULLIF(COALESCE(settings->>'credential_ref', settings->>'credentials_ref'), '') IS NOT NULL
 ORDER BY
       CASE WHEN status = 'error' THEN 0 ELSE 1 END,
       last_sync_at NULLS FIRST,
       updated_at ASC
 LIMIT $4`, ProviderPayPal, payPalCursorComplete, staleBefore.UTC(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PayPalBackfillTarget{}
	for rows.Next() {
		var item PayPalBackfillTarget
		if err := rows.Scan(&item.TenantID, &item.IntegrationID, &item.Cursor, &item.LastSyncAt, &item.ErrorMessage); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListAdobeCommerceBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]AdobeCommerceBackfillTarget, error) {
	if limit <= 0 {
		limit = 25
	}
	if limit > 250 {
		limit = 250
	}
	if staleBefore.IsZero() {
		staleBefore = time.Now().UTC().Add(-time.Hour)
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text,
       id::text,
       COALESCE(sync_cursor, ''),
       last_sync_at,
       COALESCE(error_message, '')
  FROM commerce_integrations
 WHERE provider = $1
   AND status IN ('connected', 'error')
   AND COALESCE(sync_cursor, '') <> $2
   AND (
        last_sync_at IS NULL
        OR last_sync_at < $3
        OR status = 'error'
   )
   AND NULLIF(COALESCE(settings->>'credential_ref', settings->>'credentials_ref'), '') IS NOT NULL
 ORDER BY
       CASE WHEN status = 'error' THEN 0 ELSE 1 END,
       last_sync_at NULLS FIRST,
       updated_at ASC
 LIMIT $4`, ProviderAdobeCommerce, adobeCommerceCursorComplete, staleBefore.UTC(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AdobeCommerceBackfillTarget{}
	for rows.Next() {
		var item AdobeCommerceBackfillTarget
		if err := rows.Scan(&item.TenantID, &item.IntegrationID, &item.Cursor, &item.LastSyncAt, &item.ErrorMessage); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListWixStoresBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]WixStoresBackfillTarget, error) {
	if limit <= 0 {
		limit = 25
	}
	if limit > 250 {
		limit = 250
	}
	if staleBefore.IsZero() {
		staleBefore = time.Now().UTC().Add(-time.Hour)
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text,
       id::text,
       COALESCE(sync_cursor, ''),
       last_sync_at,
       COALESCE(error_message, '')
  FROM commerce_integrations
 WHERE provider = $1
   AND status IN ('connected', 'error')
   AND COALESCE(sync_cursor, '') <> $2
   AND (
        last_sync_at IS NULL
        OR last_sync_at < $3
        OR status = 'error'
   )
   AND NULLIF(COALESCE(settings->>'credential_ref', settings->>'credentials_ref'), '') IS NOT NULL
 ORDER BY
       CASE WHEN status = 'error' THEN 0 ELSE 1 END,
       last_sync_at NULLS FIRST,
       updated_at ASC
 LIMIT $4`, ProviderWixStores, wixStoresCursorComplete, staleBefore.UTC(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WixStoresBackfillTarget{}
	for rows.Next() {
		var item WixStoresBackfillTarget
		if err := rows.Scan(&item.TenantID, &item.IntegrationID, &item.Cursor, &item.LastSyncAt, &item.ErrorMessage); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListSquarespaceBackfillTargets(ctx context.Context, limit int, staleBefore time.Time) ([]SquarespaceBackfillTarget, error) {
	if limit <= 0 {
		limit = 25
	}
	if limit > 250 {
		limit = 250
	}
	if staleBefore.IsZero() {
		staleBefore = time.Now().UTC().Add(-time.Hour)
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT tenant_id::text,
       id::text,
       COALESCE(sync_cursor, ''),
       last_sync_at,
       COALESCE(error_message, '')
  FROM commerce_integrations
 WHERE provider = $1
   AND status IN ('connected', 'error')
   AND COALESCE(sync_cursor, '') <> $2
   AND (
        last_sync_at IS NULL
        OR last_sync_at < $3
        OR status = 'error'
   )
   AND NULLIF(COALESCE(settings->>'credential_ref', settings->>'credentials_ref'), '') IS NOT NULL
 ORDER BY
       CASE WHEN status = 'error' THEN 0 ELSE 1 END,
       last_sync_at NULLS FIRST,
       updated_at ASC
 LIMIT $4`, ProviderSquarespace, squarespaceCursorComplete, staleBefore.UTC(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SquarespaceBackfillTarget{}
	for rows.Next() {
		var item SquarespaceBackfillTarget
		if err := rows.Scan(&item.TenantID, &item.IntegrationID, &item.Cursor, &item.LastSyncAt, &item.ErrorMessage); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}
