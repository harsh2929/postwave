// SPDX-License-Identifier: AGPL-3.0-only

package segments

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	savedSegmentsTestTenant = "00000000-0000-4000-8000-005a9ed00001"
	savedSegmentsTestUserA  = "00000000-0000-4000-8000-005a9ed0000a"
	savedSegmentsTestUserB  = "00000000-0000-4000-8000-005a9ed0000b"
)

func seedSavedSegmentsOwnershipFixture(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, savedSegmentsTestTenant)
	if err != nil {
		t.Fatalf("tenant scope for saved-segment fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, savedSegmentsTestTenant); err != nil {
		t.Fatalf("clean saved-segment fixture tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'saved-segment-ownership-test', 'saved-segment-ownership-test', 'studio')`, savedSegmentsTestTenant); err != nil {
		t.Fatalf("seed saved-segment fixture tenant: %v", err)
	}
	for _, user := range []struct {
		id       string
		external string
		email    string
	}{
		{savedSegmentsTestUserA, "saved-segment-user-a", "saved-segment-a@example.test"},
		{savedSegmentsTestUserB, "saved-segment-user-b", "saved-segment-b@example.test"},
	} {
		if _, err := tx.Exec(ctx, `
INSERT INTO users (id, tenant_id, external_user_id, email, role)
VALUES ($1::uuid, $2::uuid, $3, $4, 'editor')`, user.id, savedSegmentsTestTenant, user.external, user.email); err != nil {
			t.Fatalf("seed saved-segment fixture user: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit saved-segment fixture: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanup, cleanupErr := db.WithTenant(cleanupCtx, pool, savedSegmentsTestTenant)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(cleanupCtx) }()
		_, _ = cleanup.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, savedSegmentsTestTenant)
		_ = cleanup.Commit(cleanupCtx)
	})
}

func savedIDs(items []SavedSegment) map[string]bool {
	ids := make(map[string]bool, len(items))
	for _, item := range items {
		ids[item.ID] = true
	}
	return ids
}

func TestSavedSegmentOwnershipDuplicatesAndCountInvalidation_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	seedSavedSegmentsOwnershipFixture(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}
	predicate := json.RawMessage(`{"filters":{"status":"enabled"}}`)

	workspace, err := repo.CreateSaved(ctx, savedSegmentsTestTenant, savedSegmentsTestUserA, SavedSegmentInput{
		Name: "Workspace readers", PredicateJSON: predicate, VisibilityScope: SavedScopeWorkspace,
	})
	if err != nil {
		t.Fatalf("create workspace saved segment: %v", err)
	}
	personalA, err := repo.CreateSaved(ctx, savedSegmentsTestTenant, savedSegmentsTestUserA, SavedSegmentInput{
		Name: "Personal A", PredicateJSON: predicate, VisibilityScope: SavedScopePersonal,
	})
	if err != nil {
		t.Fatalf("create personal A: %v", err)
	}
	personalB, err := repo.CreateSaved(ctx, savedSegmentsTestTenant, savedSegmentsTestUserB, SavedSegmentInput{
		Name: "Personal B", PredicateJSON: predicate, VisibilityScope: SavedScopePersonal,
	})
	if err != nil {
		t.Fatalf("create personal B: %v", err)
	}

	itemsA, total, err := repo.ListSaved(ctx, savedSegmentsTestTenant, savedSegmentsTestUserA)
	if err != nil {
		t.Fatalf("list as A: %v", err)
	}
	idsA := savedIDs(itemsA)
	if total != 3 || !idsA[workspace.ID] || !idsA[personalA.ID] || idsA[personalB.ID] {
		t.Fatalf("A visibility ids=%v total=%d", idsA, total)
	}
	itemsB, _, err := repo.ListSaved(ctx, savedSegmentsTestTenant, savedSegmentsTestUserB)
	if err != nil {
		t.Fatalf("list as B: %v", err)
	}
	idsB := savedIDs(itemsB)
	if !idsB[workspace.ID] || !idsB[personalB.ID] || idsB[personalA.ID] {
		t.Fatalf("B visibility ids=%v", idsB)
	}
	if _, err := repo.GetSaved(ctx, savedSegmentsTestTenant, savedSegmentsTestUserB, personalA.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("B read A personal error = %v, want not found", err)
	}
	if err := repo.DeleteSaved(ctx, savedSegmentsTestTenant, savedSegmentsTestUserB, personalA.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("B delete A personal error = %v, want not found", err)
	}
	if _, err := repo.CreateSaved(ctx, savedSegmentsTestTenant, "", SavedSegmentInput{
		Name: "Unattributed personal", PredicateJSON: predicate, VisibilityScope: SavedScopePersonal,
	}); !errors.Is(err, ErrPersonalScopeRequiresUser) {
		t.Fatalf("unattributed personal error = %v", err)
	}
	if _, err := repo.CreateSaved(ctx, savedSegmentsTestTenant, savedSegmentsTestUserA, SavedSegmentInput{
		Name: "workspace READERS", PredicateJSON: predicate, VisibilityScope: SavedScopeWorkspace,
	}); !errors.Is(err, ErrSavedNameConflict) {
		t.Fatalf("case-insensitive duplicate error = %v", err)
	}

	// A personal row whose owner is later deleted must fail closed instead of
	// silently becoming workspace-visible. Migration 1755 deliberately converts
	// only the legacy rows that were already unattributed at migration time.
	worker, err := db.WithTenant(ctx, pool, savedSegmentsTestTenant)
	if err != nil {
		t.Fatalf("open worker scope for orphan fixture: %v", err)
	}
	if _, err := worker.Exec(ctx, `
UPDATE saved_segments
   SET created_by_user_id = NULL
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, savedSegmentsTestTenant, personalB.ID); err != nil {
		_ = worker.Rollback(ctx)
		t.Fatalf("orphan personal saved segment: %v", err)
	}
	if err := worker.Commit(ctx); err != nil {
		t.Fatalf("commit orphan fixture: %v", err)
	}
	apiKeyItems, _, err := repo.ListSaved(ctx, savedSegmentsTestTenant, "")
	if err != nil {
		t.Fatalf("list as unattributed actor: %v", err)
	}
	apiKeyIDs := savedIDs(apiKeyItems)
	if !apiKeyIDs[workspace.ID] || apiKeyIDs[personalA.ID] || apiKeyIDs[personalB.ID] {
		t.Fatalf("unattributed visibility ids=%v", apiKeyIDs)
	}

	if err := repo.UpdateSavedEvaluated(ctx, savedSegmentsTestTenant, personalA.ID, 7); err != nil {
		t.Fatalf("store evaluated count: %v", err)
	}
	changed := json.RawMessage(`{"filters":{"status":"disabled"}}`)
	patched, err := repo.PatchSaved(ctx, savedSegmentsTestTenant, savedSegmentsTestUserA, personalA.ID, SavedSegmentPatch{
		PredicateJSON: &changed,
	})
	if err != nil {
		t.Fatalf("patch predicate: %v", err)
	}
	if patched.LastCount != nil || patched.LastEvaluatedAt != nil {
		t.Fatalf("predicate patch retained stale count: %+v", patched)
	}
}
