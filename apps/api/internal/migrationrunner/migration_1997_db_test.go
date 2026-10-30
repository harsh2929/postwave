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

// TestVerificationSignupAttemptFenceMigrationBackfillsOffPolicy exercises the
// exact 1997 file over the historical schema. An off policy carrying the old
// exact default must be advanced before a later enable, while a bespoke set is
// preserved. This prevents off-at-deploy tenants retaining an incomplete
// terminal-F rejection set when the feature is enabled later.
func TestVerificationSignupAttemptFenceMigrationBackfillsOffPolicy(t *testing.T) {
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		adminURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL or DATABASE_URL is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	adminConfig, err := pgx.ParseConfig(adminURL)
	if err != nil {
		t.Fatalf("parse admin database URL: %v", err)
	}
	control, err := pgx.ConnectConfig(ctx, adminConfig)
	if err != nil {
		t.Fatalf("connect to database server: %v", err)
	}
	t.Cleanup(func() { _ = control.Close(context.Background()) })

	databaseName := "postwave_1997_signup_" + strings.ReplaceAll(uuid.NewString()[:12], "-", "")
	quotedDatabase := pgx.Identifier{databaseName}.Sanitize()
	if _, err = control.Exec(ctx, "CREATE DATABASE "+quotedDatabase); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "42501" {
			t.Fatalf("database role cannot create isolated migration fixture: %v", err)
		}
		t.Fatalf("create isolated migration database: %v", err)
	}
	var pool *pgxpool.Pool
	t.Cleanup(func() {
		if pool != nil {
			pool.Close()
		}
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		_, _ = control.Exec(cleanupCtx, `
SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
 WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
		_, _ = control.Exec(cleanupCtx, "DROP DATABASE IF EXISTS "+quotedDatabase)
	})

	poolConfig, err := pgxpool.ParseConfig(adminURL)
	if err != nil {
		t.Fatalf("parse fixture pool URL: %v", err)
	}
	poolConfig.ConnConfig.Database = databaseName
	pool, err = pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatalf("connect isolated migration database: %v", err)
	}

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration test source path")
	}
	migrationsDir := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../infra/migrations"))
	files, err := LoadFiles(migrationsDir)
	if err != nil {
		t.Fatalf("load migrations: %v", err)
	}
	baseline := make([]MigrationFile, 0, len(files))
	var target MigrationFile
	for _, file := range files {
		if file.Version == "1997_verification_signup_attempt_fence" {
			target = file
			break
		}
		baseline = append(baseline, file)
	}
	if target.Version == "" {
		t.Fatal("migration 1997 not found")
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err = RunWithOptions(ctx, pool, baseline, logger, RunOptions{AllowUnsafe: true}); err != nil {
		t.Fatalf("apply historical baseline: %v", err)
	}

	historicalTenant, customTenant := uuid.NewString(), uuid.NewString()
	if _, err = pool.Exec(ctx, `
INSERT INTO tenants (id,name,slug,tier) VALUES
 ($1::uuid,'signup-fence-historical',$2,'studio'),
 ($3::uuid,'signup-fence-custom',$4,'studio')`,
		historicalTenant, "signup-fence-historical-"+historicalTenant[:8],
		customTenant, "signup-fence-custom-"+customTenant[:8]); err != nil {
		t.Fatalf("seed tenants: %v", err)
	}
	if _, err = pool.Exec(ctx, `
INSERT INTO verification_policy
       (tenant_id, forms_mode, forms_reject_statuses, forms_suggest_typos, import_mode)
VALUES ($1::uuid, 'off', ARRAY['invalid','spamtrap']::text[], true, 'off'),
       ($2::uuid, 'off', ARRAY['invalid','do_not_mail']::text[], true, 'off')`,
		historicalTenant, customTenant); err != nil {
		t.Fatalf("seed historical policies: %v", err)
	}

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire migration connection: %v", err)
	}
	defer conn.Release()
	if err = applyOne(ctx, conn.Conn(), target); err != nil {
		t.Fatalf("apply exact 1997 migration: %v", err)
	}
	if _, err = conn.Exec(ctx, `
UPDATE verification_policy SET forms_mode='local' WHERE tenant_id=$1::uuid`, historicalTenant); err != nil {
		t.Fatalf("enable formerly-off policy: %v", err)
	}

	var historicalMode string
	var historicalStatuses, customStatuses []string
	if err = conn.QueryRow(ctx, `
SELECT forms_mode, forms_reject_statuses
  FROM verification_policy WHERE tenant_id=$1::uuid`, historicalTenant).
		Scan(&historicalMode, &historicalStatuses); err != nil {
		t.Fatalf("read migrated historical policy: %v", err)
	}
	if err = conn.QueryRow(ctx, `
SELECT forms_reject_statuses
  FROM verification_policy WHERE tenant_id=$1::uuid`, customTenant).
		Scan(&customStatuses); err != nil {
		t.Fatalf("read migrated custom policy: %v", err)
	}
	wantHistorical := []string{"invalid", "spamtrap", "abuse", "do_not_mail"}
	wantCustom := []string{"invalid", "do_not_mail"}
	if historicalMode != "local" || strings.Join(historicalStatuses, ",") != strings.Join(wantHistorical, ",") {
		t.Fatalf("off-to-enable policy mode=%q statuses=%v, want local/%v",
			historicalMode, historicalStatuses, wantHistorical)
	}
	if strings.Join(customStatuses, ",") != strings.Join(wantCustom, ",") {
		t.Fatalf("bespoke policy overwritten: got=%v want=%v", customStatuses, wantCustom)
	}
}
