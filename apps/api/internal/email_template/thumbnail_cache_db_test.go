// SPDX-License-Identifier: AGPL-3.0-only

package email_template

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// CACHE-08. A thumbnail is a picture of a tenant's own template served from
// a URL keyed by template id. It was marked `public, max-age=300,
// stale-while-revalidate=86400`, and its Vary header replaced the route's
// `Authorization, Cookie`: any shared cache in front of the API could hand one
// tenant's PNG to another, and an edited template showed a day-old picture.
// The route is driven here exactly as mounted: under the AuthRead policy.
func TestThumbnailResponsesArePrivateAndKeepTheRouteVaryDB(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping thumbnail cache-header integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	tenantID := thumbnailSecurityTenant(t, ctx, pool, "cache")
	templateID := thumbnailSecurityTemplate(t, ctx, pool, tenantID, "thumbnail-cache-"+strings.ReplaceAll(tenantID[:8], "-", ""))

	deps := &ThumbnailDeps{Pool: pool}
	router := chi.NewRouter()
	router.With(httpcache.WithPolicy(httpcache.AuthRead())).
		Get("/api/v1/templates/{id}/thumbnail.png", deps.Serve)

	get := func(ifNoneMatch string) *httptest.ResponseRecorder {
		req := httptest.NewRequestWithContext(
			middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID}),
			http.MethodGet, "/api/v1/templates/"+templateID+"/thumbnail.png", nil)
		if ifNoneMatch != "" {
			req.Header.Set("If-None-Match", ifNoneMatch)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	assertPrivate := func(label string, rec *httptest.ResponseRecorder) {
		t.Helper()
		cacheControl := rec.Header().Get("Cache-Control")
		if !strings.HasPrefix(cacheControl, "private") || strings.Contains(cacheControl, "public") {
			t.Fatalf("%s Cache-Control = %q, want private", label, cacheControl)
		}
		if m := regexp.MustCompile(`max-age=(\d+)`).FindStringSubmatch(cacheControl); m == nil || m[1] != "0" {
			t.Fatalf("%s Cache-Control = %q, want max-age=0 so an edit is never served stale", label, cacheControl)
		}
		if strings.Contains(cacheControl, "stale-while-revalidate") {
			t.Fatalf("%s Cache-Control = %q allows serving a stale picture", label, cacheControl)
		}
		vary := strings.Join(rec.Header().Values("Vary"), ",")
		for _, want := range []string{"Authorization", "Cookie", "Accept-Encoding"} {
			if !strings.Contains(vary, want) {
				t.Fatalf("%s Vary = %q, missing %s", label, vary, want)
			}
		}
		if n := strings.Count(vary, "Accept-Encoding"); n != 1 {
			t.Fatalf("%s Vary lists Accept-Encoding %d times: %q", label, n, vary)
		}
	}

	first := get("")
	if first.Code != http.StatusOK || first.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("GET thumbnail status=%d type=%q", first.Code, first.Header().Get("Content-Type"))
	}
	assertPrivate("200", first)
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("thumbnail has no ETag to revalidate against")
	}
	revalidated := get(etag)
	if revalidated.Code != http.StatusNotModified || revalidated.Body.Len() != 0 {
		t.Fatalf("If-None-Match %s: status=%d body=%d bytes, want an empty 304", etag, revalidated.Code, revalidated.Body.Len())
	}
	assertPrivate("304", revalidated)
}
