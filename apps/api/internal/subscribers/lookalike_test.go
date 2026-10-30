// SPDX-License-Identifier: AGPL-3.0-only
//
// lookalike_test.go — SUB-068: first-party AI lookalike audiences
// (subscriber-namespaced, migrations 0949/0950). Pure-function coverage of the
// create-input guards, similarity-band bucketing, and score clamping, plus a
// pg-backed CRUD + export round-trip. Skips cleanly without DATABASE_URL.

package subscribers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/predictive"
)

// TestCreateLookalike_Validation pins the create-input guards: missing seed,
// too-small / too-large size, and out-of-range confidence are all rejected
// with ErrInvalidInput before any DB work.
func TestCreateLookalike_Validation(t *testing.T) {
	r := &Repo{Pool: nil}
	ctx := context.Background()
	seedID := uuid.NewString()
	if _, err := r.CreateLookalike(ctx, "t", CreateLookalikeInput{}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("missing seed -> %v; want ErrInvalidInput", err)
	}
	if _, err := r.CreateLookalike(ctx, "t", CreateLookalikeInput{SeedSegmentID: seedID}); !errors.Is(err, ErrInvalidInput) || !strings.Contains(err.Error(), "data_use_acknowledged") {
		t.Errorf("missing data-use acknowledgement -> %v; want acknowledgement ErrInvalidInput", err)
	}
	if _, err := r.CreateLookalike(ctx, "t", CreateLookalikeInput{SeedSegmentID: seedID, Size: 5, DataUseAcknowledged: true}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("size below min -> %v; want ErrInvalidInput", err)
	}
	if _, err := r.CreateLookalike(ctx, "t", CreateLookalikeInput{SeedSegmentID: seedID, Size: 999999, DataUseAcknowledged: true}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("size above max -> %v; want ErrInvalidInput", err)
	}
	over := 1.5
	if _, err := r.CreateLookalike(ctx, "t", CreateLookalikeInput{SeedSegmentID: seedID, DataUseAcknowledged: true, ConfidenceThreshold: &over}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("confidence above 1 -> %v; want ErrInvalidInput", err)
	}
	under := 0.49
	if _, err := r.CreateLookalike(ctx, "t", CreateLookalikeInput{SeedSegmentID: seedID, DataUseAcknowledged: true, ConfidenceThreshold: &under}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("confidence below supported floor -> %v; want ErrInvalidInput", err)
	}
}

// TestExportLookalike_Validation pins the export guard: a blank destination_id
// is rejected before the tenant tx.
func TestExportLookalike_Validation(t *testing.T) {
	r := &Repo{Pool: nil}
	if _, err := r.ExportLookalike(context.Background(), "t", "id", ExportLookalikeInput{}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("blank destination_id -> %v; want ErrInvalidInput", err)
	}
}

// TestLookalikeBands buckets scored candidates into high/medium/low bands.
func TestLookalikeBands(t *testing.T) {
	ranked := []predictive.Scored{
		{Similarity: 0.95}, {Similarity: 0.81}, {Similarity: 0.5}, {Similarity: 0.49}, {Similarity: 0.1},
	}
	bands := lookalikeBands(ranked)
	if bands["high"] != 2 {
		t.Errorf("high = %d; want 2", bands["high"])
	}
	if bands["medium"] != 1 {
		t.Errorf("medium = %d; want 1", bands["medium"])
	}
	if bands["low"] != 2 {
		t.Errorf("low = %d; want 2", bands["low"])
	}
}

func TestNonSeedLookalikeCandidateCount(t *testing.T) {
	seed := []predictive.Profile{{SubscriberID: "seed-1"}, {SubscriberID: "seed-2"}}
	candidates := []predictive.Profile{{SubscriberID: "seed-1"}, {SubscriberID: "candidate-1"}, {SubscriberID: "candidate-2"}}
	if got := nonSeedLookalikeCandidateCount(seed, candidates); got != 2 {
		t.Fatalf("non-seed candidate count = %d; want 2", got)
	}
}

// TestRoundLookalikeScore clamps + rounds to numeric(5,4) range.
func TestRoundLookalikeScore(t *testing.T) {
	if got := roundLookalikeScore(-0.5); got != 0 {
		t.Errorf("clamp low = %v; want 0", got)
	}
	if got := roundLookalikeScore(1.9); got != 1 {
		t.Errorf("clamp high = %v; want 1", got)
	}
	if got := roundLookalikeScore(0.123456); got != 0.1235 {
		t.Errorf("round = %v; want 0.1235", got)
	}
}

func newLookalikeTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed lookalike test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedLookalikeTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
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
		slug := "subscriber-lookalike-" + tenantID
		if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'subscriber-lookalike-test', $2, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID, slug); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed tenant: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

// TestLookalike_CRUD pins the SUB-068 round-trip: seed a segment + subscribers,
// generate a lookalike, read header + members (top = the gmail match, not the
// yahoo outlier), export it, list it, and discard (cascading members).
func TestLookalike_CRUD(t *testing.T) {
	pool := newLookalikeTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	seedLookalikeTenant(t, pool, tenantID)
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
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	seedTag := fmt.Sprintf("llseed-%d", suffix)
	for i := 0; i < MinLookalikeSeedMembers; i++ {
		if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, signup_source, engagement_score, churn_score, tags)
VALUES ($1::uuid, $2, 'enabled', 'single_optin', 'embedded_form', 90, 10, ARRAY[$3])`,
			tenantID, fmt.Sprintf("llseed%d-%d@gmail.com", i, suffix), seedTag); err != nil {
			t.Fatalf("insert seed %d: %v", i, err)
		}
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, signup_source, engagement_score, churn_score)
VALUES ($1::uuid, $2, 'enabled', 'single_optin', 'embedded_form', 88, 12),
       ($1::uuid, $3, 'enabled', 'import', 'import', 5, 95)`,
		tenantID, fmt.Sprintf("llmatch-%d@gmail.com", suffix), fmt.Sprintf("lldiff-%d@yahoo.com", suffix)); err != nil {
		t.Fatalf("insert candidates: %v", err)
	}
	ast := json.RawMessage(fmt.Sprintf(
		`{"op":"condition","field":"tag","comparator":"equals","value":%q}`, seedTag))
	var segID string
	if err := tx.QueryRow(ctx, `
INSERT INTO segments (tenant_id, name, query_ast)
VALUES ($1::uuid, $2, $3::jsonb) RETURNING id::text`,
		tenantID, fmt.Sprintf("ll-seg-%d", suffix), ast).Scan(&segID); err != nil {
		t.Fatalf("insert segment: %v", err)
	}
	dest := uuid.NewString()
	if _, err := tx.Exec(ctx, `
INSERT INTO audience_destinations (id, tenant_id, provider, status)
VALUES ($1::uuid, $2::uuid, 'meta', 'active')`, dest, tenantID); err != nil {
		t.Fatalf("insert destination: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixtures: %v", err)
	}

	r := &Repo{Pool: pool}
	conf := 0.5
	a, err := r.CreateLookalike(ctx, tenantID, CreateLookalikeInput{
		Name: "test-ll", SeedSegmentID: segID, Size: MinLookalikeSize, ConfidenceThreshold: &conf, DataUseAcknowledged: true,
	})
	if err != nil {
		t.Fatalf("CreateLookalike: %v", err)
	}
	if a.SeedCount != MinLookalikeSeedMembers {
		t.Errorf("seed_count = %d; want %d", a.SeedCount, MinLookalikeSeedMembers)
	}
	if a.Status != "ready" {
		t.Errorf("status = %q; want ready", a.Status)
	}
	if a.MemberCount < 1 {
		t.Fatalf("member_count = %d; want >= 1", a.MemberCount)
	}

	aggregate, err := r.GetLookalike(ctx, tenantID, a.ID, 1, 100, false)
	if err != nil {
		t.Fatalf("GetLookalike aggregate: %v", err)
	}
	if aggregate.PIIIncluded || len(aggregate.Members) != 0 {
		t.Fatalf("aggregate detail leaked members: pii=%v members=%d", aggregate.PIIIncluded, len(aggregate.Members))
	}
	detail, err := r.GetLookalike(ctx, tenantID, a.ID, 1, 100, true)
	if err != nil {
		t.Fatalf("GetLookalike: %v", err)
	}
	if len(detail.Members) == 0 {
		t.Fatalf("GetLookalike returned 0 members")
	}
	if detail.Members[0].Rank != 1 {
		t.Errorf("top rank = %d; want 1", detail.Members[0].Rank)
	}
	wantTop := fmt.Sprintf("llmatch-%d@gmail.com", suffix)
	if detail.Members[0].Email != wantTop {
		t.Errorf("top member = %q; want %q", detail.Members[0].Email, wantTop)
	}

	// Export stamps the destination id.
	exported, err := r.ExportLookalike(ctx, tenantID, a.ID, ExportLookalikeInput{DestinationID: dest})
	if err != nil {
		t.Fatalf("ExportLookalike: %v", err)
	}
	if exported.ExportedDestinationID == nil || *exported.ExportedDestinationID != dest {
		t.Errorf("exported_destination_id = %v; want %q", exported.ExportedDestinationID, dest)
	}

	// List includes it.
	list, err := r.ListLookalikes(ctx, tenantID)
	if err != nil {
		t.Fatalf("ListLookalikes: %v", err)
	}
	found := false
	for _, it := range list.Items {
		if it.ID == a.ID {
			found = true
		}
	}
	if !found {
		t.Errorf("ListLookalikes did not include %s", a.ID)
	}

	// Discard cascades members.
	if err := r.DeleteLookalike(ctx, tenantID, a.ID); err != nil {
		t.Fatalf("DeleteLookalike: %v", err)
	}
	if _, err := r.GetLookalike(ctx, tenantID, a.ID, 1, 100, false); !errors.Is(err, ErrNotFound) {
		t.Errorf("after delete GetLookalike err = %v; want ErrNotFound", err)
	}
}
