package commerce

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

var (
	ErrNotFound                   = errors.New("commerce resource not found")
	ErrCatalogRequiresIntegration = errors.New("commerce catalog import requires integration")
	ErrSyncPayloadRequired        = errors.New("commerce sync requires canonical payload rows")
)

type Repo struct {
	Pool *db.Pool
	// Cipher envelope-encrypts provider-owned install secrets such as
	// Shopify OAuth access tokens and webhook signing secrets. nil keeps
	// legacy plaintext settings readable for local tests/dev only.
	Cipher    EnvelopeCipher
	LegacyKEK []byte
	// CatalogBackfill, when set, is invoked (non-blocking) after every
	// commerce-event ingest that can carry an attributable customer email
	// (Sync / UpsertCustomer / UpsertOrder) so SUB-013 catalog-linked
	// profile attributes (favorite_category / last_viewed_sku) are
	// recomputed onto subscriber_computed_traits as events arrive — turning
	// BackfillCatalogAttributes from dead code into a live listener. nil in
	// tests / when the feature is disabled; the trigger is then a no-op.
	// See catalog_backfill_listener.go.
	CatalogBackfill *CatalogBackfillListener
	// CadenceBackfill, when set, is invoked (non-blocking) after every
	// order-ingest that can carry an attributable customer email
	// (Sync / UpsertOrder) so the SUB-061 / SUB-062 replenishment-cadence
	// traits (average_days_between_orders / last_order_at /
	// expected_next_order_at) are recomputed onto subscriber_computed_traits
	// as orders arrive. nil in tests / when the feature is disabled; the
	// trigger is then a no-op. See replenishment_cadence_listener.go.
	CadenceBackfill *CadenceBackfillListener
}

type EnvelopeCipher interface {
	Encrypt(ctx context.Context, plaintext []byte) ([]byte, error)
	Decrypt(ctx context.Context, blob, legacyKEK []byte) ([]byte, error)
}

func (r *Repo) ListIntegrations(ctx context.Context, tenantID string) ([]Integration, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, integrationSelectSQL+`
	WHERE tenant_id = $1::uuid
	  AND status <> 'disconnected'
	ORDER BY updated_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Integration{}
	for rows.Next() {
		i, err := r.scanIntegration(ctx, rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *i)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) GetIntegration(ctx context.Context, tenantID, id string) (*Integration, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, integrationSelectSQL+`
	WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	i, err := r.scanIntegration(ctx, row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return i, tx.Commit(ctx)
}

func (r *Repo) SetIntegrationStatus(ctx context.Context, tenantID, id, status string) (*Integration, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE commerce_integrations
   SET status = $3,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND status <> 'disconnected'
RETURNING `+integrationColumns, tenantID, id, status)
	i, err := r.scanIntegration(ctx, row)
	if errors.Is(err, pgx.ErrNoRows) {
		var existingStatus string
		statusErr := tx.QueryRow(ctx, `
SELECT status
  FROM commerce_integrations
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id).Scan(&existingStatus)
		if statusErr == nil && strings.EqualFold(strings.TrimSpace(existingStatus), "disconnected") {
			return nil, errIntegrationDisconnected
		}
		if statusErr != nil && !errors.Is(statusErr, pgx.ErrNoRows) {
			return nil, statusErr
		}
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return i, tx.Commit(ctx)
}

func (r *Repo) DeleteIntegration(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM commerce_integrations
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func (r *Repo) DisconnectIntegrationWithProviderCleanup(ctx context.Context, tenantID, id string, cleanup *DisconnectCleanupEvidence) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cleanupPayload := ""
	if cleanup != nil {
		payload, err := json.Marshal(cleanup)
		if err != nil {
			return err
		}
		cleanupPayload = string(payload)
	}
	tag, err := tx.Exec(ctx, `
UPDATE commerce_integrations
   SET status = 'disconnected',
       settings = CASE
           WHEN NULLIF($3, '') IS NULL THEN COALESCE(settings, '{}'::jsonb)
           ELSE COALESCE(settings, '{}'::jsonb) || jsonb_build_object('provider_cleanup', $3::jsonb)
       END,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND status <> 'disconnected'`, tenantID, id, cleanupPayload)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		var status string
		err = tx.QueryRow(ctx, `
SELECT status
  FROM commerce_integrations
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id).Scan(&status)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if strings.EqualFold(strings.TrimSpace(status), "disconnected") {
			return tx.Commit(ctx)
		}
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func (r *Repo) FindShopifyIntegrationByShop(ctx context.Context, shop string) (*Integration, error) {
	shop = NormalizeShopDomain(shop)
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.shopify_shop_domain', $1, true)`, shop); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, integrationSelectSQL+`
	WHERE provider = 'shopify'
	  AND status = 'connected'
	  AND lower(shop_domain) = lower($1)
	ORDER BY updated_at DESC
	LIMIT 1`, shop)
	i, err := r.scanIntegration(ctx, row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return i, tx.Commit(ctx)
}

func (r *Repo) FindWooCommerceIntegrationByStoreURL(ctx context.Context, storeURL string) (*Integration, error) {
	storeURL, err := normalizeWooCommerceStoreOrigin(storeURL)
	if err != nil {
		return nil, err
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.woocommerce_store_url', $1, true)`, storeURL); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, integrationSelectSQL+`
	WHERE provider = $1
	  AND status = 'connected'
	  AND (
	        lower(trim(trailing '/' from COALESCE(shop_domain, ''))) = lower($2)
	     OR lower(trim(trailing '/' from COALESCE(settings->>'store_url', ''))) = lower($2)
	  )
	ORDER BY updated_at DESC
	LIMIT 1`, ProviderWooCommerce, storeURL)
	i, err := r.scanIntegration(ctx, row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return i, tx.Commit(ctx)
}

func (r *Repo) FindWooCommerceIntegrationByTenantStoreURL(ctx context.Context, tenantID, storeURL string) (*Integration, error) {
	storeURL, err := normalizeWooCommerceStoreOrigin(storeURL)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, integrationSelectSQL+`
	WHERE tenant_id = $1::uuid
	  AND provider = $2
	  AND (
	        lower(trim(trailing '/' from COALESCE(shop_domain, ''))) = lower($3)
	     OR lower(trim(trailing '/' from COALESCE(settings->>'store_url', ''))) = lower($3)
	  )
	ORDER BY updated_at DESC
	LIMIT 1`, tenantID, ProviderWooCommerce, storeURL)
	i, err := r.scanIntegration(ctx, row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return i, tx.Commit(ctx)
}

func (r *Repo) FindBigCommerceIntegrationByStoreHash(ctx context.Context, storeHash string) (*Integration, error) {
	normalized, ok := normalizeBigCommerceStoreHash(storeHash)
	if !ok {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.bigcommerce_store_hash', $1, true)`, normalized); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, integrationSelectSQL+`
	WHERE provider = $1
	  AND status = 'connected'
	  AND (
	        lower(COALESCE(shop_domain, '')) = lower($2)
	     OR lower(COALESCE(settings->>'store_hash', '')) = lower($2)
	  )
	ORDER BY updated_at DESC
	LIMIT 1`, ProviderBigCommerce, normalized)
	i, err := r.scanIntegration(ctx, row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return i, tx.Commit(ctx)
}

func (r *Repo) FindBigCommerceIntegrationByTenantStoreHash(ctx context.Context, tenantID, storeHash string) (*Integration, error) {
	normalized, ok := normalizeBigCommerceStoreHash(storeHash)
	if !ok {
		return nil, ErrNotFound
	}
	row := r.Pool.QueryRow(ctx, integrationSelectSQL+`
	WHERE tenant_id = $1
	  AND provider = $2
	  AND (
	        lower(COALESCE(shop_domain, '')) = lower($3)
	     OR lower(COALESCE(settings->>'store_hash', '')) = lower($3)
	  )
	ORDER BY updated_at DESC
	LIMIT 1`, tenantID, ProviderBigCommerce, normalized)
	i, err := r.scanIntegration(ctx, row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return i, nil
}

func (r *Repo) FindStripeIntegrationByAccountID(ctx context.Context, accountID string) (*Integration, error) {
	accountID = normalizeStripeAccountID(accountID)
	if accountID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.stripe_account_id', $1, true)`, accountID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, integrationSelectSQL+`
	WHERE provider = $1
	  AND status = 'connected'
	  AND (
	        lower(COALESCE(shop_domain, '')) = lower($2)
	     OR lower(COALESCE(settings->>'account_id', '')) = lower($2)
	  )
	ORDER BY updated_at DESC
	LIMIT 1`, ProviderStripe, accountID)
	i, err := r.scanIntegration(ctx, row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return i, tx.Commit(ctx)
}

func (r *Repo) FindSquareIntegrationByMerchantID(ctx context.Context, merchantID string) (*Integration, error) {
	merchantID = normalizeSquareMerchantID(merchantID)
	if merchantID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.square_merchant_id', $1, true)`, merchantID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, integrationSelectSQL+`
	WHERE provider = $1
	  AND status = 'connected'
	  AND (
	        lower(COALESCE(shop_domain, '')) = lower($2)
	     OR lower(COALESCE(settings->>'merchant_id', '')) = lower($2)
	  )
	ORDER BY updated_at DESC
	LIMIT 1`, ProviderSquare, merchantID)
	i, err := r.scanIntegration(ctx, row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return i, tx.Commit(ctx)
}

func (r *Repo) FindPayPalIntegrationByMerchantID(ctx context.Context, merchantID string) (*Integration, error) {
	merchantID = normalizePayPalMerchantID(merchantID)
	if merchantID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.paypal_merchant_id', $1, true)`, merchantID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, integrationSelectSQL+`
	WHERE provider = $1
	  AND status = 'connected'
	  AND (
	        lower(COALESCE(shop_domain, '')) = lower($2)
	     OR lower(COALESCE(settings->>'merchant_id', '')) = lower($2)
	  )
	ORDER BY updated_at DESC
	LIMIT 1`, ProviderPayPal, merchantID)
	i, err := r.scanIntegration(ctx, row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return i, tx.Commit(ctx)
}

func (r *Repo) FindRazorpayIntegrationByAccountID(ctx context.Context, accountID string) (*Integration, error) {
	accountID = normalizeRazorpayAccountID(accountID)
	if accountID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.razorpay_account_id', $1, true)`, accountID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, integrationSelectSQL+`
	WHERE provider = $1
	  AND status = 'connected'
	  AND (
	        lower(COALESCE(shop_domain, '')) = lower($2)
	     OR lower(COALESCE(settings->>'account_id', '')) = lower($2)
	  )
	ORDER BY updated_at DESC
	LIMIT 1`, ProviderRazorpay, accountID)
	i, err := r.scanIntegration(ctx, row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return i, tx.Commit(ctx)
}

func (r *Repo) FindAdobeCommerceIntegrationByBaseURL(ctx context.Context, baseURL string) (*Integration, error) {
	baseURL = normalizeAdobeCommerceStoreBaseURL(baseURL)
	if baseURL == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.adobe_commerce_base_url', $1, true)`, baseURL); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, integrationSelectSQL+`
	WHERE provider = $1
	  AND status = 'connected'
	  AND (
	        lower(trim(trailing '/' from COALESCE(shop_domain, ''))) = lower($2)
	     OR lower(trim(trailing '/' from COALESCE(settings->>'base_url', ''))) = lower($2)
	  )
	ORDER BY updated_at DESC
	LIMIT 1`, ProviderAdobeCommerce, baseURL)
	i, err := r.scanIntegration(ctx, row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return i, tx.Commit(ctx)
}

func (r *Repo) FindWixStoresIntegrationBySiteID(ctx context.Context, siteID string) (*Integration, error) {
	siteID = normalizeWixSiteID(siteID)
	if siteID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.wix_site_id', $1, true)`, siteID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, integrationSelectSQL+`
	WHERE provider = $1
	  AND status IN ('connected', 'error', 'needs_auth')
	  AND (
	        lower(COALESCE(shop_domain, '')) = lower($2)
	     OR lower(COALESCE(settings->>'site_id', '')) = lower($2)
	     OR lower(COALESCE(settings->>'instance_id', '')) = lower($2)
	     OR lower(COALESCE(settings->>'store_id', '')) = lower($2)
	  )
	ORDER BY updated_at DESC
	LIMIT 1`, ProviderWixStores, siteID)
	i, err := r.scanIntegration(ctx, row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return i, tx.Commit(ctx)
}

func (r *Repo) FindSquarespaceIntegrationBySiteID(ctx context.Context, siteID string) (*Integration, error) {
	siteID = normalizeSquarespaceSiteID(siteID)
	if siteID == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.squarespace_site_id', $1, true)`, siteID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, integrationSelectSQL+`
	WHERE provider = $1
	  AND status = 'connected'
	  AND (
	        lower(COALESCE(shop_domain, '')) = lower($2)
	     OR lower(COALESCE(settings->>'site_id', '')) = lower($2)
	     OR lower(COALESCE(settings->>'website_id', '')) = lower($2)
	     OR lower(COALESCE(settings->>'store_id', '')) = lower($2)
	  )
	ORDER BY updated_at DESC
	LIMIT 1`, ProviderSquarespace, siteID)
	i, err := r.scanIntegration(ctx, row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return i, tx.Commit(ctx)
}

func (r *Repo) UpsertIntegration(ctx context.Context, tenantID string, in IntegrationInput) (*Integration, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	settings := nonNilMap(in.Settings)
	delete(settings, "provider_cleanup")
	if strings.TrimSpace(in.CredentialRef) != "" {
		settings["credential_ref"] = strings.TrimSpace(in.CredentialRef)
	}
	var accessTokenEnvelope []byte
	if in.AccessToken != "" {
		settings["access_token_present"] = true
		settings["access_token_configured_at"] = time.Now().UTC().Format(time.RFC3339)
		if r.Cipher != nil {
			accessTokenEnvelope, err = r.Cipher.Encrypt(ctx, []byte(in.AccessToken))
			if err != nil {
				return nil, fmt.Errorf("encrypt shopify access token: %w", err)
			}
		} else {
			settings["access_token"] = in.AccessToken
		}
	}
	var webhookSecretEnvelope []byte
	if in.WebhookSecret != "" {
		settings["webhook_secret_present"] = true
		if r.Cipher != nil {
			webhookSecretEnvelope, err = r.Cipher.Encrypt(ctx, []byte(in.WebhookSecret))
			if err != nil {
				return nil, fmt.Errorf("encrypt shopify webhook secret: %w", err)
			}
		} else {
			settings["webhook_secret"] = in.WebhookSecret
		}
	}
	raw, _ := json.Marshal(settings)
	row := tx.QueryRow(ctx, `
	INSERT INTO commerce_integrations (
	    tenant_id, provider, shop_domain, status, scopes, settings,
	    access_token_envelope, webhook_secret_envelope
	)
	VALUES ($1::uuid, $2, NULLIF($3, ''), $4, $5, $6::jsonb, $7, $8)
	ON CONFLICT (tenant_id, provider, shop_domain) DO UPDATE SET
	  status = EXCLUDED.status,
	  scopes = EXCLUDED.scopes,
	  settings = (commerce_integrations.settings - 'provider_cleanup') || EXCLUDED.settings,
	  access_token_envelope = COALESCE(EXCLUDED.access_token_envelope, commerce_integrations.access_token_envelope),
	  webhook_secret_envelope = COALESCE(EXCLUDED.webhook_secret_envelope, commerce_integrations.webhook_secret_envelope),
	  sync_cursor = CASE WHEN commerce_integrations.status = 'disconnected' THEN NULL ELSE commerce_integrations.sync_cursor END,
	  last_sync_at = CASE WHEN commerce_integrations.status = 'disconnected' THEN NULL ELSE commerce_integrations.last_sync_at END,
	  error_message = NULL,
	  updated_at = now()
	RETURNING `+integrationColumns,
		tenantID, in.Provider, in.ShopDomain, in.Status, in.Scopes, string(raw), accessTokenEnvelope, webhookSecretEnvelope)
	i, err := r.scanIntegration(ctx, row)
	if err != nil {
		return nil, err
	}
	eventSource := "commerce_integration"
	if source, ok := settings["created_via"].(string); ok && strings.TrimSpace(source) != "" {
		eventSource = strings.TrimSpace(source)
	} else if in.Provider == ProviderShopify {
		eventSource = "shopify_oauth"
	}
	eventMeta, _ := json.Marshal(map[string]string{"source": eventSource, "provider": in.Provider})
	if _, err := tx.Exec(ctx, `
	INSERT INTO commerce_events (tenant_id, integration_id, event_type, metadata)
	VALUES ($1::uuid, $2::uuid, 'sync_started', $3::jsonb)`,
		tenantID, i.ID, string(eventMeta)); err != nil {
		return nil, err
	}
	return i, tx.Commit(ctx)
}

func (r *Repo) SetIntegrationSync(ctx context.Context, tenantID, id, cursor string, at time.Time, syncErr error) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	status := "connected"
	errMsg := ""
	if syncErr != nil {
		status = "error"
		errMsg = syncErr.Error()
	}
	provider := ""
	err = tx.QueryRow(ctx, `
	UPDATE commerce_integrations
	   SET status = $3,
	       sync_cursor = NULLIF($4, ''),
	       last_sync_at = CASE WHEN $5 = '' THEN $6 ELSE last_sync_at END,
	       error_message = NULLIF($5, ''),
	       updated_at = now()
	 WHERE tenant_id = $1::uuid
	   AND id::text = $2
	   AND status <> 'disconnected'
	 RETURNING provider`, tenantID, id, status, cursor, errMsg, at).Scan(&provider)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	source := firstNonEmpty(provider, "commerce")
	if syncErr == nil {
		metadata, marshalErr := json.Marshal(map[string]any{
			"source": source,
			"cursor": cursor,
		})
		if marshalErr != nil {
			return marshalErr
		}
		_, err = tx.Exec(ctx, `
		INSERT INTO commerce_events (tenant_id, integration_id, event_type, metadata)
		VALUES ($1::uuid, $2::uuid, 'sync_completed', $3::jsonb)`,
			tenantID, id, string(metadata))
		if err != nil {
			return err
		}
	} else {
		metadata, marshalErr := json.Marshal(map[string]any{
			"source": source,
			"cursor": cursor,
			"error":  syncErr.Error(),
		})
		if marshalErr != nil {
			return marshalErr
		}
		_, err = tx.Exec(ctx, `
		INSERT INTO commerce_events (tenant_id, integration_id, event_type, metadata)
		VALUES ($1::uuid, $2::uuid, 'sync_failed', $3::jsonb)`,
			tenantID, id, string(metadata))
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *Repo) UpsertCustomer(ctx context.Context, tenantID, integrationID string, in CustomerInput) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := upsertCustomer(ctx, tx, tenantID, integrationID, in); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	// SUB-013: a customer_created event with an email may shift the
	// subscriber's catalog attributes; recompute out of band.
	r.triggerCatalogBackfill(tenantID)
	return nil
}

func (r *Repo) UpsertProduct(ctx context.Context, tenantID, integrationID string, in ProductInput) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := upsertProduct(ctx, tx, tenantID, integrationID, in); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) UpsertOrder(ctx context.Context, tenantID, integrationID string, in OrderInput) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := upsertOrder(ctx, tx, tenantID, integrationID, in); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	// SUB-013: an order_created/refunded event carries a customer_email and
	// (via line items) catalog signals; recompute the subscriber's catalog
	// attributes out of band.
	r.triggerCatalogBackfill(tenantID)
	// SUB-061 / SUB-062: a new order shifts the subscriber's replenishment
	// cadence; recompute average_days_between_orders / expected_next_order_at
	// out of band.
	r.triggerCadenceBackfill(tenantID)
	return nil
}

func (r *Repo) RecordProviderEvent(ctx context.Context, tenantID, integrationID string, in ProviderEventInput) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureConnectedIntegration(ctx, tx, tenantID, integrationID); err != nil {
		return err
	}
	if err := recordProviderEvent(ctx, tx, tenantID, integrationID, in); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) DeleteCustomer(ctx context.Context, tenantID, integrationID string, in ProviderDeletion) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := deleteCustomer(ctx, tx, tenantID, integrationID, in); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	r.triggerCatalogBackfill(tenantID)
	return nil
}

func (r *Repo) DeleteProduct(ctx context.Context, tenantID, integrationID string, in ProviderDeletion) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := deleteProduct(ctx, tx, tenantID, integrationID, in); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	r.triggerCatalogBackfill(tenantID)
	return nil
}

func (r *Repo) DeleteOrder(ctx context.Context, tenantID, integrationID string, in ProviderDeletion) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := deleteOrder(ctx, tx, tenantID, integrationID, in); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	r.triggerCatalogBackfill(tenantID)
	r.triggerCadenceBackfill(tenantID)
	return nil
}

func (r *Repo) Sync(ctx context.Context, tenantID, integrationID string, req SyncRequest, now time.Time) (*SyncSummary, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `
	SELECT EXISTS (
	  SELECT 1 FROM commerce_integrations
	   WHERE tenant_id = $1::uuid AND id::text = $2
	)`, tenantID, integrationID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	if !syncRequestHasPayload(req) {
		return nil, ErrSyncPayloadRequired
	}
	for _, c := range req.Customers {
		if err := upsertCustomer(ctx, tx, tenantID, integrationID, c); err != nil {
			return nil, err
		}
	}
	for _, p := range req.Products {
		if _, err := upsertProduct(ctx, tx, tenantID, integrationID, p); err != nil {
			return nil, err
		}
	}
	for _, deletion := range req.ProductDeletions {
		if err := deleteProduct(ctx, tx, tenantID, integrationID, deletion); err != nil {
			return nil, err
		}
	}
	for _, o := range req.Orders {
		if err := upsertOrder(ctx, tx, tenantID, integrationID, o); err != nil {
			return nil, err
		}
	}
	for _, event := range req.ProviderEvents {
		if err := recordProviderEvent(ctx, tx, tenantID, integrationID, event); err != nil {
			return nil, err
		}
	}
	cursor := req.Cursor
	if cursor == "" {
		cursor = fmt.Sprintf("sync-%d", now.Unix())
	}
	tag, err := tx.Exec(ctx, `
	UPDATE commerce_integrations
	   SET status = 'connected',
	       sync_cursor = $3,
	       last_sync_at = $4,
	       error_message = NULL,
	       updated_at = now()
	 WHERE tenant_id = $1::uuid
	   AND id::text = $2
	   AND status <> 'disconnected'`, tenantID, integrationID, cursor, now)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	if _, err := tx.Exec(ctx, `
	INSERT INTO commerce_events (tenant_id, integration_id, event_type, metadata)
	VALUES ($1::uuid, $2::uuid, 'sync_completed', $3::jsonb)`,
		tenantID, integrationID, `{"source":"manual"}`); err != nil {
		return nil, err
	}
	out := &SyncSummary{
		CustomersUpserted: len(req.Customers),
		ProductsUpserted:  len(req.Products),
		ProductsDeleted:   len(req.ProductDeletions),
		OrdersUpserted:    len(req.Orders),
		EventsRecorded:    len(req.ProviderEvents),
		Cursor:            cursor,
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	// SUB-013: recompute catalog attributes out of band when the sync wrote
	// any events that can be attributed to a subscriber by email
	// (customers / orders). A products-only sync carries no email so there
	// is nothing to attribute.
	if len(req.Customers) > 0 || len(req.ProductDeletions) > 0 || len(req.Orders) > 0 {
		r.triggerCatalogBackfill(tenantID)
	}
	// SUB-061 / SUB-062: recompute replenishment cadence when the sync wrote
	// any orders (the cadence is derived from order timestamps).
	if len(req.Orders) > 0 {
		r.triggerCadenceBackfill(tenantID)
	}
	return out, nil
}

func syncRequestHasPayload(req SyncRequest) bool {
	return len(req.Customers) > 0 || len(req.Products) > 0 || len(req.ProductDeletions) > 0 || len(req.Orders) > 0 || len(req.ProviderEvents) > 0
}

func (r *Repo) ListCustomers(ctx context.Context, tenantID, integrationID string, limit int, cursor pagination.Cursor) (*CustomersPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureIntegration(ctx, tx, tenantID, integrationID); err != nil {
		return nil, err
	}
	args := []any{tenantID, integrationID, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (updated_at, id) < ($4::timestamptz, $5::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, source_id, COALESCE(email::text, ''), COALESCE(first_name, ''),
       COALESCE(last_name, ''), accepts_marketing, tags, raw, created_at, updated_at
  FROM commerce_customers
 WHERE tenant_id = $1::uuid AND integration_id::text = $2
 `+keyset+`
 ORDER BY updated_at DESC, id DESC
 LIMIT $3`, args...)
	if err != nil {
		return nil, err
	}
	items, err := scanCustomers(rows)
	if err != nil {
		return nil, err
	}
	items, more := pagination.HasMore(items, limit)
	next := ""
	if more {
		last := items[len(items)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.UpdatedAt, ID: last.ID})
	}
	return &CustomersPage{Items: items, NextCursor: next}, tx.Commit(ctx)
}

func (r *Repo) ListProducts(ctx context.Context, tenantID, integrationID string, limit int, cursor pagination.Cursor) (*ProductsPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureIntegration(ctx, tx, tenantID, integrationID); err != nil {
		return nil, err
	}
	args := []any{tenantID, integrationID, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (updated_at, id) < ($4::timestamptz, $5::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, source_id, title, COALESCE(url, ''), COALESCE(image_url, ''),
       price_cents, currency, raw, created_at, updated_at
  FROM commerce_products
 WHERE tenant_id = $1::uuid AND integration_id::text = $2
 `+keyset+`
 ORDER BY updated_at DESC, id DESC
 LIMIT $3`, args...)
	if err != nil {
		return nil, err
	}
	items, err := scanProducts(rows)
	if err != nil {
		return nil, err
	}
	items, more := pagination.HasMore(items, limit)
	next := ""
	if more {
		last := items[len(items)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.UpdatedAt, ID: last.ID})
	}
	return &ProductsPage{Items: items, NextCursor: next}, tx.Commit(ctx)
}

func (r *Repo) ListProductVariants(ctx context.Context, tenantID, integrationID, productID string, limit int, cursor pagination.Cursor) (*ProductVariantsPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	resolvedProductID, err := ensureProduct(ctx, tx, tenantID, integrationID, productID)
	if err != nil {
		return nil, err
	}
	args := []any{tenantID, integrationID, resolvedProductID, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (updated_at, id) < ($5::timestamptz, $6::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, integration_id::text, product_id::text, source_id,
       COALESCE(sku, ''), COALESCE(title, ''), option_values, price_cents,
       compare_at_price_cents, currency, inventory_quantity, inventory_policy,
       available, COALESCE(image_url, ''), COALESCE(url, ''), raw, created_at, updated_at
  FROM commerce_product_variants
 WHERE tenant_id = $1::uuid AND integration_id::text = $2 AND product_id::text = $3
 `+keyset+`
 ORDER BY updated_at DESC, id DESC
 LIMIT $4`, args...)
	if err != nil {
		return nil, err
	}
	items, err := scanProductVariants(rows)
	if err != nil {
		return nil, err
	}
	items, more := pagination.HasMore(items, limit)
	next := ""
	if more {
		last := items[len(items)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.UpdatedAt, ID: last.ID})
	}
	return &ProductVariantsPage{Items: items, NextCursor: next}, tx.Commit(ctx)
}

func (r *Repo) ListInventorySnapshots(ctx context.Context, tenantID, integrationID, productID string, limit int, cursor pagination.Cursor) (*InventorySnapshotsPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	resolvedProductID, err := ensureProduct(ctx, tx, tenantID, integrationID, productID)
	if err != nil {
		return nil, err
	}
	args := []any{tenantID, integrationID, resolvedProductID, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (observed_at, id) < ($5::timestamptz, $6::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, integration_id::text, product_id::text,
       COALESCE(variant_id::text, ''), quantity, available, inventory_policy,
       observed_at, COALESCE(source_event_id, ''), metadata
  FROM commerce_inventory_snapshots
 WHERE tenant_id = $1::uuid AND integration_id::text = $2 AND product_id::text = $3
 `+keyset+`
 ORDER BY observed_at DESC, id DESC
 LIMIT $4`, args...)
	if err != nil {
		return nil, err
	}
	items, err := scanInventorySnapshots(rows)
	if err != nil {
		return nil, err
	}
	items, more := pagination.HasMore(items, limit)
	next := ""
	if more {
		last := items[len(items)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.ObservedAt, ID: last.ID})
	}
	return &InventorySnapshotsPage{Items: items, NextCursor: next}, tx.Commit(ctx)
}

func (r *Repo) ListPriceHistory(ctx context.Context, tenantID, integrationID, productID string, limit int, cursor pagination.Cursor) (*PriceHistoryPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	resolvedProductID, err := ensureProduct(ctx, tx, tenantID, integrationID, productID)
	if err != nil {
		return nil, err
	}
	args := []any{tenantID, integrationID, resolvedProductID, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (observed_at, id) < ($5::timestamptz, $6::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, integration_id::text, product_id::text,
       COALESCE(variant_id::text, ''), price_cents, compare_at_price_cents,
       currency, observed_at, COALESCE(source_event_id, ''), metadata
  FROM commerce_price_history
 WHERE tenant_id = $1::uuid AND integration_id::text = $2 AND product_id::text = $3
 `+keyset+`
 ORDER BY observed_at DESC, id DESC
 LIMIT $4`, args...)
	if err != nil {
		return nil, err
	}
	items, err := scanPriceHistory(rows)
	if err != nil {
		return nil, err
	}
	items, more := pagination.HasMore(items, limit)
	next := ""
	if more {
		last := items[len(items)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.ObservedAt, ID: last.ID})
	}
	return &PriceHistoryPage{Items: items, NextCursor: next}, tx.Commit(ctx)
}

func (r *Repo) ListOrders(ctx context.Context, tenantID, integrationID string, limit int, cursor pagination.Cursor) (*OrdersPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureIntegration(ctx, tx, tenantID, integrationID); err != nil {
		return nil, err
	}
	args := []any{tenantID, integrationID, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (ordered_at, id) < ($4::timestamptz, $5::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, source_id, COALESCE(customer_email::text, ''), status,
       subtotal_cents, discount_cents, shipping_cents, tax_cents, total_cents,
       currency, COALESCE(campaign_id::text, ''), attribution, line_items, ordered_at,
       raw, created_at, updated_at
  FROM commerce_orders
 WHERE tenant_id = $1::uuid AND integration_id::text = $2
 `+keyset+`
 ORDER BY ordered_at DESC, id DESC
 LIMIT $3`, args...)
	if err != nil {
		return nil, err
	}
	items, err := scanOrders(rows)
	if err != nil {
		return nil, err
	}
	items, more := pagination.HasMore(items, limit)
	next := ""
	if more {
		last := items[len(items)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.OrderedAt, ID: last.ID})
	}
	return &OrdersPage{Items: items, NextCursor: next}, tx.Commit(ctx)
}

func (r *Repo) ListEvents(ctx context.Context, tenantID, integrationID string, limit int, cursor pagination.Cursor) (*EventsPage, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureIntegration(ctx, tx, tenantID, integrationID); err != nil {
		return nil, err
	}
	args := []any{tenantID, integrationID, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (at, id) < ($4::timestamptz, $5::bigint)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id, event_type, COALESCE(customer_email::text, ''), COALESCE(order_id::text, ''),
       COALESCE(provider_event_id, ''), COALESCE(provider_topic, ''), metadata, at
  FROM commerce_events
 WHERE tenant_id = $1::uuid AND integration_id::text = $2
 `+keyset+`
 ORDER BY at DESC, id DESC
 LIMIT $3`, args...)
	if err != nil {
		return nil, err
	}
	items, err := scanEvents(rows)
	if err != nil {
		return nil, err
	}
	items, more := pagination.HasMore(items, limit)
	next := ""
	if more {
		last := items[len(items)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.At, ID: strconv.FormatInt(last.ID, 10)})
	}
	return &EventsPage{Items: items, NextCursor: next}, tx.Commit(ctx)
}

func (r *Repo) Analytics(ctx context.Context, tenantID, integrationID string) (*Analytics, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureIntegration(ctx, tx, tenantID, integrationID); err != nil {
		return nil, err
	}
	out := &Analytics{Currency: "USD", OrdersByStatus: map[string]int{}}
	if err := tx.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM commerce_customers WHERE tenant_id = $1::uuid AND integration_id::text = $2),
  (SELECT count(*) FROM commerce_products WHERE tenant_id = $1::uuid AND integration_id::text = $2),
  count(*),
  COALESCE(sum(total_cents), 0),
  max(ordered_at),
  COALESCE(max(currency), 'USD')
FROM commerce_orders
WHERE tenant_id = $1::uuid AND integration_id::text = $2`, tenantID, integrationID).
		Scan(&out.Customers, &out.Products, &out.Orders, &out.RevenueCents, &out.LastOrderAt, &out.Currency); err != nil {
		return nil, err
	}
	if out.Orders > 0 {
		out.AverageOrderCents = out.RevenueCents / out.Orders
	}
	rows, err := tx.Query(ctx, `
SELECT status, count(*)
  FROM commerce_orders
 WHERE tenant_id = $1::uuid AND integration_id::text = $2
 GROUP BY status`, tenantID, integrationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return nil, err
		}
		out.OrdersByStatus[status] = count
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func ensureIntegration(ctx context.Context, tx pgx.Tx, tenantID, integrationID string) error {
	var exists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM commerce_integrations
   WHERE tenant_id = $1::uuid AND id::text = $2
)`, tenantID, integrationID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}

func ensureConnectedIntegration(ctx context.Context, tx pgx.Tx, tenantID, integrationID string) error {
	var status string
	if err := tx.QueryRow(ctx, `
SELECT status
  FROM commerce_integrations
 WHERE tenant_id = $1::uuid AND id::text = $2
 LIMIT 1`, tenantID, integrationID).Scan(&status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if strings.EqualFold(strings.TrimSpace(status), "disconnected") {
		return errIntegrationDisconnected
	}
	return nil
}

func ensureProduct(ctx context.Context, tx pgx.Tx, tenantID, integrationID, productID string) (string, error) {
	var id string
	if err := tx.QueryRow(ctx, `
SELECT id::text
  FROM commerce_products
 WHERE tenant_id = $1::uuid AND integration_id::text = $2
   AND (id::text = $3 OR source_id = $3)
 LIMIT 1`, tenantID, integrationID, productID).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	return id, nil
}

func ensureOrder(ctx context.Context, tx pgx.Tx, tenantID, integrationID, orderID string) (string, error) {
	var id string
	if err := tx.QueryRow(ctx, `
SELECT id::text
  FROM commerce_orders
 WHERE tenant_id = $1::uuid AND integration_id::text = $2
   AND (id::text = $3 OR source_id = $3)
 LIMIT 1`, tenantID, integrationID, orderID).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	return id, nil
}

func ensureVariant(ctx context.Context, tx pgx.Tx, tenantID, integrationID, productID, variantID string) (string, error) {
	variantID = strings.TrimSpace(variantID)
	if variantID == "" {
		return "", nil
	}
	var id string
	if err := tx.QueryRow(ctx, `
SELECT id::text
  FROM commerce_product_variants
 WHERE tenant_id = $1::uuid AND integration_id::text = $2 AND product_id::text = $3
   AND (id::text = $4 OR source_id = $4)
 LIMIT 1`, tenantID, integrationID, productID, variantID).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	return id, nil
}

func currentProductPrice(ctx context.Context, tx pgx.Tx, tenantID, integrationID, productID, variantID string) (int, string, error) {
	if strings.TrimSpace(variantID) != "" {
		var price int
		var currency string
		if err := tx.QueryRow(ctx, `
SELECT price_cents, currency
  FROM commerce_product_variants
 WHERE tenant_id = $1::uuid AND integration_id::text = $2 AND product_id::text = $3 AND id::text = $4`,
			tenantID, integrationID, productID, variantID).Scan(&price, &currency); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return 0, "", ErrNotFound
			}
			return 0, "", err
		}
		return price, currency, nil
	}
	var price int
	var currency string
	if err := tx.QueryRow(ctx, `
SELECT price_cents, currency
  FROM commerce_products
 WHERE tenant_id = $1::uuid AND integration_id::text = $2 AND id::text = $3`,
		tenantID, integrationID, productID).Scan(&price, &currency); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, "", ErrNotFound
		}
		return 0, "", err
	}
	return price, currency, nil
}

func scanProductVariants(rows pgx.Rows) ([]ProductVariant, error) {
	defer rows.Close()
	out := []ProductVariant{}
	for rows.Next() {
		var item ProductVariant
		var optionRaw, raw []byte
		var compareAt, inventory sql.NullInt64
		if err := rows.Scan(&item.ID, &item.TenantID, &item.IntegrationID, &item.ProductID, &item.SourceID, &item.SKU, &item.Title, &optionRaw, &item.PriceCents, &compareAt, &item.Currency, &inventory, &item.InventoryPolicy, &item.Available, &item.ImageURL, &item.URL, &raw, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(optionRaw, &item.OptionValues)
		_ = json.Unmarshal(raw, &item.Raw)
		item.CompareAtPriceCents = nullIntPtr(compareAt)
		item.InventoryQuantity = nullIntPtr(inventory)
		if item.OptionValues == nil {
			item.OptionValues = map[string]any{}
		}
		if item.Raw == nil {
			item.Raw = map[string]any{}
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func scanInventorySnapshots(rows pgx.Rows) ([]InventorySnapshot, error) {
	defer rows.Close()
	out := []InventorySnapshot{}
	for rows.Next() {
		var item InventorySnapshot
		var quantity sql.NullInt64
		var raw []byte
		if err := rows.Scan(&item.ID, &item.TenantID, &item.IntegrationID, &item.ProductID, &item.VariantID, &quantity, &item.Available, &item.InventoryPolicy, &item.ObservedAt, &item.SourceEventID, &raw); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(raw, &item.Metadata)
		item.Quantity = nullIntPtr(quantity)
		if item.Metadata == nil {
			item.Metadata = map[string]any{}
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func scanPriceHistory(rows pgx.Rows) ([]PriceHistoryPoint, error) {
	defer rows.Close()
	out := []PriceHistoryPoint{}
	for rows.Next() {
		var item PriceHistoryPoint
		var compareAt sql.NullInt64
		var raw []byte
		if err := rows.Scan(&item.ID, &item.TenantID, &item.IntegrationID, &item.ProductID, &item.VariantID, &item.PriceCents, &compareAt, &item.Currency, &item.ObservedAt, &item.SourceEventID, &raw); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(raw, &item.Metadata)
		item.CompareAtPriceCents = nullIntPtr(compareAt)
		if item.Metadata == nil {
			item.Metadata = map[string]any{}
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func nullIntPtr(v sql.NullInt64) *int {
	if !v.Valid {
		return nil
	}
	n := int(v.Int64)
	return &n
}

func nullableIntFromPtr(v *int) any {
	if v == nil {
		return nil
	}
	return *v
}

func scanCustomers(rows pgx.Rows) ([]Customer, error) {
	defer rows.Close()
	out := []Customer{}
	for rows.Next() {
		var item Customer
		var raw []byte
		if err := rows.Scan(&item.ID, &item.SourceID, &item.Email, &item.FirstName, &item.LastName, &item.AcceptsMarketing, &item.Tags, &raw, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(raw, &item.Raw)
		if item.Tags == nil {
			item.Tags = []string{}
		}
		if item.Raw == nil {
			item.Raw = map[string]any{}
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func scanProducts(rows pgx.Rows) ([]Product, error) {
	defer rows.Close()
	out := []Product{}
	for rows.Next() {
		var item Product
		var raw []byte
		if err := rows.Scan(&item.ID, &item.SourceID, &item.Title, &item.URL, &item.ImageURL, &item.PriceCents, &item.Currency, &raw, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(raw, &item.Raw)
		if item.Raw == nil {
			item.Raw = map[string]any{}
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func scanOrders(rows pgx.Rows) ([]Order, error) {
	defer rows.Close()
	out := []Order{}
	for rows.Next() {
		var item Order
		var attributionRaw, lineItemsRaw, raw []byte
		if err := rows.Scan(&item.ID, &item.SourceID, &item.CustomerEmail, &item.Status, &item.SubtotalCents, &item.DiscountCents, &item.ShippingCents, &item.TaxCents, &item.TotalCents, &item.Currency, &item.CampaignID, &attributionRaw, &lineItemsRaw, &item.OrderedAt, &raw, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(attributionRaw, &item.Attribution)
		_ = json.Unmarshal(lineItemsRaw, &item.LineItems)
		_ = json.Unmarshal(raw, &item.Raw)
		if item.Attribution == nil {
			item.Attribution = map[string]any{}
		}
		if item.LineItems == nil {
			item.LineItems = []map[string]any{}
		}
		if item.Raw == nil {
			item.Raw = map[string]any{}
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func scanEvents(rows pgx.Rows) ([]Event, error) {
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var item Event
		var raw []byte
		if err := rows.Scan(&item.ID, &item.EventType, &item.CustomerEmail, &item.OrderID, &item.ProviderEventID, &item.ProviderTopic, &raw, &item.At); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(raw, &item.Metadata)
		if item.Metadata == nil {
			item.Metadata = map[string]any{}
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

const integrationSelectSQL = `SELECT ` + integrationColumns + ` FROM commerce_integrations`
const integrationColumns = `id::text, tenant_id::text, provider, COALESCE(shop_domain, ''), status, scopes, settings, access_token_envelope, webhook_secret_envelope, COALESCE(sync_cursor, ''), last_sync_at, COALESCE(error_message, ''), created_at, updated_at`

type scanner interface{ Scan(dest ...any) error }

func (r *Repo) scanIntegration(ctx context.Context, row scanner) (*Integration, error) {
	var i Integration
	var raw []byte
	var accessTokenEnvelope []byte
	var webhookSecretEnvelope []byte
	if err := row.Scan(&i.ID, &i.TenantID, &i.Provider, &i.ShopDomain, &i.Status, &i.Scopes, &raw, &accessTokenEnvelope, &webhookSecretEnvelope, &i.SyncCursor, &i.LastSyncAt, &i.ErrorMessage, &i.CreatedAt, &i.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(raw, &i.Settings)
	if len(webhookSecretEnvelope) > 0 {
		if r.Cipher == nil {
			return nil, fmt.Errorf("commerce integration webhook secret envelope present but no cipher configured")
		}
		plain, err := r.Cipher.Decrypt(ctx, webhookSecretEnvelope, r.LegacyKEK)
		if err != nil {
			return nil, fmt.Errorf("decrypt commerce webhook secret: %w", err)
		}
		i.WebhookSecret = string(plain)
	}
	if len(accessTokenEnvelope) > 0 {
		if r.Cipher == nil {
			return nil, fmt.Errorf("commerce integration access token envelope present but no cipher configured")
		}
		plain, err := r.Cipher.Decrypt(ctx, accessTokenEnvelope, r.LegacyKEK)
		if err != nil {
			return nil, fmt.Errorf("decrypt commerce access token: %w", err)
		}
		i.AccessToken = string(plain)
	}
	if v, ok := i.Settings["webhook_secret"].(string); ok && i.WebhookSecret == "" {
		i.WebhookSecret = v
	}
	if v, ok := i.Settings["access_token"].(string); ok && i.AccessToken == "" {
		i.AccessToken = v
	}
	i.Settings = sanitizedSettings(i.Settings)
	return &i, nil
}

func sanitizedSettings(in map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range nonNilMap(in) {
		switch k {
		case "access_token", "webhook_secret", "client_secret":
			out[k+"_present"] = v != nil && fmt.Sprint(v) != ""
		default:
			out[k] = v
		}
	}
	return out
}

func secretFromSettings(settings map[string]any) string {
	if v, ok := settings["webhook_secret"].(string); ok {
		return v
	}
	return ""
}

func nonNilSliceMap(v []map[string]any) []map[string]any {
	if v == nil {
		return []map[string]any{}
	}
	return v
}
