// SPDX-License-Identifier: AGPL-3.0-only
//
// lookalike_test.go — SUB-033 lookalike audiences (migrations 0901/0902).
// Validation guards on CreateLookalike run without a DB (they fire before the
// tenant tx); the full model-creation + member-ranking round-trip is pg-backed
// and skips cleanly without DATABASE_URL, matching the project convention.

package audiences

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

// TestCreateLookalike_Validation pins the input guards that fire before any DB
// work: missing seed, out-of-range size, out-of-range confidence.
func TestCreateLookalike_Validation(t *testing.T) {
	r := &Repo{Pool: nil}
	ctx := context.Background()
	seedID := uuid.NewString()

	if _, err := r.CreateLookalike(ctx, "t", CreateLookalikeInput{}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("missing seed_segment_id err = %v; want ErrInvalidInput", err)
	}
	if _, err := r.CreateLookalike(ctx, "t", CreateLookalikeInput{SeedSegmentID: seedID}); !errors.Is(err, ErrInvalidInput) || !strings.Contains(err.Error(), "data_use_acknowledged") {
		t.Errorf("missing data-use acknowledgement err = %v; want acknowledgement ErrInvalidInput", err)
	}
	if _, err := r.CreateLookalike(ctx, "t", CreateLookalikeInput{SeedSegmentID: seedID, Size: 5, DataUseAcknowledged: true}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("size below min err = %v; want ErrInvalidInput", err)
	}
	if _, err := r.CreateLookalike(ctx, "t", CreateLookalikeInput{SeedSegmentID: seedID, Size: 999999, DataUseAcknowledged: true}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("size above max err = %v; want ErrInvalidInput", err)
	}
	over := 2.0
	if _, err := r.CreateLookalike(ctx, "t", CreateLookalikeInput{SeedSegmentID: seedID, DataUseAcknowledged: true, ConfidenceThreshold: &over}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("confidence above 1 err = %v; want ErrInvalidInput", err)
	}
	under := 0.49
	if _, err := r.CreateLookalike(ctx, "t", CreateLookalikeInput{SeedSegmentID: seedID, DataUseAcknowledged: true, ConfidenceThreshold: &under}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("confidence below supported floor err = %v; want ErrInvalidInput", err)
	}
}

func TestNonSeedCandidateCount(t *testing.T) {
	seed := []predictive.Profile{{SubscriberID: "seed-1"}, {SubscriberID: "seed-2"}}
	candidates := []predictive.Profile{{SubscriberID: "seed-2"}, {SubscriberID: "candidate-1"}}
	if got := nonSeedCandidateCount(seed, candidates); got != 1 {
		t.Fatalf("non-seed candidate count = %d; want 1", got)
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

// TestCreateLookalike_RoundTrip pins the SUB-033 generation end-to-end against
// a live DB: seed two gmail/high-engagement subscribers via a segment, plant a
// matching candidate + a dissimilar candidate, then generate the lookalike and
// assert the matching candidate ranks first and the model header + members
// persist + read back using the same app-role tenant scope as production.
func TestCreateLookalike_RoundTrip(t *testing.T) {
	pool := newLookalikeTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	tenantSlug := "aud-lookalike-" + tenantID[:8]

	// Tenant creation is itself tenant-scoped under the app role. Bind the
	// prospective tenant id so RLS and tenant lifecycle triggers exercise the
	// same contract as production writes.
	seedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seeding: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'lookalike-test', $2, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID, tenantSlug); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
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
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Seed members: high-engagement gmail signups, tagged so the segment AST
	// can select exactly them.
	seedTag := fmt.Sprintf("seed-%d", suffix)
	for i := 0; i < MinLookalikeSeedMembers; i++ {
		if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, signup_source, engagement_score, churn_score, tags)
VALUES ($1::uuid, $2, 'enabled', 'single_optin', 'embedded_form', 90, 10, ARRAY[$3])`,
			tenantID, fmt.Sprintf("seed%d-%d@gmail.com", i, suffix), seedTag); err != nil {
			t.Fatalf("insert seed %d: %v", i, err)
		}
	}
	// Matching candidate (looks like the seed) + dissimilar candidate.
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, signup_source, engagement_score, churn_score)
VALUES ($1::uuid, $2, 'enabled', 'single_optin', 'embedded_form', 88, 12),
       ($1::uuid, $3, 'enabled', 'import', 'import', 5, 95)`,
		tenantID, fmt.Sprintf("match-%d@gmail.com", suffix), fmt.Sprintf("diff-%d@yahoo.com", suffix)); err != nil {
		t.Fatalf("insert candidates: %v", err)
	}

	// Seed segment whose AST selects the seedTag members.
	ast := json.RawMessage(fmt.Sprintf(
		`{"op":"condition","field":"tag","comparator":"equals","value":%q}`, seedTag))
	var segID string
	if err := tx.QueryRow(ctx, `
INSERT INTO segments (tenant_id, name, query_ast)
VALUES ($1::uuid, $2, $3::jsonb) RETURNING id::text`,
		tenantID, fmt.Sprintf("seed-seg-%d", suffix), ast).Scan(&segID); err != nil {
		t.Fatalf("insert segment: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixtures: %v", err)
	}

	r := &Repo{Pool: pool}
	conf := 0.5
	model, err := r.CreateLookalike(ctx, tenantID, CreateLookalikeInput{
		Name: "test-lookalike", SeedSegmentID: segID, Size: MinLookalikeSize, ConfidenceThreshold: &conf, DataUseAcknowledged: true,
	})
	if err != nil {
		t.Fatalf("CreateLookalike: %v", err)
	}
	if model.SeedCount != MinLookalikeSeedMembers {
		t.Errorf("seed_count = %d; want %d", model.SeedCount, MinLookalikeSeedMembers)
	}
	if model.Status != "ready" {
		t.Errorf("status = %q; want ready", model.Status)
	}
	if model.MemberCount < 1 {
		t.Fatalf("member_count = %d; want >= 1 (the matching candidate)", model.MemberCount)
	}

	// Read back the header.
	got, err := r.GetLookalike(ctx, tenantID, model.ID)
	if err != nil {
		t.Fatalf("GetLookalike: %v", err)
	}
	if got.ID != model.ID || got.MemberCount != model.MemberCount {
		t.Errorf("GetLookalike mismatch: %+v vs %+v", got, model)
	}

	// Top-ranked member is the matching gmail candidate, not the yahoo one.
	redacted, err := r.ListMembers(ctx, tenantID, model.ID, 1, 100, false)
	if err != nil {
		t.Fatalf("ListMembers redacted: %v", err)
	}
	if redacted.PIIIncluded || len(redacted.Items) == 0 || redacted.Items[0].SubscriberID != "" || redacted.Items[0].Email != "" {
		t.Fatalf("default member page was not redacted: %+v", redacted)
	}
	page, err := r.ListMembers(ctx, tenantID, model.ID, 1, 100, true)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	if len(page.Items) == 0 {
		t.Fatalf("ListMembers returned 0 items")
	}
	top := page.Items[0]
	if top.Rank != 1 {
		t.Errorf("top rank = %d; want 1", top.Rank)
	}
	wantTop := fmt.Sprintf("match-%d@gmail.com", suffix)
	if top.Email != wantTop {
		t.Errorf("top member email = %q; want %q", top.Email, wantTop)
	}

	// Discard cascades members.
	if err := r.DeleteLookalike(ctx, tenantID, model.ID); err != nil {
		t.Fatalf("DeleteLookalike: %v", err)
	}
	if _, err := r.GetLookalike(ctx, tenantID, model.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("after delete GetLookalike err = %v; want ErrNotFound", err)
	}
}
