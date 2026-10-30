// SPDX-License-Identifier: AGPL-3.0-only
//
// Repository-level tests against a real Postgres. Skipped when DATABASE_URL is
// unset so the package stays hermetic by default.
package subscription_integrations

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func newSubscriptionRepoTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed subscription repo tests")
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

func seedSubscriptionRepoTenant(t *testing.T, pool *pgxpool.Pool, slug string) string {
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
		tenantID, slug, "Subscription Repo "+slug); err != nil {
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
		_, _ = conn.Exec(ctx, `DELETE FROM subscription_sync_runs WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = conn.Exec(ctx, `DELETE FROM subscription_integrations WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = conn.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})
	return tenantID
}

func TestRepoUpsertIntegrationReconnectClearsDisconnectedRechargeState(t *testing.T) {
	pool := newSubscriptionRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedSubscriptionRepoTenant(t, pool, "subscription-reconnect-"+suffix)
	name := "Recharge Reconnect " + suffix
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
INSERT INTO subscription_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings,
    sync_cursor, last_sync_at, error_message
) VALUES (
    $1::uuid, 'recharge', $2, 'disconnected', ARRAY[]::text[], 'cred_old',
    $3::jsonb, 'recharge_retry:stale', now() - interval '1 day', 'old failure'
)`, tenantID, name, `{
		"store_domain":"old.myshopify.com",
		"webhook_secret_ref":"old_secret",
		"recharge_webhook_id":"old_webhook",
		"provider_cleanup":{"status":"operator_action_required"}
	}`); err != nil {
		conn.Release()
		t.Fatalf("seed disconnected integration: %v", err)
	}
	conn.Release()

	out, err := repo.UpsertIntegration(ctx, tenantID, IntegrationInput{
		Provider:       ProviderRecharge,
		Name:           name,
		CredentialsRef: "cred_new",
		Settings: map[string]any{
			"store_domain": "new.myshopify.com",
		},
	})
	if err != nil {
		t.Fatalf("upsert reconnect: %v", err)
	}
	if out.Status != "connected" || out.CredentialsRef != "cred_new" || out.SyncCursor != "" || out.LastSyncAt != nil || out.ErrorMessage != "" {
		t.Fatalf("reconnected integration=%+v", out)
	}
	if settingString(out.Settings, "store_domain") != "new.myshopify.com" ||
		settingString(out.Settings, "webhook_secret_ref") != "" ||
		settingString(out.Settings, "recharge_webhook_id") != "" ||
		out.Settings["provider_cleanup"] != nil {
		t.Fatalf("stale settings survived reconnect: %+v", out.Settings)
	}
}

func TestRepoPauseIntegrationDoesNotResurrectDisconnectedRechargeRow(t *testing.T) {
	pool := newSubscriptionRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedSubscriptionRepoTenant(t, pool, "subscription-pause-"+suffix)
	name := "Recharge Pause " + suffix
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
INSERT INTO subscription_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings
) VALUES (
    $1::uuid, 'recharge', $2, 'disconnected', ARRAY[]::text[], 'cred_recharge',
    '{"store_domain":"pause.myshopify.com","provider_cleanup":{"status":"operator_action_required"}}'::jsonb
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

func TestRepoAcknowledgeProviderCleanupMergesRechargeEvidence(t *testing.T) {
	pool := newSubscriptionRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedSubscriptionRepoTenant(t, pool, "subscription-cleanup-ack-"+suffix)
	name := "Recharge Cleanup Ack " + suffix
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
INSERT INTO subscription_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings
) VALUES (
    $1::uuid, 'recharge', $2, 'disconnected', ARRAY[]::text[], 'cred_recharge',
    '{"store_domain":"ack.myshopify.com","provider_cleanup":{"provider":"recharge","status":"operator_action_required","recorded_at":"2026-06-29T13:00:00Z","managed_provider_cleanup":false,"provider_scope_id":"ack.myshopify.com"}}'::jsonb
)
RETURNING id::text`, tenantID, name).Scan(&id); err != nil {
		conn.Release()
		t.Fatalf("seed disconnected integration: %v", err)
	}
	conn.Release()

	out, err := repo.AcknowledgeProviderCleanup(ctx, tenantID, id, ProviderCleanupAcknowledgementInput{
		CompletedActions: []string{"api_token_revoked_or_rotated", "tokenized_ingest_urls_removed"},
		Notes:            "done in Recharge",
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
		cleanup["operator_notes"] != "done in Recharge" ||
		cleanup["recorded_at"] != "2026-06-29T13:00:00Z" ||
		cleanup["managed_provider_cleanup"] != false ||
		cleanup["provider_scope_id"] != "ack.myshopify.com" {
		t.Fatalf("cleanup=%+v", cleanup)
	}
	actions, ok := cleanup["completed_actions"].([]any)
	if !ok || len(actions) != 2 || actions[0] != "api_token_revoked_or_rotated" || actions[1] != "tokenized_ingest_urls_removed" {
		t.Fatalf("completed actions=%T %+v", cleanup["completed_actions"], cleanup["completed_actions"])
	}
}

func TestRepoAcknowledgeProviderCleanupMergesNonRechargeEvidence(t *testing.T) {
	pool := newSubscriptionRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedSubscriptionRepoTenant(t, pool, "subscription-cleanup-ack-chargebee-"+suffix)
	name := "Chargebee Cleanup Ack " + suffix
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
INSERT INTO subscription_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings
) VALUES (
    $1::uuid, 'chargebee', $2, 'disconnected', ARRAY[]::text[], 'cred_chargebee',
    '{"site_id":"ack-site","provider_cleanup":{"provider":"chargebee","status":"operator_action_required","recorded_at":"2026-07-02T13:00:00Z","managed_provider_cleanup":false,"provider_scope_id":"ack-site"}}'::jsonb
)
RETURNING id::text`, tenantID, name).Scan(&id); err != nil {
		conn.Release()
		t.Fatalf("seed disconnected integration: %v", err)
	}
	conn.Release()

	out, err := repo.AcknowledgeProviderCleanup(ctx, tenantID, id, ProviderCleanupAcknowledgementInput{
		CompletedActions: []string{"api_token_revoked_or_rotated"},
		Notes:            "done in Chargebee",
		AcknowledgedBy:   "ops@example.com",
	}, time.Date(2026, 7, 2, 14, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("ack cleanup: %v", err)
	}
	cleanup, ok := out.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup missing: %+v", out.Settings)
	}
	if cleanup["provider"] != ProviderChargebee ||
		cleanup["status"] != "operator_acknowledged" ||
		cleanup["acknowledged_at"] != "2026-07-02T14:00:00Z" ||
		cleanup["operator_notes"] != "done in Chargebee" ||
		cleanup["provider_scope_id"] != "ack-site" {
		t.Fatalf("cleanup=%+v", cleanup)
	}
}
