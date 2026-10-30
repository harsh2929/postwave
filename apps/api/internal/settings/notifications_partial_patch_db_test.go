// SPDX-License-Identifier: AGPL-3.0-only
package settings

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

func notifDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	// Closed by t.Cleanup, never by a deferred Close in the test: Go runs a
	// test's defers before its t.Cleanup callbacks, and every tenant teardown
	// in this package runs from t.Cleanup on this pool. The tests used
	// `defer pool.Close()`, so each teardown's WithTenant failed on the closed
	// pool, the error was dropped, and every run left its tenant behind.
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}
	return pool
}

// A partial PATCH that omits email_on_deliverability_alert must PRESERVE the
// user's prior choice, not silently re-enable it (INBOX-036 review fix #4). A
// user who opted OUT of reputation alerts must stay opted out.
func TestNotificationsUpsert_PartialPatchPreservesDeliverabilityOptOut_DB(t *testing.T) {
	pool := notifDB(t)
	ctx := context.Background()

	tenantID := "00000000-0000-4000-8000-00b0e6600001"
	userID := "00000000-0000-4000-8000-00b0e660000a"

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("worker scope: %v", err)
	}
	_, _ = tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, 'notif-patch-test', 'notif-patch-test', 'studio')`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant (needs pre-seeded DB): %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO users (id, tenant_id, external_user_id, email, role)
VALUES ($1::uuid, $2::uuid, 'notif-patch-user', 'u@notif-patch.test', 'owner')`, userID, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed user: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() { deleteNotifTenant(t, pool, tenantID) })

	repo := &NotificationsRepo{Pool: pool}
	optOut := false

	// Opt OUT of deliverability alerts.
	first, err := repo.Upsert(ctx, tenantID, userID, NotificationsPatch{
		EmailOnDeliverabilityAlert: &optOut,
	})
	if err != nil {
		t.Fatalf("Upsert opt-out: %v", err)
	}
	if first.EmailOnDeliverabilityAlert {
		t.Fatalf("opt-out did not persist: %+v", first)
	}

	// A later partial PATCH that touches only another field must NOT resurrect
	// the deliverability opt-in.
	other := true
	second, err := repo.Upsert(ctx, tenantID, userID, NotificationsPatch{
		EmailOnSendComplete: &other,
	})
	if err != nil {
		t.Fatalf("Upsert partial: %v", err)
	}
	if second.EmailOnDeliverabilityAlert {
		t.Fatalf("partial PATCH silently re-enabled deliverability alerts: %+v", second)
	}
}

// deleteNotifTenant removes a tenant the test created, and everything
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
func deleteNotifTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteNotifTenantOnce(ctx, pool, tenantID)
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

func deleteNotifTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
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
