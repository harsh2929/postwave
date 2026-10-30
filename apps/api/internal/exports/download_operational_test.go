// SPDX-License-Identifier: AGPL-3.0-only

package exports

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type downloadStorageStub struct {
	opened      []string
	stated      []string
	body        string
	contentType string
	storedSize  int64
	storedSHA   string
}

func (*downloadStorageStub) Put(context.Context, string, string, io.Reader, int64, string) error {
	return nil
}

func (s *downloadStorageStub) Open(_ context.Context, key string) (io.ReadCloser, string, int64, string, error) {
	s.opened = append(s.opened, key)
	contentType := s.contentType
	if contentType == "" {
		contentType = "application/zip"
	}
	storedSize := s.storedSize
	if storedSize == 0 {
		storedSize = int64(len(s.body))
	}
	return io.NopCloser(strings.NewReader(s.body)), contentType, storedSize, s.storedSHA, nil
}

func (s *downloadStorageStub) Stat(_ context.Context, key string) (string, int64, string, error) {
	s.stated = append(s.stated, key)
	contentType := s.contentType
	if contentType == "" {
		contentType = "application/zip"
	}
	storedSize := s.storedSize
	if storedSize == 0 {
		storedSize = int64(len(s.body))
	}
	return contentType, storedSize, s.storedSHA, nil
}

func (*downloadStorageStub) Delete(context.Context, string) error { return nil }

func TestDownloadRechecksTenantStatusExpiryAndPrivateHeaders(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping private export download operational test")
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
	leaseID := uuid.NewString()
	objectKey := "exports/" + tenantID + "/" + exportID + "/" + leaseID + ".zip"
	bundleSHA := testSHA256("zip")
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant(seed): %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'private-export-download', 'private-export-' || right($1::text, 12), 'studio')`, tenantID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO tenant_exports
  (id, tenant_id, status, include, object_key, bundle_sha256, bytes_total, rows_total, expires_at, completed_at)
VALUES
  ($1::uuid, $2::uuid, 'ready', '["consent"]'::jsonb, $3, $4, 3, 1, now() + interval '1 hour', now())`, exportID, tenantID, objectKey, bundleSHA); err != nil {
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

	storage := &downloadStorageStub{body: "zip", storedSHA: bundleSHA}
	deps := &Deps{Pool: pool, Storage: storage}

	response := invokeDownload(t, deps, tenantID, exportID, http.MethodGet)
	if response.Code != http.StatusOK || response.Body.String() != "zip" {
		t.Fatalf("download = %d %q", response.Code, response.Body.String())
	}
	for name, want := range map[string]string{
		"Cache-Control":                "private, no-store, max-age=0",
		"Content-Type":                 "application/zip",
		"Content-Length":               "3",
		"X-Content-Type-Options":       "nosniff",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Referrer-Policy":              "no-referrer",
	} {
		if got := response.Header().Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	if len(storage.opened) != 1 || storage.opened[0] != objectKey {
		t.Fatalf("opened keys = %#v", storage.opened)
	}

	head := invokeDownload(t, deps, tenantID, exportID, http.MethodHead)
	if head.Code != http.StatusOK || head.Body.Len() != 0 {
		t.Fatalf("HEAD = %d body=%q", head.Code, head.Body.String())
	}
	if len(storage.opened) != 1 || len(storage.stated) != 1 || storage.stated[0] != objectKey {
		t.Fatalf("HEAD opened the body or skipped metadata verification: opened=%#v stated=%#v", storage.opened, storage.stated)
	}

	storage.storedSHA = testSHA256("same-size-tampering")
	tampered := invokeDownload(t, deps, tenantID, exportID, http.MethodGet)
	if tampered.Code != http.StatusInternalServerError {
		t.Fatalf("digest-mismatched download = %d, want 500", tampered.Code)
	}
	storage.storedSHA = bundleSHA
	if len(storage.opened) != 2 {
		t.Fatalf("digest mismatch did not perform exactly one guarded open: %#v", storage.opened)
	}

	otherTenant := uuid.NewString()
	crossTenant := invokeDownload(t, deps, otherTenant, exportID, http.MethodGet)
	if crossTenant.Code != http.StatusNotFound {
		t.Fatalf("cross-tenant download = %d, want 404", crossTenant.Code)
	}
	if len(storage.opened) != 2 {
		t.Fatalf("cross-tenant request reached storage: %#v", storage.opened)
	}

	expire, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant(expire): %v", err)
	}
	if _, err := expire.Exec(ctx,
		`UPDATE tenant_exports SET expires_at = now() - interval '1 minute' WHERE id = $1::uuid`, exportID); err != nil {
		_ = expire.Rollback(ctx)
		t.Fatalf("expire export: %v", err)
	}
	if err := expire.Commit(ctx); err != nil {
		t.Fatalf("commit expiry: %v", err)
	}
	expired := invokeDownload(t, deps, tenantID, exportID, http.MethodGet)
	if expired.Code != http.StatusGone {
		t.Fatalf("expired download = %d, want 410", expired.Code)
	}
	if len(storage.opened) != 2 {
		t.Fatalf("expired request reached storage: %#v", storage.opened)
	}
}

func invokeDownload(t *testing.T, deps *Deps, tenantID, exportID, method string) *httptest.ResponseRecorder {
	t.Helper()
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("id", exportID)
	ctx := context.WithValue(context.Background(), chi.RouteCtxKey, routeContext)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
	request := httptest.NewRequest(method, "/api/v1/exports/"+exportID+"/download", nil).WithContext(ctx)
	response := httptest.NewRecorder()
	deps.Download(response, request)
	return response
}
