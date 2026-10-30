// segment_folders_test.go — SUB-040. Covers the folder-CRUD handler
// guard paths that do not require a DB (tenant guard + name validation +
// JSON contract). The repo methods themselves need Postgres and are
// exercised by the integration suite.
package segments

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// withFolderID injects {id} into the chi route context so a handler that
// reads chi.URLParam(r, "id") sees it without a full router.
func withFolderID(req *http.Request, id string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

func TestListFoldersRequiresTenant(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/segment-folders", nil)
	rec := httptest.NewRecorder()

	deps.ListFolders(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

func TestCreateFolderRequiresTenant(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/segment-folders", strings.NewReader(`{"name":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.CreateFolder(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

// TestCreateFolderRejectsBlankName: a whitespace-only name is rejected
// with 400 missing_name before the handler touches the (nil) repo.
func TestCreateFolderRejectsBlankName(t *testing.T) {
	deps := &Deps{}
	req := withTenantCtx(httptest.NewRequest(http.MethodPost, "/api/v1/segment-folders", strings.NewReader(`{"name":"   "}`)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.CreateFolder(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "missing_name") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// TestPatchFolderRejectsBlankName: a present-but-blank name on PATCH is
// rejected with 400 missing_name before the repo call. The {id} param is
// injected so the handler clears the missing_id guard first.
func TestPatchFolderRejectsBlankName(t *testing.T) {
	deps := &Deps{}
	req := withTenantCtx(withFolderID(httptest.NewRequest(http.MethodPatch, "/api/v1/segment-folders/abc", strings.NewReader(`{"name":""}`)), "abc"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.PatchFolder(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "missing_name") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// TestPatchFolderMissingID: no {id} param → 400 missing_id before any
// body decode / repo access.
func TestPatchFolderMissingID(t *testing.T) {
	deps := &Deps{}
	req := withTenantCtx(httptest.NewRequest(http.MethodPatch, "/api/v1/segment-folders/", strings.NewReader(`{"name":"x"}`)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.PatchFolder(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "missing_id") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// TestPatchFolderRequiresTenant: the up-front no_tenant guard fires.
func TestPatchFolderRequiresTenant(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/segment-folders/abc", strings.NewReader(`{"name":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.PatchFolder(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

// TestSegmentFolderJSONShape pins the wire contract the folder selector
// dropdown reads.
func TestSegmentFolderJSONShape(t *testing.T) {
	f := SegmentFolder{ID: "f-1", TenantID: "t-1", Name: "Lifecycle"}
	buf, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(buf, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if m["name"] != "Lifecycle" {
		t.Fatalf("name not carried: %s", buf)
	}
	if m["id"] != "f-1" {
		t.Fatalf("id not carried: %s", buf)
	}
}
