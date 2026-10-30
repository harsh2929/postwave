// SPDX-License-Identifier: AGPL-3.0-only

package retention

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/assurancelegalhold"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
)

func sendingIdentityTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping sending-identity privacy lifecycle test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	config.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatalf("connect application pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedSendingIdentityTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin tenant seed: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'sending identity privacy test', $2, 'studio')`,
		tenantID, "sending-identity-"+strings.ReplaceAll(tenantID, "-", "")); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	campaignID := uuid.NewString()
	if _, err := tx.Exec(ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, body_html, status)
VALUES ($1::uuid, $2::uuid, 'privacy lifecycle campaign', 'privacy', '', 'draft')`,
		campaignID, tenantID); err != nil {
		t.Fatalf("seed campaign: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
	return campaignID
}

func cleanupSendingIdentityTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Logf("begin tenant cleanup: %v", err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); err != nil {
		t.Logf("delete test tenant: %v", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		t.Logf("commit tenant cleanup: %v", err)
	}
}

func TestSendingIdentityPrivacyLifecycle_DB(t *testing.T) {
	pool := sendingIdentityTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	var bypassRLS, appRole bool
	if err := pool.QueryRow(ctx, `
SELECT role.rolsuper OR role.rolbypassrls,
       pg_has_role(current_user, 'postwave_app', 'member')
  FROM pg_roles AS role
 WHERE role.rolname = current_user`).Scan(&bypassRLS, &appRole); err != nil {
		t.Fatalf("inspect application database role: %v", err)
	}
	if bypassRLS || !appRole {
		t.Fatalf("DATABASE_URL must use a non-BYPASSRLS postwave_app role; bypass=%v member=%v",
			bypassRLS, appRole)
	}

	for _, object := range []struct {
		kind string
		name string
	}{
		{kind: "index", name: "subscriber_send_log_retention_idx"},
		{kind: "index", name: "intelligent_retry_events_retention_idx"},
		{kind: "policy", name: "subscriber_send_log_retention_worker_select"},
		{kind: "policy", name: "intelligent_retry_events_retention_worker_select"},
	} {
		var exists bool
		var err error
		if object.kind == "index" {
			err = pool.QueryRow(ctx, `
SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND indexname=$1)`,
				object.name).Scan(&exists)
		} else {
			err = pool.QueryRow(ctx, `
SELECT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND policyname=$1)`,
				object.name).Scan(&exists)
		}
		if err != nil {
			t.Fatalf("inspect %s %s: %v", object.kind, object.name, err)
		}
		if !exists {
			t.Fatalf("migration 2037 %s %s is not applied", object.kind, object.name)
		}
	}

	tenantID := uuid.NewString()
	otherTenantID := uuid.NewString()
	campaignID := seedSendingIdentityTenant(t, pool, tenantID)
	otherCampaignID := seedSendingIdentityTenant(t, pool, otherTenantID)
	t.Cleanup(func() {
		cleanupSendingIdentityTenant(t, pool, tenantID)
		cleanupSendingIdentityTenant(t, pool, otherTenantID)
	})

	const (
		retentionEmail = "retention-window@example.test"
		crossEmail     = "cross-tenant-sending-identity@example.test"
		crossAlias     = "cross-tenant-sending-alias@example.test"
	)
	seedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin lifecycle fixture seed: %v", err)
	}
	defer func() { _ = seedTx.Rollback(context.Background()) }()
	for _, email := range []string{retentionEmail, crossEmail} {
		if _, err := seedTx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, primary_email, status, consent_source)
VALUES ($1::uuid, $2::citext, $2::citext, 'enabled', 'api')`, tenantID, email); err != nil {
			t.Fatalf("seed subscriber %s: %v", email, err)
		}
	}
	var crossSubscriberID string
	if err := seedTx.QueryRow(ctx, `
SELECT id::text FROM subscribers WHERE tenant_id=$1::uuid AND email=$2::citext`,
		tenantID, crossEmail).Scan(&crossSubscriberID); err != nil {
		t.Fatalf("load cross-tenant canary subscriber id: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO subscriber_emails
    (tenant_id, subscriber_id, email, is_primary, consent_status, suppressed)
VALUES ($1::uuid, $2::uuid, $3::citext, false, 'never_subscribed', false)
ON CONFLICT DO NOTHING`, tenantID, crossSubscriberID, crossAlias); err != nil {
		t.Fatalf("seed cross-tenant canary alias: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO subscriber_send_log
    (tenant_id, subscriber_email, campaign_id, channel, sent_at)
VALUES
    ($1::uuid, $2::citext, $3::uuid, 'email', now() - interval '40 days'),
    ($1::uuid, $2::citext, $3::uuid, 'email', now() - interval '35 days'),
    ($1::uuid, $2::citext, $3::uuid, 'email', now() - interval '29 days'),
    ($1::uuid, $4::citext, $3::uuid, 'email', now()),
    ($1::uuid, $5::citext, $3::uuid, 'email', now())`,
		tenantID, retentionEmail, campaignID, crossEmail, crossAlias); err != nil {
		t.Fatalf("seed subscriber send log: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO intelligent_retry_events
    (tenant_id, campaign_id, subscriber_email, reason, status,
     retry_after, created_at, updated_at)
VALUES
    ($1::uuid, $2::uuid, $3::citext, 'expired-pending', 'pending', now(),
     now() - interval '40 days', now()),
    ($1::uuid, $2::uuid, $3::citext, 'expired-stale-lease', 'retrying', now(),
     now() - interval '40 days', now() - interval '31 minutes'),
    ($1::uuid, $2::uuid, $3::citext, 'expired-live-lease', 'retrying', now(),
     now() - interval '40 days', now()),
    ($1::uuid, $2::uuid, $3::citext, 'fresh-terminal', 'retried', now(),
     now() - interval '29 days', now()),
    ($1::uuid, $2::uuid, $4::citext, 'erase-primary', 'pending', now(), now(), now()),
    ($1::uuid, $2::uuid, $5::citext, 'erase-alias', 'failed', now(), now(), now())`,
		tenantID, campaignID, retentionEmail, crossEmail, crossAlias); err != nil {
		t.Fatalf("seed intelligent retry events: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit lifecycle fixture seed: %v", err)
	}

	otherTx, err := db.WithTenant(ctx, pool, otherTenantID)
	if err != nil {
		t.Fatalf("begin cross-tenant seed: %v", err)
	}
	defer func() { _ = otherTx.Rollback(context.Background()) }()
	if _, err := otherTx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, primary_email, status, consent_source)
VALUES ($1::uuid, $2::citext, $2::citext, 'enabled', 'api')`,
		otherTenantID, crossEmail); err != nil {
		t.Fatalf("seed cross-tenant subscriber: %v", err)
	}
	if _, err := otherTx.Exec(ctx, `
INSERT INTO subscriber_send_log (tenant_id, subscriber_email, campaign_id, channel)
VALUES ($1::uuid, $2::citext, $3::uuid, 'email')`,
		otherTenantID, crossEmail, otherCampaignID); err != nil {
		t.Fatalf("seed cross-tenant send log: %v", err)
	}
	if _, err := otherTx.Exec(ctx, `
INSERT INTO intelligent_retry_events
    (tenant_id, campaign_id, subscriber_email, reason, status)
VALUES ($1::uuid, $3::uuid, $2::citext, 'cross-tenant-canary', 'pending')`,
		otherTenantID, crossEmail, otherCampaignID); err != nil {
		t.Fatalf("seed cross-tenant retry event: %v", err)
	}
	if err := otherTx.Commit(ctx); err != nil {
		t.Fatalf("commit cross-tenant canaries: %v", err)
	}

	for _, table := range []string{"subscriber_send_log", "intelligent_retry_events"} {
		var visible int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE tenant_id=$1::uuid`, tenantID).Scan(&visible); err != nil {
			t.Fatalf("unscoped %s read: %v", table, err)
		}
		if visible != 0 {
			t.Fatalf("unscoped caller saw %d %s rows", visible, table)
		}
	}

	genericWorker, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatalf("begin generic worker scope: %v", err)
	}
	for _, table := range []string{"subscriber_send_log", "intelligent_retry_events"} {
		var visible int
		if err := genericWorker.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE tenant_id=$1::uuid`, tenantID).Scan(&visible); err != nil {
			_ = genericWorker.Rollback(ctx)
			t.Fatalf("generic-worker %s read: %v", table, err)
		}
		if visible != 0 {
			_ = genericWorker.Rollback(ctx)
			t.Fatalf("generic outbox worker saw %d %s rows without retention capability", visible, table)
		}
	}
	_ = genericWorker.Rollback(ctx)

	retentionWorker, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatalf("begin retention worker scope: %v", err)
	}
	if _, err := retentionWorker.Exec(ctx, `
SELECT set_config('app.tenant_id', $1, true),
       set_config('app.retention_worker', 'true', true)`, workerNoTenantID); err != nil {
		_ = retentionWorker.Rollback(ctx)
		t.Fatalf("bind retention worker capabilities: %v", err)
	}
	for _, table := range []string{"subscriber_send_log", "intelligent_retry_events"} {
		var visible int
		if err := retentionWorker.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE tenant_id=$1::uuid`, tenantID).Scan(&visible); err != nil {
			_ = retentionWorker.Rollback(ctx)
			t.Fatalf("retention-worker %s read: %v", table, err)
		}
		if visible == 0 {
			_ = retentionWorker.Rollback(ctx)
			t.Fatalf("retention worker could not discover %s tenant", table)
		}
		tag, err := retentionWorker.Exec(ctx, `DELETE FROM `+table+` WHERE tenant_id=$1::uuid`, tenantID)
		if err != nil {
			_ = retentionWorker.Rollback(ctx)
			t.Fatalf("retention-worker %s DELETE proof: %v", table, err)
		}
		if tag.RowsAffected() != 0 {
			_ = retentionWorker.Rollback(ctx)
			t.Fatalf("cross-tenant retention worker deleted %d %s rows", tag.RowsAffected(), table)
		}
	}
	_ = retentionWorker.Rollback(ctx)

	sweeper := &Sweeper{Pool: pool, Privacy: fakePrivacy{days: 30}, BatchSize: 1, MaxBatchesPerTenant: 10}
	tenants, err := sweeper.listTenants(ctx)
	if err != nil {
		t.Fatalf("discover retention tenants: %v", err)
	}
	containsTenant := false
	for _, id := range tenants {
		if id == tenantID {
			containsTenant = true
			break
		}
	}
	if !containsTenant {
		t.Fatalf("sending identity tenant %s absent from discovery: %v", tenantID, tenants)
	}
	if deleted, err := sweeper.sweepSubscriberSendLog(ctx, tenantID, 30); err != nil || deleted != 2 {
		t.Fatalf("subscriber send-log sweep deleted=%d err=%v, want 2", deleted, err)
	}
	if deleted, err := sweeper.sweepIntelligentRetryEvents(ctx, tenantID, 30); err != nil || deleted != 2 {
		t.Fatalf("intelligent-retry sweep deleted=%d err=%v, want 2", deleted, err)
	}

	verifyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin retention verification: %v", err)
	}
	var expiredSends, freshSends, expiredPending, staleLease, liveLease, freshTerminal int
	if err := verifyTx.QueryRow(ctx, `
SELECT
  count(*) FILTER (WHERE subscriber_email=$2::citext AND sent_at < now() - interval '30 days'),
  count(*) FILTER (WHERE subscriber_email=$2::citext AND sent_at >= now() - interval '30 days')
FROM subscriber_send_log WHERE tenant_id=$1::uuid`, tenantID, retentionEmail).Scan(&expiredSends, &freshSends); err != nil {
		_ = verifyTx.Rollback(ctx)
		t.Fatalf("verify send-log retention: %v", err)
	}
	if err := verifyTx.QueryRow(ctx, `
SELECT
  count(*) FILTER (WHERE reason='expired-pending'),
  count(*) FILTER (WHERE reason='expired-stale-lease'),
  count(*) FILTER (WHERE reason='expired-live-lease'),
  count(*) FILTER (WHERE reason='fresh-terminal')
FROM intelligent_retry_events WHERE tenant_id=$1::uuid`, tenantID).Scan(
		&expiredPending, &staleLease, &liveLease, &freshTerminal,
	); err != nil {
		_ = verifyTx.Rollback(ctx)
		t.Fatalf("verify intelligent-retry retention: %v", err)
	}
	_ = verifyTx.Rollback(ctx)
	if expiredSends != 0 || freshSends != 1 || expiredPending != 0 || staleLease != 0 || liveLease != 1 || freshTerminal != 1 {
		t.Fatalf("retention result expired/fresh sends=%d/%d retry pending/stale/live/fresh=%d/%d/%d/%d",
			expiredSends, freshSends, expiredPending, staleLease, liveLease, freshTerminal)
	}

	for _, tenant := range []struct {
		id   string
		want int
	}{
		{id: tenantID, want: 4},
		{id: otherTenantID, want: 2},
	} {
		tx, err := db.WithTenant(ctx, pool, tenant.id)
		if err != nil {
			t.Fatalf("begin final verification for %s: %v", tenant.id, err)
		}
		var count int
		if err := tx.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM subscriber_send_log
    WHERE tenant_id=$1::uuid AND lower(btrim(subscriber_email::text)) IN (lower($2), lower($3)))
  +
  (SELECT count(*) FROM intelligent_retry_events
    WHERE tenant_id=$1::uuid AND lower(btrim(subscriber_email::text)) IN (lower($2), lower($3)))`,
			tenant.id, crossEmail, crossAlias).Scan(&count); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("verify final sending identity count for %s: %v", tenant.id, err)
		}
		_ = tx.Rollback(ctx)
		if count != tenant.want {
			t.Fatalf("tenant %s retained %d subject rows, want %d", tenant.id, count, tenant.want)
		}
	}
}

func TestSendingIdentityRetentionLegalHoldsAndAggregateReceipts_DB(t *testing.T) {
	pool := sendingIdentityTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	var bypassRLS, appRole bool
	if err := pool.QueryRow(ctx, `
SELECT role.rolsuper OR role.rolbypassrls,
       pg_has_role(current_user, 'postwave_app', 'member')
  FROM pg_roles AS role
 WHERE role.rolname = current_user`).Scan(&bypassRLS, &appRole); err != nil {
		t.Fatalf("inspect application database role: %v", err)
	}
	if bypassRLS || !appRole {
		t.Fatalf("DATABASE_URL must use a non-BYPASSRLS postwave_app role; bypass=%v member=%v",
			bypassRLS, appRole)
	}

	tenantID := uuid.NewString()
	heldCampaignID := seedSendingIdentityTenant(t, pool, tenantID)
	freeCampaignID := uuid.NewString()
	t.Cleanup(func() { cleanupSendingIdentityTenant(t, pool, tenantID) })

	const (
		heldEmail = "held-sending-identity@example.test"
		freeEmail = "free-sending-identity@example.test"
	)
	seedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin legal-hold fixture seed: %v", err)
	}
	defer func() { _ = seedTx.Rollback(context.Background()) }()
	if _, err := seedTx.Exec(ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, body_html, status)
VALUES ($1::uuid, $2::uuid, 'free retention campaign', 'privacy', '', 'draft')`,
		freeCampaignID, tenantID); err != nil {
		t.Fatalf("seed free campaign: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO subscriber_send_log
    (tenant_id, subscriber_email, campaign_id, channel, sent_at)
VALUES
    ($1::uuid, $2::citext, $3::uuid, 'email', now() - interval '40 days'),
    ($1::uuid, $4::citext, $5::uuid, 'email', now() - interval '40 days')`,
		tenantID, heldEmail, heldCampaignID, freeEmail, freeCampaignID); err != nil {
		t.Fatalf("seed held/free send logs: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO intelligent_retry_events
    (tenant_id, campaign_id, subscriber_email, reason, status,
     retry_after, created_at, updated_at)
VALUES
    ($1::uuid, $2::uuid, $3::citext, 'campaign-hold', 'pending', now(),
     now() - interval '40 days', now()),
    ($1::uuid, $4::uuid, $5::citext, 'free', 'pending', now(),
     now() - interval '40 days', now())`,
		tenantID, heldCampaignID, heldEmail, freeCampaignID, freeEmail); err != nil {
		t.Fatalf("seed held/free retry events: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit legal-hold fixture seed: %v", err)
	}

	// A campaign hold placed after the rows expired still protects exactly that
	// campaign while unrelated expired operational state continues to purge.
	campaignHold, err := assurancelegalhold.Place(ctx, pool, assurancelegalhold.PlaceInput{
		TenantID:   tenantID,
		CampaignID: heldCampaignID,
		Reason:     "R46 campaign preservation proof",
	})
	if err != nil {
		t.Fatalf("place campaign-scoped legal hold: %v", err)
	}
	sweeper := &Sweeper{Pool: pool, Privacy: fakePrivacy{days: 30}, BatchSize: 20, MaxBatchesPerTenant: 10}
	if deleted, err := sweeper.sweepSubscriberSendLog(ctx, tenantID, 30); err != nil || deleted != 1 {
		t.Fatalf("campaign-held send-log sweep deleted=%d err=%v, want 1 unrelated row", deleted, err)
	}
	if deleted, err := sweeper.sweepIntelligentRetryEvents(ctx, tenantID, 30); err != nil || deleted != 1 {
		t.Fatalf("campaign-held retry sweep deleted=%d err=%v, want 1 unrelated row", deleted, err)
	}

	assertRemaining := func(stage string, want int) {
		t.Helper()
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("%s: begin verification: %v", stage, err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		for _, table := range []string{subscriberSendLogDataClass, intelligentRetryEventsDataClass} {
			var count int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE tenant_id=$1::uuid`, tenantID).Scan(&count); err != nil {
				t.Fatalf("%s: count %s: %v", stage, table, err)
			}
			if count != want {
				t.Fatalf("%s: %s rows=%d, want %d", stage, table, count, want)
			}
		}
	}
	assertReceiptRows := func(stage string, want int) {
		t.Helper()
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("%s: begin receipt verification: %v", stage, err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		var count int
		if err := tx.QueryRow(ctx, `
SELECT count(*) FROM audit_log
 WHERE tenant_id=$1::uuid
   AND action=$2
   AND actor_label=$3`, tenantID, audit.PurgeAction, sendingIdentityPurgeActorLabel).Scan(&count); err != nil {
			t.Fatalf("%s: count purge receipts: %v", stage, err)
		}
		if count != want {
			t.Fatalf("%s: purge receipt rows=%d, want %d", stage, count, want)
		}
	}
	assertRemaining("campaign hold", 1)
	assertReceiptRows("campaign hold", 2)

	if err := assurancelegalhold.Release(ctx, pool, assurancelegalhold.ReleaseInput{
		TenantID: tenantID,
		HoldID:   campaignHold.ID,
		Reason:   "switching to tenant-wide preservation proof",
	}); err != nil {
		t.Fatalf("release campaign-scoped legal hold: %v", err)
	}
	tenantHold, err := assurancelegalhold.Place(ctx, pool, assurancelegalhold.PlaceInput{
		TenantID: tenantID,
		Reason:   "R46 tenant-wide preservation proof",
	})
	if err != nil {
		t.Fatalf("place tenant-wide legal hold: %v", err)
	}

	// Tenant-wide scope protects every campaign, including operational rows
	// created after the hold was placed.
	postHoldTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin post-hold seed: %v", err)
	}
	defer func() { _ = postHoldTx.Rollback(context.Background()) }()
	if _, err := postHoldTx.Exec(ctx, `
INSERT INTO subscriber_send_log
    (tenant_id, subscriber_email, campaign_id, channel, sent_at)
VALUES ($1::uuid, $2::citext, $3::uuid, 'email', now() - interval '40 days')`,
		tenantID, freeEmail, freeCampaignID); err != nil {
		t.Fatalf("seed send log after tenant hold: %v", err)
	}
	if _, err := postHoldTx.Exec(ctx, `
INSERT INTO intelligent_retry_events
    (tenant_id, campaign_id, subscriber_email, reason, status,
     retry_after, created_at, updated_at)
VALUES ($1::uuid, $2::uuid, $3::citext, 'tenant-hold', 'pending', now(),
        now() - interval '40 days', now())`,
		tenantID, freeCampaignID, freeEmail); err != nil {
		t.Fatalf("seed retry event after tenant hold: %v", err)
	}
	if err := postHoldTx.Commit(ctx); err != nil {
		t.Fatalf("commit post-hold seed: %v", err)
	}
	if deleted, err := sweeper.sweepSubscriberSendLog(ctx, tenantID, 30); err != nil || deleted != 0 {
		t.Fatalf("tenant-held send-log sweep deleted=%d err=%v, want 0", deleted, err)
	}
	if deleted, err := sweeper.sweepIntelligentRetryEvents(ctx, tenantID, 30); err != nil || deleted != 0 {
		t.Fatalf("tenant-held retry sweep deleted=%d err=%v, want 0", deleted, err)
	}
	assertRemaining("tenant-wide hold", 2)
	assertReceiptRows("tenant-wide hold", 2) // zero-row sweeps emit no receipt

	if err := assurancelegalhold.Release(ctx, pool, assurancelegalhold.ReleaseInput{
		TenantID: tenantID,
		HoldID:   tenantHold.ID,
		Reason:   "R46 preservation proof complete",
	}); err != nil {
		t.Fatalf("release tenant-wide legal hold: %v", err)
	}
	if deleted, err := sweeper.sweepSubscriberSendLog(ctx, tenantID, 30); err != nil || deleted != 2 {
		t.Fatalf("released send-log sweep deleted=%d err=%v, want 2", deleted, err)
	}
	if deleted, err := sweeper.sweepIntelligentRetryEvents(ctx, tenantID, 30); err != nil || deleted != 2 {
		t.Fatalf("released retry sweep deleted=%d err=%v, want 2", deleted, err)
	}
	assertRemaining("released holds", 0)
	assertReceiptRows("released holds", 4)

	// One aggregate receipt per non-empty (tenant, table, batch). Its tenant
	// column and content-free metadata prove what policy removed how many rows;
	// neither recipient/campaign identity nor deleted row ids are recorded.
	verifyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin aggregate receipt verification: %v", err)
	}
	defer func() { _ = verifyTx.Rollback(context.Background()) }()
	rows, err := verifyTx.Query(ctx, `
SELECT tenant_id::text, resource_type, resource_id,
       metadata->>'data_class',
       (metadata->>'deleted_count')::bigint,
       (metadata->>'retention_days')::int,
       metadata->>'cutoff_at',
       metadata->>'oldest_deleted_at',
       metadata->>'newest_deleted_at',
       metadata->>'retention_source',
       metadata->>'legal_hold_predicate',
       metadata::text
  FROM audit_log
 WHERE tenant_id=$1::uuid
   AND action=$2
   AND actor_label=$3
 ORDER BY id`, tenantID, audit.PurgeAction, sendingIdentityPurgeActorLabel)
	if err != nil {
		t.Fatalf("query aggregate purge receipts: %v", err)
	}
	defer rows.Close()
	counts := map[string]int64{}
	receipts := map[string]int{}
	for rows.Next() {
		var (
			receiptTenant, resourceType, resourceID, dataClass string
			cutoff, oldest, newest, source, holdPredicate, raw string
			deleted                                            int64
			days                                               int
		)
		if err := rows.Scan(
			&receiptTenant, &resourceType, &resourceID, &dataClass,
			&deleted, &days, &cutoff, &oldest, &newest, &source,
			&holdPredicate, &raw,
		); err != nil {
			t.Fatalf("scan aggregate purge receipt: %v", err)
		}
		if receiptTenant != tenantID || resourceType != sendingIdentityPurgeResourceType || resourceID != dataClass {
			t.Errorf("receipt scope tenant=%q type=%q id=%q class=%q",
				receiptTenant, resourceType, resourceID, dataClass)
		}
		if days != 30 || cutoff == "" || oldest == "" || newest == "" ||
			source != sendingIdentityRetentionSource || holdPredicate != sendingIdentityLegalHoldPolicy {
			t.Errorf("receipt policy fields days=%d cutoff=%q oldest=%q newest=%q source=%q hold=%q",
				days, cutoff, oldest, newest, source, holdPredicate)
		}
		for _, identity := range []string{heldEmail, freeEmail, heldCampaignID, freeCampaignID} {
			if strings.Contains(raw, identity) {
				t.Errorf("aggregate receipt leaked identity %q: %s", identity, raw)
			}
		}
		counts[dataClass] += deleted
		receipts[dataClass]++
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate aggregate purge receipts: %v", err)
	}
	for _, dataClass := range []string{subscriberSendLogDataClass, intelligentRetryEventsDataClass} {
		if counts[dataClass] != 3 || receipts[dataClass] != 2 {
			t.Errorf("%s receipt aggregate count=%d rows=%d, want count=3 rows=2",
				dataClass, counts[dataClass], receipts[dataClass])
		}
	}
}
