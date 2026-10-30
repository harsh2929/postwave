package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
)

func TestOAuthStartFailsClosedWhenProviderCredentialsAreMissing(t *testing.T) {
	t.Setenv("POSTWAVE_MIGRATION_DEMO_MODE", "")
	t.Setenv("MAILCHIMP_CLIENT_ID", "")
	t.Setenv("MAILCHIMP_CLIENT_SECRET", "")
	t.Setenv("CONVERTKIT_CLIENT_ID", "")
	t.Setenv("CONVERTKIT_CLIENT_SECRET", "")

	for _, source := range []string{"mailchimp", "convertkit"} {
		t.Run(source, func(t *testing.T) {
			handler := NewMigration("https://app.postwave.example/migrations/oauth/callback", jobstore.NewMemoryJobStore())
			router := chi.NewRouter()
			handler.Mount(router)
			req := httptest.NewRequest(http.MethodPost, "/v1/migrations/"+source+"/oauth/start", nil)
			req.Header.Set("X-Tenant-ID", "tenant_a")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503; body=%s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(strings.ToLower(rec.Body.String()), "not configured") {
				t.Fatalf("body = %s", rec.Body.String())
			}
		})
	}
}
