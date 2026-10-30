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

// TestPlatformTemplateRewriteMigrationRefusesDivergedRows exercises the exact
// 2055 file over the historical schema. The migration replaces whole bodies of
// the built-in templates, so it must never overwrite a row someone edited out
// of band: it has to stop, name the row, and leave every template untouched.
// Once the row matches its seed again, the same file applies and leaves no
// built-in template carrying the defects it exists to remove.
func TestPlatformTemplateRewriteMigrationRefusesDivergedRows(t *testing.T) {
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

	databaseName := "postwave_2055_templates_" + strings.ReplaceAll(uuid.NewString()[:12], "-", "")
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
		if file.Version == "2055_platform_template_drafts_and_mobile_layout" {
			target = file
			break
		}
		baseline = append(baseline, file)
	}
	if target.Version == "" {
		t.Fatal("migration 2055 not found")
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err = RunWithOptions(ctx, pool, baseline, logger, RunOptions{AllowUnsafe: true}); err != nil {
		t.Fatalf("apply historical baseline: %v", err)
	}

	platformSnapshot := func() map[string]string {
		t.Helper()
		rows, queryErr := pool.Query(ctx, `
SELECT slug, md5(subject || preview_text || body_html || body_mjml || variables::text)
  FROM campaign_templates WHERE tenant_id IS NULL`)
		if queryErr != nil {
			t.Fatalf("snapshot platform templates: %v", queryErr)
		}
		defer rows.Close()
		out := map[string]string{}
		for rows.Next() {
			var slug, digest string
			if scanErr := rows.Scan(&slug, &digest); scanErr != nil {
				t.Fatalf("scan snapshot: %v", scanErr)
			}
			out[slug] = digest
		}
		return out
	}
	seeded := platformSnapshot()
	if len(seeded) != 29 {
		t.Fatalf("baseline has %d platform templates, want 29", len(seeded))
	}

	// An operator hand-edited one starter after it was seeded.
	var original string
	if err = pool.QueryRow(ctx, `
SELECT body_html FROM campaign_templates
 WHERE tenant_id IS NULL AND slug = 'newsletter-one-link'`).Scan(&original); err != nil {
		t.Fatalf("read seeded body: %v", err)
	}
	if _, err = pool.Exec(ctx, `
UPDATE campaign_templates SET body_html = body_html || '<!-- local edit -->'
 WHERE tenant_id IS NULL AND slug = 'newsletter-one-link'`); err != nil {
		t.Fatalf("diverge one starter: %v", err)
	}
	diverged := platformSnapshot()

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire migration connection: %v", err)
	}
	defer conn.Release()
	err = applyOne(ctx, conn.Conn(), target)
	if err == nil || !strings.Contains(err.Error(), "newsletter-one-link") {
		t.Fatalf("applying 2055 over a diverged starter: err=%v, want a refusal naming newsletter-one-link", err)
	}
	after := platformSnapshot()
	for slug, digest := range diverged {
		if after[slug] != digest {
			t.Fatalf("refused migration still changed %s", slug)
		}
	}
	var recorded int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version = $1`, target.Version).Scan(&recorded); err != nil || recorded != 0 {
		t.Fatalf("refused migration recorded=%d err=%v", recorded, err)
	}

	// Reconciled, the same file applies.
	if _, err = pool.Exec(ctx, `
UPDATE campaign_templates SET body_html = $1
 WHERE tenant_id IS NULL AND slug = 'newsletter-one-link'`, original); err != nil {
		t.Fatalf("reconcile starter: %v", err)
	}
	if err = applyOne(ctx, conn.Conn(), target); err != nil {
		t.Fatalf("apply exact 2055 migration: %v", err)
	}
	rewritten := platformSnapshot()
	for slug, digest := range seeded {
		if rewritten[slug] == digest {
			t.Fatalf("%s was not rewritten", slug)
		}
	}
	var offenders []string
	rows, err := pool.Query(ctx, `
SELECT slug FROM campaign_templates
 WHERE tenant_id IS NULL
   AND (   (subject || preview_text || body_html || variables::text) ~* 'postwave|example\.invalid|creator@'
        OR variables::text ~ '"name": "(unsubscribe_url|product|reply_email|founder_name|author_name|support_email)"'
        OR body_mjml <> ''
        OR (goal <> 'transactional' AND body_html !~ '\{\{ unsubscribe_url \}\}'))
 ORDER BY slug`)
	if err != nil {
		t.Fatalf("scan rewritten starters: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var slug string
		if scanErr := rows.Scan(&slug); scanErr != nil {
			t.Fatalf("scan offender: %v", scanErr)
		}
		offenders = append(offenders, slug)
	}
	if len(offenders) != 0 {
		t.Fatalf("starters still carrying a defect after 2055: %v", offenders)
	}
}
