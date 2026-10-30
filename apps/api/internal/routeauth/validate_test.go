// SPDX-License-Identifier: AGPL-3.0-only
package routeauth

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestValidateRouterRequiresDefaultDenyOnAuthenticatedRoutes(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		build   func(*chi.Mux)
		wantErr string
	}{
		{
			name: "authenticated route carries middleware",
			build: func(router *chi.Mux) {
				router.Group(func(protected chi.Router) {
					protected.Use(Middleware)
					protected.Get("/api/v1/lists", noContentHandler().ServeHTTP)
				})
			},
		},
		{
			name: "authenticated route bypasses middleware",
			build: func(router *chi.Mux) {
				router.Get("/api/v1/lists", noContentHandler().ServeHTTP)
			},
			wantErr: "bypasses routeauth.Middleware",
		},
		{
			name: "unclassified route",
			build: func(router *chi.Mux) {
				router.Group(func(protected chi.Router) {
					protected.Use(Middleware)
					protected.Get("/api/v1/new-unclassified-route", noContentHandler().ServeHTTP)
				})
			},
			wantErr: "has no exact route capability",
		},
		{
			name: "public route needs no tenant authorization middleware",
			build: func(router *chi.Mux) {
				router.Post("/api/public/inbound-email/{slug}", noContentHandler().ServeHTTP)
			},
		},
		{
			name: "handler credential route needs no tenant authorization middleware",
			build: func(router *chi.Mux) {
				router.Get("/api/v1/audit/portal/branding", noContentHandler().ServeHTTP)
			},
		},
		{
			name: "ANY proxy is validated",
			build: func(router *chi.Mux) {
				router.Group(func(protected chi.Router) {
					protected.Use(Middleware)
					protected.Handle("/api/v1/automations/*", noContentHandler())
				})
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			router := chi.NewRouter()
			test.build(router)
			err := ValidateRouter(router)
			if test.wantErr == "" && err != nil {
				t.Fatalf("ValidateRouter() error = %v", err)
			}
			if test.wantErr != "" && (err == nil || !strings.Contains(err.Error(), test.wantErr)) {
				t.Fatalf("ValidateRouter() error = %v, want substring %q", err, test.wantErr)
			}
		})
	}
}

func TestValidateRouterIgnoresNonAPIRoutes(t *testing.T) {
	t.Parallel()
	router := chi.NewRouter()
	router.Get("/metrics", func(http.ResponseWriter, *http.Request) {})
	if err := ValidateRouter(router); err != nil {
		t.Fatalf("ValidateRouter() error = %v", err)
	}
}

func TestExactValidationRejectsStaleManifestRoute(t *testing.T) {
	router := chi.NewRouter()
	router.Group(func(protected chi.Router) {
		protected.Use(Middleware)
		protected.Get("/api/v1/lists", noContentHandler().ServeHTTP)
	})
	manifest := testManifest(t,
		testAuthenticatedPolicy("GET", "/api/v1/lists"),
		testAuthenticatedPolicy("GET", "/api/v1/stale"),
	)
	err := validateRouterAgainstManifest(router, manifest, true)
	if err == nil || !strings.Contains(err.Error(), "manifest route GET /api/v1/stale is not mounted") {
		t.Fatalf("exact validation error = %v, want stale-manifest failure", err)
	}
}

func TestExactValidationAllowsConcreteRoutesBehindReviewedANYProxy(t *testing.T) {
	router := chi.NewRouter()
	router.Group(func(protected chi.Router) {
		protected.Use(Middleware)
		protected.Handle("/api/v1/migrations/*", noContentHandler())
	})
	manifest := testManifest(t,
		testAuthenticatedPolicy("ANY", "/api/v1/migrations/{rest}"),
		testAuthenticatedPolicy("GET", "/api/v1/migrations/{job_id}"),
	)
	if err := validateRouterAgainstManifest(router, manifest, true); err != nil {
		t.Fatalf("exact proxy validation: %v", err)
	}
}

func testManifest(t *testing.T, policies ...Policy) *Manifest {
	t.Helper()
	raw, err := json.Marshal(manifestDocument{SchemaVersion: 1, Routes: policies})
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	manifest, err := ParseManifest(raw)
	if err != nil {
		t.Fatalf("parse manifest: %v", err)
	}
	return manifest
}

func testAuthenticatedPolicy(method, path string) Policy {
	return Policy{
		Method:             method,
		Path:               path,
		Exposure:           ExposureAuthenticated,
		AuthMethods:        []string{"session", "api_key"},
		SessionMinimumRole: "viewer",
		APIKeyScopes:       []string{"read:reports"},
		APIKeyScopeMode:    ScopeModeAny,
		PolicySource:       "test",
		ReviewStatus:       "reviewed",
	}
}
