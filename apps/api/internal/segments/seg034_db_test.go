// SPDX-License-Identifier: AGPL-3.0-only

package segments

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
)

// SEG-034: the archive-scope toggle must persist on the segment definition so
// re-opening a saved segment reflects it (and the recompute/count use it),
// while a nil update leaves it untouched (PATCH semantics).
func TestSegmentIncludeArchivedPersistence_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, _ := seedPreviewAggregateFixture(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}
	ast := json.RawMessage(`{"op":"condition","field":"email","comparator":"contains","value":"x"}`)

	// Create with the scope ON → it round-trips through Create + Get + List.
	created, err := repo.Create(ctx, tenantID, CreateInput{
		Name:            "archived-scope-" + uuid.NewString(),
		QueryAST:        ast,
		IncludeArchived: true,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !created.IncludeArchived {
		t.Fatal("Create did not return IncludeArchived=true")
	}
	got, err := repo.Get(ctx, tenantID, created.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !got.IncludeArchived {
		t.Fatal("Get did not persist IncludeArchived=true")
	}

	// A nil update must NOT change the persisted scope (PATCH semantics).
	newName := "renamed-" + uuid.NewString()
	afterNil, err := repo.Update(ctx, tenantID, created.ID, UpdateInput{Name: &newName})
	if err != nil {
		t.Fatalf("update(nil scope): %v", err)
	}
	if !afterNil.IncludeArchived {
		t.Fatal("nil IncludeArchived update wrongly reset the scope to false")
	}

	// An explicit false flips it off.
	off := false
	afterOff, err := repo.Update(ctx, tenantID, created.ID, UpdateInput{IncludeArchived: &off})
	if err != nil {
		t.Fatalf("update(false): %v", err)
	}
	if afterOff.IncludeArchived {
		t.Fatal("explicit false did not turn IncludeArchived off")
	}
	reread, err := repo.Get(ctx, tenantID, created.ID)
	if err != nil {
		t.Fatalf("reget: %v", err)
	}
	if reread.IncludeArchived {
		t.Fatal("Get after false-update still reports IncludeArchived=true")
	}

	// New segments default to active-only (false).
	def, err := repo.Create(ctx, tenantID, CreateInput{
		Name:     "default-scope-" + uuid.NewString(),
		QueryAST: ast,
	})
	if err != nil {
		t.Fatalf("create default: %v", err)
	}
	if def.IncludeArchived {
		t.Fatal("new segment defaulted to IncludeArchived=true")
	}
}
