// SPDX-License-Identifier: AGPL-3.0-only
package handlers

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// The Go-served portal and the nginx-served portal must answer the same URL the
// same way. nginx uses `try_files $uri =404`, so a request for the asset
// DIRECTORY 404s; http.FileServer instead rendered a browsable index of every
// built file. The build's own reasoning (vite.config.ts) names an artifact
// index as the way a hidden source map stops needing a guessed content hash,
// so this is the disagreement that matters.
func TestServeAssetRefusesDirectoryListing(t *testing.T) {
	spaDir := t.TempDir()
	assets := filepath.Join(spaDir, "assets")
	if err := os.MkdirAll(assets, 0o755); err != nil {
		t.Fatal(err)
	}
	bundle := filepath.Join(assets, "index-8ulLr-4Y.js")
	if err := os.WriteFile(bundle, []byte("console.log(1)\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bundle+".map", []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	h := &AuditPortalHandlers{SPADir: spaDir}
	router := chi.NewRouter()
	router.Get("/portal/audit/assets/*", h.ServeAsset)

	for _, path := range []string{"/portal/audit/assets/", "/portal/audit/assets"} {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code == http.StatusOK {
			t.Fatalf("GET %s returned 200 with body %q — the asset index is browsable", path, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "index-8ulLr-4Y.js") {
			t.Fatalf("GET %s enumerated bundle filenames: %s", path, w.Body.String())
		}
	}

	// The files themselves must still be served, or the fix broke the portal.
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/portal/audit/assets/index-8ulLr-4Y.js", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("asset fetch status = %d, want 200", w.Code)
	}
	if !strings.Contains(w.Body.String(), "console.log(1)") {
		t.Fatalf("asset body = %q", w.Body.String())
	}
}
