package lists

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

func TestListWebhooksRejectsUnknownAndCrossTenantParents(t *testing.T) {
	pool := newListIdentityDBTestPool(t)
	tenantA := seedListIdentityTenant(t, pool)
	tenantB := seedListIdentityTenant(t, pool)
	crossTenantListID := uuid.NewString()
	if _, err := (&Repo{Pool: pool}).ensureListIDMap(
		t.Context(),
		tenantB,
		crossTenantListID,
		946201,
	); err != nil {
		t.Fatalf("seed cross-tenant list identity: %v", err)
	}

	deps := New("http://upstream.invalid", "u", "p")
	deps.Repo = &Repo{
		Pool:             pool,
		OutboundWebhooks: &outbound_webhooks.Store{Pool: pool},
	}
	for _, test := range []struct {
		name   string
		listID string
	}{
		{name: "unknown", listID: uuid.NewString()},
		{name: "cross_tenant", listID: crossTenantListID},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(
				http.MethodGet,
				"/api/v1/lists/"+test.listID+"/webhooks",
				nil,
			)
			request = withListIDParam(request, test.listID)
			request = request.WithContext(middleware.WithTenant(
				request.Context(),
				&middleware.Tenant{ID: tenantA},
			))
			response := httptest.NewRecorder()

			deps.ListWebhooks(response, request)

			if response.Code != http.StatusNotFound {
				t.Fatalf(
					"status = %d, want 404; body=%s",
					response.Code,
					response.Body.String(),
				)
			}
			if !strings.Contains(response.Body.String(), `"list_not_found"`) {
				t.Fatalf("body does not contain list_not_found: %s", response.Body.String())
			}
			if strings.Contains(response.Body.String(), test.listID) {
				t.Fatalf("response disclosed supplied list UUID: %s", response.Body.String())
			}
		})
	}
}
