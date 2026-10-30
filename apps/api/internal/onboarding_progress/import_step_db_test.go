// SPDX-License-Identifier: AGPL-3.0-only
package onboarding_progress

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// "Bulk-import subscribers from CSV" never completed. The probe asked for
// subscriber_imports.status IN ('committed','succeeded'); neither value is
// allowed by subscriber_imports_status_check, and a finished import is 'ready'.

func seedImportAt(t *testing.T, pool *db.Pool, tenantID, status string, rowsImported int) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("import seed tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id := uuid.NewString()
	var errorCode, errorText any
	if status == "failed" {
		errorCode, errorText = "chunk_failed", "An atomic import batch failed and was rolled back."
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_imports (
    id, tenant_id, object_key, original_filename, mapping, status,
    rows_total, processed_rows, rows_imported, error_code, error
) VALUES (
    $1::uuid, $2::uuid, $3, 'contacts.csv',
    '{"headers":["email"],"columns":[{"index":0,"name":"email","kind":"email"}],"rows":3}'::jsonb,
    $4, 3, $5, $5, $6, $7
)`, id, tenantID, "imports/"+id+".csv", status, rowsImported, errorCode, errorText); err != nil {
		t.Fatalf("seed %s import: %v", status, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit %s import: %v", status, err)
	}
	t.Cleanup(func() {
		cleanup, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(context.Background()) }()
		if _, err := cleanup.Exec(context.Background(),
			`DELETE FROM subscriber_imports WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id); err == nil {
			_ = cleanup.Commit(context.Background())
		}
	})
}

// bulkImportStepCompleted reads the checklist through the mounted route, as the
// dashboard does, and returns the import step's done-ness.
func bulkImportStepCompleted(t *testing.T, router http.Handler, tenantID string) bool {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/onboarding-progress", nil)
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID, Slug: "acme", Tier: "studio"})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: uuid.NewString(), TenantID: tenantID, Role: "owner"})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req.WithContext(ctx))
	if rec.Code != http.StatusOK {
		t.Fatalf("onboarding progress status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Steps []Step `json:"steps"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode onboarding progress: %v", err)
	}
	for _, step := range body.Steps {
		if step.Key == "uploaded_subscribers_bulk" {
			return step.Completed
		}
	}
	t.Fatalf("uploaded_subscribers_bulk missing from %s", rec.Body.String())
	return false
}

func TestBulkImportStepCompletesOnlyForAFinishedImportThatWroteContacts(t *testing.T) {
	pool := newStepStatePool(t)
	tenantID := seedStepStateTenant(t, pool)
	router := chi.NewRouter()
	MountRoutes(router, &Deps{Pool: pool})

	if bulkImportStepCompleted(t, router, tenantID) {
		t.Fatal("import step completed for a workspace with no imports")
	}
	// Nothing that stopped short of writing contacts counts.
	seedImportAt(t, pool, tenantID, "preview", 0)
	seedImportAt(t, pool, tenantID, "failed", 0)
	seedImportAt(t, pool, tenantID, "cancelled", 0)
	seedImportAt(t, pool, tenantID, "ready", 0)
	if bulkImportStepCompleted(t, router, tenantID) {
		t.Fatal("import step completed although no import wrote a contact")
	}

	seedImportAt(t, pool, tenantID, "ready", 3)
	if !bulkImportStepCompleted(t, router, tenantID) {
		t.Fatal("import step stayed incomplete after a finished import wrote 3 contacts")
	}
}

// A probe that errors must not take the probes after it down with it: they
// share one transaction, which PostgreSQL aborts at the first error.
func TestOneFailingProbeDoesNotHideLaterCompletedSteps(t *testing.T) {
	pool := newStepStatePool(t)
	tenantID := seedStepStateTenant(t, pool)
	seedImportAt(t, pool, tenantID, "ready", 3)

	original := checklist
	t.Cleanup(func() { checklist = original })
	broken := stepDef{
		key: "broken_probe", label: "Broken", description: "A probe against a table this deploy lacks.",
		check: `SELECT EXISTS (SELECT 1 FROM onboarding_table_that_does_not_exist WHERE tenant_id = $1::uuid)`,
	}
	checklist = append([]stepDef{broken}, original...)

	router := chi.NewRouter()
	MountRoutes(router, &Deps{Pool: pool})
	if !bulkImportStepCompleted(t, router, tenantID) {
		t.Fatal("a failing earlier probe reported the completed import step as not done")
	}
}
