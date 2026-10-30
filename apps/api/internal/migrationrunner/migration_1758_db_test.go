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

// TestSubscriberEngineLinkETagMigrationOnDirtyUpgrade applies the exact 1758
// file after a full historical baseline and existing subscriber data. It pins
// the narrow contract: only an internal _listmonk_id delta preserves the
// concurrency timestamp; every user-visible mutation still advances it.
func TestSubscriberEngineLinkETagMigrationOnDirtyUpgrade(t *testing.T) {
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

	databaseName := "postwave_1758_etag_" + strings.ReplaceAll(uuid.NewString()[:12], "-", "")
	quotedDatabase := pgx.Identifier{databaseName}.Sanitize()
	if _, err = control.Exec(ctx, "CREATE DATABASE "+quotedDatabase); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "42501" {
			t.Fatalf("database role cannot create isolated migration fixture: %v", err)
		}
		t.Fatalf("create isolated migration database: %v", err)
	}

	poolConfig, err := pgxpool.ParseConfig(adminURL)
	if err != nil {
		t.Fatalf("parse fixture pool URL: %v", err)
	}
	poolConfig.ConnConfig.Database = databaseName
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
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
		if file.Version == "1758_subscriber_engine_link_etag_semantics" {
			target = file
			continue
		}
		if target.Version == "" {
			baseline = append(baseline, file)
		}
	}
	if target.Version == "" {
		t.Fatal("migration 1758 not found")
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err = RunWithOptions(ctx, pool, baseline, logger, RunOptions{AllowUnsafe: true}); err != nil {
		t.Fatalf("apply baseline before 1758: %v", err)
	}

	tenantID := uuid.NewString()
	subscriberID := uuid.NewString()
	initialUpdatedAt := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	if _, err = pool.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'subscriber-engine-etag-test', $2, 'studio')`,
		tenantID, "subscriber-engine-etag-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err = pool.Exec(ctx, `
INSERT INTO subscribers (
    id, tenant_id, email, status, consent_source, custom_fields, updated_at
)
VALUES (
    $1::uuid, $2::uuid, $3, 'unconfirmed', 'unknown',
    '{"favorite_color":"violet"}'::jsonb, $4
)`, subscriberID, tenantID, "etag-"+tenantID[:8]+"@example.test", initialUpdatedAt); err != nil {
		t.Fatalf("seed dirty subscriber: %v", err)
	}

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire migration connection: %v", err)
	}
	defer conn.Release()
	if err = applyOne(ctx, conn.Conn(), target); err != nil {
		t.Fatalf("apply exact 1758 migration: %v", err)
	}

	var persistedInitialUpdatedAt time.Time
	if err = conn.QueryRow(ctx, `
SELECT updated_at
  FROM subscribers s
	WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID).Scan(&persistedInitialUpdatedAt); err != nil {
		t.Fatalf("read pre-marker visible snapshot: %v", err)
	}
	var markerUpdatedAt time.Time
	var favoriteColor, marker string
	if err = conn.QueryRow(ctx, `
UPDATE subscribers
   SET custom_fields = jsonb_set(custom_fields, '{_listmonk_id}', '"101"'::jsonb, true)
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING updated_at, custom_fields ->> 'favorite_color', custom_fields ->> '_listmonk_id'`,
		tenantID, subscriberID).Scan(&markerUpdatedAt, &favoriteColor, &marker); err != nil {
		t.Fatalf("write internal engine link: %v", err)
	}
	if !markerUpdatedAt.Equal(persistedInitialUpdatedAt) || favoriteColor != "violet" || marker != "101" {
		t.Fatalf("internal marker changed ETag or user fields: initial=%s requested=%s updated=%s color=%q marker=%q",
			persistedInitialUpdatedAt, initialUpdatedAt, markerUpdatedAt, favoriteColor, marker)
	}

	time.Sleep(2 * time.Millisecond)
	var visibleUpdatedAt time.Time
	if err = conn.QueryRow(ctx, `
UPDATE subscribers
   SET custom_fields = jsonb_set(custom_fields, '{favorite_color}', '"indigo"'::jsonb, true)
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING updated_at`, tenantID, subscriberID).Scan(&visibleUpdatedAt); err != nil {
		t.Fatalf("write user-visible custom field: %v", err)
	}
	if !visibleUpdatedAt.After(markerUpdatedAt) {
		t.Fatalf("visible custom-field change did not advance ETag: before=%s after=%s", markerUpdatedAt, visibleUpdatedAt)
	}

	time.Sleep(2 * time.Millisecond)
	var statusUpdatedAt time.Time
	if err = conn.QueryRow(ctx, `
UPDATE subscribers
   SET status = 'blocklisted',
       custom_fields = jsonb_set(custom_fields, '{_listmonk_id}', '"202"'::jsonb, true)
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING updated_at`, tenantID, subscriberID).Scan(&statusUpdatedAt); err != nil {
		t.Fatalf("write combined visible/internal change: %v", err)
	}
	if !statusUpdatedAt.After(visibleUpdatedAt) {
		t.Fatalf("combined status/marker change did not advance ETag: before=%s after=%s", visibleUpdatedAt, statusUpdatedAt)
	}

	var applied int
	if err = conn.QueryRow(ctx, `
SELECT count(*) FROM schema_migrations WHERE version = $1 AND checksum = $2`,
		target.Version, target.Checksum).Scan(&applied); err != nil {
		t.Fatalf("read 1758 migration ledger: %v", err)
	}
	if applied != 1 {
		t.Fatalf("1758 ledger rows=%d; want exactly 1", applied)
	}
}
