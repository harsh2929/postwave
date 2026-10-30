package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/services/deliverability/internal/auth"
	"github.com/postwave/postwave/services/deliverability/internal/internalauth"
	"github.com/postwave/postwave/services/deliverability/internal/render"
	"github.com/postwave/postwave/services/deliverability/internal/reputation"
)

type fakeRenderer struct{}

func (fakeRenderer) Render(context.Context, string, []render.Environment) ([]render.Render, error) {
	return nil, nil
}

func TestPostRenderRejectsOversizedBody(t *testing.T) {
	r := chi.NewRouter()
	Mount(r, Deps{Renderer: fakeRenderer{}})
	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/render",
		strings.NewReader(`{"html":"`+strings.Repeat("x", int(deliverabilityJSONMaxBodyBytes))+`"}`),
	)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid body") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPostRenderRejectsTrailingJSONValue(t *testing.T) {
	r := chi.NewRouter()
	Mount(r, Deps{Renderer: fakeRenderer{}})
	req := httptest.NewRequest(http.MethodPost, "/v1/render", strings.NewReader(`{"html":"ok"} {"html":"extra"}`))
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "single JSON value") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestMissingSendingDomainDoesNotInvalidateSession(t *testing.T) {
	for _, path := range []string{"/v1/auth-checks", "/v1/reputation"} {
		t.Run(path, func(t *testing.T) {
			r := chi.NewRouter()
			r.Use(internalauth.Middleware("test-service-token"))
			Mount(r, Deps{Tenant: HeaderTenantResolver{}, AuthResolver: auth.New(), Reputation: reputation.NewAggregator()})
			// The service still enforces its authentication boundary.
			unauthenticated := httptest.NewRecorder()
			r.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, path, nil))
			if unauthenticated.Code != http.StatusUnauthorized {
				t.Fatalf("unauthenticated status = %d", unauthenticated.Code)
			}
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.Header.Set("Authorization", "Bearer test-service-token")
			req.Header.Set("X-Tenant-ID", "test-tenant")
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "sending_domain_not_configured") {
				t.Fatalf("configured session status = %d, body = %s", rec.Code, rec.Body.String())
			}
		})
	}
}
