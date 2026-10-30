// SPDX-License-Identifier: AGPL-3.0-only
package omnichannel

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestUpsertTemplatePersistsInsertAndUpdate(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping omnichannel template database contract")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect template database: %v", err)
	}
	t.Cleanup(pool.Close)

	var tablePresent, forceRLS bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.omni_message_templates') IS NOT NULL,
       COALESCE((SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public.omni_message_templates')), false)`).Scan(
		&tablePresent, &forceRLS); err != nil {
		t.Fatalf("inspect message template schema: %v", err)
	}
	if !tablePresent || !forceRLS {
		t.Fatalf("message template FORCE RLS contract missing: table=%v force_rls=%v", tablePresent, forceRLS)
	}

	tenantID := uuid.NewString()
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin tenant seed: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'omnichannel-template-contract', 'studio')`, tenantID,
		"omni-template-"+strings.ReplaceAll(tenantID, "-", "")); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed template tenant: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit template tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanup, err := db.WithTenant(cleanupCtx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(cleanupCtx) }()
		_, _ = cleanup.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanup.Commit(cleanupCtx)
	})

	repo := &Repo{Pool: pool}
	name := "welcome-" + uuid.NewString()
	created, err := repo.UpsertTemplate(ctx, tenantID, MessageTemplate{
		Channel: "email", Name: name, Status: "ready", Subject: "Welcome",
		BodyHTML: "<p>Hello {{ first_name }}</p>", Variables: []string{"first_name"},
		Media: map[string]any{"layout": "hero"}, ApprovalStatus: "not_required",
	})
	if err != nil {
		t.Fatalf("insert template: %v", err)
	}
	if created.ID == "" {
		t.Fatal("insert returned an empty template id")
	}

	persisted, err := repo.GetTemplate(ctx, tenantID, created.ID)
	if err != nil {
		t.Fatalf("read committed template: %v", err)
	}
	if persisted == nil || persisted.Subject != "Welcome" || persisted.Media["layout"] != "hero" {
		t.Fatalf("persisted template = %+v", persisted)
	}

	updated, err := repo.UpsertTemplate(ctx, tenantID, MessageTemplate{
		Channel: "email", Name: name, Status: "approved", Subject: "Welcome back",
		BodyHTML: "<p>Updated</p>", Variables: []string{}, ApprovalStatus: "approved",
	})
	if err != nil {
		t.Fatalf("update template: %v", err)
	}
	if updated.ID != created.ID {
		t.Fatalf("upsert changed template id from %q to %q", created.ID, updated.ID)
	}
	persisted, err = repo.GetTemplate(ctx, tenantID, created.ID)
	if err != nil {
		t.Fatalf("read committed update: %v", err)
	}
	if persisted == nil || persisted.Subject != "Welcome back" || persisted.Status != "approved" {
		t.Fatalf("persisted update = %+v", persisted)
	}
}
