// SPDX-License-Identifier: AGPL-3.0-only

package editorcheckpoint

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Resuming an edit on another device must restore the WORK, not just the page.
//
// `activity_cursor` stores one (entity_key, entity_id) reference and no
// content, so "Continue — <campaign>" opens an empty form and the half-written
// subject line stays on the laptop it was typed on.

func checkpointPool(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping checkpoint DB test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedTenant(t *testing.T, pool *db.Pool) string {
	t.Helper()
	ctx := context.Background()
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'ckpt', 'studio')`,
		tenantID, "ckpt-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		if _, err := c.Exec(bg, `DELETE FROM editor_checkpoints WHERE tenant_id = $1::uuid`, tenantID); err != nil {
			return
		}
		_ = c.Commit(bg)
	})
	return tenantID
}

func TestADraftSurvivesToAnotherDevice(t *testing.T) {
	pool := checkpointPool(t)
	repo := &Repo{Pool: pool}
	tenantID := seedTenant(t, pool)
	userID := uuid.NewString()
	ctx := context.Background()

	saved, err := repo.Save(ctx, tenantID, userID, "campaign", "c-1",
		json.RawMessage(`{"subject":"half written"}`), 0)
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if saved.Version != 1 {
		t.Errorf("version = %d, want 1 on first save", saved.Version)
	}

	got, err := repo.Load(ctx, tenantID, userID, "campaign", "c-1")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if string(got.Content) != `{"subject": "half written"}` &&
		string(got.Content) != `{"subject":"half written"}` {
		t.Errorf("content = %s, want the draft back", got.Content)
	}
}

func TestAStaleWriteFromASecondDeviceIsRefused(t *testing.T) {
	// The normal case, and the one where last-write-wins destroys work: the
	// laptop autosaves a stale buffer three seconds after the phone saved a
	// newer one.
	pool := checkpointPool(t)
	repo := &Repo{Pool: pool}
	tenantID := seedTenant(t, pool)
	userID := uuid.NewString()
	ctx := context.Background()

	if _, err := repo.Save(ctx, tenantID, userID, "campaign", "c-1",
		json.RawMessage(`{"subject":"from the phone"}`), 0); err != nil {
		t.Fatalf("first save: %v", err)
	}
	// The laptop still believes it is at version 0.
	_, err := repo.Save(ctx, tenantID, userID, "campaign", "c-1",
		json.RawMessage(`{"subject":"stale laptop buffer"}`), 0)
	if !errors.Is(err, ErrStaleCheckpoint) {
		t.Fatalf("err = %v, want ErrStaleCheckpoint — a stale buffer silently "+
			"overwrote newer work from another device", err)
	}

	// And the newer content must still be there.
	got, err := repo.Load(ctx, tenantID, userID, "campaign", "c-1")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if string(got.Content) == `{"subject":"stale laptop buffer"}` {
		t.Error("the stale write landed anyway")
	}
}

func TestTwoPeopleEditingOneCampaignKeepSeparateDrafts(t *testing.T) {
	// A checkpoint is one person's unsaved work. Merging two half-finished
	// thoughts, or letting one overwrite the other, is worse than either losing
	// theirs — the editing lease is what stops them colliding on the SAVED
	// record.
	pool := checkpointPool(t)
	repo := &Repo{Pool: pool}
	tenantID := seedTenant(t, pool)
	ada, grace := uuid.NewString(), uuid.NewString()
	ctx := context.Background()

	if _, err := repo.Save(ctx, tenantID, ada, "campaign", "c-1",
		json.RawMessage(`{"subject":"ada"}`), 0); err != nil {
		t.Fatalf("ada save: %v", err)
	}
	if _, err := repo.Save(ctx, tenantID, grace, "campaign", "c-1",
		json.RawMessage(`{"subject":"grace"}`), 0); err != nil {
		t.Fatalf("grace save: %v", err)
	}

	adaGot, err := repo.Load(ctx, tenantID, ada, "campaign", "c-1")
	if err != nil {
		t.Fatalf("ada load: %v", err)
	}
	if string(adaGot.Content) != `{"subject": "ada"}` && string(adaGot.Content) != `{"subject":"ada"}` {
		t.Errorf("ada's draft was overwritten by grace's: %s", adaGot.Content)
	}
}

func TestDiscardingRemovesTheDraft(t *testing.T) {
	// Called when the edit is SAVED. Leaving it behind makes the next open
	// offer to restore a draft that is already the saved state, which reads as
	// a bug and trains people to dismiss the prompt.
	pool := checkpointPool(t)
	repo := &Repo{Pool: pool}
	tenantID := seedTenant(t, pool)
	userID := uuid.NewString()
	ctx := context.Background()

	if _, err := repo.Save(ctx, tenantID, userID, "campaign", "c-1",
		json.RawMessage(`{"subject":"x"}`), 0); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := repo.Discard(ctx, tenantID, userID, "campaign", "c-1"); err != nil {
		t.Fatalf("discard: %v", err)
	}
	if _, err := repo.Load(ctx, tenantID, userID, "campaign", "c-1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound after discard", err)
	}
}

func TestTheSweepRemovesDraftsNobodyCameBackFor(t *testing.T) {
	// Without this the table becomes an undeclared archive of things people
	// chose NOT to save — a surprise in a data-subject request, and a growing
	// table with no owner.
	pool := checkpointPool(t)
	repo := &Repo{Pool: pool}
	tenantID := seedTenant(t, pool)
	userID := uuid.NewString()
	ctx := context.Background()

	if _, err := repo.Save(ctx, tenantID, userID, "campaign", "old",
		json.RawMessage(`{"subject":"forgotten"}`), 0); err != nil {
		t.Fatalf("save: %v", err)
	}
	// Age it past the window.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE editor_checkpoints SET updated_at = now() - interval '30 days'
 WHERE tenant_id = $1::uuid`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("age: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	n, err := repo.SweepOlderThan(ctx, tenantID, 7*24*time.Hour)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if n != 1 {
		t.Errorf("swept %d, want 1", n)
	}
	if _, err := repo.Load(ctx, tenantID, userID, "campaign", "old"); !errors.Is(err, ErrNotFound) {
		t.Errorf("the stale draft survived the sweep")
	}
}

func TestTheSweepKeepsRecentDrafts(t *testing.T) {
	// The mirror failure: a sweep that takes live work is worse than none.
	pool := checkpointPool(t)
	repo := &Repo{Pool: pool}
	tenantID := seedTenant(t, pool)
	userID := uuid.NewString()
	ctx := context.Background()

	if _, err := repo.Save(ctx, tenantID, userID, "campaign", "fresh",
		json.RawMessage(`{"subject":"still working on it"}`), 0); err != nil {
		t.Fatalf("save: %v", err)
	}
	if n, err := repo.SweepOlderThan(ctx, tenantID, 7*24*time.Hour); err != nil || n != 0 {
		t.Fatalf("swept %d (err %v) — a draft someone is still editing was deleted", n, err)
	}
}
