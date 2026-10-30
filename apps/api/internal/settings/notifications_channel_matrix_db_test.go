// SPDX-License-Identifier: AGPL-3.0-only
package settings

import (
	"context"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// SETC-037: the channel matrix (in-app + webhook) must round-trip through
// Upsert, and a partial PATCH must preserve every column it does not name —
// including the webhook URL and the per-category webhook flags. This is the
// raw-$n ON CONFLICT preserve contract (an EXCLUDED/COALESCE mix would silently
// resurrect defaults for omitted fields).
func TestNotificationsUpsert_ChannelMatrixRoundTripAndPreserve_DB(t *testing.T) {
	pool := notifDB(t)
	ctx := context.Background()

	tenantID := "00000000-0000-4000-8000-00b0e6600021"
	userID := "00000000-0000-4000-8000-00b0e660002a"

	// Seed under a tenant-bound tx: the tenants INSERT RLS policy requires
	// app.tenant_id to already equal the new row's id (raw superuser bypass is
	// deliberately unavailable — postwave_app is non-privileged).
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin seed tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("bind tenant guc: %v", err)
	}
	_, _ = tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID) // idempotent rerun
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, 'notif-matrix-test', 'notif-matrix-test', 'studio')`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant (needs pre-seeded DB): %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO users (id, tenant_id, external_user_id, email, role)
VALUES ($1::uuid, $2::uuid, 'notif-matrix-user', 'u@notif-matrix.test', 'owner')`, userID, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed user: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() { deleteNotifTenant(t, pool, tenantID) })

	repo := &NotificationsRepo{Pool: pool}

	// First write CREATES the row. It sets only one webhook flag — so this
	// exercises the INSERT defaults: in-app ON (behavior-preservation contract:
	// existing users keep exactly today's delivery, previously conflated into
	// email_on_*), other webhooks OFF, URL empty, kind "slack".
	on := true
	first, err := repo.Upsert(ctx, tenantID, userID, NotificationsPatch{
		WebhookOnBounceAlert: &on,
	})
	if err != nil {
		t.Fatalf("Upsert create: %v", err)
	}
	if !first.InAppOnBounceAlert || !first.InAppOnUsageAlert {
		t.Fatalf("default in-app must be ON: %+v", first)
	}
	if !first.WebhookOnBounceAlert {
		t.Fatalf("webhook_on_bounce must persist: %+v", first)
	}
	if first.WebhookOnUsageAlert {
		t.Fatalf("only bounce webhook was enabled, usage must stay OFF: %+v", first)
	}
	if first.NotificationWebhookURL != "" {
		t.Fatalf("default webhook URL must be empty: %q", first.NotificationWebhookURL)
	}
	if first.NotificationWebhookKind != "slack" {
		t.Fatalf("default webhook kind must be slack, got %q", first.NotificationWebhookKind)
	}

	// Now add a URL + switch kind to generic; the existing webhook flag must
	// survive (raw-$n preserve).
	url := "https://hooks.example.com/services/T000/B000/xyz"
	kind := "generic"
	withURL, err := repo.Upsert(ctx, tenantID, userID, NotificationsPatch{
		NotificationWebhookURL:  &url,
		NotificationWebhookKind: &kind,
	})
	if err != nil {
		t.Fatalf("Upsert url+kind: %v", err)
	}
	if withURL.NotificationWebhookURL != url || withURL.NotificationWebhookKind != "generic" {
		t.Fatalf("webhook url/kind did not persist: %+v", withURL)
	}
	if !withURL.WebhookOnBounceAlert {
		t.Fatalf("adding a URL wrongly cleared the webhook flag: %+v", withURL)
	}

	// A later partial PATCH that names only in-app must PRESERVE the webhook URL
	// and the per-category webhook flag (raw-$n preserve, not EXCLUDED-default).
	off := false
	second, err := repo.Upsert(ctx, tenantID, userID, NotificationsPatch{
		InAppOnBounceAlert: &off,
	})
	if err != nil {
		t.Fatalf("Upsert in-app patch: %v", err)
	}
	if second.InAppOnBounceAlert {
		t.Fatalf("in-app opt-out did not persist: %+v", second)
	}
	if !second.WebhookOnBounceAlert {
		t.Fatalf("partial PATCH silently disabled the webhook flag: %+v", second)
	}
	if second.NotificationWebhookURL != url {
		t.Fatalf("partial PATCH silently wiped the webhook URL: %q", second.NotificationWebhookURL)
	}
	if second.NotificationWebhookKind != "generic" {
		t.Fatalf("partial PATCH silently reset the webhook kind: %q", second.NotificationWebhookKind)
	}

	// An explicit empty-string URL CLEARS the webhook destination (distinct from
	// nil = leave-as-is).
	empty := ""
	third, err := repo.Upsert(ctx, tenantID, userID, NotificationsPatch{
		NotificationWebhookURL: &empty,
	})
	if err != nil {
		t.Fatalf("Upsert clear-url: %v", err)
	}
	if third.NotificationWebhookURL != "" {
		t.Fatalf("empty-string URL must clear the destination, got %q", third.NotificationWebhookURL)
	}
	// Clearing the URL must NOT touch the category flags.
	if !third.WebhookOnBounceAlert {
		t.Fatalf("clearing URL wrongly disabled the webhook flag: %+v", third)
	}
}

// SETC-037 review fix (#6): the pre-existing email/digest columns used
// COALESCE(EXCLUDED, current) where EXCLUDED = COALESCE($n, <default>) is never
// NULL — so a partial PATCH that OMITTED one of them silently RESET it to the
// insert default. Every field now uses the raw-$n preserve form. This proves a
// user's opt-outs and non-default digest survive a partial PATCH of an
// unrelated field.
func TestNotificationsUpsert_PartialPatchPreservesEmailAndDigest_DB(t *testing.T) {
	pool := notifDB(t)
	ctx := context.Background()

	tenantID := "00000000-0000-4000-8000-00b0e6600031"
	userID := "00000000-0000-4000-8000-00b0e660003a"
	seedNotifTenantUser(t, pool, tenantID, userID)

	repo := &NotificationsRepo{Pool: pool}

	// Opt OUT of three email categories and choose a non-default digest.
	off := false
	never := "never"
	first, err := repo.Upsert(ctx, tenantID, userID, NotificationsPatch{
		EmailOnSendComplete:    &off,
		EmailOnApprovalRequest: &off,
		EmailOnUsageAlert:      &off,
		DigestFrequency:        &never,
	})
	if err != nil {
		t.Fatalf("Upsert opt-outs: %v", err)
	}
	if first.EmailOnSendComplete || first.EmailOnApprovalRequest || first.EmailOnUsageAlert || first.DigestFrequency != "never" {
		t.Fatalf("opt-outs did not persist: %+v", first)
	}

	// A partial PATCH of an UNRELATED field (in-app bounce) must preserve all of
	// the above — a COALESCE(EXCLUDED, current) bug would resurrect them to true/weekly.
	on := true
	second, err := repo.Upsert(ctx, tenantID, userID, NotificationsPatch{
		InAppOnBounceAlert: &on,
	})
	if err != nil {
		t.Fatalf("Upsert unrelated: %v", err)
	}
	if second.EmailOnSendComplete {
		t.Fatalf("partial PATCH silently re-enabled email_on_send_complete: %+v", second)
	}
	if second.EmailOnApprovalRequest {
		t.Fatalf("partial PATCH silently re-enabled email_on_approval_request: %+v", second)
	}
	if second.EmailOnUsageAlert {
		t.Fatalf("partial PATCH silently re-enabled email_on_usage_alert: %+v", second)
	}
	if second.DigestFrequency != "never" {
		t.Fatalf("partial PATCH silently reset digest_frequency to %q", second.DigestFrequency)
	}
}

// seedNotifTenantUser seeds a tenant+user under a tenant-bound tx (postwave_app
// is non-privileged, so the tenants INSERT RLS policy requires app.tenant_id to
// already equal the new row's id). Idempotent across reruns.
func seedNotifTenantUser(t *testing.T, pool *db.Pool, tenantID, userID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin seed tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("bind tenant guc: %v", err)
	}
	_, _ = tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, 'notif-seed-test', 'notif-seed-'||left($1::text,8), 'studio')`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant (needs pre-seeded DB): %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO users (id, tenant_id, external_user_id, email, role)
VALUES ($1::uuid, $2::uuid, 'notif-seed-'||left($1::text,8), $1::text||'@notif-seed.test', 'owner')`, userID, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed user: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() { deleteNotifTenant(t, pool, tenantID) })
}
