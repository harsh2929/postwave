package tags

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestTagDepsMountsGroupRoutesWithSubscriberScopes(t *testing.T) {
	t.Parallel()
	router := chi.NewRouter()
	(&Deps{GroupRepo: &GroupRepo{}}).MountRoutes(router)

	want := map[string]struct{}{
		http.MethodGet + " /api/v1/tag-groups":         {},
		http.MethodPost + " /api/v1/tag-groups":        {},
		http.MethodPatch + " /api/v1/tag-groups/{id}":  {},
		http.MethodDelete + " /api/v1/tag-groups/{id}": {},
	}
	seen := map[string]struct{}{}
	if err := chi.Walk(router, func(method, path string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		key := method + " " + path
		if _, ok := want[key]; ok {
			seen[key] = struct{}{}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(seen) != len(want) {
		t.Fatalf("mounted group routes=%v, want=%v", seen, want)
	}

	serve := func(method, path string, scopes ...apikeys.Scope) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(`{}`))
		ctx := middleware.WithAPIKeyAuth(req.Context())
		ctx = apikeys.WithScopes(ctx, scopes)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req.WithContext(ctx))
		return rec
	}
	if rec := serve(http.MethodGet, "/api/v1/tag-groups"); rec.Code != http.StatusForbidden {
		t.Fatalf("group read without scope status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := serve(http.MethodGet, "/api/v1/tag-groups", apikeys.ScopeReadSubscribers); rec.Code != http.StatusUnauthorized {
		t.Fatalf("group read scope did not reach tenant gate: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := serve(http.MethodPost, "/api/v1/tag-groups", apikeys.ScopeReadSubscribers); rec.Code != http.StatusForbidden {
		t.Fatalf("group mutation accepted read scope: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := serve(http.MethodPost, "/api/v1/tag-groups", apikeys.ScopeWriteSubscribers); rec.Code != http.StatusUnauthorized {
		t.Fatalf("group write scope did not reach tenant gate: status=%d body=%s", rec.Code, rec.Body.String())
	}
}
