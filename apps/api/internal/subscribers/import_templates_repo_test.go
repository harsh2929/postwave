// SPDX-License-Identifier: AGPL-3.0-only
//
// import_templates_repo_test.go — pg-backed coverage for SUB-109 (reusable
// import-mapping templates). Skips cleanly without DATABASE_URL, matching the
// project-wide pg-backed test convention. Each test seeds a disposable tenant
// and drives the real Repo methods against the subscriber_import_templates
// table (migration 1336), asserting upsert-by-name, tenant-scoped listing,
// delete + not-found, and mapping round-trip fidelity.

package subscribers

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func newImportTemplatesTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := mustEnvDatabaseURL(t)
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedImportTemplateTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seeding: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'import-tmpl-test', 'import-tmpl-test-' || $1::text, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

// TestSaveImportTemplate_RoundTrip — a saved template returns its id +
// timestamps and the mapping round-trips through jsonb unchanged.
func TestSaveImportTemplate_RoundTrip(t *testing.T) {
	pool := newImportTemplatesTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0109a2c41001"
	seedImportTemplateTenant(t, pool, tenantID)
	r := &Repo{Pool: pool}
	ctx := context.Background()

	name := fmt.Sprintf("Weekly CRM %d", time.Now().UnixNano())
	in := SaveImportTemplateInput{
		Name: name,
		Mapping: map[string]any{
			"Email Address": "email",
			"First Name":    "FNAME",
			"Custom Notes":  "notes",
		},
		SourceHint: "Salesforce nightly export",
	}
	got, err := r.SaveImportTemplate(ctx, tenantID, in)
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if got.ID == "" {
		t.Fatal("save returned empty id")
	}
	if got.Name != name {
		t.Errorf("name = %q, want %q", got.Name, name)
	}
	if got.SourceHint != "Salesforce nightly export" {
		t.Errorf("source_hint = %q", got.SourceHint)
	}
	if got.Mapping["Email Address"] != "email" || got.Mapping["First Name"] != "FNAME" {
		t.Errorf("mapping round-trip lost data: %+v", got.Mapping)
	}
	if got.CreatedAt.IsZero() || got.UpdatedAt.IsZero() {
		t.Errorf("timestamps not set: created=%v updated=%v", got.CreatedAt, got.UpdatedAt)
	}
}

// TestSaveImportTemplate_UpsertByName — saving twice under the same name
// overwrites the mapping rather than creating a second row, and bumps
// updated_at.
func TestSaveImportTemplate_UpsertByName(t *testing.T) {
	pool := newImportTemplatesTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0109a2c41002"
	seedImportTemplateTenant(t, pool, tenantID)
	r := &Repo{Pool: pool}
	ctx := context.Background()

	name := fmt.Sprintf("Mailchimp %d", time.Now().UnixNano())
	first, err := r.SaveImportTemplate(ctx, tenantID, SaveImportTemplateInput{
		Name:    name,
		Mapping: map[string]any{"col_a": "email"},
	})
	if err != nil {
		t.Fatalf("first save: %v", err)
	}
	second, err := r.SaveImportTemplate(ctx, tenantID, SaveImportTemplateInput{
		Name:       name,
		Mapping:    map[string]any{"col_b": "FNAME"},
		SourceHint: "updated",
	})
	if err != nil {
		t.Fatalf("second save: %v", err)
	}
	if first.ID != second.ID {
		t.Errorf("upsert created a new row: %s != %s", first.ID, second.ID)
	}
	if second.Mapping["col_b"] != "FNAME" || second.Mapping["col_a"] != nil {
		t.Errorf("mapping not overwritten on upsert: %+v", second.Mapping)
	}
	if second.SourceHint != "updated" {
		t.Errorf("source_hint not overwritten: %q", second.SourceHint)
	}

	// Only one row should exist for the name.
	list, err := r.ListImportTemplates(ctx, tenantID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	count := 0
	for _, tm := range list {
		if tm.Name == name {
			count++
		}
	}
	if count != 1 {
		t.Errorf("found %d rows for name %q, want 1", count, name)
	}
}

// TestListImportTemplates_NewestFirstAndTenantScoped — listing returns the
// tenant's templates newest-first and never leaks another tenant's rows.
func TestListImportTemplates_NewestFirstAndTenantScoped(t *testing.T) {
	pool := newImportTemplatesTestPool(t)
	const tenantA = "00000000-0000-4000-8000-0109a2c41003"
	const tenantB = "00000000-0000-4000-8000-0109a2c41004"
	seedImportTemplateTenant(t, pool, tenantA)
	seedImportTemplateTenant(t, pool, tenantB)
	r := &Repo{Pool: pool}
	ctx := context.Background()

	suffix := time.Now().UnixNano()
	older := fmt.Sprintf("A-older-%d", suffix)
	newer := fmt.Sprintf("A-newer-%d", suffix)
	if _, err := r.SaveImportTemplate(ctx, tenantA, SaveImportTemplateInput{Name: older}); err != nil {
		t.Fatalf("save older: %v", err)
	}
	time.Sleep(5 * time.Millisecond)
	if _, err := r.SaveImportTemplate(ctx, tenantA, SaveImportTemplateInput{Name: newer}); err != nil {
		t.Fatalf("save newer: %v", err)
	}
	// Tenant B has its own template that must NOT appear in A's listing.
	bName := fmt.Sprintf("B-only-%d", suffix)
	if _, err := r.SaveImportTemplate(ctx, tenantB, SaveImportTemplateInput{Name: bName}); err != nil {
		t.Fatalf("save B: %v", err)
	}

	listA, err := r.ListImportTemplates(ctx, tenantA)
	if err != nil {
		t.Fatalf("list A: %v", err)
	}
	// Find the relative order of older/newer among A's results.
	idxOlder, idxNewer := -1, -1
	for i, tm := range listA {
		switch tm.Name {
		case older:
			idxOlder = i
		case newer:
			idxNewer = i
		case bName:
			t.Errorf("tenant A listing leaked tenant B template %q", bName)
		}
	}
	if idxOlder == -1 || idxNewer == -1 {
		t.Fatalf("missing seeded templates in A listing: older=%d newer=%d", idxOlder, idxNewer)
	}
	if idxNewer >= idxOlder {
		t.Errorf("newest-first violated: newer at %d, older at %d", idxNewer, idxOlder)
	}
}

// TestDeleteImportTemplate_RemovesAndNotFound — delete removes the row;
// deleting an unknown id returns ErrNotFound.
func TestDeleteImportTemplate_RemovesAndNotFound(t *testing.T) {
	pool := newImportTemplatesTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0109a2c41005"
	seedImportTemplateTenant(t, pool, tenantID)
	r := &Repo{Pool: pool}
	ctx := context.Background()

	tmpl, err := r.SaveImportTemplate(ctx, tenantID, SaveImportTemplateInput{
		Name: fmt.Sprintf("ToDelete-%d", time.Now().UnixNano()),
	})
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := r.DeleteImportTemplate(ctx, tenantID, tmpl.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	// Second delete of the same id is a not-found.
	if err := r.DeleteImportTemplate(ctx, tenantID, tmpl.ID); err != ErrNotFound {
		t.Errorf("re-delete err = %v, want ErrNotFound", err)
	}
	// Unknown id is a not-found.
	if err := r.DeleteImportTemplate(ctx, tenantID, "00000000-0000-4000-8000-000000000999"); err != ErrNotFound {
		t.Errorf("unknown-id delete err = %v, want ErrNotFound", err)
	}
}
