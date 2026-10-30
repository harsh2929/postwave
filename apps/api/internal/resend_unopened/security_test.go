package resend_unopened

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestResendRequiresWriteAndSendScopesAndDefaultsDispatchClosed(t *testing.T) {
	t.Parallel()

	router := chi.NewRouter()
	MountRoutes(router, &Deps{Pool: &db.Pool{}})
	for _, scopes := range [][]apikeys.Scope{
		{apikeys.ScopeWriteCampaigns},
		{apikeys.ScopeSendTransactional},
	} {
		rec := serveResendRoute(router, scopes)
		if rec.Code != http.StatusForbidden {
			t.Errorf("scopes=%v status=%d, want 403; body=%s", scopes, rec.Code, rec.Body.String())
		}
	}

	rec := serveResendRoute(router, []apikeys.Scope{
		apikeys.ScopeWriteCampaigns,
		apikeys.ScopeSendTransactional,
	})
	if rec.Code != http.StatusLocked || !strings.Contains(rec.Body.String(), "campaign_live_dispatch_disabled") {
		t.Fatalf("full scopes did not reach fail-closed live gate: status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func serveResendRoute(router http.Handler, scopes []apikeys.Scope) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/c1/resend-unopened",
		strings.NewReader(`{"subject":"Fresh subject"}`))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = apikeys.WithScopes(ctx, scopes)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "tenant-1"})
	req = req.WithContext(ctx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}
