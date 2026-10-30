// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/forms"
)

// Production has no local upload store (uploads go to S3), yet routeauth
// refuses to boot when a manifest route is not mounted. So the dev-only PUT is
// mounted everywhere and answers 404 when there is no store.
func TestLocalUploadPutAnswers404WithoutALocalStore(t *testing.T) {
	rec := httptest.NewRecorder()
	localUploadPutHandler(nil)(rec, httptest.NewRequest(http.MethodPut, "/api/internal/uploads/k", strings.NewReader("x")))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("PUT without a local store answered %d, want 404", rec.Code)
	}
}

func TestLocalUploadPutReachesTheLocalStoreWhenPresent(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	store, err := forms.NewLocalUploadStore("http://localhost:8080")
	if err != nil {
		t.Fatalf("NewLocalUploadStore: %v", err)
	}
	rec := httptest.NewRecorder()
	// No signed size: the store itself rejects it with 400 bad_size, which
	// proves the request reached ServePut rather than the 404 fallback.
	localUploadPutHandler(store)(rec, httptest.NewRequest(http.MethodPut, "/api/internal/uploads/k", strings.NewReader("x")))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "bad_size") {
		t.Fatalf("PUT with a local store answered %d %q, want the store's 400 bad_size", rec.Code, rec.Body.String())
	}
}

// The mount must not become conditional again: a production-shaped boot (S3
// uploads, no local store) would then fail route-authorization validation with
// "manifest route PUT /api/internal/uploads/{key} is not mounted".
func TestLocalUploadPutIsMountedUnconditionally(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	mount := `r.Put("/api/internal/uploads/{key:.+}", observability.RecordSurfaceFunc("forms", "upload_put", localUploadPutHandler(localUploadStore)))`
	if strings.Count(text, mount) != 1 {
		t.Fatalf("main.go must mount the local upload PUT exactly once through localUploadPutHandler")
	}
	if regexp.MustCompile(`if\s+localUploadStore\s*!=\s*nil`).MatchString(text) {
		t.Fatalf("main.go gates the local upload PUT on the store again; mount it unconditionally")
	}
}
