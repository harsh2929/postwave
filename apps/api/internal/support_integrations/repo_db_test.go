// SPDX-License-Identifier: AGPL-3.0-only
//
// Repository-level tests against a real Postgres. Skipped when DATABASE_URL is
// unset so the package remains fast and hermetic by default.
package support_integrations

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func newSupportRepoTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed support repo tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedSupportRepoTenant(t *testing.T, pool *pgxpool.Pool, slug string) string {
	t.Helper()
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	var tenantID string
	if err := conn.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		t.Fatalf("uuid: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	if _, err := conn.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'pro')`,
		tenantID, slug, "Support Repo "+slug); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		conn, err := pool.Acquire(ctx)
		if err != nil {
			return
		}
		defer conn.Release()
		_, _ = conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID)
		_, _ = conn.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})
	return tenantID
}

func TestRepoUpsertIntegrationReconnectClearsDisconnectedZendeskState(t *testing.T) {
	pool := newSupportRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedSupportRepoTenant(t, pool, "support-reconnect-"+suffix)
	name := "Zendesk Reconnect " + suffix
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		conn.Release()
		t.Fatalf("set tenant: %v", err)
	}
	if _, err := conn.Exec(ctx, `
INSERT INTO support_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings,
    sync_cursor, last_sync_at, error_message
) VALUES (
    $1::uuid, 'zendesk', $2, 'disconnected', ARRAY['tickets:read'], 'cred_old',
    $3::jsonb, 'zendesk_retry:stale', now() - interval '1 day', 'old failure'
)`, tenantID, name, `{
		"subdomain":"old-subdomain",
		"zendesk_webhook_id":"old_webhook",
		"webhook_secret_ref":"old_secret",
		"provider_cleanup":{"status":"operator_action_required"}
	}`); err != nil {
		conn.Release()
		t.Fatalf("seed disconnected integration: %v", err)
	}
	conn.Release()

	out, err := repo.UpsertIntegration(ctx, tenantID, IntegrationInput{
		Provider:       ProviderZendesk,
		Name:           name,
		CredentialsRef: "cred_new",
		Settings: map[string]any{
			"subdomain": "new-subdomain",
		},
	})
	if err != nil {
		t.Fatalf("upsert reconnect: %v", err)
	}
	if out.Status != "connected" || out.CredentialsRef != "cred_new" || out.SyncCursor != "" || out.LastSyncAt != nil || out.ErrorMessage != "" {
		t.Fatalf("reconnected integration=%+v", out)
	}
	if settingString(out.Settings, "subdomain") != "new-subdomain" ||
		settingString(out.Settings, "zendesk_webhook_id") != "" ||
		settingString(out.Settings, "webhook_secret_ref") != "" ||
		out.Settings["provider_cleanup"] != nil {
		t.Fatalf("stale settings survived reconnect: %+v", out.Settings)
	}
}

func TestRepoUpsertIntegrationReconnectClearsDisconnectedGorgiasState(t *testing.T) {
	pool := newSupportRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedSupportRepoTenant(t, pool, "support-gorgias-reconnect-"+suffix)
	name := "Gorgias Reconnect " + suffix
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		conn.Release()
		t.Fatalf("set tenant: %v", err)
	}
	if _, err := conn.Exec(ctx, `
INSERT INTO support_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings,
    sync_cursor, last_sync_at, error_message
) VALUES (
    $1::uuid, 'gorgias', $2, 'disconnected', ARRAY[]::text[], 'cred_old',
    $3::jsonb, 'gorgias_retry:stale', now() - interval '1 day', 'old failure'
)`, tenantID, name, `{
		"account_domain":"old.gorgias.com",
		"gorgias_http_integration_id":"old_http",
		"webhook_secret_ref":"old_secret",
		"provider_cleanup":{"status":"operator_action_required"}
	}`); err != nil {
		conn.Release()
		t.Fatalf("seed disconnected integration: %v", err)
	}
	conn.Release()

	out, err := repo.UpsertIntegration(ctx, tenantID, IntegrationInput{
		Provider:       ProviderGorgias,
		Name:           name,
		CredentialsRef: "cred_new",
		Settings: map[string]any{
			"account_domain": "new.gorgias.com",
		},
	})
	if err != nil {
		t.Fatalf("upsert reconnect: %v", err)
	}
	if out.Status != "connected" || out.CredentialsRef != "cred_new" || out.SyncCursor != "" || out.LastSyncAt != nil || out.ErrorMessage != "" {
		t.Fatalf("reconnected integration=%+v", out)
	}
	if settingString(out.Settings, "account_domain") != "new.gorgias.com" ||
		settingString(out.Settings, "gorgias_http_integration_id") != "" ||
		settingString(out.Settings, "webhook_secret_ref") != "" ||
		out.Settings["provider_cleanup"] != nil {
		t.Fatalf("stale settings survived reconnect: %+v", out.Settings)
	}
}

func TestRepoResolveGorgiasCommerceContextResolvesExistingCommerceRows(t *testing.T) {
	pool := newSupportRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedSupportRepoTenant(t, pool, "support-gorgias-commerce-"+suffix)
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		conn.Release()
		t.Fatalf("set tenant: %v", err)
	}
	var commerceID, productID, orderID, customerID string
	if err := conn.QueryRow(ctx, `
	INSERT INTO commerce_integrations (tenant_id, provider, shop_domain, status)
	VALUES ($1::uuid, 'shopify', $2, 'connected')
	RETURNING id::text`, tenantID, "gorgias-commerce-"+suffix+".myshopify.com").Scan(&commerceID); err != nil {
		conn.Release()
		t.Fatalf("seed commerce integration: %v", err)
	}
	if err := conn.QueryRow(ctx, `
	INSERT INTO commerce_products (tenant_id, integration_id, source_id, title)
	VALUES ($1::uuid, $2::uuid, 'gid://shopify/Product/77', 'Resolved product')
	RETURNING id::text`, tenantID, commerceID).Scan(&productID); err != nil {
		conn.Release()
		t.Fatalf("seed commerce product: %v", err)
	}
	if _, err := conn.Exec(ctx, `
	INSERT INTO commerce_product_variants (tenant_id, integration_id, product_id, source_id, sku, title)
	VALUES ($1::uuid, $2::uuid, $3::uuid, 'gid://shopify/ProductVariant/88', 'SKU-77', 'Resolved variant')`,
		tenantID, commerceID, productID); err != nil {
		conn.Release()
		t.Fatalf("seed commerce variant: %v", err)
	}
	if err := conn.QueryRow(ctx, `
	INSERT INTO commerce_orders (tenant_id, integration_id, source_id, customer_email, line_items)
	VALUES ($1::uuid, $2::uuid, 'gid://shopify/Order/1001', 'buyer@example.com', $3::jsonb)
	RETURNING id::text`, tenantID, commerceID, `[{"product_id":"77","variant_id":"88","sku":"SKU-77"}]`).Scan(&orderID); err != nil {
		conn.Release()
		t.Fatalf("seed commerce order: %v", err)
	}
	if err := conn.QueryRow(ctx, `
	INSERT INTO commerce_customers (tenant_id, integration_id, source_id, email)
	VALUES ($1::uuid, $2::uuid, 'gid://shopify/Customer/88', 'buyer@example.com')
	RETURNING id::text`, tenantID, commerceID).Scan(&customerID); err != nil {
		conn.Release()
		t.Fatalf("seed commerce customer: %v", err)
	}
	conn.Release()

	props, err := repo.ResolveGorgiasCommerceContext(ctx, tenantID, Integration{
		Provider: ProviderGorgias,
		Settings: map[string]any{"commerce_integration_id": commerceID},
	}, "buyer@example.com", map[string]any{
		"gorgias_commerce_context_present": true,
		"shopify_order_id":                 "gid://shopify/Order/1001",
		"shopify_customer_id":              "gid://shopify/Customer/88",
	})
	if err != nil {
		t.Fatalf("resolve commerce context: %v", err)
	}
	if props["resolved_order_id"] != orderID ||
		props["resolved_customer_id"] != customerID ||
		props["resolved_product_id"] != productID ||
		props["product_resolution"] != "commerce_order_line_items" {
		t.Fatalf("resolved props=%+v want order=%s customer=%s product=%s", props, orderID, customerID, productID)
	}
}
