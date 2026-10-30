package reportstore

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist/categorizers"
)

type observationObjectFake struct {
	mu      sync.Mutex
	puts    []RawMIMEObject
	deleted []ObjectReceipt
}

func (f *observationObjectFake) PutRawMIME(_ context.Context, object RawMIMEObject) (ObjectReceipt, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.puts = append(f.puts, object)
	version := fmt.Sprintf("version-%d", len(f.puts))
	return ObjectReceipt{
		ObjectRef: "s3://seed-proof/v1/" + object.TenantID + "/" + object.ObservationKey + "/received.eml?versionId=" + version,
		VersionID: version,
	}, nil
}

func (f *observationObjectFake) DeleteRawMIME(_ context.Context, receipt ObjectReceipt) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, receipt)
	return nil
}

func seedObservationDBPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("POSTWAVE_SEED_OBSERVATION_TEST_DATABASE_URL"))
	if url == "" {
		t.Skip("POSTWAVE_SEED_OBSERVATION_TEST_DATABASE_URL is required for seed observation DB proof")
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var ready bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.seed_message_observations') IS NOT NULL
   AND to_regclass('public.seed_observation_object_deletions') IS NOT NULL
   AND EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'inbox_reality_tests'
          AND column_name = 'artifact_id'
   )`).Scan(&ready); err != nil || !ready {
		t.Fatalf("configured database does not have migration 1927: ready=%v err=%v", ready, err)
	}
	return pool
}

func seedObservationAppRolePool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("POSTWAVE_SEED_OBSERVATION_TEST_DATABASE_URL"))
	if url == "" {
		t.Skip("POSTWAVE_SEED_OBSERVATION_TEST_DATABASE_URL is required for seed observation DB proof")
	}
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	config.AfterConnect = func(ctx context.Context, connection *pgx.Conn) error {
		_, err := connection.Exec(ctx, `SET ROLE postwave_app`)
		return err
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

type seedObservationFixture struct {
	tenantID, campaignID, revisionID, planID, artifactID, testID, token string
}

func createSeedObservationFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) seedObservationFixture {
	t.Helper()
	fixture := seedObservationFixture{
		tenantID: uuid.NewString(), campaignID: uuid.NewString(), revisionID: uuid.NewString(),
		planID: uuid.NewString(), artifactID: uuid.NewString(), testID: uuid.NewString(),
	}
	fixture.token = strings.ReplaceAll(uuid.NewString(), "-", "")
	suffix := strings.ReplaceAll(fixture.tenantID, "-", "")[:16]
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, $3, 'studio')`, []any{
			fixture.tenantID, "seed-observation-" + suffix, "Seed observation " + suffix,
		}},
		{`INSERT INTO campaigns (id, tenant_id, name, subject, body_html)
VALUES ($1::uuid, $2::uuid, 'Seed observation proof', 'Launch', '<p>Launch</p>')`, []any{
			fixture.campaignID, fixture.tenantID,
		}},
		{`INSERT INTO campaign_content_revisions (
    id, tenant_id, campaign_id, revision_no, source_mode, content_schema_version,
    subject, semantic_tree, legacy_html, fact_contract, variants, locales, source_hash
) VALUES (
    $1::uuid, $2::uuid, $3::uuid, 1, 'legacy_html', 1, 'Launch', '[]'::jsonb,
    '<p>Launch</p>', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, repeat('1', 64)
)`, []any{fixture.revisionID, fixture.tenantID, fixture.campaignID}},
		{`INSERT INTO campaign_send_plans (
    id, tenant_id, campaign_id, content_revision_id, plan_no, request_id,
    request_hash, renderer_version, compiler_version, transform_manifest,
    coverage_manifest, fixture_set_version, policy_version, state
) VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, gen_random_uuid(), repeat('2', 64),
    'renderer-v1', 'compiler-v1', '{}'::jsonb, '{"scenarios":["base"]}'::jsonb,
    'fixtures-v1', 'policy-v1', 'preparing'
)`, []any{fixture.planID, fixture.tenantID, fixture.campaignID, fixture.revisionID}},
		{`INSERT INTO campaign_render_artifacts (
    id, tenant_id, campaign_id, send_plan_id, scenario_id, locale, branch_key,
    fixture_id, source_hash, html_hash, text_hash, mime_structure_hash,
    outbound_mime_hash, compiler_receipt, representation_manifest
) VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'base', 'en-US', 'default', 'fixture-base',
    repeat('1',64), repeat('3',64), repeat('4',64), repeat('5',64), repeat('6',64),
    '{}'::jsonb, '{}'::jsonb
)`, []any{fixture.artifactID, fixture.tenantID, fixture.campaignID, fixture.planID}},
		{`UPDATE campaign_send_plans SET state='ready', plan_hash=repeat('b',64), ready_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid`, []any{fixture.tenantID, fixture.planID}},
		{`INSERT INTO inbox_reality_tests (
    id, tenant_id, header_token, kind, status, expires_at, campaign_id,
    content_revision_id, send_plan_id, artifact_id, scenario_id,
    outbound_mime_hash, outbound_mime_structure_hash, requested_capabilities
) VALUES (
    $1::uuid, $2::uuid, $3, 'campaign_assurance', 'awaiting_delivery', now()+interval '10 minutes',
    $4::uuid, $5::uuid, $6::uuid, $7::uuid, 'base', repeat('6',64), repeat('5',64),
    '{"raw_mime":"required"}'::jsonb
)`, []any{fixture.testID, fixture.tenantID, fixture.token, fixture.campaignID,
			fixture.revisionID, fixture.planID, fixture.artifactID}},
	}
	for index, statement := range statements {
		if _, err := tx.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("fixture statement %d: %v", index+1, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1::uuid`, fixture.tenantID)
	})
	return fixture
}

func TestSeedObservationPersistsExactArtifactAndEncryptedObjectReceipt_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := seedObservationDBPool(t, ctx)
	fixture := createSeedObservationFixture(t, ctx, pool)
	objects := &observationObjectFake{}
	store := NewPostgresStore(pool, "", objects)
	rawBytes := []byte("From: sender@example.test\r\nTo: private-seed@example.test\r\nContent-Type: text/plain\r\n\r\nLaunch\r\n")
	observation := seedlist.MessageObservation{
		TestHeaderValue: "irt_" + fixture.token,
		Provider:        domain.ProviderGmail, MailboxID: "gmail-proof-01", Folder: "INBOX",
		Labels: []string{"INBOX"}, Placement: domain.PlacementPrimary,
		Headers: map[string]string{"Message-ID": "<private-id@example.test>"},
		Capabilities: seedlist.ConnectorCapabilities{
			Headers: seedlist.CapabilityAvailable, RawMIME: seedlist.CapabilityAvailable,
			BodyParts: seedlist.CapabilityAvailable, Placement: seedlist.CapabilityAvailable,
			ObservedSurface: seedlist.CapabilityUnavailable,
		},
		HealthState: seedlist.StatusActive, ReceivedAt: time.Now().UTC().Add(-time.Second),
		RawMIME: &categorizers.RawMIMEAcquisition{
			Status: categorizers.RawMIMEComplete, Source: "imap_body_peek",
			SHA256: digestBytes(rawBytes), CapturedBytes: int64(len(rawBytes)),
			ReportedBytes: int64(len(rawBytes)), MaxBytes: 1024, UID: 41, UIDValidity: 42,
			Raw: rawBytes,
			Manifest: categorizers.MIMEManifest{
				Status: categorizers.MIMEParseParsed, StructureSHA256: strings.Repeat("5", 64),
				TextBodySHA256: strings.Repeat("4", 64), HTMLBodySHA256: strings.Repeat("3", 64),
			},
		},
	}
	if err := store.WriteMessageObservation(ctx, observation); err != nil {
		t.Fatal(err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, fixture.tenantID); err != nil {
		t.Fatal(err)
	}
	var count int
	var testID, artifactID, objectRef, tokenHash, structureComparison, textComparison, htmlComparison string
	if err := tx.QueryRow(ctx, `
SELECT count(*) OVER (), test_id::text, artifact_id::text, raw_mime_object_ref,
       test_token_sha256, structure_comparison, text_comparison, html_comparison
  FROM seed_message_observations
 WHERE tenant_id=$1::uuid AND test_id=$2::uuid
`, fixture.tenantID, fixture.testID).Scan(&count, &testID, &artifactID, &objectRef,
		&tokenHash, &structureComparison, &textComparison, &htmlComparison); err != nil {
		t.Fatal(err)
	}
	if count != 1 || testID != fixture.testID || artifactID != fixture.artifactID ||
		!strings.HasPrefix(objectRef, "s3://seed-proof/") || tokenHash == fixture.token ||
		structureComparison != "match" || textComparison != "match" || htmlComparison != "match" {
		t.Fatalf("unexpected receipt count=%d test=%s artifact=%s ref=%s token=%s comparisons=%s/%s/%s",
			count, testID, artifactID, objectRef, tokenHash, structureComparison, textComparison, htmlComparison)
	}
	if _, err := tx.Exec(ctx, `UPDATE seed_message_observations SET placement='spam'
WHERE tenant_id=$1::uuid AND test_id=$2::uuid`, fixture.tenantID, fixture.testID); sqlState(err) != "55000" {
		t.Fatalf("immutable update SQLSTATE=%s err=%v", sqlState(err), err)
	}
	_ = tx.Rollback(ctx)

	// An exact retry converges on one row and deletes only the newly-created
	// object version, not the canonical first version.
	if err := store.WriteMessageObservation(ctx, observation); err != nil {
		t.Fatal(err)
	}
	objects.mu.Lock()
	puts, deletions := len(objects.puts), append([]ObjectReceipt(nil), objects.deleted...)
	objects.mu.Unlock()
	if puts != 2 || len(deletions) != 1 || deletions[0].VersionID != "version-2" {
		t.Fatalf("object idempotency puts=%d deletions=%#v", puts, deletions)
	}

	// Reusing one IMAP UID for different received bytes is evidence drift, not
	// a harmless retry, and cleans up the losing object version.
	changed := observation
	changed.RawMIME = cloneAcquisitionForDBTest(observation.RawMIME)
	changed.RawMIME.Raw = []byte("different")
	changed.RawMIME.CapturedBytes = int64(len(changed.RawMIME.Raw))
	changed.RawMIME.ReportedBytes = int64(len(changed.RawMIME.Raw))
	changed.RawMIME.SHA256 = digestBytes(changed.RawMIME.Raw)
	if err := store.WriteMessageObservation(ctx, changed); !errors.Is(err, ErrObservationConflict) {
		t.Fatalf("UID drift err = %v", err)
	}
	objects.mu.Lock()
	deletionCount := len(objects.deleted)
	objects.mu.Unlock()
	if deletionCount != 2 {
		t.Fatalf("losing object version was not cleaned up: deletions=%d", deletionCount)
	}
}

func TestSeedMailboxCursorPersistsMonotonicUIDAndResetHistory_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := seedObservationDBPool(t, ctx)
	mailboxID := "cursor-proof-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:16]
	base := time.Now().UTC().Truncate(time.Second)
	store := NewPostgresStore(pool, "")
	store.Now = func() time.Time { return base }

	if err := store.AdvanceSeedMailboxCursors(ctx, mailboxID, []seedlist.FolderWatermark{{
		Folder: "INBOX", UIDValidity: 10, LastUID: 5, ObservedAt: base,
	}}); err != nil {
		t.Fatal(err)
	}
	store.Now = func() time.Time { return base.Add(time.Second) }
	if err := store.AdvanceSeedMailboxCursors(ctx, mailboxID, []seedlist.FolderWatermark{{
		Folder: "INBOX", UIDValidity: 10, LastUID: 9, ObservedAt: base.Add(time.Second),
	}}); err != nil {
		t.Fatal(err)
	}
	// A stale concurrent poll is a no-op, never a regression.
	store.Now = func() time.Time { return base.Add(2 * time.Second) }
	if err := store.AdvanceSeedMailboxCursors(ctx, mailboxID, []seedlist.FolderWatermark{{
		Folder: "INBOX", UIDValidity: 10, LastUID: 7, ObservedAt: base.Add(2 * time.Second),
	}}); err != nil {
		t.Fatal(err)
	}
	store.Now = func() time.Time { return base.Add(3 * time.Second) }
	if err := store.AdvanceSeedMailboxCursors(ctx, mailboxID, []seedlist.FolderWatermark{{
		Folder: "INBOX", UIDValidity: 20, LastUID: 2, ObservedAt: base.Add(3 * time.Second),
	}}); err != nil {
		t.Fatal(err)
	}

	cursors, err := store.LoadSeedMailboxCursors(ctx, mailboxID)
	if err != nil {
		t.Fatal(err)
	}
	cursor := cursors["INBOX"]
	if cursor.UIDValidity != 20 || cursor.LastUID != 2 || cursor.Generation != 2 {
		t.Fatalf("cursor = %#v", cursor)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.seed_observation_worker','true',true)`); err != nil {
		t.Fatal(err)
	}
	var eventTypes []string
	rows, err := tx.Query(ctx, `
SELECT event_type FROM seed_mailbox_capture_cursor_events
 WHERE mailbox_id=$1 AND folder='INBOX' ORDER BY recorded_at,id
`, mailboxID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var eventType string
		if err := rows.Scan(&eventType); err != nil {
			t.Fatal(err)
		}
		eventTypes = append(eventTypes, eventType)
	}
	rows.Close()
	if strings.Join(eventTypes, ",") != "created,advanced,uidvalidity_reset" {
		t.Fatalf("cursor events = %#v", eventTypes)
	}
	if _, err := tx.Exec(ctx, `
UPDATE seed_mailbox_capture_cursors SET last_uid=1,updated_at=updated_at+interval '1 second'
 WHERE mailbox_id=$1 AND folder='INBOX'
`, mailboxID); sqlState(err) != "23514" {
		t.Fatalf("database allowed cursor regression: SQLSTATE=%s err=%v", sqlState(err), err)
	}
}

func TestSeedObservationRetentionDeletesExactVersionAndPersistsReceiptAsAppRole_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	adminPool := seedObservationDBPool(t, ctx)
	fixture := createSeedObservationFixture(t, ctx, adminPool)
	objects := &observationObjectFake{}
	capturedAt := time.Now().UTC().Add(-31 * 24 * time.Hour).Truncate(time.Second)
	writer := NewPostgresStore(adminPool, "", objects)
	writer.Now = func() time.Time { return capturedAt }
	rawBytes := []byte("From: sender@example.test\r\nTo: private-seed@example.test\r\nContent-Type: text/plain\r\n\r\nLaunch\r\n")
	observation := seedlist.MessageObservation{
		TestHeaderValue: "irt_" + fixture.token,
		Provider:        domain.ProviderGmail,
		MailboxID:       "gmail-retention-proof-01",
		Folder:          "INBOX",
		Labels:          []string{"INBOX"},
		Placement:       domain.PlacementPrimary,
		Headers:         map[string]string{"Message-ID": "<retention-private-id@example.test>"},
		Capabilities: seedlist.ConnectorCapabilities{
			Headers: seedlist.CapabilityAvailable, RawMIME: seedlist.CapabilityAvailable,
			BodyParts: seedlist.CapabilityAvailable, Placement: seedlist.CapabilityAvailable,
			ObservedSurface: seedlist.CapabilityUnavailable,
		},
		HealthState: seedlist.StatusActive,
		ReceivedAt:  capturedAt.Add(-time.Second),
		CheckedAt:   capturedAt,
		RawMIME: &categorizers.RawMIMEAcquisition{
			Status: categorizers.RawMIMEComplete, Source: "imap_body_peek",
			SHA256: digestBytes(rawBytes), CapturedBytes: int64(len(rawBytes)),
			ReportedBytes: int64(len(rawBytes)), MaxBytes: 1024, UID: 51, UIDValidity: 52,
			Raw: rawBytes,
			Manifest: categorizers.MIMEManifest{
				Status: categorizers.MIMEParseParsed, StructureSHA256: strings.Repeat("5", 64),
				TextBodySHA256: strings.Repeat("4", 64), HTMLBodySHA256: strings.Repeat("3", 64),
			},
		},
	}
	if err := writer.WriteMessageObservation(ctx, observation); err != nil {
		t.Fatal(err)
	}

	appPool := seedObservationAppRolePool(t, ctx)
	retentionStore := NewPostgresStore(appPool, "", objects)
	now := capturedAt.Add(seedObservationRetention + time.Hour)
	sweeper := &SeedObservationRetentionSweeper{
		Store: retentionStore, Objects: objects, Now: func() time.Time { return now }, BatchSize: 10,
	}
	result, err := sweeper.RunOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result != (SeedObservationRetentionResult{Scanned: 1, Deleted: 1}) {
		t.Fatalf("retention result = %#v", result)
	}
	objects.mu.Lock()
	deletions := append([]ObjectReceipt(nil), objects.deleted...)
	objects.mu.Unlock()
	if len(deletions) != 1 || deletions[0].VersionID != "version-1" {
		t.Fatalf("exact object deletion = %#v", deletions)
	}

	var receiptCount int
	var refHash, reason, schema, versionHash string
	if err := adminPool.QueryRow(ctx, `
SELECT count(*) OVER (), object_ref_sha256, reason,
       deletion_receipt->>'schema', deletion_receipt->>'object_version_sha256'
  FROM seed_observation_object_deletions
 WHERE tenant_id=$1::uuid
`, fixture.tenantID).Scan(&receiptCount, &refHash, &reason, &schema, &versionHash); err != nil {
		t.Fatal(err)
	}
	if receiptCount != 1 || !validLowerSHA256(refHash) || reason != "retention" ||
		schema != seedObservationDeletionReceiptVersion || versionHash != digestString("version-1") {
		t.Fatalf("deletion receipt count=%d ref=%s reason=%s schema=%s version=%s",
			receiptCount, refHash, reason, schema, versionHash)
	}
	result, err = sweeper.RunOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.Scanned != 0 || result.Deleted != 0 {
		t.Fatalf("receipt did not make retry converge: %#v", result)
	}
}

func cloneAcquisitionForDBTest(input *categorizers.RawMIMEAcquisition) *categorizers.RawMIMEAcquisition {
	copy := *input
	copy.Raw = append([]byte(nil), input.Raw...)
	return &copy
}

func sqlState(err error) string {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		return postgresError.Code
	}
	return ""
}
