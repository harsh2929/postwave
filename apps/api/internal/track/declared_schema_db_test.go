// SPDX-License-Identifier: AGPL-3.0-only

package track

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func schemaTestPool(t *testing.T) (*pgxpool.Pool, string) {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping declared-schema database test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	adminURL := os.Getenv("POSTWAVE_ADMIN_DATABASE_URL")
	if adminURL == "" {
		adminURL = url
	}
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("admin connect: %v", err)
	}
	t.Cleanup(admin.Close)

	tenantID := uuid.NewString()
	tx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'event-schema-test', $2, 'studio')`, tenantID, "evtschema-"+tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	// The teardown runs under the same tenant binding as the seed. In CI
	// POSTWAVE_ADMIN_DATABASE_URL is unset, so "admin" is the application role,
	// and the tenants DELETE policy sees only the row whose id equals
	// app.tenant_id. The bare `admin.Exec` DELETE this replaces matched no row,
	// reported no error, and left every seeded tenant in the shared database.
	t.Cleanup(func() { deleteTrackTestTenant(t, admin, tenantID) })
	return pool, tenantID
}

func declare(t *testing.T, pool *pgxpool.Pool, tenantID, event string, props map[string]string, required []string) {
	t.Helper()
	// The column is NOT NULL with a default; a nil slice binds as NULL rather
	// than falling back to it, which is a distinction worth stating because the
	// handler hits the same edge and handles it the same way.
	if required == nil {
		required = []string{}
	}
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open declare tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO product_event_schemas (tenant_id, event_name, version, properties, required, active)
VALUES ($1::uuid, $2, 1, $3::jsonb, $4::text[], true)`,
		tenantID, event, jsonOrEmpty(props), required); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("declare: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit declare: %v", err)
	}
}

// The whole chain: a declaration exists, an event violates it, the count moves.
//
// Each piece is testable alone and none of them proves the feature works. The
// gap this closes was a missing SIGNAL, so the thing to verify is that a
// violating event produces one.
func TestAViolatingEventIsCountedAgainstItsDeclaration(t *testing.T) {
	pool, tenantID := schemaTestPool(t)
	ctx := context.Background()
	declare(t, pool, tenantID, "order_placed",
		map[string]string{"value": TypeNumber}, []string{"value"})

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open check tx: %v", err)
	}
	// `value` arrives as a string — the exact drift the subsystem exists for.
	if err := CheckDeclared(ctx, tx, tenantID, "order_placed",
		map[string]string{"value": TypeString}); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("CheckDeclared: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open verify tx: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var count int64
	var detail string
	if err := verify.QueryRow(ctx, `
SELECT violation_count, COALESCE(last_violation_detail,'')
  FROM product_event_schemas
 WHERE tenant_id=$1::uuid AND event_name='order_placed' AND active`,
		tenantID).Scan(&count, &detail); err != nil {
		t.Fatalf("read counters: %v", err)
	}
	if count != 1 {
		t.Fatalf("violation_count = %d, want 1 — the declaration and the app "+
			"disagree and nothing recorded it", count)
	}
	if detail == "" {
		t.Fatalf("no violation detail; a count with no example cannot be acted on")
	}
}

// An event with no declaration is the ordinary case and must not be counted.
//
// The feature is opt-in per event. Treating "undeclared" as a failure would
// make every event a violation on the day the table shipped.
func TestAnUndeclaredEventIsNotAViolation(t *testing.T) {
	pool, tenantID := schemaTestPool(t)
	ctx := context.Background()

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open tx: %v", err)
	}
	if err := CheckDeclared(ctx, tx, tenantID, "never_declared",
		map[string]string{"anything": TypeString}); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("CheckDeclared on an undeclared event: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

// Only ONE version may be active, enforced by the schema rather than by the
// handler remembering to clear the previous flag — two active rows would mean
// an event validates against whichever the planner happened to return.
func TestOnlyOneVersionCanBeActive(t *testing.T) {
	pool, tenantID := schemaTestPool(t)
	ctx := context.Background()
	declare(t, pool, tenantID, "dup_event", map[string]string{"a": TypeString}, nil)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
INSERT INTO product_event_schemas (tenant_id, event_name, version, properties, active)
VALUES ($1::uuid, 'dup_event', 2, '{}'::jsonb, true)`, tenantID)
	if err == nil {
		t.Fatal("a second active version was accepted; an event would validate " +
			"against whichever row the planner returned")
	}
}

// deleteTrackTestTenant removes a tenant the test created, and everything
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
func deleteTrackTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteTrackTestTenantOnce(ctx, pool, tenantID)
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

func deleteTrackTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
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
