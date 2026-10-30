package mailchimpv3

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestMailchimpV3ParityReadsAcceptSessionAuth — desktop-audit gap A17.
//
// The dashboard's Mailchimp-parity card is rendered for every signed-in
// user, so the four parity READ endpoints it polls must accept
// session-cookie auth, not only API keys. The dual-auth arrangement is
// apikeys.RequireScope: API-key requests get a scope check, while
// session requests (IsAPIKeyAuth=false) are admitted for read-only
// scopes regardless of dashboard role. This test pins that contract by
// driving the real Mount() route table with a session-shaped context
// (tenant+user, no API-key marker) for a non-admin member.
func TestMailchimpV3ParityReadsAcceptSessionAuth(t *testing.T) {
	store := &fakeV3Store{member: &Member{
		ID: "hash", EmailAddress: "reader@example.com",
		Status: "subscribed", LastChanged: time.Now(),
	}}
	router := chi.NewRouter()
	// Session-cookie shape: tenant + user on context, IsAPIKeyAuth
	// false (no scopes attached) — exactly what TenantMiddleware's
	// SessionResolver path produces for a logged-in dashboard user.
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{
				ID: "00000000-0000-0000-0000-000000000001", Slug: "demo", Name: "Demo", Tier: "pro",
			})
			ctx = middleware.WithUser(ctx, &middleware.User{
				ID:       "00000000-0000-0000-0000-000000000002",
				TenantID: "00000000-0000-0000-0000-000000000001",
				Email:    "member@example.com",
				Role:     "member", // deliberately NOT admin/owner
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	Mount(router, &Deps{Store: store})

	// The four endpoints the desktop's MailchimpParityCard polls.
	parityReads := []string{
		"/api/mailchimp/3.0/campaign-manager/calendar",
		"/api/mailchimp/3.0/audience/insights",
		"/api/mailchimp/3.0/content-studio",
		"/api/mailchimp/3.0/growth/channels",
	}
	for _, path := range parityReads {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s (session, member role) = %d, want 200; body=%s",
				path, rec.Code, rec.Body.String())
		}
	}

	// Boundary check: the same member-role session must NOT pass an
	// admin-tier (write) gate — RequireScope's session path enforces
	// owner/admin for non-read scopes.
	req := httptest.NewRequest(http.MethodPost, "/api/mailchimp/3.0/campaigns",
		strings.NewReader(`{"type":"regular"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("POST /campaigns (session, member role) = %d, want 403; body=%s",
			rec.Code, rec.Body.String())
	}
}
