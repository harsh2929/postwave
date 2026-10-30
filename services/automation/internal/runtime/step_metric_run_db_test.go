package runtime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func stepMetricTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping step-metric database test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect step-metric database: %v", err)
	}
	t.Cleanup(pool.Close)
	var present bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.flow_step_metrics') IS NOT NULL`).Scan(&present); err != nil {
		t.Fatalf("check flow_step_metrics: %v", err)
	}
	if !present {
		t.Fatal("DATABASE_URL is configured but migration 1627 (flow_step_metrics) is not applied")
	}
	return pool
}

// seedStepMetricTenant creates a tenant that belongs to the calling test alone
// and deletes it when the test ends.
//
// The insert and the delete both run as the application role, in a
// transaction bound to the new tenant's own app.tenant_id. The tenants RLS
// policies (tenant_isolation_insert, tenant_isolation_delete) allow either
// statement only in that scope.
//
// The teardown used to run a bare `DELETE FROM tenants` on the pool. With no
// tenant bound, tenant_isolation_delete hides every row, so the statement
// matched nothing and returned no error. Every run therefore left behind, in
// the shared database, its tenant, the flow_step_metrics rows it wrote and the
// rows the tenant-insert triggers seed. The bare statement also had a side
// effect. Migration 1996's statement-level trigger on tenants treats a DELETE
// with no tenant scope as authority-domain maintenance and takes the EXCLUSIVE
// push-suppression domain lease. So each cleanup waited behind, and then
// blocked, every push send and authority mutation of every tenant in the
// database, only to delete nothing. With its tenant bound, the DELETE takes
// the shared lease plus this tenant's own key, and cascades to
// flow_step_metrics.
//
// A teardown that removes anything other than this one row fails the test, so
// a leak can no longer go unnoticed.
func seedStepMetricTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	tenantID := uuid.NewString()
	inStepMetricTenantTx(t, pool, tenantID, "seed tenant", func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'step-metric-test', $2, 'studio')`, tenantID, "step-metric-"+tenantID)
		return err
	})
	t.Cleanup(func() {
		var removed int64
		inStepMetricTenantTx(t, pool, tenantID, "delete tenant", func(ctx context.Context, tx pgx.Tx) error {
			tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
			removed = tag.RowsAffected()
			return err
		})
		if removed != 1 {
			t.Errorf("tenant teardown removed %d tenant rows, want 1; tenant %s and its "+
				"flow_step_metrics rows leaked", removed, tenantID)
		}
	})
	return tenantID
}

// inStepMetricTenantTx runs one fixture step (seed or teardown) in a
// transaction bound to tenantID, and commits it. It creates its own bounded
// context, so it works from t.Cleanup and cannot hang the package.
//
// It replays the step while Postgres reports that its shared lock table is
// full (SQLSTATE 53200, "out of shared memory"). Deleting a tenant cascades
// through every foreign key that references tenants(id), 735 at migration
// head. Until commit it holds a lock on each of those tables and on their
// indexes: about 3,300 lock-table entries for a single DELETE. The lock table
// is sized from max_locks_per_transaction × max_connections and shared by
// every database on the server. At the image default of 64, which a shared
// local server may still run, a few tenant deletes from packages running at
// the same time can fill it, and every statement that needs a new lock then
// fails until one of them commits. CI raises the setting to 512 (the service
// container in .github/workflows/test.yml and infra/aws/codebuild/ci-group.sh),
// which leaves room for several overlapping deletes, so there the retry is a
// backstop rather than the usual path. It also replays a step Postgres picked
// as a deadlock victim (40P01): a tenant delete can deadlock with another
// package's DDL on a shared table, such as the consent tracking test's
// CREATE/DROP TRIGGER on audit_log. That is contention on the shared database,
// not a defect in the code under test, and it clears on its own. Only fixture
// steps retry: RecordStepMetric, the code under test, runs once.
func inStepMetricTenantTx(t *testing.T, pool *pgxpool.Pool, tenantID, what string, fn func(context.Context, pgx.Tx) error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	backoff := 50 * time.Millisecond
	for {
		err := runStepMetricTenantTx(ctx, pool, tenantID, fn)
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

func runStepMetricTenantTx(ctx context.Context, pool *pgxpool.Pool, tenantID string, fn func(context.Context, pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("bind tenant: %w", err)
	}
	if err := fn(ctx, tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// countStepMetrics reads under the tenant's own scope.
//
// flow_step_metrics has RLS (tenant_isolation), so a bare pool query returns
// nothing regardless of what was written — which on the first run of this test
// looked exactly like "the feature does not work". The bind is the difference
// between testing the code and testing the policy.
func countStepMetrics(t *testing.T, pool *pgxpool.Pool, tenantID, query string, args ...any) int {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin count tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("scope count tx: %v", err)
	}
	var n int
	all := append([]any{tenantID}, args...)
	if err := tx.QueryRow(ctx, query, all...).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

// A per-node inspector needs per-RUN rows, and until now nothing wrote any.
//
// `flow_step_metrics` has carried a `run_id` column and a matching read index
// — `(tenant_id, run_id, occurred_at DESC) WHERE run_id IS NOT NULL` — since
// migration 1627, whose own comment says the unique index is partial on
// `run_id IS NULL` so "a future batch path that wants per-run rows can still
// append without colliding with the rollup". That index matched zero rows,
// because the writer never supplied the field. The ledger read this as "the
// table does not exist"; it existed, with the index already built for the
// query nobody could run.
func TestRecordStepMetricWritesTheRunRowAndKeepsTheRollup(t *testing.T) {
	pool := stepMetricTestPool(t)
	ctx := context.Background()
	tenantID := seedStepMetricTenant(t, pool)
	// TenantOf is stubbed to the seeded tenant: the default resolver looks the
	// tenant up from an existing automation_executions row, and this test
	// deliberately has no execution — the metric path must work for a run whose
	// execution rows live in the other automation model.
	store := &PostgresStateStore{
		Pool:     pool,
		TenantOf: func(context.Context, string) (string, error) { return tenantID, nil },
	}

	flowID := uuid.NewString()
	runID := uuid.NewString()
	nodeID := "node-a"

	if err := store.RecordStepMetric(ctx, StepMetric{
		TenantID:     tenantID,
		AutomationID: flowID,
		NodeID:       nodeID,
		RunID:        runID,
		ActionKind:   "add_tag",
		Outcome:      "applied",
	}); err != nil {
		t.Fatalf("record step metric: %v", err)
	}

	runRows := countStepMetrics(t, pool, tenantID,
		`SELECT count(*) FROM flow_step_metrics WHERE tenant_id = $1::uuid AND run_id = $2::uuid`, runID)
	rollupRows := countStepMetrics(t, pool, tenantID,
		`SELECT count(*) FROM flow_step_metrics WHERE tenant_id = $1::uuid AND run_id IS NULL`)
	if runRows != 1 {
		t.Fatalf("per-run rows = %d, want 1 — the inspector still has no data for "+
			"the run somebody is looking at", runRows)
	}
	// The rollup must survive: its reader (StepMetrics) filters `run_id IS NULL`
	// and would go empty if per-run rows replaced it rather than joining it.
	if rollupRows != 1 {
		t.Fatalf("rollup rows = %d, want 1 — the per-flow reader lost its data", rollupRows)
	}

	// A second execution of the same node in the same run APPENDS rather than
	// colliding, which is what the partial unique index was shaped for.
	if err := store.RecordStepMetric(ctx, StepMetric{
		TenantID:     tenantID,
		AutomationID: flowID,
		NodeID:       nodeID,
		RunID:        runID,
		ActionKind:   "add_tag",
		Outcome:      "failed",
		Error:        "boom",
	}); err != nil {
		t.Fatalf("record second step metric: %v", err)
	}
	runRows = countStepMetrics(t, pool, tenantID,
		`SELECT count(*) FROM flow_step_metrics WHERE tenant_id = $1::uuid AND run_id = $2::uuid`, runID)
	if runRows != 2 {
		t.Fatalf("per-run rows after two attempts = %d, want 2 — attempts are being "+
			"collapsed, which is the whole thing an attempt view must not do", runRows)
	}
}

// A caller with no run in hand keeps exactly its previous behaviour, rather
// than being given a fabricated identifier.
func TestRecordStepMetricWithoutARunWritesOnlyTheRollup(t *testing.T) {
	pool := stepMetricTestPool(t)
	ctx := context.Background()
	tenantID := seedStepMetricTenant(t, pool)
	// TenantOf is stubbed to the seeded tenant: the default resolver looks the
	// tenant up from an existing automation_executions row, and this test
	// deliberately has no execution — the metric path must work for a run whose
	// execution rows live in the other automation model.
	store := &PostgresStateStore{
		Pool:     pool,
		TenantOf: func(context.Context, string) (string, error) { return tenantID, nil },
	}

	if err := store.RecordStepMetric(ctx, StepMetric{
		TenantID:     tenantID,
		AutomationID: uuid.NewString(),
		NodeID:       "node-b",
		ActionKind:   "wait",
		Outcome:      "applied",
	}); err != nil {
		t.Fatalf("record step metric: %v", err)
	}
	runRows := countStepMetrics(t, pool, tenantID,
		`SELECT count(*) FROM flow_step_metrics WHERE tenant_id = $1::uuid AND run_id IS NOT NULL`)
	if runRows != 0 {
		t.Fatalf("per-run rows = %d for a metric with no RunID, want 0 — an "+
			"invented run id is worse than none", runRows)
	}
}
