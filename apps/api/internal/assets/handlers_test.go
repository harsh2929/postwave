package assets

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func assetTenantRequest(contentType string, contentLength int64) *http.Request {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/v1/assets", strings.NewReader("{}"))
	req.Header.Set("Content-Type", contentType)
	req.ContentLength = contentLength
	return req
}

func TestUploadRejectsOversizedMultipartByContentLength(t *testing.T) {
	d := &Deps{}
	req := assetTenantRequest("multipart/form-data; boundary=x", assetMultipartMaxBodyBytes+1)
	rec := httptest.NewRecorder()
	d.Upload(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413 body=%s", rec.Code, rec.Body.String())
	}
}

func TestUploadRejectsOversizedJSONByContentLength(t *testing.T) {
	d := &Deps{}
	req := assetTenantRequest("application/json", assetJSONMaxBodyBytes+1)
	rec := httptest.NewRecorder()
	d.Upload(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413 body=%s", rec.Code, rec.Body.String())
	}
}

func TestUploadReturnsServiceUnavailableWhenRepoMissing(t *testing.T) {
	body := `{"filename":"logo.png","mime":"image/png","content_base64":"` + base64.StdEncoding.EncodeToString(minimalAssetPNG()) + `","expected_version":0}`
	req := assetTenantRequest("application/json", int64(len(body)))
	req.Body = http.NoBody
	req = httptest.NewRequestWithContext(req.Context(), http.MethodPost, "/api/v1/assets", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.ContentLength = int64(len(body))

	rec := httptest.NewRecorder()
	(&Deps{}).Upload(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "repo_unavailable") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestListReturnsServiceUnavailableWhenRepoMissing(t *testing.T) {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/v1/assets", nil)
	rec := httptest.NewRecorder()

	(&Deps{}).List(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "repo_unavailable") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

/* ---------- PATCH /api/v1/assets/{id} (PR 1) -------------------------- */

func patchRequest(body string) *http.Request {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, http.MethodPatch, "/api/v1/assets/abc",
		strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.ContentLength = int64(len(body))
	return req
}

func TestPatchRejectsUnknownField(t *testing.T) {
	// No repo configured — the validation gate must run first and 400 out
	// before we attempt any DB I/O.
	rec := httptest.NewRecorder()
	(&Deps{}).Patch(rec, patchRequest(`{"filename":"new.png"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "unknown_field") {
		t.Fatalf("expected unknown_field in body, got %s", rec.Body.String())
	}
}

func TestPatchRejectsOversizedAltText(t *testing.T) {
	big := strings.Repeat("x", 2000)
	rec := httptest.NewRecorder()
	(&Deps{}).Patch(rec, patchRequest(`{"alt_text":"`+big+`"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "alt_too_long") {
		t.Fatalf("expected alt_too_long in body, got %s", rec.Body.String())
	}
}

func TestPatchCountsAltTextCharactersNotUTF8Bytes(t *testing.T) {
	validUnicode := strings.Repeat("界", 1024)
	rec := httptest.NewRecorder()
	(&Deps{}).Patch(rec, patchRequest(`{"alt_text":"`+validUnicode+`","expected_version":1}`))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("1024 Unicode characters status = %d, want 503 after validation; body=%s", rec.Code, rec.Body.String())
	}

	tooLongUnicode := strings.Repeat("界", 1025)
	rec = httptest.NewRecorder()
	(&Deps{}).Patch(rec, patchRequest(`{"alt_text":"`+tooLongUnicode+`"}`))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "alt_too_long") {
		t.Fatalf("1025 Unicode characters status = %d, want alt_too_long; body=%s", rec.Code, rec.Body.String())
	}
}

func TestNormalizeTagPreservesMultilingualLettersAndMarks(t *testing.T) {
	for input, want := range map[string]string{
		"  Café Été  ": "café été",
		"हिंदी अभियान": "हिंदी अभियान",
		"東京 2026":      "東京 2026",
	} {
		if got := normalizeTag(input); got != want {
			t.Errorf("normalizeTag(%q)=%q, want %q", input, got, want)
		}
	}
}

func TestPatchAcceptsAltTextThenFails503WhenRepoMissing(t *testing.T) {
	// Validation should pass, then the handler should hit the repo-missing
	// guard and 503. This proves we don't reject benign inputs.
	rec := httptest.NewRecorder()
	(&Deps{}).Patch(rec, patchRequest(`{"alt_text":"hero image of spring sale","expected_version":1}`))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (validation passed, repo missing); body=%s",
			rec.Code, rec.Body.String())
	}
}

func TestPatchRejectsNonStringAltText(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Deps{}).Patch(rec, patchRequest(`{"alt_text": 42}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "bad_type") {
		t.Fatalf("expected bad_type in body, got %s", rec.Body.String())
	}
}

func TestPatchRequiresAltTextPresence(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Deps{}).Patch(rec, patchRequest(`{}`))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "missing_alt_text") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

/* ---------- DELETE / GetByID / GetUsage / List ------------------------- */

func TestDeleteReturns503WhenRepoMissing(t *testing.T) {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, http.MethodDelete, "/api/v1/assets/abc", nil)
	rec := httptest.NewRecorder()
	(&Deps{}).Delete(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503, body=%s", rec.Code, rec.Body.String())
	}
}

func TestListAcceptsNewQueryParams(t *testing.T) {
	// With repo missing this still 503s — but the assertion proves the
	// handler doesn't choke on the new query params before reaching the
	// repo guard.
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, http.MethodGet,
		"/api/v1/assets?q=spring&filter=in-use&sort=most-used&limit=25", nil)
	rec := httptest.NewRecorder()
	(&Deps{}).List(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (only repo missing should fail), body=%s",
			rec.Code, rec.Body.String())
	}
}

func TestListRejectsNonCanonicalCursorSortFilterAndFolderAtHTTPBoundary(t *testing.T) {
	tenantCtx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	validID := uuid.NewString()
	cases := []struct {
		name  string
		query string
		code  string
	}{
		{name: "cursor not uuid", query: "before=not-a-uuid", code: "invalid_cursor"},
		{name: "cursor not canonical", query: "before=" + strings.ToUpper(validID), code: "invalid_cursor"},
		{name: "unknown sort", query: "sort=popular", code: "invalid_sort"},
		{name: "unknown filter", query: "filter=orphaned", code: "invalid_filter"},
		{name: "folder not uuid", query: "folder_id=../../foreign", code: "invalid_folder"},
		{name: "folder root not canonical", query: "folder_id=ROOT", code: "invalid_folder"},
		{name: "folder not canonical", query: "folder_id=" + strings.ToUpper(validID), code: "invalid_folder"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequestWithContext(tenantCtx, http.MethodGet, "/api/v1/assets?"+tc.query, nil)
			rec := httptest.NewRecorder()
			(&Deps{}).List(rec, req)
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), tc.code) {
				t.Fatalf("status=%d body=%s, want 400/%s", rec.Code, rec.Body.String(), tc.code)
			}
		})
	}
}

func TestGetByIDReturns503WhenRepoMissing(t *testing.T) {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/v1/assets/abc", nil)
	rec := httptest.NewRecorder()
	(&Deps{}).GetByID(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503, body=%s", rec.Code, rec.Body.String())
	}
}

func TestGetUsageReturns503WhenRepoMissing(t *testing.T) {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/v1/assets/abc/usage", nil)
	rec := httptest.NewRecorder()
	(&Deps{}).GetUsage(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503, body=%s", rec.Code, rec.Body.String())
	}
}

func minimalAssetPNG() []byte {
	var buf bytes.Buffer
	_ = png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 10, 20)))
	return buf.Bytes()
}

type failingAssetInserter struct {
	asset Asset
	err   error
}

func (f *failingAssetInserter) Insert(_ context.Context, _ string, asset Asset) (*Asset, error) {
	f.asset = asset
	return nil, f.err
}

type recordingAssetStorage struct {
	putKey    string
	deleteKey string
}

type fakeCheckedAssetDeleter struct {
	count int
	refs  []Referrer
	err   error
	calls int
}

func (f *fakeCheckedAssetDeleter) DeleteChecked(_ context.Context, _ string, _ string, expectedVersion int64, _ bool) (int64, int, []Referrer, error) {
	f.calls++
	return expectedVersion, f.count, f.refs, f.err
}

func (s *recordingAssetStorage) Put(_ context.Context, key, _ string, _ []byte) (string, error) {
	s.putKey = key
	return "/api/v1/assets/placeholder/blob", nil
}

func (*recordingAssetStorage) Open(context.Context, string) (io.ReadCloser, string, error) {
	return nil, "", errors.New("unused")
}

func (s *recordingAssetStorage) Delete(_ context.Context, key string) error {
	s.deleteKey = key
	return nil
}

func TestUploadBytesUsesPreassignedIDAndCompensatesInsertFailure(t *testing.T) {
	insertErr := errors.New("commit failed")
	inserter := &failingAssetInserter{err: insertErr}
	storage := &recordingAssetStorage{}
	d := &Deps{Storage: storage, insertRepo: inserter}

	_, err := d.UploadBytes(context.Background(), "tenant", "wrong.svg", "image/svg+xml", minimalAssetPNG())
	if !errors.Is(err, insertErr) {
		t.Fatalf("error=%v, want insert failure", err)
	}
	if _, err := uuid.Parse(inserter.asset.ID); err != nil {
		t.Fatalf("preassigned ID %q is not UUID: %v", inserter.asset.ID, err)
	}
	if got, want := strings.SplitN(storage.putKey, "/", 2)[0], inserter.asset.ID; got != want {
		t.Fatalf("storage directory=%q, asset ID=%q", got, want)
	}
	if storage.deleteKey != storage.putKey {
		t.Fatalf("compensation deleted %q, want %q", storage.deleteKey, storage.putKey)
	}
	if inserter.asset.Filename != "wrong.png" {
		t.Fatalf("filename=%q, want canonical wrong.png", inserter.asset.Filename)
	}
}

func TestRepoInsertRejectsInvalidPreassignedIDBeforeDB(t *testing.T) {
	if _, err := (&Repo{}).Insert(context.Background(), "tenant", Asset{ID: "not-a-uuid"}); !errors.Is(err, ErrInvalidAssetID) {
		t.Fatalf("error=%v, want ErrInvalidAssetID", err)
	}
}

func TestDeleteReturnsAuthoritativeConflictInOneCall(t *testing.T) {
	const assetID = "00000000-0000-4000-8000-000000000001"
	deleter := &fakeCheckedAssetDeleter{
		count: 1,
		refs:  []Referrer{{Kind: "campaign", ID: "campaign-1", Name: "Launch"}},
		err:   ErrHasReferences,
	}
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "tenant"})
	req := httptest.NewRequestWithContext(ctx, http.MethodDelete, "/api/v1/assets/"+assetID, strings.NewReader(`{"expected_version":3}`))
	req.Header.Set("Content-Type", "application/json")
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", assetID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
	rec := httptest.NewRecorder()
	(&Deps{deleteRepo: deleter}).Delete(rec, req)

	if rec.Code != http.StatusConflict || deleter.calls != 1 {
		t.Fatalf("status=%d calls=%d body=%s", rec.Code, deleter.calls, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"code":"has_references"`) || !strings.Contains(rec.Body.String(), `"name":"Launch"`) {
		t.Fatalf("conflict omitted stable usage: %s", rec.Body.String())
	}
}

func TestDeleteFailsClosedWithoutLeakingRepositoryError(t *testing.T) {
	const assetID = "00000000-0000-4000-8000-000000000001"
	deleter := &fakeCheckedAssetDeleter{err: errors.New("postgres password and SQL detail")}
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "tenant"})
	req := httptest.NewRequestWithContext(ctx, http.MethodDelete, "/api/v1/assets/"+assetID, strings.NewReader(`{"expected_version":3}`))
	req.Header.Set("Content-Type", "application/json")
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", assetID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
	rec := httptest.NewRecorder()
	(&Deps{deleteRepo: deleter}).Delete(rec, req)

	if rec.Code != http.StatusInternalServerError || deleter.calls != 1 {
		t.Fatalf("status=%d calls=%d body=%s", rec.Code, deleter.calls, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "postgres") || strings.Contains(rec.Body.String(), "password") {
		t.Fatalf("raw repository error leaked: %s", rec.Body.String())
	}
}

func TestFolderAndTagBodiesRequireExactFieldsAndSafeLengths(t *testing.T) {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "tenant"})
	cases := []struct {
		name   string
		method string
		path   string
		body   string
		call   func(*Deps, http.ResponseWriter, *http.Request)
		code   string
	}{
		{"folder name missing", http.MethodPost, "/api/v1/assets/folders", `{}`, (*Deps).CreateFolder, "missing_name"},
		{"folder name too long unicode", http.MethodPost, "/api/v1/assets/folders", `{"name":"` + strings.Repeat("界", 129) + `","expected_version":0}`, (*Deps).CreateFolder, "invalid_name"},
		{"folder id missing", http.MethodPatch, "/api/v1/assets/id/folder", `{}`, (*Deps).MoveAsset, "missing_folder_id"},
		{"tag variants ambiguous", http.MethodPost, "/api/v1/assets/id/tags", `{"tag":"one","tags":["two"]}`, (*Deps).AddTags, "invalid_tag_body"},
		{"tag too long unicode", http.MethodPost, "/api/v1/assets/id/tags", `{"tag":"` + strings.Repeat("界", 65) + `","expected_version":1}`, (*Deps).AddTags, "invalid_tag"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequestWithContext(ctx, tc.method, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			routeCtx := chi.NewRouteContext()
			routeCtx.URLParams.Add("id", "00000000-0000-4000-8000-000000000001")
			req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
			rec := httptest.NewRecorder()
			tc.call(&Deps{}, rec, req)
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), tc.code) {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestEscapeLikePatternTreatsMetacharactersLiterally(t *testing.T) {
	if got, want := escapeLikePattern(`50%_off\today`), `50\%\_off\\today`; got != want {
		t.Fatalf("escapeLikePattern=%q, want %q", got, want)
	}
}
