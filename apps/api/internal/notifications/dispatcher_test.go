// SPDX-License-Identifier: AGPL-3.0-only
package notifications

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The DB-backed Gate tests need a Postgres reachable via DATABASE_URL +
// the `notification_preferences` table from migration 0015 (or whatever
// migration owns it today). Tests skip cleanly when the URL is unset so
// `go test ./...` works in environments without a database.

func newPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed dispatcher test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestColumnMapping(t *testing.T) {
	cases := []struct {
		pref Pref
		want string
	}{
		{PrefSendComplete, "email_on_send_complete"},
		{PrefApprovalRequest, "email_on_approval_request"},
		{PrefBounceAlert, "email_on_bounce_alert"},
		{Pref("nonsense"), ""},
	}
	for _, tc := range cases {
		got := column(tc.pref)
		if got != tc.want {
			t.Fatalf("column(%q) = %q, want %q", tc.pref, got, tc.want)
		}
	}
}

func TestNopDispatcherAlwaysOpen(t *testing.T) {
	d := NopDispatcher{}
	for _, pref := range []Pref{PrefSendComplete, PrefApprovalRequest, PrefBounceAlert} {
		ok, err := d.Gate(context.Background(), "tenant", "user", pref)
		if err != nil {
			t.Fatalf("nop pref %s: unexpected err %v", pref, err)
		}
		if !ok {
			t.Fatalf("nop pref %s: gate must be open", pref)
		}
	}
}

func TestPgDispatcherNilFailsOpen(t *testing.T) {
	// A zero-value PgDispatcher has Pool == nil. The contract is fail-open.
	d := &PgDispatcher{}
	ok, err := d.Gate(context.Background(), "tenant", "user", PrefBounceAlert)
	if err != nil {
		t.Fatalf("nil pool: unexpected err %v", err)
	}
	if !ok {
		t.Fatal("nil pool: must fail open")
	}
}

func TestPgDispatcherUnknownPref(t *testing.T) {
	d := &PgDispatcher{}
	ok, err := d.Gate(context.Background(), "tenant", "user", Pref("nonsense"))
	if err == nil {
		t.Fatal("unknown pref: expected err")
	}
	if !ok {
		t.Fatal("unknown pref: must fail open even on err")
	}
}

func TestPgDispatcherEmptyKeys(t *testing.T) {
	// Empty tenant or user → fail-open default-true (no row to look up).
	d := &PgDispatcher{Pool: nil} // Pool unused on this path
	for _, pair := range [][2]string{{"", ""}, {"t", ""}, {"", "u"}} {
		ok, err := d.Gate(context.Background(), pair[0], pair[1], PrefBounceAlert)
		if err != nil {
			t.Fatalf("empty (%q,%q): unexpected err %v", pair[0], pair[1], err)
		}
		if !ok {
			t.Fatalf("empty (%q,%q): must fail open", pair[0], pair[1])
		}
	}
}

// TestPgDispatcherStoredValueWins exercises the real DB path: insert a
// preferences row, then call Gate (which uses the pool, not the test tx)
// and check it returns the stored bool. Cleans up the row at the end.
// Skipped without DATABASE_URL.
func TestPgDispatcherStoredValueWins(t *testing.T) {
	pool := newPool(t)
	d := &PgDispatcher{Pool: pool}
	ctx := context.Background()

	tenantID := "00000000-0000-0000-0000-000000001111"
	userID := "00000000-0000-0000-0000-000000002222"

	// Seed via a tenant-scoped tx and commit so a separate connection
	// (the dispatcher's pool.QueryRow) can see it.
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("set tenant scope: %v", err)
	}
	// notification_preferences.tenant_id is a foreign key and nothing created
	// this tenant, so every seed was rejected. The tenant GUC is already set
	// above, which is what the tenants INSERT policy reads.
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'notify-dispatch-test', 'notify-dispatch-' || right($1::text, 12), 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO notification_preferences (
    user_id, tenant_id,
    email_on_send_complete, email_on_approval_request, email_on_bounce_alert,
    digest_frequency, updated_at
) VALUES ($1::uuid, $2::uuid, false, true, false, 'never', now())
ON CONFLICT (user_id, tenant_id) DO UPDATE SET
    email_on_send_complete = EXCLUDED.email_on_send_complete,
    email_on_approval_request = EXCLUDED.email_on_approval_request,
    email_on_bounce_alert = EXCLUDED.email_on_bounce_alert,
    updated_at = now()`, userID, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed prefs: %v (notification_preferences likely missing or RLS denies)", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	// The tenant delete cascades to the preferences row. The teardown used to
	// delete only that row, on the bare pool: with no app.tenant_id bound the
	// row is invisible under RLS, so the DELETE matched nothing, and the
	// tenant was never removed at all.
	t.Cleanup(func() { deleteDispatcherTestTenant(t, pool, tenantID) })

	// Stored values should win.
	ok, err := d.Gate(ctx, tenantID, userID, PrefSendComplete)
	if err != nil {
		t.Fatalf("send_complete: %v", err)
	}
	if ok {
		t.Fatal("send_complete: expected stored false to gate off")
	}
	ok, err = d.Gate(ctx, tenantID, userID, PrefApprovalRequest)
	if err != nil {
		t.Fatalf("approval_request: %v", err)
	}
	if !ok {
		t.Fatal("approval_request: expected stored true")
	}
	ok, err = d.Gate(ctx, tenantID, userID, PrefBounceAlert)
	if err != nil {
		t.Fatalf("bounce_alert: %v", err)
	}
	if ok {
		t.Fatal("bounce_alert: expected stored false")
	}
}

// TestPgDispatcherDefaultOnWhenNoRow asserts the contract that a missing
// row implies opt-in (default-true). Skipped without DATABASE_URL.
func TestPgDispatcherDefaultOnWhenNoRow(t *testing.T) {
	pool := newPool(t)
	d := &PgDispatcher{Pool: pool}
	ctx := context.Background()
	// A clearly-unique pair so we can be confident no row exists.
	tenantID := "00000000-0000-0000-0000-00000000aaaa"
	userID := "00000000-0000-0000-0000-00000000bbbb"
	// Defensive cleanup.
	_, _ = pool.Exec(ctx,
		`DELETE FROM notification_preferences WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
		userID, tenantID)
	for _, pref := range []Pref{PrefSendComplete, PrefApprovalRequest, PrefBounceAlert} {
		ok, err := d.Gate(ctx, tenantID, userID, pref)
		if err != nil {
			t.Fatalf("%s: unexpected err %v", pref, err)
		}
		if !ok {
			t.Fatalf("%s: expected default-true for missing row", pref)
		}
	}
}

// errorRow is a pgx.Row whose Scan returns a non-ErrNoRows error. Used to
// confirm fail-open on DB error.
var _ = errors.New // keep errors import used if other tests trim

// TestResolveReadsChannelMatrix_DB exercises the real SETC-037 read path:
// Resolve reads inapp_on_/webhook_on_/url/kind for a category. It seeds a
// tenant+user+prefs row (the prefs columns require the FK rows to exist under
// RLS), then asserts the resolved Channels — including the new webhook kind.
func TestResolveReadsChannelMatrix_DB(t *testing.T) {
	pool := newPool(t)
	d := &PgDispatcher{Pool: pool}
	ctx := context.Background()

	tenantID := "00000000-0000-4000-8000-00c0e6600001"
	userID := "00000000-0000-4000-8000-00c0e660000a"

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin seed: %v", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("set tenant scope: %v", err)
	}
	_, _ = tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, 'resolve-test', 'resolve-'||left($1::text,8), 'studio')`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant (needs pre-seeded DB): %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO users (id, tenant_id, external_user_id, email, role) VALUES ($1::uuid, $2::uuid, 'resolve-user', 'u@resolve.test', 'owner')`, userID, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed user: %v", err)
	}
	// In-app OFF, webhook ON with a generic-kind destination for bounce alerts.
	if _, err := tx.Exec(ctx, `
INSERT INTO notification_preferences (
    user_id, tenant_id,
    inapp_on_bounce_alert, webhook_on_bounce_alert,
    notification_webhook_url, notification_webhook_kind, updated_at)
VALUES ($1::uuid, $2::uuid, false, true, 'https://hooks.example.com/x', 'generic', now())`, userID, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed prefs: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() { deleteDispatcherTestTenant(t, pool, tenantID) })

	ch, err := d.Resolve(ctx, tenantID, userID, PrefBounceAlert)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if ch.InApp {
		t.Fatalf("in-app must be OFF (stored false): %+v", ch)
	}
	if !ch.Webhook || ch.WebhookURL != "https://hooks.example.com/x" || ch.WebhookKind != "generic" {
		t.Fatalf("webhook channel not resolved: %+v", ch)
	}

	// A category the user has no explicit row-off for defaults to in-app ON,
	// webhook OFF (usage_alert columns default true/false).
	other, err := d.Resolve(ctx, tenantID, userID, PrefUsageAlert)
	if err != nil {
		t.Fatalf("Resolve usage: %v", err)
	}
	if !other.InApp || other.Webhook {
		t.Fatalf("usage default must be in-app ON / webhook OFF: %+v", other)
	}
}

// deleteDispatcherTestTenant removes a tenant the test created, and everything
// that cascades from it, in a transaction bound to that tenant. The tenants
// DELETE policy sees only the row whose id equals app.tenant_id, so a DELETE
// issued without that binding matches nothing and reports no error.
//
// It retries the whole transaction when Postgres reports its shared lock table
// full (SQLSTATE 53200) or picks it as a deadlock victim (40P01). One tenant
// delete cascades through every foreign key that references tenants(id), about
// 735 at migration head, and holds a lock on each of those tables and their
// indexes until commit. So a few concurrent deletes from other packages sharing
// the database can briefly exhaust the lock table, and one can deadlock with
// another package's DDL on a shared table (the consent tracking test's
// CREATE/DROP TRIGGER on audit_log, for one). Both clear on their own. Any other
// failure, or a delete that removes no row, fails the test, so a leaked tenant
// cannot go unnoticed.
func deleteDispatcherTestTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteDispatcherTestTenantOnce(ctx, pool, tenantID)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "53200" || pgErr.Code == "40P01") && ctx.Err() == nil {
			t.Logf("cleanup of tenant %s: %s (SQLSTATE %s), retrying in %v", tenantID, pgErr.Message, pgErr.Code, wait)
			time.Sleep(wait)
			continue
		}
		if err != nil {
			t.Errorf("cleanup of tenant %s: %v", tenantID, err)
		} else if removed != 1 {
			t.Errorf("cleanup of tenant %s removed %d tenant rows, want 1", tenantID, removed)
		}
		return
	}
}

func deleteDispatcherTestTenantOnce(ctx context.Context, pool *pgxpool.Pool, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}
