package migrationrunner

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestMergeFieldCompatibilityMigrationRejectsDriftAndResumes proves the exact
// 1754 file's two operationally important properties on an isolated database:
// ambiguous historical drift cannot be guessed away, and a retry resumes after
// the already-committed trigger cutover once an operator reconciles the value.
func TestMergeFieldCompatibilityMigrationRejectsDriftAndResumes(t *testing.T) {
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		adminURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL or DATABASE_URL is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	adminConfig, err := pgx.ParseConfig(adminURL)
	if err != nil {
		t.Fatalf("parse admin database URL: %v", err)
	}
	control, err := pgx.ConnectConfig(ctx, adminConfig)
	if err != nil {
		t.Fatalf("connect to database server: %v", err)
	}
	// t.Cleanup, not defer. The cleanup below drops the isolated database
	// through this connection, and Go runs a test's defers before its
	// t.Cleanup callbacks, so a deferred Close left that cleanup running on a
	// closed connection: the DROP DATABASE failed, its error was discarded,
	// and every run leaked one fully migrated database onto the server.
	// Cleanups run last-registered-first, so registering Close first keeps the
	// connection open until the drop has run.
	t.Cleanup(func() { _ = control.Close(context.Background()) })

	databaseName := "postwave_1754_resume_" + strings.ReplaceAll(uuid.NewString()[:12], "-", "")
	quotedDatabase := pgx.Identifier{databaseName}.Sanitize()
	if _, err = control.Exec(ctx, "CREATE DATABASE "+quotedDatabase); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "42501" {
			t.Fatalf("database role cannot create isolated migration fixture: %v", err)
		}
		t.Fatalf("create isolated migration database: %v", err)
	}

	testPoolConfig, err := pgxpool.ParseConfig(adminURL)
	if err != nil {
		t.Fatalf("parse fixture pool URL: %v", err)
	}
	testPoolConfig.ConnConfig.Database = databaseName
	pool, err := pgxpool.NewWithConfig(ctx, testPoolConfig)
	if err != nil {
		t.Fatalf("connect isolated migration database: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		_, _ = control.Exec(cleanupCtx, `
SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
 WHERE datname = $1 AND pid <> pg_backend_pid()`, databaseName)
		if _, dropErr := control.Exec(cleanupCtx, "DROP DATABASE IF EXISTS "+quotedDatabase); dropErr != nil {
			t.Errorf("drop isolated migration database %s: %v", databaseName, dropErr)
		}
	})

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration test source path")
	}
	migrationsDir := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../infra/migrations"))
	files, err := LoadFiles(migrationsDir)
	if err != nil {
		t.Fatalf("load migration files: %v", err)
	}
	baseline := make([]MigrationFile, 0, len(files))
	var target MigrationFile
	for _, file := range files {
		switch file.Version {
		case "1754_merge_field_write_compatibility":
			target = file
		default:
			if target.Version == "" {
				baseline = append(baseline, file)
			}
		}
	}
	if target.Version == "" {
		t.Fatal("migration 1754 not found")
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err = RunWithOptions(ctx, pool, baseline, logger, RunOptions{AllowUnsafe: true}); err != nil {
		t.Fatalf("apply baseline through 1753: %v", err)
	}

	tenantID := uuid.NewString()
	subscriberID := uuid.NewString()
	if _, err = pool.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'merge-field-resume-test', $2, 'studio')`, tenantID, "merge-field-resume-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err = pool.Exec(ctx, `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source, merge_fields)
VALUES ($1::uuid, $2::uuid, $3, 'unconfirmed', 'api', jsonb_build_object('FNAME', 'Canonical'))`,
		subscriberID, tenantID, "resume-"+tenantID[:8]+"@example.test"); err != nil {
		t.Fatalf("seed canonical value: %v", err)
	}
	if _, err = pool.Exec(ctx, `
INSERT INTO merge_field_schema (tenant_id, key, label, type)
VALUES ($1::uuid, 'FNAME', 'First name', 'text')`, tenantID); err != nil {
		t.Fatalf("seed schema: %v", err)
	}
	if _, err = pool.Exec(ctx, `
INSERT INTO merge_field_values (tenant_id, subscriber_id, key, value)
VALUES ($1::uuid, $2::uuid, 'FNAME', 'Legacy')`, tenantID, subscriberID); err != nil {
		t.Fatalf("seed sidecar drift: %v", err)
	}

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire migration connection: %v", err)
	}
	defer conn.Release()
	firstErr := applyOne(ctx, conn.Conn(), target)
	if firstErr == nil || !strings.Contains(firstErr.Error(), "declared values disagree") {
		t.Fatalf("first 1754 apply error = %v; want strict drift rejection", firstErr)
	}
	var phaseCount, appliedCount int
	if err = conn.QueryRow(ctx,
		`SELECT count(*) FROM schema_migration_steps WHERE version = $1`, target.Version,
	).Scan(&phaseCount); err != nil {
		t.Fatalf("read retained phase marker: %v", err)
	}
	if phaseCount != 1 {
		t.Fatalf("retained phases = %d; want committed trigger-cutover phase", phaseCount)
	}
	if err = conn.QueryRow(ctx,
		`SELECT count(*) FROM schema_migrations WHERE version = $1`, target.Version,
	).Scan(&appliedCount); err != nil {
		t.Fatalf("read migration ledger after rejection: %v", err)
	}
	if appliedCount != 0 {
		t.Fatalf("migration ledger rows after rejection = %d; want 0", appliedCount)
	}

	// This fixture's reviewed decision is canonical-wins. The committed
	// compatibility trigger mirrors the explicit sidecar repair atomically.
	if _, err = conn.Exec(ctx, `
UPDATE merge_field_values
   SET value = 'Canonical'
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND key = 'FNAME'`, tenantID, subscriberID); err != nil {
		t.Fatalf("reconcile sidecar to reviewed canonical value: %v", err)
	}
	if err = applyOne(ctx, conn.Conn(), target); err != nil {
		t.Fatalf("resume 1754 after reconciliation: %v", err)
	}
	if err = conn.QueryRow(ctx, `
SELECT (SELECT count(*) FROM schema_migrations WHERE version = $1),
       (SELECT count(*) FROM schema_migration_steps WHERE version = $1)`, target.Version,
	).Scan(&appliedCount, &phaseCount); err != nil {
		t.Fatalf("read completed migration ledgers: %v", err)
	}
	if appliedCount != 1 || phaseCount != 0 {
		t.Fatalf("completed ledger versions=%d phases=%d; want 1/0", appliedCount, phaseCount)
	}
	var validated int
	if err = conn.QueryRow(ctx, `
SELECT count(*)
  FROM pg_constraint
 WHERE conname IN (
           'subscribers_merge_fields_object_check',
           'merge_field_values_tenant_subscriber_fkey'
       )
   AND convalidated`).Scan(&validated); err != nil {
		t.Fatalf("read validated constraints: %v", err)
	}
	if validated != 2 {
		t.Fatalf("validated constraints = %d; want 2", validated)
	}
}
