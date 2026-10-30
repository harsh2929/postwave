package lists

// Scope-gate tests for the A1/A2 routes (desktop audit 2026-06-10
// follow-up): the membership write surface must require
// write:subscribers and the list-scoped suppressions read must require
// read:subscribers for API-key callers, mounted exactly as production
// does via MountRoutes. Session-cookie principals are unaffected
// (read-tier scopes admit any logged-in user; see
// apikeys.RequireScope).

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// doAPIKey runs req through MountRoutes with API-key auth carrying the
// given scopes (plus tenant context) and returns the recorder.
func doAPIKey(t *testing.T, req *http.Request, scopes ...apikeys.Scope) *httptest.ResponseRecorder {
	t.Helper()
	d := New("http://upstream.invalid", "u", "p")
	router := chi.NewRouter()
	d.MountRoutes(router)

	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "t1"})
	ctx = apikeys.WithScopes(ctx, scopes)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req.WithContext(ctx))
	return w
}

func doWebhookAPIKey(t *testing.T, req *http.Request, scopes ...apikeys.Scope) *httptest.ResponseRecorder {
	t.Helper()
	d := New("http://upstream.invalid", "u", "p")
	router := chi.NewRouter()
	d.MountWebhookRoutes(router)

	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "t1"})
	ctx = apikeys.WithScopes(ctx, scopes)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req.WithContext(ctx))
	return w
}

func doAllListAPIKey(t *testing.T, req *http.Request, scopes ...apikeys.Scope) *httptest.ResponseRecorder {
	t.Helper()
	d := New("http://upstream.invalid", "u", "p")
	router := chi.NewRouter()
	d.MountRoutes(router)
	d.MountIdempotentRoutes(router)
	d.MountAnalyticsRoutes(router)
	d.MountGrowthRoutes(router)
	d.MountVersionRoutes(router)
	d.MountArchiveRoutes(router)
	d.MountMergeFieldRoutes(router)
	d.MountImportExportRoutes(router)

	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "t1"})
	ctx = apikeys.WithScopes(ctx, scopes)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req.WithContext(ctx))
	return w
}

func TestMembershipWriteRoutes_RequireWriteSubscribersScope(t *testing.T) {
	cases := []struct {
		method, path, body string
	}{
		{"POST", "/api/v1/lists/7/subscribers", `{"subscriber_ids":["` + testSubUUID + `"]}`},
		{"DELETE", "/api/v1/lists/7/subscribers/" + testSubUUID, ""},
	}
	for _, c := range cases {
		// Read-only key: 403 insufficient_scope from the gate, before
		// the handler runs.
		req := httptest.NewRequest(c.method, c.path, strings.NewReader(c.body))
		w := doAPIKey(t, req, apikeys.ScopeReadSubscribers)
		if w.Code != http.StatusForbidden {
			t.Fatalf("%s %s with read-only key: status = %d, want 403", c.method, c.path, w.Code)
		}
		if !strings.Contains(w.Body.String(), "insufficient_scope") {
			t.Fatalf("%s %s: body = %q, want insufficient_scope", c.method, c.path, w.Body.String())
		}

		// write:subscribers passes the gate (the handler then fails on
		// the unset Repo / upstream, never on scope).
		req = httptest.NewRequest(c.method, c.path, strings.NewReader(c.body))
		w = doAPIKey(t, req, apikeys.ScopeWriteSubscribers)
		if w.Code == http.StatusForbidden {
			t.Fatalf("%s %s with write:subscribers: status = 403, want gate passed", c.method, c.path)
		}
	}
}

func TestSuppressionsRoute_RequiresReadSubscribersScope(t *testing.T) {
	// A key with an unrelated read scope must not see suppressions.
	req := httptest.NewRequest("GET", "/api/v1/lists/7/suppressions", nil)
	w := doAPIKey(t, req, apikeys.ScopeReadReports)
	if w.Code != http.StatusForbidden {
		t.Fatalf("GET suppressions with read:reports key: status = %d, want 403", w.Code)
	}
	if !strings.Contains(w.Body.String(), "insufficient_scope") {
		t.Fatalf("body = %q, want insufficient_scope", w.Body.String())
	}

	// read:subscribers passes the gate.
	req = httptest.NewRequest("GET", "/api/v1/lists/7/suppressions", nil)
	w = doAPIKey(t, req, apikeys.ScopeReadSubscribers)
	if w.Code == http.StatusForbidden {
		t.Fatalf("GET suppressions with read:subscribers: status = 403, want gate passed")
	}
}

func TestListsForSubscriberRouteRequiresReadSubscribersScope(t *testing.T) {
	path := "/api/v1/lists/for-subscriber/00000000-0000-0000-0000-000000000001"
	req := httptest.NewRequest(http.MethodGet, path, nil)
	w := doAPIKey(t, req, apikeys.ScopeReadReports)
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "insufficient_scope") {
		t.Fatalf("unrelated scope: status=%d body=%q, want 403 insufficient_scope", w.Code, w.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, path, nil)
	w = doAPIKey(t, req, apikeys.ScopeReadSubscribers)
	if w.Code == http.StatusForbidden {
		t.Fatalf("read:subscribers was rejected by the route scope gate")
	}
}

func TestListCollectionRequiresReadSubscribersScope(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/v1/lists", nil)
	w := doAPIKey(t, req /* no scopes */)
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "insufficient_scope") {
		t.Fatalf("GET /api/v1/lists without scope: status=%d body=%q, want 403", w.Code, w.Body.String())
	}
	req = httptest.NewRequest("GET", "/api/v1/lists", nil)
	w = doAPIKey(t, req, apikeys.ScopeReadSubscribers)
	if w.Code == http.StatusForbidden {
		t.Fatalf("GET /api/v1/lists rejected read:subscribers")
	}
}

func TestAllListRouteFamiliesDefaultDenyUnrelatedScopes(t *testing.T) {
	readRoutes := []string{
		"/api/v1/lists",
		"/api/v1/lists/7/subscribers",
		"/api/v1/lists/7/growth",
		"/api/v1/lists/7/growth-sources",
		"/api/v1/lists/7/versions",
		"/api/v1/lists/7/preferences-page",
		"/api/v1/lists/7/merge-fields",
		"/api/v1/lists/7/export.csv",
	}
	for _, path := range readRoutes {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		w := doAllListAPIKey(t, req, apikeys.ScopeReadReports)
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "insufficient_scope") {
			t.Fatalf("GET %s unrelated scope: status=%d body=%q", path, w.Code, w.Body.String())
		}
	}
	writeRoutes := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/v1/lists"},
		{http.MethodPatch, "/api/v1/lists/7"},
		{http.MethodDelete, "/api/v1/lists/7"},
		{http.MethodPost, "/api/v1/lists/7/archive"},
		{http.MethodPost, "/api/v1/lists/7/import"},
		{http.MethodPost, "/api/v1/lists/7/merge-fields"},
	}
	for _, route := range writeRoutes {
		req := httptest.NewRequest(route.method, route.path, strings.NewReader(`{}`))
		w := doAllListAPIKey(t, req, apikeys.ScopeReadSubscribers)
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "insufficient_scope") {
			t.Fatalf("%s %s read-only scope: status=%d body=%q", route.method, route.path, w.Code, w.Body.String())
		}
	}
}

func TestListWebhookRoutesRequireAdminScope(t *testing.T) {
	cases := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/api/v1/lists/7/webhooks", ""},
		{http.MethodPost, "/api/v1/lists/7/webhooks", `{"url":"https://hooks.example","events":["list.subscriber.added"]}`},
		{http.MethodPatch, "/api/v1/lists/7/webhooks/00000000-0000-0000-0000-000000000001", `{"active":false}`},
		{http.MethodDelete, "/api/v1/lists/7/webhooks/00000000-0000-0000-0000-000000000001", ""},
		{http.MethodPost, "/api/v1/lists/7/webhooks/00000000-0000-0000-0000-000000000001/rotate-secret", ""},
		{http.MethodPost, "/api/v1/lists/7/webhooks/00000000-0000-0000-0000-000000000001/test", ""},
		{http.MethodGet, "/api/v1/lists/7/webhooks/00000000-0000-0000-0000-000000000001/deliveries", ""},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		w := doWebhookAPIKey(t, req, apikeys.ScopeWriteSubscribers)
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "insufficient_scope") {
			t.Fatalf("%s %s with non-admin key: status=%d body=%q, want 403 insufficient_scope", tc.method, tc.path, w.Code, w.Body.String())
		}

		req = httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		w = doWebhookAPIKey(t, req, apikeys.ScopeAdmin)
		if w.Code == http.StatusForbidden {
			t.Fatalf("%s %s with admin key: scope gate returned 403", tc.method, tc.path)
		}
	}
}
