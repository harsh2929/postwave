// SPDX-License-Identifier: AGPL-3.0-only
package storage

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// perfDB skips when DATABASE_URL is unset, mirroring the cross-service
// integration-test convention.
//
// The pool is closed by t.Cleanup, never by a deferred Close in the test body.
// Cleanups run after the body's defers, last-registered-first, so registering
// Close here, before seedPerfTenant registers its teardown, keeps the pool open
// until that teardown has run. (The test used to defer pool.Close(), which
// would have closed the pool under the teardown.)
func perfDB(t *testing.T) *pgxpool.Pool {
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
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}
	return pool
}

// seedPerfTenant creates tenantID, a tenant that belongs to the calling test
// alone, and removes it when the test ends.
//
// sequence_funnel_events.tenant_id references tenants(id), and a freshly
// migrated database (what CI runs against) holds no tenants, so the test must
// make its own. tenants is FORCE ROW LEVEL SECURITY, and its INSERT policy
// admits a row for the application role only when the row's id equals
// app.tenant_id, which is the shape signup uses. This helper used to insert
// with no tenant bound. The policy refused the row (SQLSTATE 42501), the helper
// called t.Skipf, and so the test skipped on every database the CI role can
// reach: PerformanceStore was never exercised, and the package reported 0.5%
// coverage. The insert now runs under the tenant's own app.tenant_id, and a
// seed that fails fails the test. There is no ON CONFLICT: a clash would mean
// the id belongs to someone else, and the teardown must never delete a tenant
// this test did not create.
//
// The teardown runs under the same scope. The tenants DELETE policy requires
// it, and with it bound the tenant-delete trigger takes only this tenant's
// push-suppression lock, not the exclusive database-wide one it takes when no
// tenant is bound. The delete cascades to the funnel rows the test wrote (the
// application role has no DELETE on sequence_funnel_events) and to the rows the
// tenant-insert triggers seeded. The old teardown ran with no tenant bound, so
// under FORCE ROW LEVEL SECURITY it could never see the row; its error was
// discarded. A teardown that removes nothing is now reported, because the
// tenant and its rows would then have leaked into the shared database.
func seedPerfTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	inPerfTenantTx(t, pool, tenantID, "seed tenant", func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'seq-perf-test', $2, 'studio')`, tenantID, "seq-perf-"+tenantID)
		return err
	})
	t.Cleanup(func() {
		var removed int64
		inPerfTenantTx(t, pool, tenantID, "delete tenant", func(ctx context.Context, tx pgx.Tx) error {
			tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
			removed = tag.RowsAffected()
			return err
		})
		if removed != 1 {
			t.Errorf("tenant teardown removed %d tenant rows, want 1; tenant %s leaked", removed, tenantID)
		}
	})
}

// inPerfTenantTx runs a fixture step (seed, funnel insert, teardown) in one
// transaction scoped to tenantID and commits it. It builds its own bounded
// context so it also works from t.Cleanup, after the test body has returned.
//
// It retries while Postgres reports its shared lock table full (SQLSTATE 53200,
// "out of shared memory"). Deleting a tenant cascades through every table that
// references tenants(id), 735 foreign keys at migration head, and holds a lock
// on each of those tables and their indexes until commit: 3,344 locks for one
// DELETE. The shared lock table holds roughly max_locks_per_transaction ×
// max_connections entries for the whole server, every database on it included.
// At the image default of 64, which a shared local server may still run, two
// tenant deletes from other packages at the same moment can fill it, and any
// statement that needs a new lock fails until one of them commits. CI raises
// the setting to 512 (the service container in .github/workflows/test.yml and
// infra/aws/codebuild/ci-group.sh), which leaves room for several overlapping
// deletes, so there the retry is a backstop rather than the usual path. It
// also replays a step Postgres picked as a deadlock victim (40P01): a tenant
// delete can deadlock with another package's DDL on a shared table, such as the
// consent tracking test's CREATE/DROP TRIGGER on audit_log. That is contention
// on the shared test database, not a defect in the code under test, and it
// clears on its own: the whole transaction is rolled back and replayed. Only
// fixture steps retry; the PerformanceStore calls under test run once.
func inPerfTenantTx(t *testing.T, pool *pgxpool.Pool, tenantID, what string, fn func(context.Context, pgx.Tx) error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	backoff := 50 * time.Millisecond
	for {
		err := runPerfTenantTx(ctx, pool, tenantID, fn)
		if err == nil {
			return
		}
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || (pgErr.Code != "53200" && pgErr.Code != "40P01") {
			t.Fatalf("%s: %v", what, err)
		}
		t.Logf("%s: transient %s, retrying in %v: %v", what, pgErr.Code, backoff, err)
		select {
		case <-ctx.Done():
			t.Fatalf("%s: still failing after retrying: %v", what, err)
		case <-time.After(backoff):
		}
		if backoff < 2*time.Second {
			backoff *= 2
		}
	}
}

func runPerfTenantTx(ctx context.Context, pool *pgxpool.Pool, tenantID string, fn func(context.Context, pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("set_config: %w", err)
	}
	if err := fn(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// insertFunnel writes one sequence_funnel_events row under the tenant GUC.
func insertFunnel(t *testing.T, pool *pgxpool.Pool, tenantID, seqID, email string, position int, opened, clicked bool) {
	t.Helper()
	now := time.Now().UTC()
	var openedAt, clickedAt *time.Time
	if opened {
		o := now
		openedAt = &o
	}
	if clicked {
		c := now
		clickedAt = &c
	}
	inPerfTenantTx(t, pool, tenantID, "insert funnel", func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
INSERT INTO sequence_funnel_events
    (tenant_id, sequence_id, subscriber_email, position, sent_at, opened_at, clicked_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`,
			tenantID, seqID, email, position, now, openedAt, clickedAt)
		return err
	})
}

// Performance aggregates per-position (reached/opened/clicked, 1-based) and a
// DISTINCT-subscriber rollup, tenant-scoped.
func TestPerformanceStore_AggregatesDB(t *testing.T) {
	pool := perfDB(t)
	store := NewPerformanceStore(pool)
	ctx := context.Background()

	tenant := uuid.NewString()
	seedPerfTenant(t, pool, tenant)
	seqID := uuid.NewString()

	// Email position 0: s1 (opened+clicked), s2 (opened), s3 (nothing).
	insertFunnel(t, pool, tenant, seqID, "s1@x.test", 0, true, true)
	insertFunnel(t, pool, tenant, seqID, "s2@x.test", 0, true, false)
	insertFunnel(t, pool, tenant, seqID, "s3@x.test", 0, false, false)
	// Email position 1: s1 (opened), s2 (nothing). s3 dropped off.
	insertFunnel(t, pool, tenant, seqID, "s1@x.test", 1, true, false)
	insertFunnel(t, pool, tenant, seqID, "s2@x.test", 1, false, false)

	perf, err := store.Performance(ctx, tenant, seqID)
	if err != nil {
		t.Fatalf("Performance: %v", err)
	}

	// Rollup counts DISTINCT subscribers: reached s1/s2/s3=3, opened s1/s2=2,
	// clicked s1=1.
	if perf.Reached != 3 || perf.Opened != 2 || perf.Clicked != 1 {
		t.Fatalf("rollup = %+v, want reached 3 opened 2 clicked 1", perf)
	}
	if len(perf.Positions) != 2 {
		t.Fatalf("positions len = %d, want 2", len(perf.Positions))
	}
	// 1-based wire positions.
	p1, p2 := perf.Positions[0], perf.Positions[1]
	if p1.Position != 1 || p1.Reached != 3 || p1.Opened != 2 || p1.Clicked != 1 {
		t.Fatalf("email 1 = %+v, want pos1 reached3 opened2 clicked1", p1)
	}
	if p2.Position != 2 || p2.Reached != 2 || p2.Opened != 1 || p2.Clicked != 0 {
		t.Fatalf("email 2 = %+v, want pos2 reached2 opened1 clicked0", p2)
	}

	// Another tenant sees nothing.
	other, err := store.Performance(ctx, uuid.NewString(), seqID)
	if err != nil {
		t.Fatalf("Performance(other tenant): %v", err)
	}
	if other.Reached != 0 || len(other.Positions) != 0 {
		t.Fatalf("cross-tenant leak: %+v", other)
	}
}
