package migrationrunner

import (
	"context"
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
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestRoute40TenantReferenceMigrationPoisonRollbackAndResume applies the real
// historical baseline and migration 1989 to an isolated database. It pins the
// phased rollout contract: the four online indexes and their exact phase
// marker may survive a failed ownership preflight, but constraint adoption,
// validation, and the migration version must roll back together. After a
// reviewed repair, retry resumes from that marker without rebuilding the
// indexes and atomically validates the complete tenant-reference set.
func TestRoute40TenantReferenceMigrationPoisonRollbackAndResume(t *testing.T) {
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		adminURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL or DATABASE_URL is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
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

	databaseName := "postwave_1989_tenant_ref_" + strings.ReplaceAll(uuid.NewString()[:12], "-", "")
	quotedDatabase := pgx.Identifier{databaseName}.Sanitize()
	if _, err = control.Exec(ctx, "CREATE DATABASE "+quotedDatabase); err != nil {
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
		cleanupControl, cleanupErr := pgx.ConnectConfig(cleanupCtx, adminConfig)
		if cleanupErr != nil {
			t.Errorf("connect for isolated migration database cleanup: %v", cleanupErr)
			return
		}
		defer func() { _ = cleanupControl.Close(context.Background()) }()
		if _, cleanupErr = cleanupControl.Exec(cleanupCtx, `
SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
	WHERE datname = $1 AND pid <> pg_backend_pid()`, databaseName); cleanupErr != nil {
			t.Errorf("terminate isolated migration database sessions: %v", cleanupErr)
			return
		}
		if _, cleanupErr = cleanupControl.Exec(cleanupCtx, "DROP DATABASE IF EXISTS "+quotedDatabase); cleanupErr != nil {
			t.Errorf("drop isolated migration database: %v", cleanupErr)
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
		if file.Version == "1989_sms_tenant_reference_integrity" {
			target = file
			break
		}
		baseline = append(baseline, file)
	}
	if target.Version == "" {
		t.Fatal("migration 1989 not found")
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err = RunWithOptions(ctx, pool, baseline, logger, RunOptions{AllowUnsafe: true}); err != nil {
		t.Fatalf("apply historical baseline before 1989: %v", err)
	}

	tenantA := uuid.NewString()
	tenantB := uuid.NewString()
	senderB := uuid.NewString()
	listA := uuid.NewString()
	if _, err = pool.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier) VALUES
  ($1::uuid, 'route40-1989-a', $2, 'studio'),
	($3::uuid, 'route40-1989-b', $4, 'studio')
`, tenantA, "route40-1989-a-"+tenantA[:8], tenantB, "route40-1989-b-"+tenantB[:8]); err != nil {
		t.Fatalf("seed poison tenants: %v", err)
	}
	if _, err = pool.Exec(ctx, `
INSERT INTO sms_sender_profiles (id, tenant_id, provider)
VALUES ($1::uuid, $2::uuid, 'twilio')
`, senderB, tenantB); err != nil {
		t.Fatalf("seed poison sender: %v", err)
	}
	if _, err = pool.Exec(ctx, `
INSERT INTO sms_lists (id, tenant_id, name, sender_profile_id)
VALUES ($1::uuid, $2::uuid, 'cross-tenant-poison', $3::uuid)
`, listA, tenantA, senderB); err != nil {
		t.Fatalf("seed cross-tenant ownership poison: %v", err)
	}

	indexNames := []string{
		"sms_sender_profiles_tenant_id_id_uidx",
		"sms_lists_tenant_id_id_uidx",
		"sms_campaigns_tenant_id_id_uidx",
		"users_tenant_id_id_campaign_template_uidx",
	}
	uniqueConstraintNames := []string{
		"sms_sender_profiles_tenant_id_id_unique",
		"sms_lists_tenant_id_id_unique",
		"sms_campaigns_tenant_id_id_unique",
		"users_tenant_id_id_unique",
	}
	fkConstraintNames := []string{
		"sms_lists_sender_profile_tenant_fk",
		"sms_subscriptions_list_tenant_fk",
		"sms_consent_events_list_tenant_fk",
		"sms_campaigns_sender_profile_tenant_fk",
		"sms_campaigns_list_tenant_fk",
		"sms_messages_sender_profile_tenant_fk",
		"sms_messages_campaign_tenant_fk",
		"sms_campaign_recipients_sender_profile_tenant_fk",
		"sms_campaign_recipients_list_tenant_fk",
		"sms_campaign_recipients_campaign_tenant_fk",
		"sms_campaign_recipients_message_tenant_fk",
		"sms_broadcasts_sender_profile_tenant_fk",
		"sms_broadcasts_campaign_tenant_fk",
		"sms_broadcasts_segment_tenant_fk",
		"sms_link_clicks_message_tenant_fk",
		"sms_link_clicks_campaign_tenant_fk",
		"sms_link_tokens_message_tenant_fk",
		"sms_link_tokens_campaign_tenant_fk",
		"sms_send_throttle_sender_tenant_fk",
		"social_auto_reply_rules_sms_list_tenant_fk",
		"social_auto_reply_rules_sender_profile_tenant_fk",
		"tap_to_text_links_sms_list_tenant_fk",
		"tap_to_text_links_sender_profile_tenant_fk",
		"sms_conversation_state_assignee_tenant_fk",
		"sms_conversation_tags_creator_tenant_fk",
		"sms_quick_replies_creator_tenant_fk",
	}
	allConstraintNames := append(append([]string{}, uniqueConstraintNames...), fkConstraintNames...)

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire migration connection: %v", err)
	}
	defer conn.Release()
	if err = applyOne(ctx, conn.Conn(), target); err == nil || !strings.Contains(err.Error(), "Route40 SMS tenant-reference preflight failed") {
		t.Fatalf("poisoned migration error = %v, want ownership preflight failure", err)
	}

	var versionRows, phaseRows, constraintRows int
	if err = conn.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version=$1`, target.Version).Scan(&versionRows); err != nil {
		t.Fatalf("read failed migration version: %v", err)
	}
	if err = conn.QueryRow(ctx, `SELECT count(*) FROM schema_migration_steps WHERE version=$1`, target.Version).Scan(&phaseRows); err != nil {
		t.Fatalf("read retained phase marker: %v", err)
	}
	if err = conn.QueryRow(ctx, `SELECT count(*) FROM pg_constraint WHERE conname=ANY($1::text[])`, allConstraintNames).Scan(&constraintRows); err != nil {
		t.Fatalf("read rolled-back constraints: %v", err)
	}
	if versionRows != 0 || phaseRows != 1 || constraintRows != 0 {
		t.Fatalf("poison rollback version=%d phases=%d constraints=%d, want 0/1/0", versionRows, phaseRows, constraintRows)
	}

	var phaseStep int
	var phaseChecksum, phaseDigest string
	var phaseTransactional bool
	if err = conn.QueryRow(ctx, `
SELECT step, checksum, phase_digest, transactional
  FROM schema_migration_steps
 WHERE version=$1`, target.Version).Scan(&phaseStep, &phaseChecksum, &phaseDigest, &phaseTransactional); err != nil {
		t.Fatalf("read exact phase marker: %v", err)
	}
	if phaseStep != 0 || phaseChecksum != target.Checksum || len(phaseDigest) != 64 || phaseTransactional {
		t.Fatalf("phase marker step=%d checksum=%q digest=%q transactional=%v", phaseStep, phaseChecksum, phaseDigest, phaseTransactional)
	}

	readIndexOIDs := func() map[string]int64 {
		t.Helper()
		out := make(map[string]int64, len(indexNames))
		for _, name := range indexNames {
			var oid int64
			var valid, ready bool
			if queryErr := conn.QueryRow(ctx, `
SELECT relation.oid::bigint, index.indisvalid, index.indisready
  FROM pg_class relation
  JOIN pg_index index ON index.indexrelid=relation.oid
	WHERE relation.oid=to_regclass('public.' || $1)`, name).Scan(&oid, &valid, &ready); queryErr != nil {
				t.Fatalf("read concurrent index %s: %v", name, queryErr)
			}
			if !valid || !ready {
				t.Fatalf("concurrent index %s valid=%v ready=%v", name, valid, ready)
			}
			out[name] = oid
		}
		return out
	}
	beforeRepairIndexOIDs := readIndexOIDs()

	if tag, repairErr := conn.Exec(ctx, `
UPDATE sms_lists
   SET sender_profile_id=NULL
 WHERE id=$1::uuid AND tenant_id=$2::uuid AND sender_profile_id=$3::uuid`, listA, tenantA, senderB); repairErr != nil {
		t.Fatalf("repair poisoned list ownership: %v", repairErr)
	} else if tag.RowsAffected() != 1 {
		t.Fatalf("repair affected %d rows, want 1", tag.RowsAffected())
	}
	if err = applyOne(ctx, conn.Conn(), target); err != nil {
		t.Fatalf("resume migration 1989 after reviewed repair: %v", err)
	}

	var validatedConstraints int
	if err = conn.QueryRow(ctx, `
SELECT count(*), count(*) FILTER (WHERE convalidated)
  FROM pg_constraint
 WHERE conname=ANY($1::text[])`, allConstraintNames).Scan(&constraintRows, &validatedConstraints); err != nil {
		t.Fatalf("read resumed constraints: %v", err)
	}
	if err = conn.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version=$1 AND checksum=$2`, target.Version, target.Checksum).Scan(&versionRows); err != nil {
		t.Fatalf("read resumed migration version: %v", err)
	}
	if err = conn.QueryRow(ctx, `SELECT count(*) FROM schema_migration_steps WHERE version=$1`, target.Version).Scan(&phaseRows); err != nil {
		t.Fatalf("read cleared phase markers: %v", err)
	}
	if constraintRows != len(allConstraintNames) || validatedConstraints != len(allConstraintNames) || versionRows != 1 || phaseRows != 0 {
		t.Fatalf("resume constraints=%d validated=%d version=%d phases=%d, want %d/%d/1/0",
			constraintRows, validatedConstraints, versionRows, phaseRows, len(allConstraintNames), len(allConstraintNames))
	}
	for i, constraintName := range uniqueConstraintNames {
		var adoptedIndexOID int64
		var valid, ready bool
		if err = conn.QueryRow(ctx, `
SELECT constraint_row.conindid::bigint, index_row.indisvalid, index_row.indisready
  FROM pg_constraint constraint_row
	JOIN pg_index index_row ON index_row.indexrelid=constraint_row.conindid
	WHERE constraint_row.conname=$1`, constraintName).Scan(&adoptedIndexOID, &valid, &ready); err != nil {
			t.Fatalf("read adopted unique constraint %s: %v", constraintName, err)
		}
		if adoptedIndexOID != beforeRepairIndexOIDs[indexNames[i]] || !valid || !ready {
			t.Fatalf("unique constraint %s adopted index oid=%d valid=%v ready=%v, want retained %s oid=%d",
				constraintName, adoptedIndexOID, valid, ready, indexNames[i], beforeRepairIndexOIDs[indexNames[i]])
		}
	}
	var userOwnershipIndexCount int
	if err = conn.QueryRow(ctx, `
SELECT count(*)
  FROM pg_index index_row
  JOIN pg_class table_row ON table_row.oid=index_row.indrelid
 WHERE table_row.oid='users'::regclass
   AND index_row.indisunique
   AND index_row.indkey::text=(
     SELECT candidate.indkey::text
       FROM pg_index candidate
      WHERE candidate.indexrelid='users_tenant_id_id_unique'::regclass
   )`).Scan(&userOwnershipIndexCount); err != nil {
		t.Fatalf("count users tenant ownership indexes: %v", err)
	}
	if userOwnershipIndexCount != 1 {
		t.Fatalf("users(tenant_id,id) unique index count = %d, want one reused index", userOwnershipIndexCount)
	}
}
