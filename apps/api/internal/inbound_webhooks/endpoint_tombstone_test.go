// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

func TestInboundEndpointTombstoneMigrationContract(t *testing.T) {
	t.Parallel()

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(source),
		"../../../../infra/migrations/1793_inbound_webhook_endpoint_tombstones.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1793: %v", err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "1793_inbound_webhook_endpoint_tombstones",
		Path:    path,
		SQL:     sql,
	}
	for _, finding := range migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file}) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf(
				"migration 1793 safety blocker %q at line %d: %s",
				finding.Rule,
				finding.Line,
				finding.Snippet,
			)
		}
	}
	for _, contract := range []string{
		"ADD COLUMN IF NOT EXISTS deleted_at timestamptz",
		"CREATE INDEX CONCURRENTLY IF NOT EXISTS inbound_webhook_endpoints_deleted_idx",
		"endpoint.deleted_at IS NULL",
		"REVOKE DELETE ON inbound_webhook_endpoints FROM postwave_app",
		"purge_deleted_inbound_webhook_endpoint",
		"NULLIF(current_setting('app.tenant_id', true), '')::uuid",
		"endpoint.deleted_at < now() - interval '24 hours'",
		"FROM public.inbound_events",
		"FROM public.inbound_webhook_action_intents",
	} {
		if !strings.Contains(sql, contract) {
			t.Errorf("migration 1793 missing contract %q", contract)
		}
	}

	repoRaw, err := os.ReadFile(filepath.Join(filepath.Dir(source), "repo.go"))
	if err != nil {
		t.Fatalf("read repo: %v", err)
	}
	repo := string(repoRaw)
	for _, contract := range []string{
		"SET enabled = false,",
		"deleted_at = now(),",
		"secret = $3,",
		"secret_envelope = NULL,",
		"secret_storage_state = 'destroyed',",
		"AND deleted_at IS NULL",
	} {
		if !strings.Contains(repo, contract) {
			t.Errorf("endpoint repository missing tombstone contract %q", contract)
		}
	}
	if strings.Contains(repo, "`DELETE FROM inbound_webhook_endpoints WHERE id::text = $1`") {
		t.Fatal("admin endpoint deletion still hard-deletes")
	}
}

func TestInboundEndpointCryptoshredMigrationContract(t *testing.T) {
	t.Parallel()

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(source),
		"../../../../infra/migrations/1801_inbound_webhook_tombstone_cryptoshred.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1801: %v", err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "1801_inbound_webhook_tombstone_cryptoshred",
		Path:    path,
		SQL:     sql,
	}
	for _, finding := range migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file}) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf(
				"migration 1801 safety blocker %q at line %d: %s",
				finding.Rule,
				finding.Line,
				finding.Snippet,
			)
		}
	}
	for _, contract := range []string{
		"'ready', 'legacy_pending', 'invalid', 'destroyed'",
		"cryptoshred_inbound_webhook_tombstone",
		"BEFORE INSERT OR UPDATE OF deleted_at",
		"NEW.secret := 'tombstone:destroyed'",
		"NEW.secret_envelope := NULL",
		"NEW.secondary_secret := NULL",
		"NEW.secondary_secret_envelope := NULL",
		"NEW.secondary_expires_at := NULL",
		"NEW.secret_storage_state := 'destroyed'",
		"WHERE deleted_at IS NOT NULL",
		"inbound_webhook_endpoints_tombstone_cryptoshred_check",
		"VALIDATE CONSTRAINT inbound_webhook_endpoints_tombstone_cryptoshred_check",
	} {
		if !strings.Contains(sql, contract) {
			t.Errorf("migration 1801 missing cryptoshred contract %q", contract)
		}
	}
}

func TestInboundEndpointDeletePreservesRetainedEventEvidence(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping inbound endpoint tombstone integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	// t.Cleanup, not defer: both tenant cleanups need this pool, and deferred
	// calls run before t.Cleanup callbacks (see TestRepoList_QFilter).
	t.Cleanup(pool.Close)
	tenantID := createInboundWebhookTestTenant(t, ctx, pool)
	repo := &Repo{Pool: pool, Cipher: &recordingInboundEnvelopeCipher{}}
	created, err := repo.Create(ctx, tenantID, "endpoint tombstone evidence")
	if err != nil {
		t.Fatalf("create endpoint: %v", err)
	}
	header := http.Header{}
	header.Set("X-Postwave-Event-Id", "tombstone-evidence-"+created.Endpoint.ID)
	replayKey, err := inboundWebhookReplayKey(header)
	if err != nil {
		t.Fatalf("build replay key: %v", err)
	}
	eventID, _, err := repo.RecordEvent(
		ctx,
		tenantID,
		created.Endpoint.ID,
		[]byte(`{}`),
		[]byte(`{"event":"retained"}`),
		true,
		replayKey,
	)
	if err != nil {
		t.Fatalf("record retained event: %v", err)
	}
	items, _, err := repo.ListEventsPage(
		ctx,
		tenantID,
		created.Endpoint.ID,
		50,
		pagination.Cursor{},
	)
	if err != nil || len(items) != 1 || items[0].ID != eventID {
		t.Fatalf("live parent event page = %#v, err=%v", items, err)
	}
	otherTenantID := createInboundWebhookTestTenant(t, ctx, pool)
	if _, _, err := repo.ListEventsPage(
		ctx,
		otherTenantID,
		created.Endpoint.ID,
		50,
		pagination.Cursor{},
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant event page error = %v, want ErrNotFound", err)
	}
	triggerInput := Trigger{
		Name:           "Retained tombstone child",
		Active:         true,
		MatchJSONPath:  "$.event",
		MatchOperator:  OpExists,
		EmailJSONPath:  "$.email",
		ActionType:     ActionAddTag,
		ActionTargetID: "retained",
	}
	trigger, err := repo.CreateTrigger(
		ctx,
		tenantID,
		created.Endpoint.ID,
		triggerInput,
	)
	if err != nil {
		t.Fatalf("create retained trigger: %v", err)
	}
	if err := repo.Delete(ctx, tenantID, created.Endpoint.ID); err != nil {
		t.Fatalf("tombstone endpoint (migration 1793 may be absent): %v", err)
	}
	if _, err := repo.Get(ctx, tenantID, created.Endpoint.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("tombstoned endpoint Get error = %v, want ErrNotFound", err)
	}
	if _, _, err := repo.ListEventsPage(
		ctx,
		tenantID,
		created.Endpoint.ID,
		50,
		pagination.Cursor{},
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("tombstoned endpoint event page error = %v, want ErrNotFound", err)
	}
	if _, err := repo.ListTriggers(
		ctx,
		tenantID,
		created.Endpoint.ID,
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("tombstoned endpoint trigger list error = %v, want ErrNotFound", err)
	}
	if _, err := repo.CreateTrigger(
		ctx,
		tenantID,
		created.Endpoint.ID,
		triggerInput,
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("tombstoned endpoint trigger create error = %v, want ErrNotFound", err)
	}
	disabled := false
	if _, err := repo.UpdateTrigger(
		ctx,
		tenantID,
		created.Endpoint.ID,
		trigger.ID,
		TriggerPatch{Active: &disabled},
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("tombstoned endpoint trigger update error = %v, want ErrNotFound", err)
	}
	if err := repo.DeleteTrigger(
		ctx,
		tenantID,
		created.Endpoint.ID,
		trigger.ID,
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("tombstoned endpoint trigger delete error = %v, want ErrNotFound", err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant verify transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var enabled bool
	var deletedAt *time.Time
	var secret, storageState string
	var secretEnvelope, secondaryEnvelope []byte
	var secondarySecret *string
	var secondaryExpiresAt *time.Time
	if err := tx.QueryRow(ctx, `
SELECT enabled, deleted_at, secret, secret_envelope, secret_storage_state,
       secondary_secret, secondary_secret_envelope, secondary_expires_at
  FROM inbound_webhook_endpoints
 WHERE id = $1::uuid`, created.Endpoint.ID).Scan(
		&enabled,
		&deletedAt,
		&secret,
		&secretEnvelope,
		&storageState,
		&secondarySecret,
		&secondaryEnvelope,
		&secondaryExpiresAt,
	); err != nil {
		t.Fatalf("read tombstone: %v", err)
	}
	if enabled || deletedAt == nil {
		t.Fatalf("endpoint was not revoked: enabled=%v deleted_at=%v", enabled, deletedAt)
	}
	if secret != destroyedInboundSecretSentinel ||
		len(secretEnvelope) != 0 ||
		storageState != "destroyed" ||
		secondarySecret != nil ||
		len(secondaryEnvelope) != 0 ||
		secondaryExpiresAt != nil {
		t.Fatalf(
			"tombstone retained signing capability: secret=%q envelope=%d state=%q secondary=%v/%d expires=%v",
			secret,
			len(secretEnvelope),
			storageState,
			secondarySecret,
			len(secondaryEnvelope),
			secondaryExpiresAt,
		)
	}
	var retained int
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM inbound_events
 WHERE id = $1 AND endpoint_id = $2::uuid`,
		eventID,
		created.Endpoint.ID,
	).Scan(&retained); err != nil {
		t.Fatalf("read retained event: %v", err)
	}
	if retained != 1 {
		t.Fatalf("retained events = %d, want 1", retained)
	}
	var prematurelyPurged bool
	if err := tx.QueryRow(ctx,
		`SELECT purge_deleted_inbound_webhook_endpoint($1::uuid, $2::uuid)`,
		tenantID,
		created.Endpoint.ID,
	).Scan(&prematurelyPurged); err != nil {
		t.Fatalf("guarded purge: %v", err)
	}
	if prematurelyPurged {
		t.Fatal("fresh tombstone was purged before its retention floor")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit verify transaction: %v", err)
	}

	var lookupID string
	err = pool.QueryRow(ctx,
		`SELECT id::text FROM inbound_webhook_lookup($1)`,
		created.Endpoint.Slug,
	).Scan(&lookupID)
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("public lookup exposed tombstone: id=%q err=%v", lookupID, err)
	}
}
