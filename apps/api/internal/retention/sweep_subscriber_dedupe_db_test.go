// SPDX-License-Identifier: AGPL-3.0-only

package retention

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestSweepExpiredSubscriberDuplicateScans_DB(t *testing.T) {
	appURL := os.Getenv("DATABASE_URL")
	if appURL == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed duplicate scan retention test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, appURL)
	if err != nil {
		t.Fatalf("connect app pool: %v", err)
	}
	t.Cleanup(pool.Close)
	adminURL := os.Getenv("POSTWAVE_ADMIN_DATABASE_URL")
	if adminURL == "" {
		adminURL = appURL
	}
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect seed pool: %v", err)
	}
	t.Cleanup(admin.Close)
	tenantID := uuid.NewString()
	// Seeded THROUGH the tenants RLS policy, which reads app.tenant_id. The bare
	// Exec left that unset, so `id = NULL` and the insert was always rejected —
	// reported as a PASS by the Skipf that used to sit here.
	seedTx, seedErr := admin.Begin(ctx)
	if seedErr != nil {
		t.Fatalf("begin dedupe tenant seed: %v", seedErr)
	}
	if _, err := seedTx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("scope dedupe tenant seed: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'dedupe-retention-test', $2, 'studio')`,
		tenantID, "dedupe-retention-"+tenantID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed dedupe tenant: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit dedupe tenant seed: %v", err)
	}
	// The teardown binds the tenant, as the seed does. In CI
	// POSTWAVE_ADMIN_DATABASE_URL is unset, so "admin" is the application role,
	// and the tenants DELETE policy sees only the row whose id equals
	// app.tenant_id. The bare `admin.Exec` DELETE this replaces matched no row,
	// reported no error, and left every seeded tenant in the shared database.
	t.Cleanup(func() { deleteRetentionTestTenant(t, admin, tenantID) })

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant seed tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var primaryID, duplicateID string
	var primaryUpdatedAt, duplicateUpdatedAt time.Time
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api')
RETURNING id::text, updated_at`, tenantID, "retention-primary-"+tenantID+"@example.test").
		Scan(&primaryID, &primaryUpdatedAt); err != nil {
		t.Fatalf("seed primary: %v", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api')
RETURNING id::text, updated_at`, tenantID, "retention-duplicate-"+tenantID+"@example.test").
		Scan(&duplicateID, &duplicateUpdatedAt); err != nil {
		t.Fatalf("seed duplicate: %v", err)
	}
	var expiredScanID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_duplicate_scans (
    tenant_id, status, subscriber_count, candidate_count, completed_at, expires_at
) VALUES ($1::uuid, 'complete', 2, 1, now() - interval '2 hours', now() - interval '1 hour')
RETURNING id::text`, tenantID).Scan(&expiredScanID); err != nil {
		t.Fatalf("seed expired scan: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_duplicate_scan_pairs (
    tenant_id, scan_id, ordinal, primary_id, duplicate_id,
    primary_updated_at, duplicate_updated_at, confidence, evidence
) VALUES (
    $1::uuid, $2::uuid, 1, $3::uuid, $4::uuid,
    $5::timestamptz, $6::timestamptz, 0.900,
    '[{"kind":"plus_alias","confidence":0.9,"reason":"test evidence"}]'::jsonb
)`, tenantID, expiredScanID, primaryID, duplicateID,
		primaryUpdatedAt, duplicateUpdatedAt); err != nil {
		t.Fatalf("seed expired pair: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_duplicate_scans (
    tenant_id, status, subscriber_count, candidate_count, completed_at, expires_at
) VALUES ($1::uuid, 'complete', 2, 0, now(), now() + interval '1 hour')`, tenantID); err != nil {
		t.Fatalf("seed active scan: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit retention fixture: %v", err)
	}

	sweeper := &Sweeper{Pool: pool, BatchSize: 1, MaxBatchesPerTenant: 4}
	purged, err := sweeper.sweepExpiredSubscriberDuplicateScans(ctx, tenantID)
	if err != nil {
		t.Fatalf("sweep expired duplicate scans: %v", err)
	}
	if purged != 2 {
		t.Fatalf("purged rows = %d, want one pair plus one scan", purged)
	}
	verifyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant verify tx: %v", err)
	}
	defer func() { _ = verifyTx.Rollback(ctx) }()
	var expired, active int
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE expires_at <= now()),
       count(*) FILTER (WHERE expires_at > now())
  FROM subscriber_duplicate_scans
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&expired, &active); err != nil {
		t.Fatalf("verify scan retention: %v", err)
	}
	if expired != 0 || active != 1 {
		t.Fatalf("scan retention result expired=%d active=%d", expired, active)
	}
}
