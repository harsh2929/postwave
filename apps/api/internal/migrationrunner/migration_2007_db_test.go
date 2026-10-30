// SPDX-License-Identifier: AGPL-3.0-only
package migrationrunner

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestMigration2007SupportsMixedVersionWebhookWriters applies the exact file
// over the historical schema, then races legacy (no config_version assignment)
// and current (+1 assignment) updates against one endpoint. Every committed
// capability change must consume exactly one revision during a rolling deploy.
func TestMigration2007SupportsMixedVersionWebhookWriters(t *testing.T) {
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		adminURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL or DATABASE_URL is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	adminConfig, err := pgx.ParseConfig(adminURL)
	if err != nil {
		t.Fatalf("parse admin database URL: %v", err)
	}
	control, err := pgx.ConnectConfig(ctx, adminConfig)
	if err != nil {
		t.Fatalf("connect to database server: %v", err)
	}
	defer func() { _ = control.Close(context.Background()) }()

	databaseName := "postwave_2007_webhook_" + strings.ReplaceAll(uuid.NewString()[:12], "-", "")
	quotedDatabase := pgx.Identifier{databaseName}.Sanitize()
	if _, err = control.Exec(ctx, "CREATE DATABASE "+quotedDatabase); err != nil {
		t.Fatalf("create isolated migration database: %v", err)
	}
	poolConfig, err := pgxpool.ParseConfig(adminURL)
	if err != nil {
		t.Fatalf("parse fixture pool URL: %v", err)
	}
	poolConfig.ConnConfig.Database = databaseName
	poolConfig.MaxConns = 16
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatalf("connect isolated migration database: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		cleanup, cleanupErr := pgx.ConnectConfig(cleanupCtx, adminConfig)
		if cleanupErr != nil {
			t.Errorf("connect for migration 2007 cleanup: %v", cleanupErr)
			return
		}
		defer func() { _ = cleanup.Close(context.Background()) }()
		_, _ = cleanup.Exec(cleanupCtx, `
SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
 WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
		if _, cleanupErr = cleanup.Exec(cleanupCtx, "DROP DATABASE IF EXISTS "+quotedDatabase); cleanupErr != nil {
			t.Errorf("drop isolated migration 2007 database: %v", cleanupErr)
		}
	})

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration 2007 test source path")
	}
	migrationsDir := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../infra/migrations"))
	files, err := LoadFiles(migrationsDir)
	if err != nil {
		t.Fatalf("load migrations: %v", err)
	}
	baseline := make([]MigrationFile, 0, len(files))
	var target MigrationFile
	for _, file := range files {
		if file.Version == migration2007Version {
			target = file
			break
		}
		baseline = append(baseline, file)
	}
	if target.Version == "" {
		t.Fatalf("migration %s not found", migration2007Version)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err = RunWithOptions(ctx, pool, baseline, logger, RunOptions{AllowUnsafe: true}); err != nil {
		t.Fatalf("apply historical baseline: %v", err)
	}

	tenantID, webhookID := uuid.NewString(), uuid.NewString()
	seed, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = seed.Rollback(context.Background()) }()
	if _, err = seed.Exec(ctx, `SELECT set_config('app.tenant_id',$1,false)`, tenantID); err != nil {
		t.Fatalf("set seed tenant context: %v", err)
	}
	if _, err = seed.Exec(ctx, `
INSERT INTO tenants (id,name,slug,tier)
VALUES ($1::uuid,'migration-2007-mixed-writer',$2,'studio')`,
		tenantID, "migration-2007-"+strings.ReplaceAll(tenantID, "-", "")); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err = seed.Exec(ctx, `
INSERT INTO outbound_webhooks (
    id,tenant_id,url,url_envelope,url_state,events,secret_envelope,
    active,auth_config_state
) VALUES (
    $1::uuid,$2::uuid,'https://migration-2007.example.test/hook',
    '\x01'::bytea,'ready',ARRAY['campaign.sent']::text[],
    '\x01'::bytea,true,'ready'
)`, webhookID, tenantID); err != nil {
		t.Fatalf("seed pre-2007 webhook: %v", err)
	}
	if err = seed.Commit(ctx); err != nil {
		t.Fatalf("commit pre-2007 fixture: %v", err)
	}

	migrationConn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire migration connection: %v", err)
	}
	defer migrationConn.Release()
	if err = applyOne(ctx, migrationConn.Conn(), target); err != nil {
		t.Fatalf("apply exact migration 2007: %v", err)
	}

	var indexName string
	var indexValid, indexReady, indexUnique bool
	if err = pool.QueryRow(ctx, `
SELECT constraint_row.conindid::regclass::text,
       index_row.indisvalid,index_row.indisready,index_row.indisunique
  FROM pg_constraint constraint_row
  JOIN pg_index index_row ON index_row.indexrelid=constraint_row.conindid
 WHERE constraint_row.conrelid='outbound_webhooks'::regclass
   AND constraint_row.conname='outbound_webhooks_tenant_id_id_key'
   AND constraint_row.contype='u'`).Scan(
		&indexName, &indexValid, &indexReady, &indexUnique,
	); err != nil {
		t.Fatalf("read adopted migration 2007 index: %v", err)
	}
	if indexName != "outbound_webhooks_tenant_id_id_key" || !indexValid || !indexReady || !indexUnique {
		t.Fatalf("adopted index name=%q valid=%v ready=%v unique=%v",
			indexName, indexValid, indexReady, indexUnique)
	}
	var versionRows, phaseRows int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version=$1 AND checksum=$2`, target.Version, target.Checksum).Scan(&versionRows); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM schema_migration_steps WHERE version=$1`, target.Version).Scan(&phaseRows); err != nil {
		t.Fatal(err)
	}
	if versionRows != 1 || phaseRows != 0 {
		t.Fatalf("migration 2007 version=%d phase markers=%d, want 1/0", versionRows, phaseRows)
	}

	var revision int64
	if err = pool.QueryRow(ctx, `
UPDATE outbound_webhooks
   SET active=false
 WHERE id=$1::uuid
RETURNING config_version`, webhookID).Scan(&revision); err != nil {
		t.Fatalf("legacy writer capability update: %v", err)
	}
	if revision != 2 {
		t.Fatalf("legacy writer revision=%d, want 2", revision)
	}
	if err = pool.QueryRow(ctx, `
UPDATE outbound_webhooks
   SET active=true, config_version=config_version+1
 WHERE id=$1::uuid
RETURNING config_version`, webhookID).Scan(&revision); err != nil {
		t.Fatalf("current writer capability update: %v", err)
	}
	if revision != 3 {
		t.Fatalf("current writer revision=%d, want 3", revision)
	}

	const writers = 8
	start := make(chan struct{})
	versions := make(chan int64, writers)
	errorsCh := make(chan error, writers)
	var writerGroup sync.WaitGroup
	for i := 0; i < writers; i++ {
		currentWriter := i%2 == 1
		writerGroup.Add(1)
		go func(writer int, current bool) {
			defer writerGroup.Done()
			<-start
			statement := `
UPDATE outbound_webhooks
   SET active=NOT active
 WHERE id=$1::uuid
RETURNING config_version`
			if current {
				statement = `
UPDATE outbound_webhooks
   SET active=NOT active, config_version=config_version+1
 WHERE id=$1::uuid
RETURNING config_version`
			}
			var got int64
			if queryErr := pool.QueryRow(ctx, statement, webhookID).Scan(&got); queryErr != nil {
				errorsCh <- fmt.Errorf("writer %d current=%v: %w", writer, current, queryErr)
				return
			}
			versions <- got
		}(i, currentWriter)
	}
	close(start)
	writerGroup.Wait()
	close(errorsCh)
	close(versions)
	for writerErr := range errorsCh {
		t.Error(writerErr)
	}
	if t.Failed() {
		t.FailNow()
	}
	gotVersions := make([]int64, 0, writers)
	for got := range versions {
		gotVersions = append(gotVersions, got)
	}
	if len(gotVersions) != writers {
		t.Fatalf("mixed writer revisions=%v, want %d committed writers", gotVersions, writers)
	}
	sort.Slice(gotVersions, func(i, j int) bool { return gotVersions[i] < gotVersions[j] })
	for i, got := range gotVersions {
		want := int64(4 + i)
		if got != want {
			t.Fatalf("mixed writer revisions=%v, want contiguous 4..%d", gotVersions, 3+writers)
		}
	}
	if err = pool.QueryRow(ctx, `SELECT config_version FROM outbound_webhooks WHERE id=$1::uuid`, webhookID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if revision != 3+writers {
		t.Fatalf("final mixed-writer revision=%d, want %d", revision, 3+writers)
	}

	if _, err = pool.Exec(ctx, `
UPDATE outbound_webhooks
   SET active=NOT active, config_version=config_version+2
 WHERE id=$1::uuid`, webhookID); err == nil || !strings.Contains(err.Error(), "must increment config_version exactly once") {
		t.Fatalf("invalid capability revision error=%v", err)
	}
	if _, err = pool.Exec(ctx, `
UPDATE outbound_webhooks
   SET description=description, config_version=config_version+1
		WHERE id=$1::uuid`, webhookID); err == nil || !strings.Contains(err.Error(), "changed without a capability mutation") {
		t.Fatalf("invalid non-capability revision error=%v", err)
	}

	// Completion replaces the reserved receipt and its locator as one exact
	// unit. An address that exists only in the reserved skeleton must be allowed
	// to disappear when it is absent from the terminal plaintext.
	replacementFireID := uuid.NewString()
	if _, err = pool.Exec(ctx, `
INSERT INTO outbound_webhook_playground_fires (
    tenant_id,fire_id,webhook_id,webhook_ref_id,config_version,
    idempotency_key_sha256,request_sha256,event_type,
    receipt_envelope,receipt_sha256,subject_email_sha256s
) VALUES (
    $1::uuid,$2::uuid,$3::uuid,$3::uuid,$4,$5,$6,'campaign.sent',
    '\x01'::bytea,$7,ARRAY[$8]::text[]
)`, tenantID, replacementFireID, webhookID, revision, strings.Repeat("1", 64),
		strings.Repeat("2", 64), strings.Repeat("3", 64), strings.Repeat("4", 64)); err != nil {
		t.Fatalf("insert reserved-only subject locator: %v", err)
	}
	if _, err = pool.Exec(ctx, `
UPDATE outbound_webhook_playground_fires
   SET state='completed',outcome='filtered',receiver_status_code=204,
       receipt_envelope='\x02'::bytea,receipt_sha256=$3,
       subject_email_sha256s='{}'::text[],completed_at=now()
 WHERE tenant_id=$1::uuid AND fire_id=$2::uuid`, tenantID, replacementFireID,
		strings.Repeat("5", 64)); err != nil {
		t.Fatalf("replace terminal receipt with exact empty locator: %v", err)
	}
	var replacementLocatorCount int
	if err = pool.QueryRow(ctx, `
SELECT cardinality(subject_email_sha256s)
  FROM outbound_webhook_playground_fires
 WHERE tenant_id=$1::uuid AND fire_id=$2::uuid`, tenantID, replacementFireID).Scan(
		&replacementLocatorCount,
	); err != nil || replacementLocatorCount != 0 {
		t.Fatalf("terminal replacement locators=%d err=%v, want zero", replacementLocatorCount, err)
	}

	// The privacy locator is mutable only as part of a valid receipt transition.
	// Email-address erasure may consume an unresolved pending fire, but it must
	// wipe the encrypted receipt/locator without weakening either permanent
	// identity digest used to prevent redispatch.
	fireID := uuid.NewString()
	keyDigest := strings.Repeat("a", 64)
	requestDigest := strings.Repeat("b", 64)
	subjectDigest := strings.Repeat("c", 64)
	receiptDigest := strings.Repeat("d", 64)
	if _, err = pool.Exec(ctx, `
INSERT INTO outbound_webhook_playground_fires (
    tenant_id,fire_id,webhook_id,webhook_ref_id,config_version,
    idempotency_key_sha256,request_sha256,event_type,
    receipt_envelope,receipt_sha256,subject_email_sha256s
) VALUES (
    $1::uuid,$2::uuid,$3::uuid,$3::uuid,$4,$5,$6,'campaign.sent',
    '\x01'::bytea,$7,ARRAY[$8]::text[]
)`, tenantID, fireID, webhookID, revision, keyDigest, requestDigest,
		receiptDigest, subjectDigest); err != nil {
		t.Fatalf("insert subject-locatable playground receipt: %v", err)
	}
	if _, err = pool.Exec(ctx, `
UPDATE outbound_webhook_playground_fires
   SET subject_email_sha256s='{}'::text[]
 WHERE tenant_id=$1::uuid AND fire_id=$2::uuid`, tenantID, fireID); err == nil ||
		!strings.Contains(err.Error(), "invalid webhook playground fire transition") {
		t.Fatalf("locator-only removal error=%v, want guarded transition", err)
	}
	if _, err = pool.Exec(ctx, `
UPDATE outbound_webhook_playground_fires
   SET state='receipt_expired',outcome='transport_ambiguous',
       receiver_status_code=0,receipt_envelope=NULL,receipt_sha256=NULL,
       subject_email_sha256s='{}'::text[],completed_at=now(),
       receipt_expired_at=now()
 WHERE tenant_id=$1::uuid AND fire_id=$2::uuid`, tenantID, fireID); err != nil {
		t.Fatalf("cryptoshred pending subject receipt: %v", err)
	}
	var state, storedKeyDigest, storedRequestDigest string
	var envelopeGone bool
	var locatorCount int
	if err = pool.QueryRow(ctx, `
SELECT state,idempotency_key_sha256,request_sha256,
       receipt_envelope IS NULL,cardinality(subject_email_sha256s)
  FROM outbound_webhook_playground_fires
 WHERE tenant_id=$1::uuid AND fire_id=$2::uuid`, tenantID, fireID).Scan(
		&state, &storedKeyDigest, &storedRequestDigest, &envelopeGone, &locatorCount,
	); err != nil {
		t.Fatal(err)
	}
	if state != "receipt_expired" || !envelopeGone || locatorCount != 0 ||
		storedKeyDigest != keyDigest || storedRequestDigest != requestDigest {
		t.Fatalf("cryptoshred state=%q envelope_gone=%v locators=%d key=%q request=%q",
			state, envelopeGone, locatorCount, storedKeyDigest, storedRequestDigest)
	}
	tag, err := pool.Exec(ctx, `
INSERT INTO outbound_webhook_playground_fires (
    tenant_id,fire_id,webhook_id,webhook_ref_id,config_version,
    idempotency_key_sha256,request_sha256,event_type,
    receipt_envelope,receipt_sha256
) VALUES (
    $1::uuid,$2::uuid,$3::uuid,$3::uuid,$4,$5,$6,'campaign.sent',
    '\x02'::bytea,$7
) ON CONFLICT DO NOTHING`, tenantID, fireID, webhookID, revision,
		strings.Repeat("e", 64), strings.Repeat("f", 64), receiptDigest)
	if err != nil || tag.RowsAffected() != 0 {
		t.Fatalf("cryptoshredded fire fence reinsert rows=%d err=%v", tag.RowsAffected(), err)
	}
}
