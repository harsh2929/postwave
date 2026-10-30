// SPDX-License-Identifier: AGPL-3.0-only

package flowsteps

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

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping flow-steps database test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedTenant(t *testing.T, admin *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
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
VALUES ($1::uuid, 'flowsteps-test', $2, 'studio')`, tenantID, "flowsteps-"+tenantID); err != nil {
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
	t.Cleanup(func() { deleteFlowStepsTestTenant(t, admin, tenantID) })
	return tenantID
}

func seedAttempt(t *testing.T, pool *pgxpool.Pool, tenantID, runID, node, kind string, failed int, errText string, at time.Time) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open seed tx: %v", err)
	}
	applied := 1
	if failed > 0 {
		applied = 0
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO flow_step_metrics
  (tenant_id, run_id, flow_id, node_id, action_kind, applied, skipped, failed, error, occurred_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 0, $7, NULLIF($8,''), $9)`,
		tenantID, runID, uuid.NewString(), node, kind, applied, failed, errText, at); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed attempt: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit attempt: %v", err)
	}
}

// A retry must be visible as two attempts, not folded into one outcome.
//
// That is the whole reason the counters stay as three numbers: a node that
// failed and then succeeded reads as "applied" if the run is summarised, and
// the retry — the thing somebody opened the inspector to find — disappears.
func TestARetryIsVisibleAsTwoAttemptsInOrder(t *testing.T) {
	pool := testPool(t)
	adminURL := os.Getenv("POSTWAVE_ADMIN_DATABASE_URL")
	if adminURL == "" {
		adminURL = os.Getenv("DATABASE_URL")
	}
	admin, err := pgxpool.New(context.Background(), adminURL)
	if err != nil {
		t.Fatalf("admin connect: %v", err)
	}
	t.Cleanup(admin.Close)

	tenantID := seedTenant(t, admin)
	runID := uuid.NewString()
	base := time.Now().UTC().Add(-time.Hour)
	seedAttempt(t, pool, tenantID, runID, "node-a", "send_email", 1, "smtp timeout", base)
	seedAttempt(t, pool, tenantID, runID, "node-a", "send_email", 0, "", base.Add(time.Minute))

	got, err := (&Repo{Pool: pool}).ForRun(context.Background(), tenantID, runID)
	if err != nil {
		t.Fatalf("ForRun: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("attempts = %d, want 2 — a retry has been collapsed into a single "+
			"outcome and the failure is invisible", len(got))
	}
	if got[0].Failed != 1 || got[0].Error != "smtp timeout" {
		t.Fatalf("first attempt = %+v, want the failure with its message", got[0])
	}
	if got[1].Applied != 1 {
		t.Fatalf("second attempt = %+v, want the successful retry", got[1])
	}
	if !got[0].OccurredAt.Before(got[1].OccurredAt) {
		t.Fatalf("attempts are not oldest-first; an inspector is read as a sequence")
	}
}

// Another tenant's run must be invisible even with its id in hand.
//
// This pins the PROPERTY, not the predicate. Removing `tenant_id = $1` from the
// query leaves this test green, because `flow_step_metrics` carries
// `tenant_isolation` and RLS refuses the row on its own — which is the right
// answer and worth stating rather than implying the WHERE clause is what saves
// us. The predicate is belt-and-braces; the policy is the belt. A future reader
// deleting the predicate to "simplify" would find this test unchanged, and
// should know that is expected rather than a gap.
func TestAnotherTenantsRunIsNotReadable(t *testing.T) {
	pool := testPool(t)
	adminURL := os.Getenv("POSTWAVE_ADMIN_DATABASE_URL")
	if adminURL == "" {
		adminURL = os.Getenv("DATABASE_URL")
	}
	admin, err := pgxpool.New(context.Background(), adminURL)
	if err != nil {
		t.Fatalf("admin connect: %v", err)
	}
	t.Cleanup(admin.Close)

	mine := seedTenant(t, admin)
	theirs := seedTenant(t, admin)
	runID := uuid.NewString()
	seedAttempt(t, pool, theirs, runID, "node-a", "wait", 0, "", time.Now().UTC())

	got, err := (&Repo{Pool: pool}).ForRun(context.Background(), mine, runID)
	if err != nil {
		t.Fatalf("ForRun: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("read %d attempt(s) from another tenant's run", len(got))
	}
}

// deleteFlowStepsTestTenant removes a tenant the test created, and everything
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
func deleteFlowStepsTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteFlowStepsTestTenantOnce(ctx, pool, tenantID)
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

func deleteFlowStepsTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
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
