// SPDX-License-Identifier: AGPL-3.0-only

package forms

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
)

func TestRepoDeleteWithVersionRejectsStaleRevision(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := seedFormsTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	form, err := repo.Create(
		ctx,
		tenantID,
		CreateInput{
			Slug:      "delete-version-" + randHex4(t),
			Name:      "Delete version baseline",
			OptInMode: OptInSingle,
		},
		map[string]any{},
		map[string]any{},
	)
	if err != nil {
		t.Fatalf("create form: %v", err)
	}
	staleVersion := httpcache.ConcurrencyToken("form", form.ID, form.UpdatedAt)
	updatedName := "Delete version current"
	current, err := repo.Update(ctx, tenantID, form.ID, UpdateInput{Name: &updatedName})
	if err != nil {
		t.Fatalf("update form: %v", err)
	}
	currentVersion := httpcache.ConcurrencyToken("form", current.ID, current.UpdatedAt)
	if currentVersion == staleVersion {
		t.Fatal("form update did not advance its concurrency token")
	}

	if err := repo.DeleteWithVersion(ctx, tenantID, form.ID, staleVersion); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("stale delete error = %v, want ErrPreconditionFailed", err)
	}
	if _, err := repo.Get(ctx, tenantID, form.ID); err != nil {
		t.Fatalf("stale delete removed or hid the form: %v", err)
	}
	if err := repo.DeleteWithVersion(ctx, tenantID, form.ID, currentVersion); err != nil {
		t.Fatalf("current-version delete: %v", err)
	}
	if _, err := repo.Get(ctx, tenantID, form.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get after delete error = %v, want ErrNotFound", err)
	}
}
