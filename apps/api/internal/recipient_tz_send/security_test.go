package recipient_tz_send

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

func TestTimezoneScheduleRequiresWriteAndSendAndDefaultsDispatchClosed(t *testing.T) {
	t.Parallel()

	router := chi.NewRouter()
	MountRoutes(router, &Deps{Pool: &db.Pool{}})
	for _, scopes := range [][]apikeys.Scope{
		{apikeys.ScopeWriteCampaigns},
		{apikeys.ScopeSendTransactional},
	} {
		rec := serveTimezoneSchedule(router, scopes)
		if rec.Code != http.StatusForbidden {
			t.Errorf("scopes=%v status=%d, want 403; body=%s", scopes, rec.Code, rec.Body.String())
		}
	}

	rec := serveTimezoneSchedule(router, []apikeys.Scope{
		apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional,
	})
	if rec.Code != http.StatusLocked || !strings.Contains(rec.Body.String(), "campaign_live_dispatch_disabled") {
		t.Fatalf("full scopes did not reach fail-closed live gate: status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func serveTimezoneSchedule(router http.Handler, scopes []apikeys.Scope) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/c1/tz-schedule",
		strings.NewReader(`{"local_time":"09:00","date":"2030-01-01","fallback_tz":"UTC"}`))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = apikeys.WithScopes(ctx, scopes)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "tenant-1"})
	req = req.WithContext(ctx)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}
