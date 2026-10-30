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
	segFolderTestTenant  = "00000000-0000-4000-8000-005e6f01d001"
	segFolderTestTenantB = "00000000-0000-4000-8000-005e6f01d002"
)

func seedFolderAssignmentTenant(t *testing.T, pool *pgxpool.Pool, tenantID, slug string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for folder-assignment fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); err != nil {
		t.Fatalf("clean folder-assignment tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, $2, $2, 'studio')`, tenantID, slug); err != nil {
		t.Fatalf("seed folder-assignment tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit folder-assignment fixture: %v", err)
	}
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer ccancel()
		cleanup, cerr := db.WithTenant(cctx, pool, tenantID)
		if cerr != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(cctx) }()
		_, _ = cleanup.Exec(cctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanup.Commit(cctx)
	})
}

// SEG-038 tenant isolation: filing a segment under ANOTHER tenant's folder id
// must fail (composite (tenant_id, folder_id) FK), even though the folder id
// exists globally. A single-column FK would let this through because Postgres
// RI checks bypass RLS.
func TestSegmentFolderCrossTenantRejected_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	seedFolderAssignmentTenant(t, pool, segFolderTestTenant, "seg-folder-xtenant-a")
	seedFolderAssignmentTenant(t, pool, segFolderTestTenantB, "seg-folder-xtenant-b")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}
	ast := json.RawMessage(`{"filters":{"status":"enabled"}}`)

	// Folder owned by tenant B.
	folderB, err := repo.CreateFolder(ctx, segFolderTestTenantB, "B's folder")
	if err != nil {
		t.Fatalf("create folder for B: %v", err)
	}
	// Tenant A's segment.
	segA, err := repo.Create(ctx, segFolderTestTenant, CreateInput{Name: "A seg", QueryAST: ast})
	if err != nil {
		t.Fatalf("create A's segment: %v", err)
	}

	// A tries to file its segment under B's (globally-existent) folder → reject.
	if _, err := repo.Update(ctx, segFolderTestTenant, segA.ID, UpdateInput{FolderID: &folderB.ID}); !errors.Is(err, ErrFolderNotFound) {
		t.Fatalf("cross-tenant Update err = %v, want ErrFolderNotFound", err)
	}
	// Same on Create.
	if _, err := repo.Create(ctx, segFolderTestTenant, CreateInput{
		Name: "A seg 2", QueryAST: ast, FolderID: &folderB.ID,
	}); !errors.Is(err, ErrFolderNotFound) {
		t.Fatalf("cross-tenant Create err = %v, want ErrFolderNotFound", err)
	}
}

// SEG-038: builder segments can be filed under a folder, re-filed, unfiled, and
// filing under an unknown folder id fails with ErrFolderNotFound.
func TestSegmentFolderAssignment_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	seedFolderAssignmentTenant(t, pool, segFolderTestTenant, "segment-folder-assign-test")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}
	ast := json.RawMessage(`{"filters":{"status":"enabled"}}`)

	folder, err := repo.CreateFolder(ctx, segFolderTestTenant, "Q1 Campaigns")
	if err != nil {
		t.Fatalf("create folder: %v", err)
	}

	// Create filed directly under the folder.
	filed, err := repo.Create(ctx, segFolderTestTenant, CreateInput{
		Name: "Filed on create", QueryAST: ast, FolderID: &folder.ID,
	})
	if err != nil {
		t.Fatalf("create filed: %v", err)
	}
	if filed.FolderID == nil || *filed.FolderID != folder.ID {
		t.Fatalf("created segment folderID = %v, want %s", filed.FolderID, folder.ID)
	}

	// Create under a non-existent folder → ErrFolderNotFound.
	bogus := "00000000-0000-4000-8000-0000deadbeef"
	if _, err := repo.Create(ctx, segFolderTestTenant, CreateInput{
		Name: "Bad folder", QueryAST: ast, FolderID: &bogus,
	}); !errors.Is(err, ErrFolderNotFound) {
		t.Fatalf("create under bogus folder err = %v, want ErrFolderNotFound", err)
	}

	// Create unfiled, then file via Update.
	unfiled, err := repo.Create(ctx, segFolderTestTenant, CreateInput{Name: "Unfiled", QueryAST: ast})
	if err != nil {
		t.Fatalf("create unfiled: %v", err)
	}
	if unfiled.FolderID != nil {
		t.Fatalf("new unfiled segment has folderID %v, want nil", unfiled.FolderID)
	}
	filedNow, err := repo.Update(ctx, segFolderTestTenant, unfiled.ID, UpdateInput{FolderID: &folder.ID})
	if err != nil {
		t.Fatalf("update file: %v", err)
	}
	if filedNow.FolderID == nil || *filedNow.FolderID != folder.ID {
		t.Fatalf("after file: folderID = %v, want %s", filedNow.FolderID, folder.ID)
	}

	// Update with nil FolderID leaves the folder unchanged (only rename).
	renamed := "Renamed"
	kept, err := repo.Update(ctx, segFolderTestTenant, unfiled.ID, UpdateInput{Name: &renamed})
	if err != nil {
		t.Fatalf("update rename: %v", err)
	}
	if kept.FolderID == nil || *kept.FolderID != folder.ID {
		t.Fatalf("nil FolderID must not change folder: got %v", kept.FolderID)
	}

	// Unfile with "" → NULL.
	empty := ""
	unfiledNow, err := repo.Update(ctx, segFolderTestTenant, unfiled.ID, UpdateInput{FolderID: &empty})
	if err != nil {
		t.Fatalf("update unfile: %v", err)
	}
	if unfiledNow.FolderID != nil {
		t.Fatalf("after unfile: folderID = %v, want nil", unfiledNow.FolderID)
	}

	// Update filing under a bogus folder → ErrFolderNotFound.
	if _, err := repo.Update(ctx, segFolderTestTenant, unfiled.ID, UpdateInput{FolderID: &bogus}); !errors.Is(err, ErrFolderNotFound) {
		t.Fatalf("update under bogus folder err = %v, want ErrFolderNotFound", err)
	}

	// Deleting the folder unfiles its segments (ON DELETE SET NULL), not delete.
	if err := repo.DeleteFolder(ctx, segFolderTestTenant, folder.ID); err != nil {
		t.Fatalf("delete folder: %v", err)
	}
	stillThere, err := repo.Get(ctx, segFolderTestTenant, filed.ID)
	if err != nil {
		t.Fatalf("get after folder delete: %v", err)
	}
	if stillThere.FolderID != nil {
		t.Fatalf("segment should be unfiled after folder delete, got %v", stillThere.FolderID)
	}
}
