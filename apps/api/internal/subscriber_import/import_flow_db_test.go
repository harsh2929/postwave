// SPDX-License-Identifier: AGPL-3.0-only
//
// import_flow_db_test.go — drives a CSV import the way the dashboard does:
// upload through the mounted routes, review the exhaustive preflight, confirm,
// then let the real worker claim and execute it, all as the RLS-bound
// application role. Row outcomes are asserted in the database, not in the
// handlers' own summaries.

package subscriber_import

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// memoryImportStorage is the object store behind a whole import: Preview puts
// the upload, the preflight and the worker open it, the purge deletes it.
type memoryImportStorage struct {
	mu      sync.Mutex
	objects map[string][]byte
	deletes map[string]int
}

func newMemoryImportStorage() *memoryImportStorage {
	return &memoryImportStorage{objects: map[string][]byte{}, deletes: map[string]int{}}
}

func (s *memoryImportStorage) Put(_ context.Context, key, _ string, body []byte) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = append([]byte(nil), body...)
	return "", nil
}

func (s *memoryImportStorage) Open(_ context.Context, key string) (io.ReadCloser, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	body, ok := s.objects[key]
	if !ok {
		return nil, "", errors.New("object not found")
	}
	return io.NopCloser(bytes.NewReader(body)), "text/csv", nil
}

func (s *memoryImportStorage) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.objects, key)
	s.deletes[key]++
	return nil
}

func (s *memoryImportStorage) deleteCount(key string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.deletes[key]
}

// importFlow is one tenant's wizard session against the mounted routes.
type importFlow struct {
	t        *testing.T
	app      *pgxpool.Pool
	admin    *pgxpool.Pool
	tenantID string
	storage  *memoryImportStorage
	router   chi.Router
}

func newImportFlow(t *testing.T) *importFlow {
	t.Helper()
	app, admin := subscriberImportDBPools(t)
	t.Setenv("POSTWAVE_SUBSCRIBER_IMPORT_FINGERPRINT_KEY_VERSION", "v1")
	t.Setenv("POSTWAVE_SUBSCRIBER_IMPORT_FINGERPRINT_KEY", strings.Repeat("k", 32))
	t.Setenv("POSTWAVE_SUBSCRIBER_IMPORT_FINGERPRINT_KEYS", "")
	flow := &importFlow{
		t: t, app: app, admin: admin,
		tenantID: seedImportTenant(t, admin),
		storage:  newMemoryImportStorage(),
		router:   chi.NewRouter(),
	}
	MountRoutes(flow.router, &Deps{Pool: app, Storage: flow.storage})
	return flow
}

func (f *importFlow) setCustomFieldsMode(mode string) {
	f.t.Helper()
	if _, err := f.admin.Exec(context.Background(),
		`UPDATE tenants SET custom_fields_mode = $2 WHERE id = $1::uuid`, f.tenantID, mode); err != nil {
		f.t.Fatalf("set custom_fields_mode=%s: %v", mode, err)
	}
}

func (f *importFlow) serve(method, path, contentType string, body io.Reader) *httptest.ResponseRecorder {
	f.t.Helper()
	req := httptest.NewRequest(method, path, body)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: f.tenantID})
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID: uuid.NewString(), TenantID: f.tenantID, Email: "owner@example.test", Role: "owner",
	})
	rec := httptest.NewRecorder()
	f.router.ServeHTTP(rec, req.WithContext(ctx))
	return rec
}

func (f *importFlow) serveJSON(method, path, body string) *httptest.ResponseRecorder {
	f.t.Helper()
	return f.serve(method, path, "application/json", strings.NewReader(body))
}

// upload posts the CSV exactly as the wizard's file input does.
func (f *importFlow) upload(filename, csvBody string) previewResponse {
	f.t.Helper()
	var buf bytes.Buffer
	form := multipart.NewWriter(&buf)
	part, err := form.CreateFormFile("file", filename)
	if err != nil {
		f.t.Fatal(err)
	}
	if _, err := part.Write([]byte(csvBody)); err != nil {
		f.t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		f.t.Fatal(err)
	}
	rec := f.serve(http.MethodPost, "/api/v1/subscriber-imports/preview", form.FormDataContentType(), &buf)
	if rec.Code != http.StatusOK {
		f.t.Fatalf("preview status=%d body=%s", rec.Code, rec.Body.String())
	}
	var preview previewResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &preview); err != nil {
		f.t.Fatalf("decode preview: %v", err)
	}
	return preview
}

func (f *importFlow) patch(importID, body string) *httptest.ResponseRecorder {
	f.t.Helper()
	return f.serveJSON(http.MethodPatch, "/api/v1/subscriber-imports/"+importID, body)
}

// preflight runs the exhaustive dry run the Review step renders.
func (f *importFlow) preflight(importID string) dryRunResults {
	f.t.Helper()
	rec := f.serveJSON(http.MethodPost, "/api/v1/subscriber-imports/"+importID+"/confirm", `{"dry_run":true}`)
	if rec.Code != http.StatusOK {
		f.t.Fatalf("preflight status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		DryRunResults dryRunResults `json:"dry_run_results"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		f.t.Fatalf("decode preflight: %v", err)
	}
	return body.DryRunResults
}

func (f *importFlow) confirm(importID string) *httptest.ResponseRecorder {
	f.t.Helper()
	return f.serveJSON(http.MethodPost, "/api/v1/subscriber-imports/"+importID+"/confirm", `{}`)
}

// execute lets the production worker claim this import and run it to its
// terminal state. Other due imports in a shared database are held locked for
// the duration of the claim so the claim query (FOR UPDATE SKIP LOCKED) can
// only return this one; none of their data is touched.
func (f *importFlow) execute(importID string) {
	f.t.Helper()
	ctx := context.Background()
	hold, err := f.admin.Begin(ctx)
	if err != nil {
		f.t.Fatal(err)
	}
	defer func() { _ = hold.Rollback(ctx) }()
	if _, err = hold.Exec(ctx, `
SELECT id FROM subscriber_imports
 WHERE id <> $1::uuid
   AND status IN ('queued','running','verification_queued','verification_running')
 FOR UPDATE SKIP LOCKED`, importID); err != nil {
		f.t.Fatalf("hold other imports: %v", err)
	}
	worker := &Worker{Pool: f.app, Storage: f.storage}
	job, err := worker.claimNextJob(ctx)
	if err != nil {
		f.t.Fatalf("claim import: %v", err)
	}
	if job == nil || job.ID != importID {
		f.t.Fatalf("claimed %+v, want import %s", job, importID)
	}
	_ = hold.Rollback(ctx)
	if err := worker.processJob(ctx, job); err != nil {
		f.t.Fatalf("process import: %v", err)
	}
}

type importOutcome struct {
	Status       string
	ErrorCode    string
	RowsImported int64
	RowsSkipped  int64
	RowsFailed   int64
}

func (f *importFlow) outcome(importID string) importOutcome {
	f.t.Helper()
	var out importOutcome
	if err := f.admin.QueryRow(context.Background(), `
SELECT status, COALESCE(error_code, ''), rows_imported, rows_skipped, rows_failed
  FROM subscriber_imports WHERE id = $1::uuid`, importID).
		Scan(&out.Status, &out.ErrorCode, &out.RowsImported, &out.RowsSkipped, &out.RowsFailed); err != nil {
		f.t.Fatalf("read import outcome: %v", err)
	}
	return out
}

// rowErrors reads the failures through the route the web's Done step calls.
func (f *importFlow) rowErrors(importID string) []rowErrorItem {
	f.t.Helper()
	rec := f.serve(http.MethodGet, "/api/v1/subscriber-imports/"+importID+"/errors", "", nil)
	if rec.Code != http.StatusOK {
		f.t.Fatalf("row errors status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Items []rowErrorItem `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		f.t.Fatalf("decode row errors: %v", err)
	}
	return body.Items
}

func (f *importFlow) subscriberCount(email string) int {
	f.t.Helper()
	var count int
	if err := f.admin.QueryRow(context.Background(), `
SELECT count(*) FROM subscribers WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)`,
		f.tenantID, email).Scan(&count); err != nil {
		f.t.Fatalf("count subscriber: %v", err)
	}
	return count
}

func dryRunRowByNumber(t *testing.T, results dryRunResults, rowNumber int64) dryRunRow {
	t.Helper()
	for _, row := range results.Rows {
		if row.RowNumber == rowNumber {
			return row
		}
	}
	t.Fatalf("preflight has no detail for row %d: %+v", rowNumber, results.Rows)
	return dryRunRow{}
}
