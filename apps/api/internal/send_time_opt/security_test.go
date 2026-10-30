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

func TestScheduleByBestTimeRequiresWriteAndSendScopesAndDefaultsDispatchClosed(t *testing.T) {
	t.Parallel()

	router := chi.NewRouter()
	(&Deps{}).MountRoutes(router)
	for _, scopes := range [][]apikeys.Scope{
		{apikeys.ScopeWriteCampaigns},
		{apikeys.ScopeSendTransactional},
	} {
		rec := serveScheduleRoute(router, scopes)
		if rec.Code != http.StatusForbidden {
			t.Errorf("scopes=%v status=%d, want 403; body=%s", scopes, rec.Code, rec.Body.String())
		}
	}

	rec := serveScheduleRoute(router, []apikeys.Scope{
		apikeys.ScopeWriteCampaigns,
		apikeys.ScopeSendTransactional,
	})
	if rec.Code != http.StatusLocked || !strings.Contains(rec.Body.String(), "campaign_live_dispatch_disabled") {
		t.Fatalf("full scopes did not reach fail-closed live gate: status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func serveScheduleRoute(router http.Handler, scopes []apikeys.Scope) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/c1/schedule-by-best-time",
		strings.NewReader(`{"within_days":7}`))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = apikeys.WithScopes(ctx, scopes)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "tenant-1"})
	req = req.WithContext(ctx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}
