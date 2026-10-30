// SPDX-License-Identifier: AGPL-3.0-only
//
// Repository-level tests against a real Postgres. Skipped when DATABASE_URL is
// unset so the package stays hermetic by default.
package review_integrations

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func newReviewRepoTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed review repo tests")
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

func seedReviewRepoTenant(t *testing.T, pool *pgxpool.Pool, slug string) string {
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
		tenantID, slug, "Review Repo "+slug); err != nil {
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
		_, _ = conn.Exec(ctx, `DELETE FROM review_sync_runs WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = conn.Exec(ctx, `DELETE FROM review_webhook_events WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = conn.Exec(ctx, `DELETE FROM review_integrations WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = conn.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})
	return tenantID
}

func TestRepoUpsertIntegrationReconnectClearsDisconnectedYotpoState(t *testing.T) {
	pool := newReviewRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedReviewRepoTenant(t, pool, "review-reconnect-"+suffix)
	name := "Yotpo Reconnect " + suffix
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
INSERT INTO review_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings,
    sync_cursor, last_sync_at, error_message
) VALUES (
    $1::uuid, 'yotpo', $2, 'disconnected', ARRAY[]::text[], 'cred_old',
    $3::jsonb, 'yotpo_retry:stale', now() - interval '1 day', 'old failure'
)`, tenantID, name, `{
		"store_id":"old-store",
		"review_ingest_token":"old_token",
		"webhook_secret_ref":"old_secret",
		"provider_cleanup":{"status":"operator_action_required"}
	}`); err != nil {
		conn.Release()
		t.Fatalf("seed disconnected integration: %v", err)
	}
	conn.Release()

	out, err := repo.UpsertIntegration(ctx, tenantID, IntegrationInput{
		Provider:       ProviderYotpo,
		Name:           name,
		CredentialsRef: "cred_new",
		Settings: map[string]any{
			"store_id": "new-store",
		},
	})
	if err != nil {
		t.Fatalf("upsert reconnect: %v", err)
	}
	if out.Status != "connected" || out.CredentialsRef != "cred_new" || out.SyncCursor != "" || out.LastSyncAt != nil || out.ErrorMessage != "" {
		t.Fatalf("reconnected integration=%+v", out)
	}
	if settingString(out.Settings, "store_id") != "new-store" ||
		settingString(out.Settings, reviewIngestTokenSetting) != "" ||
		settingString(out.Settings, "webhook_secret_ref") != "" ||
		out.Settings["provider_cleanup"] != nil {
		t.Fatalf("stale settings survived reconnect: %+v", out.Settings)
	}
}

func TestRepoPauseIntegrationDoesNotResurrectDisconnectedYotpoRow(t *testing.T) {
	pool := newReviewRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedReviewRepoTenant(t, pool, "review-pause-"+suffix)
	name := "Yotpo Pause " + suffix
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		conn.Release()
		t.Fatalf("set tenant: %v", err)
	}
	var id string
	if err := conn.QueryRow(ctx, `
INSERT INTO review_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings
) VALUES (
    $1::uuid, 'yotpo', $2, 'disconnected', ARRAY[]::text[], 'cred_yotpo',
    '{"store_id":"pause-store","provider_cleanup":{"status":"operator_action_required"}}'::jsonb
)
RETURNING id::text`, tenantID, name).Scan(&id); err != nil {
		conn.Release()
		t.Fatalf("seed disconnected integration: %v", err)
	}
	conn.Release()

	if _, err := repo.PauseIntegration(ctx, tenantID, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("pause err=%v, want ErrNotFound", err)
	}
	out, err := repo.GetIntegration(ctx, tenantID, id)
	if err != nil {
		t.Fatalf("get integration: %v", err)
	}
	if out.Status != "disconnected" || out.Settings["provider_cleanup"] == nil {
		t.Fatalf("disconnected row changed: %+v", out)
	}
}

func TestRepoAcknowledgeProviderCleanupMergesYotpoEvidence(t *testing.T) {
	pool := newReviewRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedReviewRepoTenant(t, pool, "review-cleanup-ack-"+suffix)
	name := "Yotpo Cleanup Ack " + suffix
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		conn.Release()
		t.Fatalf("set tenant: %v", err)
	}
	var id string
	if err := conn.QueryRow(ctx, `
INSERT INTO review_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings
) VALUES (
    $1::uuid, 'yotpo', $2, 'disconnected', ARRAY[]::text[], 'cred_yotpo',
    '{"store_id":"ack-store","provider_cleanup":{"provider":"yotpo","status":"operator_action_required","recorded_at":"2026-06-29T13:00:00Z","managed_provider_cleanup":false,"provider_scope_id":"ack-store"}}'::jsonb
)
RETURNING id::text`, tenantID, name).Scan(&id); err != nil {
		conn.Release()
		t.Fatalf("seed disconnected integration: %v", err)
	}
	conn.Release()

	out, err := repo.AcknowledgeProviderCleanup(ctx, tenantID, id, ProviderCleanupAcknowledgementInput{
		CompletedActions: []string{"app_secret_or_api_credentials_rotated", "tokenized_ingest_urls_removed"},
		Notes:            "done in Yotpo",
		AcknowledgedBy:   "ops@example.com",
	}, time.Date(2026, 6, 29, 14, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("ack cleanup: %v", err)
	}
	cleanup, ok := out.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup missing: %+v", out.Settings)
	}
	if cleanup["status"] != "operator_acknowledged" ||
		cleanup["acknowledged_at"] != "2026-06-29T14:00:00Z" ||
		cleanup["acknowledged_by"] != "ops@example.com" ||
		cleanup["operator_notes"] != "done in Yotpo" ||
		cleanup["recorded_at"] != "2026-06-29T13:00:00Z" ||
		cleanup["managed_provider_cleanup"] != false ||
		cleanup["provider_scope_id"] != "ack-store" {
		t.Fatalf("cleanup=%+v", cleanup)
	}
	actions, ok := cleanup["completed_actions"].([]any)
	if !ok || len(actions) != 2 || actions[0] != "app_secret_or_api_credentials_rotated" || actions[1] != "tokenized_ingest_urls_removed" {
		t.Fatalf("completed actions=%T %+v", cleanup["completed_actions"], cleanup["completed_actions"])
	}
}

func TestRepoReviewCommerceResolversLeaveAmbiguousMatchesUnresolved(t *testing.T) {
	pool := newReviewRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedReviewRepoTenant(t, pool, "review-commerce-ambiguous-"+suffix)
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		conn.Release()
		t.Fatalf("set tenant: %v", err)
	}
	var commerceID string
	if err := conn.QueryRow(ctx, `
INSERT INTO commerce_integrations (tenant_id, provider, shop_domain, status)
VALUES ($1::uuid, 'shopify', $2, 'connected')
RETURNING id::text`, tenantID, "ambiguous-"+suffix+".myshopify.com").Scan(&commerceID); err != nil {
		conn.Release()
		t.Fatalf("seed commerce integration: %v", err)
	}
	if _, err := conn.Exec(ctx, `
INSERT INTO commerce_products (tenant_id, integration_id, source_id, title)
VALUES ($1::uuid, $2::uuid, 'P-1', 'First product'),
       ($1::uuid, $2::uuid, 'P-2', 'Second product')`, tenantID, commerceID); err != nil {
		conn.Release()
		t.Fatalf("seed commerce products: %v", err)
	}
	if _, err := conn.Exec(ctx, `
INSERT INTO commerce_orders (tenant_id, integration_id, source_id, customer_email)
VALUES ($1::uuid, $2::uuid, 'O-1', 'buyer@example.com'),
       ($1::uuid, $2::uuid, 'O-2', 'buyer@example.com')`, tenantID, commerceID); err != nil {
		conn.Release()
		t.Fatalf("seed commerce orders: %v", err)
	}
	if _, err := conn.Exec(ctx, `
INSERT INTO commerce_customers (tenant_id, integration_id, source_id, email)
VALUES ($1::uuid, $2::uuid, 'C-1', 'buyer@example.com'),
       ($1::uuid, $2::uuid, 'C-2', 'buyer@example.com')`, tenantID, commerceID); err != nil {
		conn.Release()
		t.Fatalf("seed commerce customers: %v", err)
	}
	conn.Release()

	integration := Integration{
		ID:       "review_ambiguous",
		TenantID: tenantID,
		Provider: ProviderYotpo,
		Settings: map[string]any{"commerce_integration_id": commerceID},
	}
	productID, err := repo.ResolveReviewProductID(ctx, tenantID, integration, ReviewInput{
		Metadata: map[string]any{"external_product_id": "P-1", "provider_product_id": "P-2"},
	})
	if err != nil {
		t.Fatalf("resolve product: %v", err)
	}
	if productID != "" {
		t.Fatalf("ambiguous product resolved to %q", productID)
	}
	orderID, err := repo.ResolveReviewOrderID(ctx, tenantID, integration, ReviewInput{
		Metadata: map[string]any{"external_order_id": "O-1", "provider_order_id": "O-2"},
	})
	if err != nil {
		t.Fatalf("resolve order: %v", err)
	}
	if orderID != "" {
		t.Fatalf("ambiguous order resolved to %q", orderID)
	}
	customerID, err := repo.ResolveReviewCustomerID(ctx, tenantID, integration, ReviewInput{
		ReviewerEmail: "buyer@example.com",
	})
	if err != nil {
		t.Fatalf("resolve customer: %v", err)
	}
	if customerID != "" {
		t.Fatalf("ambiguous customer resolved to %q", customerID)
	}
}

func TestRepoReviewWebhookClaimsAreIntegrationScopedAndBodyChecked(t *testing.T) {
	pool := newReviewRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedReviewRepoTenant(t, pool, "review-webhook-claim-"+suffix)
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		conn.Release()
		t.Fatalf("set tenant: %v", err)
	}
	var firstID, secondID string
	if err := conn.QueryRow(ctx, `
INSERT INTO review_integrations (tenant_id, provider, name, status, scopes, credentials_ref, settings)
VALUES ($1::uuid, 'yotpo', $2, 'connected', ARRAY[]::text[], 'cred_yotpo_1', '{}'::jsonb)
RETURNING id::text`, tenantID, "Yotpo Claim A "+suffix).Scan(&firstID); err != nil {
		conn.Release()
		t.Fatalf("seed first review integration: %v", err)
	}
	if err := conn.QueryRow(ctx, `
INSERT INTO review_integrations (tenant_id, provider, name, status, scopes, credentials_ref, settings)
VALUES ($1::uuid, 'yotpo', $2, 'connected', ARRAY[]::text[], 'cred_yotpo_2', '{}'::jsonb)
RETURNING id::text`, tenantID, "Yotpo Claim B "+suffix).Scan(&secondID); err != nil {
		conn.Release()
		t.Fatalf("seed second review integration: %v", err)
	}
	conn.Release()

	body := []byte(`{"id":"rv_1","score":5}`)
	claim, err := repo.ClaimReviewWebhook(ctx, tenantID, firstID, ProviderYotpo, "msg_1", "review_create", body)
	if err != nil || claim != WebhookClaimed {
		t.Fatalf("first claim=%q err=%v", claim, err)
	}
	if err := repo.MarkReviewWebhookProcessed(ctx, tenantID, firstID, ProviderYotpo, "msg_1"); err != nil {
		t.Fatalf("mark processed: %v", err)
	}
	claim, err = repo.ClaimReviewWebhook(ctx, tenantID, firstID, ProviderYotpo, "msg_1", "review_create", body)
	if err != nil || claim != WebhookProcessed {
		t.Fatalf("duplicate claim=%q err=%v", claim, err)
	}
	claim, err = repo.ClaimReviewWebhook(ctx, tenantID, secondID, ProviderYotpo, "msg_1", "review_create", body)
	if err != nil || claim != WebhookClaimed {
		t.Fatalf("second integration claim=%q err=%v", claim, err)
	}
	if _, err := repo.ClaimReviewWebhook(ctx, tenantID, firstID, ProviderYotpo, "msg_1", "review_create", []byte(`{"id":"rv_1","score":1}`)); !errors.Is(err, ErrReviewWebhookBodyMismatch) {
		t.Fatalf("different body err=%v, want ErrReviewWebhookBodyMismatch", err)
	}
}
