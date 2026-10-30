// SPDX-License-Identifier: AGPL-3.0-only
//
// import_templates_handlers_test.go — HTTP-surface coverage for SUB-109.
//
// The no-tenant / validation gates are exercised without a database (they
// short-circuit before any pool access). The happy-path round-trips
// (save -> list -> delete -> 404) are pg-backed and skip cleanly without
// DATABASE_URL.

package subscribers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// --- gate / validation tests (no DB) ---

func TestSaveImportTemplate_NoTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/subscriber-import-templates",
		strings.NewReader(`{"name":"x"}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	d.SaveImportTemplate(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestSaveImportTemplate_MissingName(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/subscriber-import-templates",
		strings.NewReader(`{"name":"   ","mapping":{}}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.SaveImportTemplate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "missing_name") {
		t.Errorf("body = %s, want missing_name", w.Body.String())
	}
}

func TestSaveImportTemplate_InvalidJSON(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/subscriber-import-templates",
		strings.NewReader(`{not json`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.SaveImportTemplate(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "bad_json") {
		t.Errorf("body = %s, want bad_json", w.Body.String())
	}
}

func TestListImportTemplates_NoTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/subscriber-import-templates", nil)
	w := httptest.NewRecorder()
	d.ListImportTemplates(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestDeleteImportTemplate_NoTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("DELETE", "/api/v1/subscriber-import-templates/abc", nil)
	w := httptest.NewRecorder()
	d.DeleteImportTemplate(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// importTemplateRequest builds a tenant-scoped request routed through a chi
// mux so chi.URLParam("id") resolves on the DELETE path.
func importTemplateRouter(d *Deps) *chi.Mux {
	mux := chi.NewRouter()
	mux.Post("/api/v1/subscriber-import-templates", d.SaveImportTemplate)
	mux.Get("/api/v1/subscriber-import-templates", d.ListImportTemplates)
	mux.Delete("/api/v1/subscriber-import-templates/{id}", d.DeleteImportTemplate)
	return mux
}

func tenantReqWithID(method, path, body, tenantID string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	return r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: tenantID}))
}

// --- pg-backed end-to-end round-trip ---

// TestImportTemplates_HTTPRoundTrip — POST creates (201), GET lists it,
// DELETE removes it (204), and a second DELETE 404s.
func TestImportTemplates_HTTPRoundTrip(t *testing.T) {
	pool := newImportTemplatesTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0109b2c41001"
	seedImportTemplateTenant(t, pool, tenantID)
	d := &Deps{Repo: &Repo{Pool: pool}}
	mux := importTemplateRouter(d)

	name := fmt.Sprintf("E2E %d", time.Now().UnixNano())

	// POST
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, tenantReqWithID("POST", "/api/v1/subscriber-import-templates",
		fmt.Sprintf(`{"name":%q,"mapping":{"Email":"email"},"source_hint":"CRM"}`, name), tenantID))
	if w.Code != http.StatusCreated {
		t.Fatalf("POST status = %d, want 201 (body=%s)", w.Code, w.Body.String())
	}
	var created ImportTemplate
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create: %v (body=%s)", err, w.Body.String())
	}
	if created.ID == "" || created.Mapping["Email"] != "email" {
		t.Fatalf("unexpected created template: %+v", created)
	}

	// GET (list) — must contain the new template.
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, tenantReqWithID("GET", "/api/v1/subscriber-import-templates", "", tenantID))
	if w.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want 200", w.Code)
	}
	var listResp struct {
		Items []ImportTemplate `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &listResp); err != nil {
		t.Fatalf("decode list: %v (body=%s)", err, w.Body.String())
	}
	found := false
	for _, tm := range listResp.Items {
		if tm.ID == created.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("created template %s not in list", created.ID)
	}

	// DELETE — 204.
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, tenantReqWithID("DELETE", "/api/v1/subscriber-import-templates/"+created.ID, "", tenantID))
	if w.Code != http.StatusNoContent {
		t.Fatalf("DELETE status = %d, want 204 (body=%s)", w.Code, w.Body.String())
	}

	// Second DELETE — 404.
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, tenantReqWithID("DELETE", "/api/v1/subscriber-import-templates/"+created.ID, "", tenantID))
	if w.Code != http.StatusNotFound {
		t.Fatalf("re-DELETE status = %d, want 404 (body=%s)", w.Code, w.Body.String())
	}
}
