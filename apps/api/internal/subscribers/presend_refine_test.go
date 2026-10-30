// SPDX-License-Identifier: AGPL-3.0-only
//
// presend_refine_test.go — SUB-067: pre-send audience refine / optimization
// (migration 0948). Pure-function coverage of the threshold/cooling guards,
// plus a pg-backed gate that subscribers at/above the churn threshold are
// excluded with a cooling-off expiry, that QueryChurnRiskSuppressedForSend
// reads them back, and that an expired exclusion auto-re-enters. Skips cleanly
// without DATABASE_URL.

package subscribers

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestRefineForSend_Validation pins the input guards: an out-of-range churn
// threshold and a negative cooling window are rejected before any DB work.
func TestRefineForSend_Validation(t *testing.T) {
	r := &Repo{Pool: nil}
	ctx := context.Background()
	if _, err := r.RefineForSend(ctx, "t", "c", PreSendRefineInput{ChurnThreshold: 200}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("threshold above 100 -> %v; want ErrInvalidInput", err)
	}
	if _, err := r.RefineForSend(ctx, "t", "c", PreSendRefineInput{ChurnThreshold: -5}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("negative threshold -> %v; want ErrInvalidInput", err)
	}
	if _, err := r.RefineForSend(ctx, "t", "c", PreSendRefineInput{CoolingOffHours: -1}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("negative cooling window -> %v; want ErrInvalidInput", err)
	}
}

func newPreSendTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed presend_refine test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedPreSendTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	// Tenant creation is a tenant-scoped write. Binding the prospective id is
	// also required by the lifecycle-segment trigger fired by this INSERT.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seeding: %v", err)
	}
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM tenants WHERE id = $1::uuid)`, tenantID).Scan(&exists); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read tenants: %v", err)
	}
	if !exists {
		slug := "presend-test-" + tenantID
		if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'presend-test', $2, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID, slug); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed tenant: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

// TestRefineForSend_Gate pins the SUB-067 gate end-to-end: only the
// at/above-threshold subscriber is excluded, the exclusion carries a
// cooling-off expiry, QueryChurnRiskSuppressedForSend reads it back, GET
// summarises it, and Clear forces re-entry.
func TestRefineForSend_Gate(t *testing.T) {
	pool := newPreSendTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	seedPreSendTenant(t, pool, tenantID)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		cleanupTx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			t.Errorf("cleanup transaction: %v", cleanupErr)
			return
		}
		defer func() { _ = cleanupTx.Rollback(cleanupCtx) }()
		if _, cleanupErr = cleanupTx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); cleanupErr != nil {
			t.Errorf("cleanup tenant: %v", cleanupErr)
			return
		}
		if cleanupErr = cleanupTx.Commit(cleanupCtx); cleanupErr != nil {
			t.Errorf("cleanup commit: %v", cleanupErr)
		}
	})

	suffix := time.Now().UnixNano()
	campaignID := uuid.NewString()

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// One high-churn subscriber (87, excluded) + one low-churn (10, kept).
	var highID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, churn_score)
VALUES ($1::uuid, $2, 'enabled', 'single_optin', 87) RETURNING id::text`,
		tenantID, fmt.Sprintf("highchurn-%d@example.test", suffix)).Scan(&highID); err != nil {
		t.Fatalf("insert high-churn: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, churn_score)
VALUES ($1::uuid, $2, 'enabled', 'single_optin', 10)`,
		tenantID, fmt.Sprintf("lowchurn-%d@example.test", suffix)); err != nil {
		t.Fatalf("insert low-churn: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixtures: %v", err)
	}

	r := &Repo{Pool: pool}

	// Dry run: counts the high-churn sub but writes nothing.
	dry, err := r.RefineForSend(ctx, tenantID, campaignID, PreSendRefineInput{ChurnThreshold: 80, DryRun: true})
	if err != nil {
		t.Fatalf("RefineForSend dry: %v", err)
	}
	if dry.ExcludedCount < 1 {
		t.Fatalf("dry excluded_count = %d; want >= 1", dry.ExcludedCount)
	}
	if ids, _ := r.QueryChurnRiskSuppressedForSend(ctx, tenantID, campaignID); len(ids) != 0 {
		t.Fatalf("dry run persisted %d exclusions; want 0", len(ids))
	}

	// Commit: persists the exclusion with a cooling-off expiry.
	res, err := r.RefineForSend(ctx, tenantID, campaignID, PreSendRefineInput{ChurnThreshold: 80, CoolingOffHours: 24})
	if err != nil {
		t.Fatalf("RefineForSend commit: %v", err)
	}
	if res.ExcludedCount < 1 || res.CoolingOffCount < 1 {
		t.Fatalf("commit excluded=%d cooling=%d; want >= 1 each", res.ExcludedCount, res.CoolingOffCount)
	}
	if res.CoolingOffUntil == nil {
		t.Errorf("cooling_off_until nil; want a future instant")
	}

	ids, err := r.QueryChurnRiskSuppressedForSend(ctx, tenantID, campaignID)
	if err != nil {
		t.Fatalf("QueryChurnRiskSuppressedForSend: %v", err)
	}
	foundHigh := false
	for _, id := range ids {
		if id == highID {
			foundHigh = true
		}
	}
	if !foundHigh {
		t.Errorf("high-churn subscriber %s not in suppressed set %v", highID, ids)
	}

	// GET summary reflects the active set.
	got, err := r.GetSendExclusions(ctx, tenantID, campaignID)
	if err != nil {
		t.Fatalf("GetSendExclusions: %v", err)
	}
	if got.ExcludedCount != res.ExcludedCount {
		t.Errorf("GET excluded_count = %d; want %d", got.ExcludedCount, res.ExcludedCount)
	}

	// Expired exclusion auto-re-enters: backdate the expiry and confirm the
	// active query drops it.
	tx2, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant 2: %v", err)
	}
	if _, err := tx2.Exec(ctx, `
UPDATE subscriber_send_exclusions SET expires_at = now() - interval '1 hour'
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`, tenantID, campaignID); err != nil {
		_ = tx2.Rollback(ctx)
		t.Fatalf("backdate expiry: %v", err)
	}
	if err := tx2.Commit(ctx); err != nil {
		t.Fatalf("commit backdate: %v", err)
	}
	if ids, _ := r.QueryChurnRiskSuppressedForSend(ctx, tenantID, campaignID); len(ids) != 0 {
		t.Errorf("expired exclusion still active: %v", ids)
	}

	// Clear forces full re-entry (removes the rows).
	cleared, err := r.ClearSendExclusions(ctx, tenantID, campaignID)
	if err != nil {
		t.Fatalf("ClearSendExclusions: %v", err)
	}
	if cleared < 1 {
		t.Errorf("cleared = %d; want >= 1", cleared)
	}
}
