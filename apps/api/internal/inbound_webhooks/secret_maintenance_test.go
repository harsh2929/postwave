// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

func TestInboundSecretMaintenanceMigrationContract(t *testing.T) {
	t.Parallel()

	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(source),
		"../../../../infra/migrations/1791_inbound_webhook_secret_maintenance.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1791: %v", err)
	}
	sql := string(raw)
	file := migrationrunner.MigrationFile{
		Version: "1791_inbound_webhook_secret_maintenance",
		Path:    path,
		SQL:     sql,
	}
	for _, finding := range migrationrunner.AssessSafety([]migrationrunner.MigrationFile{file}) {
		if finding.Severity == migrationrunner.SafetyBlocker {
			t.Errorf(
				"migration 1791 safety blocker %q at line %d: %s",
				finding.Rule,
				finding.Line,
				finding.Snippet,
			)
		}
	}
	for _, contract := range []string{
		"ADD COLUMN IF NOT EXISTS secret_storage_state text",
		"ALTER COLUMN secret_storage_state SET DEFAULT 'legacy_pending'",
		"inbound_webhook_endpoints_secret_storage_state_check",
		"inbound_webhook_endpoints_secret_maintenance_idx",
		"classify_inbound_webhook_secret_storage",
		"inbound_webhook_secret_storage_classifier",
		"app.outbox_worker",
		"inbound_webhook_endpoints_worker_select",
		"inbound_webhook_endpoints_worker_update",
		"ALTER TABLE inbound_webhook_endpoints FORCE ROW LEVEL SECURITY",
	} {
		if !strings.Contains(sql, contract) {
			t.Errorf("migration 1791 missing contract %q", contract)
		}
	}
	if strings.Contains(strings.ToLower(sql), "pgp_sym_encrypt") {
		t.Fatal("migration attempts encryption in SQL instead of the envelope worker")
	}

	workerRaw, err := os.ReadFile(filepath.Join(filepath.Dir(source), "secret_maintenance.go"))
	if err != nil {
		t.Fatalf("read secret maintenance worker: %v", err)
	}
	worker := string(workerRaw)
	for _, contract := range []string{
		"db.WithWorkerScope(ctx, r.Pool)",
		"FOR UPDATE SKIP LOCKED",
		"maxSecretMaintenanceBatchSize",
		"secondary_expires_at <= now()",
		"row.secondaryEnvelope = nil",
	} {
		if !strings.Contains(worker, contract) {
			t.Errorf("secret maintenance worker missing contract %q", contract)
		}
	}
}

func TestInboundSecretMaintenanceRewrapsAndExpiresWithoutPlaintext(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping inbound secret maintenance integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	// t.Cleanup, not defer: the tenant cleanup needs this pool, and deferred
	// calls run before t.Cleanup callbacks (see TestRepoList_QFilter).
	t.Cleanup(pool.Close)
	tenantID := createInboundWebhookTestTenant(t, ctx, pool)
	cipher := &recordingInboundEnvelopeCipher{}
	repo := &Repo{Pool: pool, Cipher: cipher}

	// MaintainSecrets is global by design. It claims one worker-scope batch of
	// the oldest rows that need maintenance, whatever tenant owns them. This test
	// used to call it with the maximum batch, so it claimed every such row in the
	// shared database and rewrapped it with this test's fake cipher. That
	// included other tests' endpoints: after one package run, the plaintext
	// endpoints of TestRepoList_QFilter held "wrapped:<secret>" envelopes.
	//
	// Now the batch is exactly this test's two rows. Every other writer of the
	// table stamps created_at = now(). The fixtures are stamped a day before the
	// oldest row already in the table, so they sort first under the worker's
	// ORDER BY created_at, id, and a batch of two claims them and nothing else.
	// This also holds when an earlier run left fixtures behind, because each run
	// stamps its rows before those. The exact counters below prove it: the sweep
	// claimed two rows, and both of them are verified as this test's rows.
	const fixtureRows = 2
	fixtureCreatedAt := oldestInboundEndpointCreatedAt(t, ctx, pool).Add(-24 * time.Hour)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant seed transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var legacyID, expiredID string
	if err := tx.QueryRow(ctx, `
INSERT INTO inbound_webhook_endpoints (
    tenant_id, slug, secret, secret_envelope, secret_storage_state,
    name, enabled, secondary_secret, secondary_secret_envelope, secondary_expires_at,
    created_at
) VALUES (
    $1::uuid, $2, 'iwh_legacy_primary', $3, 'legacy_pending',
    'legacy secret maintenance fixture', true,
    'iwh_legacy_secondary', $4, now() + interval '1 hour',
    $5
)
RETURNING id::text`,
		tenantID,
		"secret-maintenance-"+randHex4IW(t),
		[]byte("wrapped:iwh_stale_primary"),
		[]byte("wrapped:iwh_stale_secondary"),
		fixtureCreatedAt,
	).Scan(&legacyID); err != nil {
		t.Fatalf("seed legacy endpoint (migration 1791 may be absent): %v", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO inbound_webhook_endpoints (
    tenant_id, slug, secret, secret_envelope, secret_storage_state,
    name, enabled, secondary_secret, secondary_secret_envelope, secondary_expires_at,
    created_at
) VALUES (
    $1::uuid, $2, 'envelope:do-not-use', $3, 'ready',
    'expired secondary maintenance fixture', true,
    'envelope:do-not-use', $4, now() - interval '1 minute',
    $5
)
RETURNING id::text`,
		tenantID,
		"secret-expiry-"+randHex4IW(t),
		[]byte("wrapped:iwh_ready_primary"),
		[]byte("wrapped:iwh_expired_secondary"),
		fixtureCreatedAt,
	).Scan(&expiredID); err != nil {
		t.Fatalf("seed expired endpoint: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}

	result, err := repo.MaintainSecrets(ctx, fixtureRows)
	if err != nil {
		t.Fatalf("MaintainSecrets: %v", err)
	}
	// Exact counts, not "at least one each". The batch holds only this test's
	// rows, so each counter has exactly one correct value: the legacy row
	// rewraps its primary and its live secondary, and the other row has its
	// expired secondary cleared. Claimed == fixtureRows, together with the
	// checks below that both fixtures were maintained, proves that no other
	// endpoint was claimed. Remaining is not checked because it counts the
	// backlog across the whole database.
	if result.Claimed != fixtureRows ||
		result.PrimaryRewrapped != 1 ||
		result.SecondaryRewrapped != 1 ||
		result.ExpiredCleared != 1 ||
		result.InvalidDisabled != 0 {
		t.Fatalf("maintenance result = %#v; want exactly this test's %d fixtures claimed, "+
			"1 primary rewrapped, 1 secondary rewrapped, 1 expired cleared, 0 disabled",
			result, fixtureRows)
	}

	verifyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant verify transaction: %v", err)
	}
	defer func() { _ = verifyTx.Rollback(ctx) }()
	var primary string
	var primaryEnvelope []byte
	var state string
	var secondary *string
	var secondaryEnvelope []byte
	if err := verifyTx.QueryRow(ctx, `
SELECT secret, secret_envelope, secret_storage_state,
       secondary_secret, secondary_secret_envelope
  FROM inbound_webhook_endpoints
 WHERE id = $1::uuid`, legacyID).Scan(
		&primary,
		&primaryEnvelope,
		&state,
		&secondary,
		&secondaryEnvelope,
	); err != nil {
		t.Fatalf("read maintained legacy row: %v", err)
	}
	if primary != inboundSecretSentinel || state != "ready" ||
		secondary == nil || *secondary != inboundSecretSentinel {
		t.Fatalf("legacy row not redacted: primary=%q state=%q secondary=%v", primary, state, secondary)
	}
	if bytes.Contains(primaryEnvelope, []byte("iwh_legacy_primary")) &&
		bytes.Equal(primaryEnvelope, []byte("iwh_legacy_primary")) {
		t.Fatal("primary envelope is plaintext")
	}
	if len(primaryEnvelope) == 0 || len(secondaryEnvelope) == 0 {
		t.Fatal("maintained row is missing an envelope")
	}
	openedPrimary, err := cipher.Decrypt(ctx, primaryEnvelope, nil)
	if err != nil || string(openedPrimary) != "iwh_legacy_primary" {
		t.Fatalf("primary envelope retained stale credential: opened=%q err=%v", openedPrimary, err)
	}
	openedSecondary, err := cipher.Decrypt(ctx, secondaryEnvelope, nil)
	if err != nil || string(openedSecondary) != "iwh_legacy_secondary" {
		t.Fatalf("secondary envelope retained stale credential: opened=%q err=%v", openedSecondary, err)
	}
	var expiredSecondary *string
	var expiredEnvelope []byte
	var expiresAt *time.Time
	if err := verifyTx.QueryRow(ctx, `
SELECT secondary_secret, secondary_secret_envelope, secondary_expires_at
  FROM inbound_webhook_endpoints
 WHERE id = $1::uuid`, expiredID).Scan(
		&expiredSecondary,
		&expiredEnvelope,
		&expiresAt,
	); err != nil {
		t.Fatalf("read expired row: %v", err)
	}
	if expiredSecondary != nil || expiredEnvelope != nil || expiresAt != nil {
		t.Fatal("expired secondary signing material was retained")
	}
}

// oldestInboundEndpointCreatedAt returns the earliest created_at in
// inbound_webhook_endpoints across all tenants, or now() when the table is
// empty. It reads under the same worker scope that MaintainSecrets uses, and
// it is read-only: it takes no row locks and changes nothing.
func oldestInboundEndpointCreatedAt(t *testing.T, ctx context.Context, pool *db.Pool) time.Time {
	t.Helper()
	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatalf("worker scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var oldest time.Time
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(min(created_at), now()) FROM inbound_webhook_endpoints`,
	).Scan(&oldest); err != nil {
		t.Fatalf("read oldest endpoint created_at: %v", err)
	}
	return oldest
}
