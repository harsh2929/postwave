// SPDX-License-Identifier: AGPL-3.0-only
//
// rbac_test.go — verifies admin-rbac-require-scope (P0): the
// send-time-opt routes refuse a viewer-role API key and return 403
// insufficient_scope when the caller lacks the required scope.
//
// Previously every route here was mounted bare, so any
// tenant-authenticated viewer-role API key could call
// POST /api/v1/campaigns/{id}/schedule-by-best-time and silently
// reschedule a campaign, even though the desktop's `useCanWrite`
// hook hid the UI button.

package send_time_opt

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// adminMutatingRoutes — must require ScopeAdmin.
var adminMutatingRoutes = []struct {
	method, path string
}{
	{http.MethodPost, "/api/v1/campaigns/abc/schedule-by-best-time"},
}

// readRoutes — accept read:reports OR admin.
var readRoutes = []struct {
	method, path string
}{
	{http.MethodGet, "/api/v1/subscribers/abc/best-send-time"},
	{http.MethodGet, "/api/v1/send-time-opt"},
	{http.MethodGet, "/api/v1/subscribers/abc/open-pattern"},
	{http.MethodGet, "/api/v1/send-time-opt/heatmap"},
}

func mountRouter() chi.Router {
	r := chi.NewRouter()
	d := &Deps{}
	d.MountRoutes(r)
	d.MountPatternRoutes(r)
	d.MountSchedulePreviewRoute(r)
	return r
}

func viewerCtx(r *http.Request) *http.Request {
	ctx := middleware.WithAPIKeyAuth(r.Context())
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{
		apikeys.ScopeReadSubscribers,
		apikeys.ScopeReadCampaigns,
	})
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "acme",
		Name: "Acme",
	})
	return r.WithContext(ctx)
}

func adminCtx(r *http.Request) *http.Request {
	ctx := middleware.WithAPIKeyAuth(r.Context())
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeAdmin})
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "acme",
		Name: "Acme",
	})
	return r.WithContext(ctx)
}

func TestSTOAdminRoutes_RejectViewerScope(t *testing.T) {
	router := mountRouter()
	for _, rt := range adminMutatingRoutes {
		t.Run(rt.method+" "+rt.path, func(t *testing.T) {
			req := httptest.NewRequest(rt.method, rt.path, strings.NewReader(`{}`))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, viewerCtx(req))
			if rec.Code != http.StatusForbidden {
				t.Fatalf("viewer scope reached %s — got %d, want 403", rt.path, rec.Code)
			}
			if !strings.Contains(rec.Body.String(), "insufficient_scope") {
				t.Fatalf("expected insufficient_scope envelope, got %s", rec.Body.String())
			}
		})
	}
}

func TestSTOReadRoutes_RejectViewerScope(t *testing.T) {
	router := mountRouter()
	for _, rt := range readRoutes {
		t.Run(rt.method+" "+rt.path, func(t *testing.T) {
			req := httptest.NewRequest(rt.method, rt.path, nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, viewerCtx(req))
			if rec.Code != http.StatusForbidden {
				t.Fatalf("viewer scope reached %s — got %d, want 403", rt.path, rec.Code)
			}
			if !strings.Contains(rec.Body.String(), "insufficient_scope") {
				t.Fatalf("expected insufficient_scope envelope, got %s", rec.Body.String())
			}
		})
	}
}

// TestSTOReadRoutes_AcceptReadReports confirms a key with
// read:reports passes the middleware (the handler may still return
// 5xx because Repo is nil, but the route isn't gated off).
func TestSTOReadRoutes_AcceptReadReports(t *testing.T) {
	router := mountRouter()
	for _, rt := range readRoutes {
		t.Run(rt.method+" "+rt.path, func(t *testing.T) {
			req := httptest.NewRequest(rt.method, rt.path, nil)
			rec := httptest.NewRecorder()
			ctx := middleware.WithAPIKeyAuth(req.Context())
			ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadReports})
			ctx = middleware.WithTenant(ctx, &middleware.Tenant{
				ID:   "00000000-0000-0000-0000-000000000001",
				Slug: "acme",
				Name: "Acme",
			})
			defer func() { _ = recover() }()
			router.ServeHTTP(rec, req.WithContext(ctx))
			if rec.Code == http.StatusForbidden {
				t.Fatalf("read:reports got 403 at %s — middleware misconfigured: %s", rt.path, rec.Body.String())
			}
		})
	}
}

func TestGetBestSendTime_RejectsMalformedSubscriberIDBeforeRepository(
	t *testing.T,
) {
	router := mountRouter()
	req := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/subscribers/not-a-uuid/best-send-time",
		nil,
	)
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadReports})
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "acme",
		Name: "Acme",
	})
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req.WithContext(ctx))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_subscriber_id") {
		t.Fatalf("expected invalid_subscriber_id envelope, got %s", rec.Body.String())
	}
}

// TestSTOSchedulePreview_RejectsViewerScope pins the preview to the
// campaign-write workflow. Read-only keys must not be able to probe a
// campaign's scheduling distribution.
func TestSTOSchedulePreview_RejectsViewerScope(t *testing.T) {
	router := mountRouter()
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/campaigns/abc/schedule-by-best-time/preview",
		strings.NewReader(`{}`),
	)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, viewerCtx(req))
	if rec.Code != http.StatusForbidden {
		t.Fatalf(
			"viewer (read:campaigns) reached preview — got %d, want 403: %s",
			rec.Code,
			rec.Body.String(),
		)
	}
}

func TestSTOSchedulePreview_AcceptsWriteCampaignsScope(t *testing.T) {
	router := mountRouter()
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/campaigns/not-a-uuid/schedule-by-best-time/preview",
		strings.NewReader(`{}`),
	)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeWriteCampaigns})
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "acme",
		Name: "Acme",
	})
	router.ServeHTTP(rec, req.WithContext(ctx))
	if rec.Code == http.StatusForbidden {
		t.Fatalf(
			"write:campaigns got 403 on preview — middleware misconfigured: %s",
			rec.Body.String(),
		)
	}
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid_campaign_id") {
		t.Fatalf("write scope did not reach handler validation: status=%d body=%s", rec.Code, rec.Body.String())
	}
}

// TestSTOAdminRoutes_PassAdminScope confirms the gate is permissive
// for admin keys.
func TestSTOAdminRoutes_PassAdminScope(t *testing.T) {
	router := mountRouter()
	for _, rt := range adminMutatingRoutes {
		t.Run(rt.method+" "+rt.path, func(t *testing.T) {
			req := httptest.NewRequest(rt.method, rt.path, strings.NewReader(`{}`))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			defer func() { _ = recover() }()
			router.ServeHTTP(rec, adminCtx(req))
			if rec.Code == http.StatusForbidden {
				t.Fatalf("admin scope got 403 at %s — middleware misconfigured: %s", rt.path, rec.Body.String())
			}
		})
	}
}
