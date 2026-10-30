// SPDX-License-Identifier: AGPL-3.0-only
//
// Repository-level tests against a real Postgres. Skipped when DATABASE_URL is
// unset so the package stays hermetic by default.
package loyalty_integrations

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func newLoyaltyRepoTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed loyalty repo tests")
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

func seedLoyaltyRepoTenant(t *testing.T, pool *pgxpool.Pool, slug string) string {
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
		tenantID, slug, "Loyalty Repo "+slug); err != nil {
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
		_, _ = conn.Exec(ctx, `DELETE FROM loyalty_sync_runs WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = conn.Exec(ctx, `DELETE FROM loyalty_webhook_events WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = conn.Exec(ctx, `DELETE FROM loyalty_integrations WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = conn.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})
	return tenantID
}

func TestRepoUpsertIntegrationReconnectClearsDisconnectedSmileState(t *testing.T) {
	pool := newLoyaltyRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedLoyaltyRepoTenant(t, pool, "loyalty-reconnect-"+suffix)
	name := "Smile Reconnect " + suffix
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
INSERT INTO loyalty_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings,
    sync_cursor, last_sync_at, error_message
) VALUES (
    $1::uuid, 'smile', $2, 'disconnected', ARRAY[]::text[], 'cred_old',
    $3::jsonb, 'smile_retry:stale', now() - interval '1 day', 'old failure'
)`, tenantID, name, `{
		"shop_domain":"old.myshopify.com",
		"account_id":"old-account",
		"webhook_secret_ref":"old_secret",
		"provider_cleanup":{"status":"operator_action_required"}
	}`); err != nil {
		conn.Release()
		t.Fatalf("seed disconnected integration: %v", err)
	}
	conn.Release()

	out, err := repo.UpsertIntegration(ctx, tenantID, IntegrationInput{
		Provider:       ProviderSmile,
		Name:           name,
		CredentialsRef: "cred_new",
		Settings: map[string]any{
			"shop_domain": "new.myshopify.com",
			"account_id":  "new-account",
		},
	})
	if err != nil {
		t.Fatalf("upsert reconnect: %v", err)
	}
	if out.Status != "connected" || out.CredentialsRef != "cred_new" || out.SyncCursor != "" || out.LastSyncAt != nil || out.ErrorMessage != "" {
		t.Fatalf("reconnected integration=%+v", out)
	}
	if settingString(out.Settings, "shop_domain") != "new.myshopify.com" ||
		settingString(out.Settings, "account_id") != "new-account" ||
		settingString(out.Settings, "webhook_secret_ref") != "" ||
		out.Settings["provider_cleanup"] != nil {
		t.Fatalf("stale settings survived reconnect: %+v", out.Settings)
	}
}

func TestRepoPauseIntegrationDoesNotResurrectDisconnectedSmileRow(t *testing.T) {
	pool := newLoyaltyRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedLoyaltyRepoTenant(t, pool, "loyalty-pause-"+suffix)
	name := "Smile Pause " + suffix
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
INSERT INTO loyalty_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings
) VALUES (
    $1::uuid, 'smile', $2, 'disconnected', ARRAY[]::text[], 'cred_smile',
    '{"shop_domain":"pause.myshopify.com","account_id":"pause-account","provider_cleanup":{"status":"operator_action_required"}}'::jsonb
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

func TestRepoLoyaltyWebhookClaimsAreIntegrationScopedAndBodyChecked(t *testing.T) {
	pool := newLoyaltyRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedLoyaltyRepoTenant(t, pool, "loyalty-webhook-claim-"+suffix)
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
INSERT INTO loyalty_integrations (tenant_id, provider, name, status, scopes, credentials_ref, settings)
VALUES ($1::uuid, 'smile', $2, 'connected', ARRAY[]::text[], 'cred_smile_1', '{"account_id":"claim-a"}'::jsonb)
RETURNING id::text`, tenantID, "Smile Claim A "+suffix).Scan(&firstID); err != nil {
		conn.Release()
		t.Fatalf("seed first loyalty integration: %v", err)
	}
	if err := conn.QueryRow(ctx, `
INSERT INTO loyalty_integrations (tenant_id, provider, name, status, scopes, credentials_ref, settings)
VALUES ($1::uuid, 'smile', $2, 'connected', ARRAY[]::text[], 'cred_smile_2', '{"account_id":"claim-b"}'::jsonb)
RETURNING id::text`, tenantID, "Smile Claim B "+suffix).Scan(&secondID); err != nil {
		conn.Release()
		t.Fatalf("seed second loyalty integration: %v", err)
	}
	conn.Release()

	body := []byte(`{"id":"event_1","points":5}`)
	claim, err := repo.ClaimLoyaltyWebhook(ctx, tenantID, firstID, ProviderSmile, "msg_1", "customer/updated", body)
	if err != nil || claim != WebhookClaimed {
		t.Fatalf("first claim=%q err=%v", claim, err)
	}
	if err := repo.MarkLoyaltyWebhookProcessed(ctx, tenantID, firstID, ProviderSmile, "msg_1"); err != nil {
		t.Fatalf("mark processed: %v", err)
	}
	claim, err = repo.ClaimLoyaltyWebhook(ctx, tenantID, firstID, ProviderSmile, "msg_1", "customer/updated", body)
	if err != nil || claim != WebhookProcessed {
		t.Fatalf("duplicate claim=%q err=%v", claim, err)
	}
	claim, err = repo.ClaimLoyaltyWebhook(ctx, tenantID, secondID, ProviderSmile, "msg_1", "customer/updated", body)
	if err != nil || claim != WebhookClaimed {
		t.Fatalf("second integration claim=%q err=%v", claim, err)
	}
	if _, err := repo.ClaimLoyaltyWebhook(ctx, tenantID, firstID, ProviderSmile, "msg_1", "customer/updated", []byte(`{"id":"event_1","points":1}`)); !errors.Is(err, ErrLoyaltyWebhookBodyMismatch) {
		t.Fatalf("different body err=%v, want ErrLoyaltyWebhookBodyMismatch", err)
	}
}

func TestRepoListSmileBackfillTargetsDoesNotStarveDueTargetBehindFutureRetries(t *testing.T) {
	pool := newLoyaltyRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedLoyaltyRepoTenant(t, pool, "loyalty-backfill-due-"+suffix)
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		conn.Release()
		t.Fatalf("set tenant: %v", err)
	}
	notDue := encodeSmileRetryCursor(smileRetryState{
		Cursor:        smileCursorPrefix + "future",
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: time.Now().UTC().Add(time.Hour).Format(time.RFC3339),
	})
	if _, err := conn.Exec(ctx, `
INSERT INTO loyalty_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings,
    sync_cursor, last_sync_at, error_message, updated_at
)
SELECT $1::uuid, 'smile', 'Smile Future Retry ' || g::text || ' ' || $2, 'error',
       ARRAY[]::text[], 'cred_smile', jsonb_build_object('account_id', 'future-' || g::text || '-' || $2),
       $3, NULL, 'provider throttled', now() - interval '2 hours'
  FROM generate_series(1, $4::int) AS g`, tenantID, suffix, notDue, smileBackfillWorkerMaxCandidateScan); err != nil {
		conn.Release()
		t.Fatalf("seed future retry rows: %v", err)
	}
	var dueID string
	dueCursor := smileCursorPrefix + "due"
	if err := conn.QueryRow(ctx, `
INSERT INTO loyalty_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings,
    sync_cursor, last_sync_at, error_message, updated_at
) VALUES (
    $1::uuid, 'smile', $2, 'error', ARRAY[]::text[], 'cred_smile',
    $3::jsonb, $4, NULL, 'older failure', now()
)
RETURNING id::text`, tenantID, "Smile Due Retry "+suffix, `{"account_id":"due-`+suffix+`"}`, dueCursor).Scan(&dueID); err != nil {
		conn.Release()
		t.Fatalf("seed due integration: %v", err)
	}
	conn.Release()

	targets, err := repo.ListSmileBackfillTargets(ctx, 1, time.Now().UTC().Add(-time.Hour))
	if err != nil {
		t.Fatalf("list smile targets: %v", err)
	}
	if len(targets) != 1 || targets[0].IntegrationID != dueID || targets[0].Cursor != dueCursor {
		t.Fatalf("targets=%+v want due id=%s cursor=%q", targets, dueID, dueCursor)
	}
}
