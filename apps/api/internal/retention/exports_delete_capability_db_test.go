// SPDX-License-Identifier: AGPL-3.0-only

package retention

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type failingExportDeleteStore struct{}

func (failingExportDeleteStore) Delete(context.Context, string) error {
	return errors.New("object store unavailable")
}

// The retention sweep may purge expired exports. A tenant may not.
//
// `sweepExports` runs on the application pool as `postwave_app`, which held no
// DELETE on `tenant_exports`, so every sweep raised "permission denied" and
// expired exports were never purged — a table recording that somebody pulled an
// audience out of the product, growing without bound.
//
// The grant alone would have been worse than the bug: `tenant_visible` is
// PERMISSIVE FOR ALL and already admits the tenant, so a bare grant lets any
// ordinary request delete its own export history — the evidence that an export
// happened. Migration 1908 pairs it with a RESTRICTIVE policy gated on
// `app.retention_worker`, the capability this schema already uses for exactly
// this purpose on `outbound_webhook_event_receipts`.
func TestOnlyTheRetentionSweepCanPurgeExports(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping export retention capability test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'export-retention', 'export-retention-' || right($1::text, 12), 'studio')`,
		tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO tenant_exports (tenant_id, status) VALUES ($1::uuid, 'ready')`, tenantID); err != nil {
		t.Fatalf("seed export: %v", err)
	}

	// An ordinary tenant-scoped request must not erase its own export history.
	tag, err := tx.Exec(ctx, `DELETE FROM tenant_exports WHERE tenant_id = $1::uuid`, tenantID)
	if err == nil && tag.RowsAffected() > 0 {
		t.Fatalf("an ordinary request deleted %d export row(s). The grant added for "+
			"retention has become a way for a tenant to erase the record that an "+
			"export happened.", tag.RowsAffected())
	}

	// The sweep must be able to, or retention is unenforceable.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.retention_worker', 'true', true)`); err != nil {
		t.Fatalf("retention scope: %v", err)
	}
	tag, err = tx.Exec(ctx, `DELETE FROM tenant_exports WHERE tenant_id = $1::uuid`, tenantID)
	if err != nil {
		t.Fatalf("the retention sweep cannot delete expired exports: %v. They "+
			"accumulate forever and the retention window is not enforced.", err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("the sweep deleted %d rows, want 1", tag.RowsAffected())
	}
}

// Drive the REAL sweep, not just the policy it depends on.
//
// The first version of this file asserted the RLS contract and nothing else, so
// deleting the `set_config('app.retention_worker', ...)` line from the sweep
// changed no test result — the helper was covered and the wiring was not. This
// calls sweepExpiredExports, which is the thing that was broken.
func TestTheExportSweepActuallyPurgesAnExpiredRow(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping export sweep test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := uuid.NewString()
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'export-sweep', 'export-sweep-' || right($1::text, 12), 'studio')`,
		tenantID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	// Expired well past any grace window.
	if _, err := seed.Exec(ctx, `
INSERT INTO tenant_exports (tenant_id, status, expires_at)
VALUES ($1::uuid, 'ready', now() - interval '90 days')`, tenantID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed export: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		cx, cerr := db.WithTenant(bg, pool, tenantID)
		if cerr != nil {
			return
		}
		defer func() { _ = cx.Rollback(bg) }()
		_, _ = cx.Exec(bg, `SELECT set_config('app.retention_worker', 'true', true)`)
		_, _ = cx.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cx.Commit(bg)
	})

	sweeper := &Sweeper{Pool: pool}
	purged, err := sweeper.sweepExpiredExports(ctx, tenantID, 1)
	if err != nil {
		t.Fatalf("sweepExpiredExports: %v. The sweep cannot delete what it "+
			"selected, so expired exports accumulate forever.", err)
	}
	if purged != 1 {
		t.Fatalf("the sweep purged %d expired export(s), want 1", purged)
	}
	read, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant(read): %v", err)
	}
	defer func() { _ = read.Rollback(ctx) }()
	var left int
	if err := read.QueryRow(ctx,
		`SELECT count(*) FROM tenant_exports WHERE tenant_id = $1::uuid`, tenantID).Scan(&left); err != nil {
		t.Fatalf("count: %v", err)
	}
	if left != 0 {
		t.Fatalf("%d expired export(s) survived the sweep", left)
	}
}

func TestExportSweepKeepsRetryEvidenceWhenObjectDeletionFails(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping export object deletion retry test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := uuid.NewString()
	exportID := uuid.NewString()
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant(seed): %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'export-delete-retry', 'export-delete-retry-' || right($1::text, 12), 'studio')`, tenantID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO tenant_exports (id, tenant_id, status, object_key, expires_at)
VALUES ($2::uuid, $1::uuid, 'ready', 'exports/' || $1::text || '/' || $2::text || '.zip', now() - interval '1 day')`, tenantID, exportID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed export: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		tx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = tx.Rollback(cleanupCtx) }()
		_, _ = tx.Exec(cleanupCtx, `SELECT set_config('app.retention_worker', 'true', true)`)
		_, _ = tx.Exec(cleanupCtx, `DELETE FROM tenant_exports WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = tx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = tx.Commit(cleanupCtx)
	})

	sweeper := &Sweeper{Pool: pool, ExportStore: failingExportDeleteStore{}}
	purged, err := sweeper.sweepExpiredExports(ctx, tenantID, 0)
	if err != nil {
		t.Fatalf("sweepExpiredExports: %v", err)
	}
	if purged != 0 {
		t.Fatalf("purged = %d, want 0 while object deletion failed", purged)
	}
	read, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant(read): %v", err)
	}
	defer func() { _ = read.Rollback(ctx) }()
	var objectKey string
	if err := read.QueryRow(ctx, `
SELECT object_key FROM tenant_exports WHERE tenant_id = $1::uuid`, tenantID).Scan(&objectKey); err != nil {
		t.Fatalf("retry evidence row: %v", err)
	}
	expectedObjectKey := "exports/" + tenantID + "/" + exportID + ".zip"
	if objectKey != expectedObjectKey {
		t.Fatalf("object key = %q, want retry evidence %q preserved", objectKey, expectedObjectKey)
	}
}
