// saved_segments_test.go — SUB-030: aggregate segment-count preview in
// the builder. Covers the workspace-percentage helper + the GET
// /segments/saved/{id}/preview handler guard paths that do not require a
// DB (the aggregate projection itself needs Postgres and is exercised
// by the integration suite).
package segments

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestWorkspacePercentage(t *testing.T) {
	cases := []struct {
		name  string
		count int
		total int
		want  float64
	}{
		{"empty workspace", 0, 0, 0},
		{"zero match", 0, 100, 0},
		{"quarter", 25, 100, 25},
		{"one decimal rounding", 1, 3, 33.3},
		{"rounds up", 2, 3, 66.7},
		{"all", 50, 50, 100},
		{"tiny fraction", 1, 10000, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := workspacePercentage(tc.count, tc.total)
			if got != tc.want {
				t.Fatalf("workspacePercentage(%d,%d) = %v, want %v", tc.count, tc.total, got, tc.want)
			}
		})
	}
}

func TestPreviewSavedDetailRequiresTenant(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/segments/saved/abc/preview", nil)
	rec := httptest.NewRecorder()

	deps.PreviewSavedDetail(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}

func TestPreviewSavedDetailMissingID(t *testing.T) {
	// Tenant present but no {id} URL param → 400 missing_id (handler bails
	// before touching the DB).
	deps := &Deps{}
	req := withTenantCtx(httptest.NewRequest(http.MethodGet, "/api/v1/segments/saved//preview", nil))
	rec := httptest.NewRecorder()

	deps.PreviewSavedDetail(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

// TestSavedSegmentPreviewShape pins the aggregate-only JSON contract the
// SavedSegmentDropdown reads. Subscriber IDs and emails are deliberately absent.
func TestSavedSegmentPreviewShape(t *testing.T) {
	generatedAt := time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC)
	p := SavedSegmentPreview{
		ID:                  "seg-1",
		Count:               12,
		WorkspaceTotal:      100,
		WorkspacePercentage: 12,
		GeneratedAt:         generatedAt,
	}
	buf, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	body := string(buf)
	if !strings.Contains(body, `"generated_at":"2026-07-18T12:00:00Z"`) {
		t.Fatalf("generated_at missing: %s", body)
	}
	for _, forbidden := range []string{"sample_profiles", "email", "subscriber_id"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("aggregate preview leaked %q: %s", forbidden, body)
		}
	}
}

func TestSavedSegmentTextValidation(t *testing.T) {
	if code, _ := validateSavedSegmentText("", ""); code != "missing_name" {
		t.Fatalf("empty name code = %q", code)
	}
	if code, _ := validateSavedSegmentText(strings.Repeat("x", 121), ""); code != "name_too_long" {
		t.Fatalf("long name code = %q", code)
	}
	if code, _ := validateSavedSegmentText("safe\nname", ""); code != "invalid_text" {
		t.Fatalf("control name code = %q", code)
	}
	if code, _ := validateSavedSegmentText("safe", "line one\nline two"); code != "" {
		t.Fatalf("multiline description code = %q", code)
	}
}

/* ---------------- SUB-040: sharing / pinning / folders -------------- */

// TestValidSavedScope pins the accepted visibility_scope vocabulary.
func TestValidSavedScope(t *testing.T) {
	cases := map[string]bool{
		"personal":  true,
		"workspace": true,
		"":          false,
		"public":    false,
		"PERSONAL":  false,
	}
	for in, want := range cases {
		if got := validSavedScope(in); got != want {
			t.Fatalf("validSavedScope(%q) = %v, want %v", in, got, want)
		}
	}
}

// TestCreateSavedRejectsBadScope: an unknown visibility_scope is
// rejected with 400 bad_scope BEFORE the handler touches the (nil) repo.
func TestCreateSavedRejectsBadScope(t *testing.T) {
	deps := &Deps{}
	body := `{"name":"vip","predicate_json":{"filters":{}},"visibility_scope":"public"}`
	req := withTenantCtx(httptest.NewRequest(http.MethodPost, "/api/v1/segments/saved", strings.NewReader(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.CreateSaved(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "bad_scope") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestCreatePersonalSavedRequiresAttributableUser(t *testing.T) {
	deps := &Deps{}
	body := `{"name":"vip","predicate_json":{"filters":{}},"visibility_scope":"personal"}`
	req := withTenantCtx(httptest.NewRequest(http.MethodPost, "/api/v1/segments/saved", strings.NewReader(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.CreateSaved(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "personal_scope_requires_user") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// TestPatchSavedRejectsBadScope: same guard on the PATCH surface.
func TestPatchSavedRejectsBadScope(t *testing.T) {
	deps := &Deps{}
	body := `{"visibility_scope":"team"}`
	req := withTenantCtx(httptest.NewRequest(http.MethodPatch, "/api/v1/segments/saved/abc", strings.NewReader(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.PatchSaved(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "bad_scope") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// TestCreateSavedRequiresTenant: the up-front no_tenant guard fires
// before any body decode / repo access.
func TestCreateSavedRequiresTenant(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/segments/saved", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.CreateSaved(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

// TestSavedSegmentOrganizerFieldsJSON pins the wire contract the
// segment-organizer UI reads/writes (is_pinned, pin_order,
// visibility_scope, created_by_user_id, folder_id).
func TestSavedSegmentOrganizerFieldsJSON(t *testing.T) {
	order := 2
	uid := "u-1"
	fid := "f-1"
	s := SavedSegment{
		ID:              "seg-1",
		Name:            "vip",
		IsPinned:        true,
		PinOrder:        &order,
		VisibilityScope: SavedScopeWorkspace,
		CreatedByUserID: &uid,
		FolderID:        &fid,
	}
	buf, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(buf, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if m["is_pinned"] != true {
		t.Fatalf("is_pinned not serialized: %s", buf)
	}
	if m["visibility_scope"] != "workspace" {
		t.Fatalf("visibility_scope = %v, want workspace; %s", m["visibility_scope"], buf)
	}
	if m["pin_order"].(float64) != 2 {
		t.Fatalf("pin_order = %v, want 2; %s", m["pin_order"], buf)
	}
	if m["folder_id"] != "f-1" {
		t.Fatalf("folder_id = %v; %s", m["folder_id"], buf)
	}
	if m["created_by_user_id"] != "u-1" {
		t.Fatalf("created_by_user_id = %v; %s", m["created_by_user_id"], buf)
	}
}

// TestSavedSegmentOmitsNilOrganizerPointers: nil pointer fields drop out
// of the JSON (omitempty), keeping the legacy payload compact.
func TestSavedSegmentOmitsNilOrganizerPointers(t *testing.T) {
	s := SavedSegment{ID: "seg-1", Name: "legacy", VisibilityScope: SavedScopePersonal}
	buf, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	body := string(buf)
	for _, k := range []string{"pin_order", "created_by_user_id", "folder_id"} {
		if strings.Contains(body, k) {
			t.Fatalf("nil %s should be omitted: %s", k, body)
		}
	}
	// is_pinned + visibility_scope are non-omitempty scalars, always present.
	if !strings.Contains(body, "is_pinned") || !strings.Contains(body, "visibility_scope") {
		t.Fatalf("required organizer scalars missing: %s", body)
	}
}

// TestSavedSegmentPatchFolderIDDecoding documents the *string folder_id
// patch contract: omitted OR null → nil pointer (leave unchanged); ""
// → unfile; "<id>" → re-file. (encoding/json maps a literal null to a
// nil pointer, so null and omission collapse to "leave unchanged".)
func TestSavedSegmentPatchFolderIDDecoding(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantSet bool   // FolderID pointer non-nil
		wantVal string // *FolderID when set
	}{
		{"omitted", `{"name":"x"}`, false, ""},
		{"explicit null", `{"folder_id":null}`, false, ""},
		{"empty string (unfile)", `{"folder_id":""}`, true, ""},
		{"string id (re-file)", `{"folder_id":"f-9"}`, true, "f-9"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var p SavedSegmentPatch
			if err := json.Unmarshal([]byte(tc.body), &p); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if (p.FolderID != nil) != tc.wantSet {
				t.Fatalf("FolderID set = %v, want %v", p.FolderID != nil, tc.wantSet)
			}
			if tc.wantSet && *p.FolderID != tc.wantVal {
				t.Fatalf("folder_id = %q, want %q", *p.FolderID, tc.wantVal)
			}
		})
	}
}

/* ---------------- SUB-084: saved segment row counts ----------------- */

// TestSavedSegmentCountFieldsJSON pins the wire contract the
// SavedSegmentsManager count badge reads: last_count + last_evaluated_at
// are serialized when populated.
func TestSavedSegmentCountFieldsJSON(t *testing.T) {
	count := 123
	at := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	s := SavedSegment{
		ID:              "seg-1",
		Name:            "vip",
		VisibilityScope: SavedScopePersonal,
		LastCount:       &count,
		LastEvaluatedAt: &at,
	}
	buf, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(buf, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if m["last_count"].(float64) != 123 {
		t.Fatalf("last_count = %v, want 123; %s", m["last_count"], buf)
	}
	if _, ok := m["last_evaluated_at"]; !ok {
		t.Fatalf("last_evaluated_at missing when set: %s", buf)
	}
}

// TestSavedSegmentCountFieldsOmittedWhenNil: a never-evaluated bookmark
// drops last_count / last_evaluated_at (omitempty) so the badge can branch
// on absence to render "—" without a sentinel zero.
func TestSavedSegmentCountFieldsOmittedWhenNil(t *testing.T) {
	s := SavedSegment{ID: "seg-1", Name: "cold", VisibilityScope: SavedScopePersonal}
	buf, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	body := string(buf)
	for _, k := range []string{"last_count", "last_evaluated_at"} {
		if strings.Contains(body, k) {
			t.Fatalf("nil %s should be omitted: %s", k, body)
		}
	}
}
