// SPDX-License-Identifier: AGPL-3.0-only
//
// apply_db_test.go — pg-backed tests for the transactional merge
// apply. Skips cleanly without DATABASE_URL, matching the project-
// wide pg-backed test convention (outbound_webhooks/store_test.go).

package merge

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func newMergeTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed merge apply test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedMergeTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("worker scope for seeding: %v", err)
	}
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM tenants WHERE id = $1::uuid)`,
		tenantID).Scan(&exists); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read tenants: %v", err)
	}
	if !exists {
		if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'merge-apply-test', 'merge-apply-test-' || right($1::text, 12), 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed tenant (role lacks tenants INSERT; needs a pre-seeded DB): %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

func seedMergeSubscriber(t *testing.T, pool *pgxpool.Pool, tenantID, email, status string, tags []string, cf string) string {
	t.Helper()
	if tags == nil {
		tags = []string{}
	}
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, tags, custom_fields)
VALUES ($1::uuid, $2, $3, 'api', $4::text[], $5::jsonb)
RETURNING id::text`, tenantID, email, status, tags, cf).Scan(&id); err != nil {
		t.Fatalf("seed subscriber %s: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber seed: %v", err)
	}
	return id
}

// TestApply_DryRunThenApply pins the full contract: dry_run computes
// the plan without writing; apply executes that exact plan, soft-
// deletes the loser, writes the audit row, and refuses to merge the
// same loser twice.
func TestApply_DryRunThenApply(t *testing.T) {
	pool := newMergeTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-00993e23e57e"
	seedMergeTenant(t, pool, tenantID)

	suffix := time.Now().UnixNano()
	primaryEmail := fmt.Sprintf("merge-primary-%d@example.test", suffix)
	dupEmail := fmt.Sprintf("merge-dupe-%d@example.test", suffix)
	primaryID := seedMergeSubscriber(t, pool, tenantID, primaryEmail,
		"enabled", []string{"vip"}, `{"plan":"pro"}`)
	dupID := seedMergeSubscriber(t, pool, tenantID, dupEmail,
		"blocklisted", []string{"legacy"}, `{"plan":"free","country":"NO"}`)
	seedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("permission seed tx: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
UPDATE subscribers
   SET gdpr_permissions = CASE id
       WHEN $2::uuid THEN '[{"marketing_permission_id":"email","enabled":true}]'::jsonb
       WHEN $3::uuid THEN '[{"marketing_permission_id":"email","enabled":false},{"marketing_permission_id":"sms","enabled":true}]'::jsonb
       ELSE gdpr_permissions END
 WHERE tenant_id = $1::uuid AND id = ANY(ARRAY[$2::uuid, $3::uuid])`,
		tenantID, primaryID, dupID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed GDPR permissions: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit GDPR permissions: %v", err)
	}

	d := &Deps{Pool: pool}
	scanID, primaryUpdatedAt, duplicateUpdatedAt := seedMergeScanCandidate(
		t, pool, tenantID, primaryID, dupID,
	)
	req := applyRequest{
		PrimaryID:                  primaryID,
		DuplicateID:                dupID,
		ScanID:                     scanID,
		ExpectedPrimaryUpdatedAt:   &primaryUpdatedAt,
		ExpectedDuplicateUpdatedAt: &duplicateUpdatedAt,
		DryRun:                     true,
	}

	// 1. Dry run: plan computed, nothing written.
	preview, err := d.apply(ctx, tenantID, req, db.AuditMeta{TenantID: tenantID})
	if err != nil {
		t.Fatalf("dry_run apply: %v", err)
	}
	if preview.Plan.Status != "blocklisted" {
		t.Fatalf("plan status = %q, want blocklisted", preview.Plan.Status)
	}
	if preview.Plan.CustomFields["plan"] != "pro" || preview.Plan.CustomFields["country"] != "NO" {
		t.Fatalf("plan custom_fields = %v", preview.Plan.CustomFields)
	}
	if len(preview.Plan.GDPRPermissions) != 2 || preview.Plan.GDPRPermissions[0]["enabled"] != false {
		t.Fatalf("plan GDPR permissions = %#v, want email denied plus sms", preview.Plan.GDPRPermissions)
	}
	assertSubscriberStatus(t, pool, tenantID, dupID, "blocklisted") // untouched

	// 2. Apply: same plan executed.
	req.DryRun = false
	req.ExpectedPlanFingerprint = preview.PlanFingerprint
	applied, err := d.apply(ctx, tenantID, req, db.AuditMeta{TenantID: tenantID})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if applied.Plan.Status != preview.Plan.Status {
		t.Fatalf("apply plan diverged from preview: %q vs %q",
			applied.Plan.Status, preview.Plan.Status)
	}
	if !applied.LoserSoftDeleted {
		t.Fatal("LoserSoftDeleted = false, want true")
	}
	assertSubscriberStatus(t, pool, tenantID, primaryID, "blocklisted")
	assertSubscriberStatus(t, pool, tenantID, dupID, "disabled")

	// Loser carries the marker tag + provenance.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var hasTag bool
	var mergedInto string
	if err := tx.QueryRow(ctx, `
SELECT $1 = ANY(tags), COALESCE(custom_fields->>'merged_into','')
  FROM subscribers WHERE tenant_id = $2::uuid AND id = $3::uuid`,
		mergedLoserTag, tenantID, dupID).Scan(&hasTag, &mergedInto); err != nil {
		t.Fatalf("read loser: %v", err)
	}
	if !hasTag || mergedInto != primaryID {
		t.Fatalf("loser markers: tag=%v merged_into=%q (want %q)", hasTag, mergedInto, primaryID)
	}
	var permissionsAreArray, emailDenied bool
	if err := tx.QueryRow(ctx, `
SELECT jsonb_typeof(gdpr_permissions) = 'array',
       EXISTS (
         SELECT 1 FROM jsonb_array_elements(gdpr_permissions) permission
          WHERE permission->>'marketing_permission_id' = 'email'
            AND permission->>'enabled' = 'false'
       )
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, primaryID).
		Scan(&permissionsAreArray, &emailDenied); err != nil {
		t.Fatalf("read merged GDPR permissions: %v", err)
	}
	if !permissionsAreArray || !emailDenied {
		t.Fatalf("merged GDPR shape/denial = array:%v email_denied:%v", permissionsAreArray, emailDenied)
	}
	// Audit row landed in the same tenant.
	var auditCount int
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*) FROM audit_log
 WHERE tenant_id = $1::uuid AND action = 'subscriber.merge.applied'
   AND resource_id = $2`, tenantID, primaryID).Scan(&auditCount); err != nil {
		t.Fatalf("read audit_log: %v", err)
	}
	if auditCount == 0 {
		t.Fatal("no subscriber.merge.applied audit row written")
	}
	_ = tx.Rollback(ctx)

	// 3. Re-merging the soft-deleted loser is refused.
	if _, err := d.apply(ctx, tenantID, req, db.AuditMeta{TenantID: tenantID}); err != ErrAlreadyMerged {
		t.Fatalf("re-apply err = %v, want ErrAlreadyMerged", err)
	}
}

func TestApplyRejectsRowsChangedAfterReviewedFingerprint_DB(t *testing.T) {
	pool := newMergeTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-00993e23e57f"
	seedMergeTenant(t, pool, tenantID)
	suffix := time.Now().UnixNano()
	primaryID := seedMergeSubscriber(t, pool, tenantID,
		fmt.Sprintf("review-primary-%d@example.test", suffix), "enabled", nil, `{}`)
	duplicateID := seedMergeSubscriber(t, pool, tenantID,
		fmt.Sprintf("review-duplicate-%d@example.test", suffix), "enabled", nil, `{}`)
	scanID, primaryUpdatedAt, duplicateUpdatedAt := seedMergeScanCandidate(
		t, pool, tenantID, primaryID, duplicateID,
	)
	d := &Deps{Pool: pool}
	request := applyRequest{
		PrimaryID:                  primaryID,
		DuplicateID:                duplicateID,
		ScanID:                     scanID,
		ExpectedPrimaryUpdatedAt:   &primaryUpdatedAt,
		ExpectedDuplicateUpdatedAt: &duplicateUpdatedAt,
		DryRun:                     true,
	}
	preview, err := d.apply(ctx, tenantID, request, db.AuditMeta{TenantID: tenantID})
	if err != nil {
		t.Fatalf("preview: %v", err)
	}

	changeTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("change tx: %v", err)
	}
	if _, err := changeTx.Exec(ctx, `
UPDATE subscribers SET custom_fields = '{"changed_after_review":true}'::jsonb
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, duplicateID); err != nil {
		_ = changeTx.Rollback(ctx)
		t.Fatalf("change duplicate: %v", err)
	}
	if err := changeTx.Commit(ctx); err != nil {
		t.Fatalf("commit duplicate change: %v", err)
	}

	request.DryRun = false
	request.ExpectedPlanFingerprint = preview.PlanFingerprint
	if _, err := d.apply(ctx, tenantID, request, db.AuditMeta{TenantID: tenantID}); !errors.Is(err, ErrStaleReview) {
		t.Fatalf("apply changed review err = %v, want ErrStaleReview", err)
	}

	// A caller cannot bypass the stale scan by replacing the reviewed version
	// with the subscriber's newer version obtained outside the scan contract.
	readTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("read changed version tx: %v", err)
	}
	var changedDuplicateUpdatedAt time.Time
	if err := readTx.QueryRow(ctx, `
SELECT updated_at FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, duplicateID).
		Scan(&changedDuplicateUpdatedAt); err != nil {
		_ = readTx.Rollback(ctx)
		t.Fatalf("read changed duplicate version: %v", err)
	}
	_ = readTx.Rollback(ctx)
	request.ExpectedDuplicateUpdatedAt = &changedDuplicateUpdatedAt
	if _, err := d.apply(ctx, tenantID, request, db.AuditMeta{TenantID: tenantID}); !errors.Is(err, ErrCandidateStale) {
		t.Fatalf("apply substituted version err = %v, want ErrCandidateStale", err)
	}
	assertSubscriberStatus(t, pool, tenantID, primaryID, "enabled")
	assertSubscriberStatus(t, pool, tenantID, duplicateID, "enabled")
}

func seedMergeScanCandidate(t *testing.T, pool *pgxpool.Pool, tenantID, primaryID, duplicateID string) (string, time.Time, time.Time) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scan tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var primaryUpdatedAt, duplicateUpdatedAt time.Time
	if err := tx.QueryRow(ctx, `
SELECT p.updated_at, d.updated_at
  FROM subscribers p
  JOIN subscribers d ON d.tenant_id = p.tenant_id
 WHERE p.tenant_id = $1::uuid AND p.id = $2::uuid AND d.id = $3::uuid`,
		tenantID, primaryID, duplicateID).Scan(&primaryUpdatedAt, &duplicateUpdatedAt); err != nil {
		t.Fatalf("read merge candidate versions: %v", err)
	}
	var scanID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_duplicate_scans (
    tenant_id, status, subscriber_count, candidate_count, completed_at
) VALUES ($1::uuid, 'complete', 2, 1, now())
RETURNING id::text`, tenantID).Scan(&scanID); err != nil {
		t.Fatalf("seed duplicate scan: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_duplicate_scan_pairs (
    tenant_id, scan_id, ordinal, primary_id, duplicate_id,
    primary_updated_at, duplicate_updated_at, confidence, evidence
) VALUES (
    $1::uuid, $2::uuid, 1, $3::uuid, $4::uuid, $5, $6, 1,
    '[{"kind":"test_exact","confidence":1,"reason":"Test-only deterministic identity signal."}]'::jsonb
)`, tenantID, scanID, primaryID, duplicateID, primaryUpdatedAt, duplicateUpdatedAt); err != nil {
		t.Fatalf("seed duplicate scan pair: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit duplicate scan pair: %v", err)
	}
	return scanID, primaryUpdatedAt, duplicateUpdatedAt
}

func assertSubscriberStatus(t *testing.T, pool *pgxpool.Pool, tenantID, id, want string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var got string
	if err := tx.QueryRow(ctx,
		`SELECT status FROM subscribers WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, id).Scan(&got); err != nil {
		t.Fatalf("read status: %v", err)
	}
	if got != want {
		t.Fatalf("subscriber %s status = %q, want %q", id, got, want)
	}
}
