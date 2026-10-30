package holdout

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestAssignmentPlan_IsDeterministicAndFrozen(t *testing.T) {
	pool := holdoutDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tenantID := createHoldoutTenant(t, pool, ctx)
	campaignID := createHoldoutCampaign(t, pool, ctx, tenantID)
	createHoldoutRow(t, pool, ctx, tenantID, campaignID, "idempotent-seed", 25)
	emails := make([]string, 0, 12)
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin subscriber setup: %v", err)
	}
	for i := 0; i < 12; i++ {
		email := fmt.Sprintf("holdout-%02d@example.test", i)
		if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api')`, tenantID, email); err != nil {
			t.Fatalf("insert subscriber: %v", err)
		}
		emails = append(emails, email)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscribers: %v", err)
	}

	fixedNow := time.Date(2026, 8, 14, 8, 0, 0, 0, time.UTC)
	first, err := planAudienceAt(ctx, pool, tenantID, campaignID, emails, fixedNow)
	if err != nil {
		t.Fatalf("first plan: %v", err)
	}
	second, err := planAudienceAt(ctx, pool, tenantID, campaignID, emails, fixedNow)
	if err != nil {
		t.Fatalf("second plan: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("same frozen inputs produced different assignments:\nfirst=%+v\nsecond=%+v", first, second)
	}

	freezeTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin assignment freeze: %v", err)
	}
	defer func() { _ = freezeTx.Rollback(ctx) }()
	if err := PersistAssignmentPlanTx(
		ctx, freezeTx, tenantID, campaignID, first, first.TreatmentCount(),
	); err != nil {
		t.Fatalf("freeze assignment plan: %v", err)
	}
	if err := freezeTx.Commit(ctx); err != nil {
		t.Fatalf("commit assignment plan: %v", err)
	}
	var firstAt time.Time
	var firstHeld, firstSent int
	readHoldoutDecision(t, pool, ctx, tenantID, campaignID, &firstAt, &firstHeld, &firstSent)
	if !firstAt.Equal(fixedNow) || firstHeld != first.ControlCount() || firstSent != first.TreatmentCount() {
		t.Fatalf("decision = at:%v held:%d sent:%d, want %v/%d/%d",
			firstAt, firstHeld, firstSent, fixedNow, first.ControlCount(), first.TreatmentCount())
	}

	mutationTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin mutation probe: %v", err)
	}
	if _, err := mutationTx.Exec(ctx, `
UPDATE campaign_holdouts SET percent = 49
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`, tenantID, campaignID); err == nil {
		t.Fatal("decided assignment contract accepted a percentage mutation")
	}
	_ = mutationTx.Rollback(ctx)
}

func holdoutDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed holdout test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	return pool
}

func createHoldoutTenant(t *testing.T, pool *db.Pool, ctx context.Context) string {
	t.Helper()
	slug := "holdout-" + randHex(t)
	var tenantID string
	if err := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		t.Fatalf("generate tenant id: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $2, 'studio')
RETURNING id::text`, tenantID, slug).Scan(&tenantID); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		ctx2, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cleanupTx, err := db.WithTenant(ctx2, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanupTx.Rollback(ctx2) }()
		_, _ = cleanupTx.Exec(ctx2, `DELETE FROM tenants WHERE id::text = $1`, tenantID)
		_ = cleanupTx.Commit(ctx2)
	})
	return tenantID
}

func createHoldoutCampaign(t *testing.T, pool *db.Pool, ctx context.Context, tenantID string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var campaignID string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status, body_html)
VALUES ($1::uuid, $2, 'subject', 'draft', '<p>hello {{ unsubscribe_url }}</p>')
RETURNING id::text`, tenantID, "holdout-"+randHex(t)).Scan(&campaignID); err != nil {
		t.Fatalf("insert campaign: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit campaign: %v", err)
	}
	return campaignID
}

func createHoldoutRow(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, campaignID, seed string, percent float64) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_holdouts (campaign_id, tenant_id, percent, seed)
VALUES ($1::uuid, $2::uuid, $3, $4)`,
		campaignID, tenantID, percent, seed); err != nil {
		t.Fatalf("insert holdout: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit holdout: %v", err)
	}
}

func readHoldoutDecision(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, campaignID string, decidedAt *time.Time, heldOut, sent *int) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, `
SELECT decided_at, held_out_count, sent_count
  FROM campaign_holdouts
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`,
		tenantID, campaignID).Scan(decidedAt, heldOut, sent); err != nil {
		t.Fatalf("read holdout: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit read tx: %v", err)
	}
}

func randHex(t *testing.T) string {
	t.Helper()
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b[:])
}
