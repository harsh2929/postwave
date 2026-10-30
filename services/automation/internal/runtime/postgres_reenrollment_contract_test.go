package runtime

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMigration1779ReplacesLifetimeExecutionUniquenessWithRunUniqueness(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "infra", "migrations",
		"1779_automation_execution_run_uniqueness.sql")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1779: %v", err)
	}
	sql := string(raw)
	required := []string{
		"CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS automation_executions_run_lookup_idx",
		"(tenant_id, automation_id, subscriber_email, run_id)",
		"i.indisunique",
		"i.indisvalid",
		"DROP INDEX CONCURRENTLY IF EXISTS automation_executions_lookup_idx",
		"rollback-strategy: no-op",
	}
	for _, fragment := range required {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration 1779 lost required contract %q", fragment)
		}
	}
	createAt := strings.Index(sql, "CREATE UNIQUE INDEX CONCURRENTLY")
	dropAt := strings.Index(sql, "DROP INDEX CONCURRENTLY IF EXISTS automation_executions_lookup_idx")
	if createAt < 0 || dropAt < 0 || createAt > dropAt {
		t.Fatalf("replacement index must be built before legacy index is dropped (create=%d drop=%d)", createAt, dropAt)
	}
}

func automationStateTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping automation state database contract")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect automation state database: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedAutomationStateTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	tenantID := uuid.NewString()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin tenant seed: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("bind tenant seed: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'automation-state-contract', 'studio')`, tenantID,
		"automation-state-"+strings.ReplaceAll(tenantID, "-", "")); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanup, err := pool.Begin(cleanupCtx)
		if err != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(cleanupCtx) }()
		_, _ = cleanup.Exec(cleanupCtx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID)
		_, _ = cleanup.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanup.Commit(cleanupCtx)
	})
	return tenantID
}

func TestPostgresStateStorePersistsIndependentReEnrollmentRuns(t *testing.T) {
	pool := automationStateTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	var replacementPresent, legacyPresent bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.automation_executions_run_lookup_idx') IS NOT NULL,
       to_regclass('public.automation_executions_lookup_idx') IS NOT NULL`).Scan(
		&replacementPresent, &legacyPresent); err != nil {
		t.Fatalf("inspect execution indexes: %v", err)
	}
	if !replacementPresent || legacyPresent {
		t.Fatalf("migration 1779 not applied correctly: replacement=%v legacy=%v", replacementPresent, legacyPresent)
	}

	tenantID := seedAutomationStateTenant(t, pool)
	automationID := uuid.NewString()
	email := "reenrollment-" + uuid.NewString() + "@example.test"
	store, err := NewPostgresStateStore(pool, func(context.Context, string) (string, error) {
		return tenantID, nil
	})
	if err != nil {
		t.Fatalf("new postgres state store: %v", err)
	}
	started := time.Now().UTC().Add(-time.Minute)
	for i, runID := range []string{"run-one", "run-two"} {
		if err := store.Upsert(ctx, &ExecutionState{
			TenantID: tenantID, AutomationID: automationID, SubscriberEmail: email,
			RunID: runID, CurrentNodeID: "entry", StartedAt: started.Add(time.Duration(i) * time.Second),
			CompletedNodes: map[string]time.Time{},
		}); err != nil {
			t.Fatalf("upsert %s: %v", runID, err)
		}
	}
	// A retry in run two must update the existing row, not create a third.
	if err := store.Upsert(ctx, &ExecutionState{
		TenantID: tenantID, AutomationID: automationID, SubscriberEmail: email,
		RunID: "run-two", CurrentNodeID: "next", StartedAt: started.Add(time.Second),
		CompletedNodes: map[string]time.Time{"entry": time.Now().UTC()},
	}); err != nil {
		t.Fatalf("retry run-two upsert: %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin verification: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("bind verification tenant: %v", err)
	}
	var rows, runs int
	if err := tx.QueryRow(ctx, `
SELECT count(*), count(DISTINCT run_id)
  FROM automation_executions
 WHERE tenant_id = $1::uuid AND automation_id = $2::uuid AND subscriber_email = $3`,
		tenantID, automationID, email).Scan(&rows, &runs); err != nil {
		t.Fatalf("verify execution runs: %v", err)
	}
	if rows != 2 || runs != 2 {
		t.Fatalf("execution rows/distinct runs = %d/%d, want 2/2", rows, runs)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit verification: %v", err)
	}

	latest, err := store.LatestRun(ctx, automationID, email)
	if err != nil {
		t.Fatalf("latest run: %v", err)
	}
	if latest == nil || latest.RunID != "run-two" {
		t.Fatalf("latest run = %+v, want run-two", latest)
	}
}

func TestPgxEmailEmitterPersistsUnderForcedTenantRLS(t *testing.T) {
	pool := automationStateTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	var outboxPresent, forceRLS, privileged bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.outbox_events') IS NOT NULL,
       COALESCE((SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public.outbox_events')), false),
       COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user), false)`).Scan(
		&outboxPresent, &forceRLS, &privileged); err != nil {
		t.Fatalf("inspect outbox RLS contract: %v", err)
	}
	if !outboxPresent || !forceRLS {
		t.Fatalf("outbox FORCE RLS contract missing: table=%v force_rls=%v", outboxPresent, forceRLS)
	}
	if privileged {
		t.Skip("DATABASE_URL role bypasses RLS; use the postwave_app runtime role for this contract")
	}

	tenantID := seedAutomationStateTenant(t, pool)
	runID := "email-rls-" + uuid.NewString()
	req := EmailSendRequest{
		SubscriberEmail: "outbox-" + uuid.NewString() + "@example.test",
		TemplateID:      uuid.NewString(),
		AutomationID:    uuid.NewString(),
		NodeID:          "email-node",
		RunID:           runID,
	}
	if err := (&PgxEmailEmitter{Pool: pool}).Emit(ctx, tenantID, req); err != nil {
		t.Fatalf("emit tenant-scoped automation email: %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin outbox verification: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("bind outbox verification tenant: %v", err)
	}
	var kind, storedRunID, storedEmail string
	if err := tx.QueryRow(ctx, `
SELECT kind, payload->>'run_id', payload->>'subscriber_email'
  FROM outbox_events
 WHERE tenant_id = $1::uuid AND kind = $2 AND payload->>'run_id' = $3`,
		tenantID, emailKind, runID).Scan(&kind, &storedRunID, &storedEmail); err != nil {
		t.Fatalf("read tenant-scoped email outbox row: %v", err)
	}
	if kind != emailKind || storedRunID != runID || storedEmail != req.SubscriberEmail {
		t.Fatalf("stored outbox contract = kind %q run %q email %q", kind, storedRunID, storedEmail)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit outbox verification: %v", err)
	}
}
