// SPDX-License-Identifier: AGPL-3.0-only
package audit

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// stubPrivacy returns a constant retention window. Mirrors the narrow
// PrivacyReader interface so the trimmer can be exercised without the
// settings package.
type stubPrivacy struct {
	days int
	err  error
}

func (s stubPrivacy) AuditLogRetentionDays(_ context.Context, _ string) (int, error) {
	return s.days, s.err
}

func TestDefaults(t *testing.T) {
	tr := &Trimmer{}
	if got := tr.interval(); got != DefaultInterval {
		t.Fatalf("interval default: got %v want %v", got, DefaultInterval)
	}
	if got := tr.batchSize(); got != DefaultBatchSize {
		t.Fatalf("batch size default: got %d want %d", got, DefaultBatchSize)
	}
	if got := tr.maxBatches(); got != 64 {
		t.Fatalf("max batches default: got %d", got)
	}
}

func TestRetentionDaysDefaultWithoutReader(t *testing.T) {
	tr := &Trimmer{}
	got, err := tr.retentionDays(context.Background(), "tenant")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got != 90 {
		t.Fatalf("default retention days: got %d want 90", got)
	}
}

func TestRetentionDaysReader(t *testing.T) {
	tr := &Trimmer{Privacy: stubPrivacy{days: 30}}
	got, err := tr.retentionDays(context.Background(), "tenant")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got != 30 {
		t.Fatalf("reader days: got %d want 30", got)
	}
}

func TestRunNoOpsOnNilPool(t *testing.T) {
	// A nil-pool trimmer must not panic — Run is a no-op.
	tr := &Trimmer{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	tr.Run(ctx) // should return immediately without panic
}

// newPool returns a real pgx pool when DATABASE_URL is set; skips
// otherwise. Used by the integration tests below.
func newPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed trim test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("pgx connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedAuditTenant creates the tenant these fixtures write audit rows for.
//
// `audit_log.tenant_id` carries a foreign key to tenants, and every test here
// used a fixed uuid that nothing ever created — so each seed INSERT was
// rejected and the Skipf reported it as a PASS. Seeded through the tenants RLS
// policy, which reads `app.tenant_id`, exactly as the trimmer's own
// beginTenant does.
func seedAuditTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin audit tenant seed: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("set tenant scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'audit-trim-test', 'audit-trim-' || right($1::text, 12), 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
		t.Fatalf("seed audit tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit audit tenant seed: %v", err)
	}
}

// scopedCount reads through the tenant RLS policy.
//
// These verifications used the bare pool, which sets no `app.tenant_id`, so
// `tenant_isolation` hid every row and each count came back 0 — the legal-hold
// assertion in particular read as "the trimmer deleted a row under legal hold"
// when the row was simply invisible to the query checking for it. The trimmer
// itself was correct all along.
func scopedCount(t *testing.T, pool *pgxpool.Pool, tenantID, query string, args ...any) int {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin scoped read: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("scope read: %v", err)
	}
	var n int
	if err := tx.QueryRow(ctx, query, args...).Scan(&n); err != nil {
		t.Fatalf("scoped count: %v", err)
	}
	return n
}

// TestTrimBatchDeletesStaleRows verifies the bounded-DELETE path
// against a live audit_log table. Skipped without DATABASE_URL.
func TestTrimBatchDeletesStaleRows(t *testing.T) {
	pool := newPool(t)
	ctx := context.Background()

	tenantID := uuid.NewString()
	seedAuditTenant(t, pool, tenantID)
	tr := &Trimmer{
		Pool:      pool,
		Privacy:   stubPrivacy{days: 7},
		BatchSize: 5,
	}

	// Seed: insert N rows with created_at well in the past so the
	// retention window catches them. We bypass the standard Audit
	// helper because it stamps now() — we need to backdate.
	tx, err := tr.beginTenant(ctx, tenantID)
	if err != nil {
		t.Fatalf("begin tenant tx: %v (audit_log policy likely blocks; skipping)", err)
	}
	for i := 0; i < 10; i++ {
		if _, err := tx.Exec(ctx, `
INSERT INTO audit_log (tenant_id, action, at, metadata, actor_type)
VALUES ($1::uuid, 'trim_test', now() - interval '90 days', '{}', 'system')`, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed insert: %v (audit_log schema mismatch; skipping)", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v (RLS denies; skipping)", err)
	}
	t.Cleanup(func() {
		// Best-effort cleanup; ignore errors so a partial test still cleans.
		ctx2, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = pool.Exec(ctx2, `DELETE FROM audit_log WHERE tenant_id = $1::uuid`, tenantID)
	})

	deleted, err := tr.trimTenant(ctx, tenantID, 7)
	if err != nil {
		t.Fatalf("trimTenant: %v", err)
	}
	if deleted != 10 {
		t.Fatalf("deleted: got %d want 10", deleted)
	}
}

// TestTrimEmitsPurgeEvents asserts that a non-zero delete batch writes
// a single audit.retention.purge row with the expected metadata
// fields. Skipped without DATABASE_URL.
func TestTrimEmitsPurgeEvents(t *testing.T) {
	pool := newPool(t)
	ctx := context.Background()

	tenantID := uuid.NewString()
	seedAuditTenant(t, pool, tenantID)
	tr := &Trimmer{Pool: pool, Privacy: stubPrivacy{days: 7}, BatchSize: 50}

	tx, err := tr.beginTenant(ctx, tenantID)
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	for i := 0; i < 3; i++ {
		if _, err := tx.Exec(ctx, `
INSERT INTO audit_log (tenant_id, action, at, metadata, actor_type)
VALUES ($1::uuid, 'trim_seed', now() - interval '90 days', '{}', 'system')`, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed insert: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		ctx2, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = pool.Exec(ctx2, `DELETE FROM audit_log WHERE tenant_id = $1::uuid`, tenantID)
	})

	if _, err := tr.trimTenant(ctx, tenantID, 7); err != nil {
		t.Fatalf("trim: %v", err)
	}

	// Verify exactly one purge event was emitted.
	purgeCount := scopedCount(t, pool, tenantID, `
SELECT count(*) FROM audit_log
 WHERE tenant_id = $1::uuid AND action = $2`, tenantID, PurgeAction)
	if purgeCount != 1 {
		t.Fatalf("purge events: got %d want 1", purgeCount)
	}
}

// TestTrimSkipsLegalHoldRows asserts that legal_hold=true rows survive
// the trim even when past the retention window. Skipped without
// DATABASE_URL.
func TestTrimSkipsLegalHoldRows(t *testing.T) {
	pool := newPool(t)
	ctx := context.Background()

	tenantID := uuid.NewString()
	seedAuditTenant(t, pool, tenantID)
	tr := &Trimmer{Pool: pool, Privacy: stubPrivacy{days: 7}, BatchSize: 100}

	tx, err := tr.beginTenant(ctx, tenantID)
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO audit_log (tenant_id, action, at, metadata, actor_type, legal_hold)
VALUES ($1::uuid, 'trim_holdable_old',  now() - interval '90 days', '{}', 'system', true),
       ($1::uuid, 'trim_purgeable_old', now() - interval '90 days', '{}', 'system', false)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed insert: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		ctx2, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = pool.Exec(ctx2, `DELETE FROM audit_log WHERE tenant_id = $1::uuid`, tenantID)
	})

	deleted, err := tr.trimTenant(ctx, tenantID, 7)
	if err != nil {
		t.Fatalf("trim: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("deleted: got %d want 1 (legal_hold row must survive)", deleted)
	}
	heldRemaining := scopedCount(t, pool, tenantID, `
SELECT count(*) FROM audit_log
 WHERE tenant_id = $1::uuid AND legal_hold = true`, tenantID)
	if heldRemaining != 1 {
		t.Fatalf("legal_hold rows after trim: got %d want 1", heldRemaining)
	}
}

// TestPurgeEventsNeverPurged asserts that audit.retention.purge rows
// are themselves never deleted by subsequent trim runs, even when
// older than the retention window. Skipped without DATABASE_URL.
func TestPurgeEventsNeverPurged(t *testing.T) {
	pool := newPool(t)
	ctx := context.Background()

	tenantID := uuid.NewString()
	seedAuditTenant(t, pool, tenantID)
	tr := &Trimmer{Pool: pool, Privacy: stubPrivacy{days: 7}, BatchSize: 100}

	tx, err := tr.beginTenant(ctx, tenantID)
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	// Seed an ancient purge event directly (simulating a prior trim run).
	if _, err := tx.Exec(ctx, `SELECT set_config('app.audit_internal_writer', 'true', true)`); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("guc set: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO audit_log (tenant_id, action, at, metadata, actor_type, actor_label)
VALUES ($1::uuid, $2, now() - interval '365 days',
        '{"deleted_count":1,"retention_days":7}'::jsonb,
        'system', 'audit-retention-trimmer')`, tenantID, PurgeAction); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed purge: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		ctx2, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = pool.Exec(ctx2, `DELETE FROM audit_log WHERE tenant_id = $1::uuid`, tenantID)
	})

	if _, err := tr.trimTenant(ctx, tenantID, 7); err != nil {
		t.Fatalf("trim: %v", err)
	}
	remaining := scopedCount(t, pool, tenantID, `
SELECT count(*) FROM audit_log
 WHERE tenant_id = $1::uuid AND action = $2`, tenantID, PurgeAction)
	if remaining != 1 {
		t.Fatalf("ancient purge event was deleted: remaining=%d want 1", remaining)
	}
}

// TestRetentionOverridePerRow asserts that a row with
// retention_override_days set uses its own window (not the tenant
// default). Skipped without DATABASE_URL.
func TestRetentionOverridePerRow(t *testing.T) {
	pool := newPool(t)
	ctx := context.Background()

	tenantID := uuid.NewString()
	seedAuditTenant(t, pool, tenantID)
	tr := &Trimmer{Pool: pool, Privacy: stubPrivacy{days: 30}, BatchSize: 100}

	tx, err := tr.beginTenant(ctx, tenantID)
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	// Row A: default retention 30d, age 10d → would normally survive.
	// Row B: override = 5d, age 10d → must be deleted under the override.
	// Row C: override = 365d, age 90d → must survive under the override.
	if _, err := tx.Exec(ctx, `
INSERT INTO audit_log (tenant_id, action, at, metadata, actor_type, retention_override_days)
VALUES ($1::uuid, 'row_a', now() - interval '10 days', '{}', 'system', NULL),
       ($1::uuid, 'row_b', now() - interval '10 days', '{}', 'system', 5),
       ($1::uuid, 'row_c', now() - interval '90 days', '{}', 'system', 365)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed insert: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		ctx2, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = pool.Exec(ctx2, `DELETE FROM audit_log WHERE tenant_id = $1::uuid`, tenantID)
	})

	deleted, err := tr.trimTenant(ctx, tenantID, 30)
	if err != nil {
		t.Fatalf("trim: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("deleted: got %d want 1 (only row_b should be deleted)", deleted)
	}
	survivors := scopedCount(t, pool, tenantID, `
SELECT count(*) FROM audit_log
 WHERE tenant_id = $1::uuid AND action != $2`, tenantID, PurgeAction)
	if survivors != 2 {
		t.Fatalf("survivors: got %d want 2 (row_a + row_c)", survivors)
	}
}

// TestPurgeActionConstant pins the canonical event name so a rename
// breaks the test before it silently breaks the carve-out.
func TestPurgeActionConstant(t *testing.T) {
	if PurgeAction != "audit.retention.purge" {
		t.Fatalf("PurgeAction drift: got %q want audit.retention.purge", PurgeAction)
	}
}

// TestTrimRespectsRetention asserts that rows newer than the retention
// window are not deleted. Skipped without DATABASE_URL.
func TestTrimRespectsRetention(t *testing.T) {
	pool := newPool(t)
	ctx := context.Background()

	tenantID := uuid.NewString()
	seedAuditTenant(t, pool, tenantID)
	tr := &Trimmer{Pool: pool, Privacy: stubPrivacy{days: 30}, BatchSize: 100}

	tx, err := tr.beginTenant(ctx, tenantID)
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	// Two rows: one ancient, one fresh.
	if _, err := tx.Exec(ctx, `
INSERT INTO audit_log (tenant_id, action, at, metadata, actor_type)
VALUES ($1::uuid, 'trim_test_old', now() - interval '90 days', '{}', 'system'),
       ($1::uuid, 'trim_test_new', now() - interval '1 day',  '{}', 'system')`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed insert: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		ctx2, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = pool.Exec(ctx2, `DELETE FROM audit_log WHERE tenant_id = $1::uuid`, tenantID)
	})

	deleted, err := tr.trimTenant(ctx, tenantID, 30)
	if err != nil {
		t.Fatalf("trim: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("deleted: got %d want 1 (only the 90-day-old row)", deleted)
	}
}
