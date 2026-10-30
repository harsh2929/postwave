package warehouse

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/uploads"
)

func warehouseDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed warehouse repo tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func warehouseUUID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func createWarehouseTenant(t *testing.T, ctx context.Context, pool *db.Pool) string {
	t.Helper()
	tenantID := warehouseUUID(t)
	slug := "warehouse-" + strings.ReplaceAll(tenantID[:13], "-", "")
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("bind tenant guc: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $2, 'studio')`, tenantID, slug); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		ctx2, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		tx2, err := db.WithTenant(ctx2, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx2.Rollback(ctx2) }()
		_, _ = tx2.Exec(ctx2, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = tx2.Commit(ctx2)
	})
	return tenantID
}

func warehouseExec(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, sql string, args ...any) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("exec: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

func warehouseQueryRow(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, sql string, dest []any, args ...any) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, sql, args...).Scan(dest...); err != nil {
		t.Fatalf("query: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

func testSnowflakeConnection(direction string) Connection {
	return Connection{
		Name:            "Snowflake test",
		Provider:        ProviderSnowflake,
		Direction:       direction,
		Status:          "active",
		CredentialsRef:  "vault://snowflake-test",
		ObjectSelection: []string{"profiles"},
		Cadence:         "manual",
		BackfillDays:    30,
		Config: map[string]any{
			"account":   "xy12345",
			"warehouse": "compute_wh",
			"database":  "postwave",
			"schema":    "public",
			"stage":     "postwave.public.export_stage",
		},
	}
}

func TestRunConnectionDryRunExportDoesNotStoreArtifactsOrExecuteSnowflake(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool := warehouseDB(t)
	tenantID := createWarehouseTenant(t, ctx, pool)
	executor := &fakeSnowflakeExecutor{}
	repo := &Repo{Pool: pool, SnowflakeExecutor: executor}
	conn, err := repo.CreateConnection(ctx, tenantID, testSnowflakeConnection("export"))
	if err != nil {
		t.Fatalf("create connection: %v", err)
	}
	store := uploads.NewMemoryStore()

	run, err := repo.RunConnection(ctx, tenantID, conn.ID, RunInput{
		Direction:                 "export",
		RunMode:                   "dry_run",
		ObjectSelection:           []string{"profiles"},
		ExpectedConnectionVersion: conn.Version,
	}, store)
	if err != nil {
		t.Fatalf("dry-run export: %v", err)
	}
	if run.Status != "completed" || run.RunMode != "dry_run" {
		t.Fatalf("run = %+v", run)
	}
	if run.Metrics["dry_run"] != true ||
		run.Metrics["manifest_storage_state"] != "dry_run_not_stored" ||
		run.Metrics["snowflake_provider_execution_state"] != "skipped" ||
		run.Metrics["snowflake_provider_execution_reason"] != "dry_run" {
		t.Fatalf("dry-run metrics = %+v", run.Metrics)
	}
	if len(executor.requests) != 0 {
		t.Fatalf("dry-run export should not call Snowflake executor: %+v", executor.requests)
	}
	keys, _, err := store.List(ctx, tenantID, "warehouse/runs/", "", 10)
	if err != nil {
		t.Fatalf("list store: %v", err)
	}
	if len(keys) != 0 {
		t.Fatalf("dry-run export stored artifacts: %+v", keys)
	}
}

func TestRunConnectionPersistsProviderFailureForRetry(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool := warehouseDB(t)
	tenantID := createWarehouseTenant(t, ctx, pool)
	providerErr := errors.New("snowflake test outage")
	executor := &fakeSnowflakeExecutor{err: providerErr}
	repo := &Repo{Pool: pool, SnowflakeExecutor: executor}
	conn, err := repo.CreateConnection(ctx, tenantID, testSnowflakeConnection("export"))
	if err != nil {
		t.Fatalf("create connection: %v", err)
	}

	run, err := repo.RunConnection(ctx, tenantID, conn.ID, RunInput{
		Direction:                 "export",
		RunMode:                   "manual",
		ObjectSelection:           []string{"profiles"},
		ExpectedConnectionVersion: conn.Version,
	}, uploads.NewMemoryStore())
	if !errors.Is(err, providerErr) && (err == nil || !strings.Contains(err.Error(), providerErr.Error())) {
		t.Fatalf("run error = %v, want provider error", err)
	}
	if run == nil || run.Status != "failed" || !strings.Contains(run.Error, providerErr.Error()) {
		t.Fatalf("failed run = %+v", run)
	}

	runs, err := repo.ListRuns(ctx, tenantID, conn.ID, 10)
	if err != nil {
		t.Fatalf("list runs: %v", err)
	}
	if len(runs) != 1 || runs[0].ID != run.ID || runs[0].Status != "failed" {
		t.Fatalf("persisted runs = %+v; want failed run %s", runs, run.ID)
	}
}

func TestRunConnectionDryRunImportDoesNotMaterializeRowsOrAdvanceCursor(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool := warehouseDB(t)
	tenantID := createWarehouseTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	conn, err := repo.CreateConnection(ctx, tenantID, testSnowflakeConnection("import"))
	if err != nil {
		t.Fatalf("create connection: %v", err)
	}
	subscriberID := warehouseUUID(t)
	warehouseExec(t, ctx, pool, tenantID, `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::uuid, 'ada@example.com', 'enabled', 'api')`, subscriberID, tenantID)
	warehouseExec(t, ctx, pool, tenantID, `
UPDATE warehouse_connections
   SET last_cursor = 'cursor-before'
 WHERE id = $1::uuid`, conn.ID)

	run, err := repo.RunConnection(ctx, tenantID, conn.ID, RunInput{
		Direction:                 "import",
		RunMode:                   "dry_run",
		ExpectedConnectionVersion: conn.Version,
		ImportRows: []ImportRow{{
			SubscriberID: subscriberID,
			EventName:    "Viewed Product",
			Properties:   map[string]any{"sku": "ABC"},
		}},
	}, nil)
	if err != nil {
		t.Fatalf("dry-run import: %v", err)
	}
	if run.RowsImported != 0 || run.Metrics["materialization_state"] != "dry_run_skipped" || run.Metrics["cursor_update_state"] != "dry_run_not_advanced" {
		t.Fatalf("dry-run import run = %+v", run)
	}
	var events int
	warehouseQueryRow(t, ctx, pool, tenantID, `
SELECT count(*)::int
  FROM product_events
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND event_name = 'Viewed Product'`, []any{&events}, tenantID, subscriberID)
	if events != 0 {
		t.Fatalf("dry-run import inserted product events: %d", events)
	}
	var cursor string
	warehouseQueryRow(t, ctx, pool, tenantID, `
SELECT last_cursor
  FROM warehouse_connections
 WHERE id = $1::uuid`, []any{&cursor}, conn.ID)
	if cursor != "cursor-before" {
		t.Fatalf("dry-run import advanced cursor to %q", cursor)
	}
}

func TestRepoAcknowledgeProviderCleanupMergesSnowflakeEvidence(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool := warehouseDB(t)
	tenantID := createWarehouseTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	conn, connectionErr := repo.CreateConnection(ctx, tenantID, testSnowflakeConnection("export"))
	if connectionErr != nil {
		t.Fatalf("create connection: %v", connectionErr)
	}
	receipt, err := repo.DeleteConnection(ctx, tenantID, conn.ID, conn.Version, conn.Name)
	if err != nil {
		t.Fatalf("delete connection: %v", err)
	}

	out, connectionErr := repo.AcknowledgeProviderCleanup(ctx, tenantID, conn.ID, ProviderCleanupAcknowledgementInput{
		CompletedActions: []string{
			"snowflake_user_or_key_removed_or_rotated",
			"snowflake_roles_or_grants_removed",
		},
		Notes:           "Verified Snowflake console cleanup.",
		AcknowledgedBy:  "ops@example.com",
		ExpectedVersion: receipt.Version,
	}, time.Date(2026, 6, 30, 14, 30, 0, 0, time.UTC))
	if connectionErr != nil {
		t.Fatalf("acknowledge provider cleanup: %v", connectionErr)
	}
	cleanup, ok := out.Config["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider_cleanup missing: %+v", out.Config)
	}
	if cleanup["provider"] != ProviderSnowflake ||
		cleanup["status"] != "operator_acknowledged" ||
		cleanup["acknowledged_at"] != "2026-06-30T14:30:00Z" ||
		cleanup["acknowledged_by"] != "ops@example.com" ||
		cleanup["operator_notes"] != "Verified Snowflake console cleanup." ||
		cleanup["managed_provider_cleanup"] != false ||
		cleanup["provider_scope_type"] != "snowflake_account" {
		t.Fatalf("cleanup evidence = %+v", cleanup)
	}
	actions, ok := cleanup["completed_actions"].([]any)
	if !ok || len(actions) != 2 || actions[0] != "snowflake_user_or_key_removed_or_rotated" {
		t.Fatalf("completed actions = %#v", cleanup["completed_actions"])
	}
}

func TestWarehouseRetryCountListLimitAndMissingConnectionRuns(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool := warehouseDB(t)
	tenantID := createWarehouseTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	conn, err := repo.CreateConnection(ctx, tenantID, testSnowflakeConnection("export"))
	if err != nil {
		t.Fatalf("create connection: %v", err)
	}
	warehouseExec(t, ctx, pool, tenantID, `
INSERT INTO warehouse_sync_runs (tenant_id, connection_id, direction, run_mode, status, error)
VALUES ($1::uuid, $2::uuid, 'export', 'manual', 'failed', 'previous failure')`, tenantID, conn.ID)

	run, err := repo.RunConnection(ctx, tenantID, conn.ID, RunInput{
		Direction:                 "export",
		RunMode:                   "retry",
		ObjectSelection:           []string{"profiles"},
		ExpectedConnectionVersion: conn.Version,
	}, nil)
	if err != nil {
		t.Fatalf("retry run: %v", err)
	}
	if run.RetryCount != 1 || run.Metrics["retry_count"] != float64(1) && run.Metrics["retry_count"] != 1 {
		t.Fatalf("retry count/metrics = %+v", run)
	}
	runs, err := repo.ListRuns(ctx, tenantID, conn.ID, 1)
	if err != nil {
		t.Fatalf("list runs: %v", err)
	}
	if len(runs) != 1 || runs[0].ID != run.ID {
		t.Fatalf("limited runs = %+v want latest %s", runs, run.ID)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/warehouse/connections/missing/runs?limit=1", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", warehouseUUID(t))
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	(&Deps{Repo: repo}).ListConnectionRuns(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing connection runs status=%d body=%s", rec.Code, rec.Body.String())
	}
}
