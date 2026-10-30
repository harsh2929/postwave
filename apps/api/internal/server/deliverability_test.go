// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/tags"
)

type deliverabilityRouteContract struct {
	method           string
	path             string
	admin            bool
	writeSubscribers bool
	readSubscribers  bool
}

var deliverabilityRouteContracts = []deliverabilityRouteContract{
	{method: http.MethodGet, path: "/api/v1/tag-taxonomy", readSubscribers: true},
	{method: http.MethodPost, path: "/api/v1/tag-taxonomy/merge", writeSubscribers: true},
	{method: http.MethodPost, path: "/api/v1/tag-taxonomy/rename", writeSubscribers: true},
	{method: http.MethodGet, path: "/api/v1/tag-taxonomy/subscribers", readSubscribers: true},
	{method: http.MethodGet, path: "/api/v1/tag-taxonomy/suggest", readSubscribers: true},
	{method: http.MethodGet, path: "/api/v1/tag-taxonomy/{tag_id}/membership", readSubscribers: true},
	{method: http.MethodGet, path: "/api/v1/growth-source/summary"},
	{method: http.MethodGet, path: "/api/v1/growth-source/timeseries"},
	{method: http.MethodGet, path: "/api/v1/growth-source/quality"},
	{method: http.MethodGet, path: "/api/v1/isp-breakdown"},
	{method: http.MethodGet, path: "/api/v1/isp-breakdown/by-campaign/{id}"},
	{method: http.MethodGet, path: "/api/v1/campaigns/{id}/benchmark"},
	{method: http.MethodPost, path: "/api/v1/campaigns/{id}/save-as-template", admin: true},
	{method: http.MethodGet, path: "/api/v1/dns-health"},
	{method: http.MethodGet, path: "/api/v1/dns-health/issues"},
	{method: http.MethodPost, path: "/api/v1/dns-health/run-now", admin: true},
	{method: http.MethodGet, path: "/api/v1/deliverability/hub"},
	{method: http.MethodGet, path: "/api/v1/deliverability/hub/history"},
	{method: http.MethodGet, path: "/api/v1/deliverability/hub/dns-health"},
	{method: http.MethodGet, path: "/api/v1/deliverability/hub/blocklist-hits"},
	{method: http.MethodGet, path: "/api/v1/deliverability/hub/webhook-errors"},
	{method: http.MethodGet, path: "/api/v1/deliverability/hub/bounce-class-breakdown"},
	{method: http.MethodPost, path: "/api/v1/deliverability/hub/repair-override", admin: true},
	{method: http.MethodGet, path: "/api/v1/deliverability/dns-health"},
	{method: http.MethodGet, path: "/api/v1/deliverability/blocklist-hits"},
	{method: http.MethodGet, path: "/api/v1/deliverability/webhook-errors"},
	{method: http.MethodGet, path: "/api/v1/deliverability/bounce-class-breakdown"},
	{method: http.MethodPost, path: "/api/v1/deliverability/repair/override", admin: true},
	{method: http.MethodGet, path: "/api/v1/campaigns/{id}/health"},
	{method: http.MethodGet, path: "/api/v1/firewall/settings"},
	{method: http.MethodPut, path: "/api/v1/firewall/settings", admin: true},
	{method: http.MethodGet, path: "/api/v1/firewall/events"},
	{method: http.MethodGet, path: "/api/v1/firewall/stats"},
	{method: http.MethodPost, path: "/api/v1/firewall/detect", admin: true},
	{method: http.MethodGet, path: "/api/v1/frequency-caps"},
	{method: http.MethodPost, path: "/api/v1/frequency-caps", admin: true},
	{method: http.MethodPatch, path: "/api/v1/frequency-caps/{id}", admin: true},
	{method: http.MethodDelete, path: "/api/v1/frequency-caps/{id}", admin: true},
	{method: http.MethodPost, path: "/api/v1/frequency-caps/{id}/test", admin: true},
	{method: http.MethodGet, path: "/api/v1/inactive-keys", admin: true},
	{method: http.MethodGet, path: "/api/v1/from-name-picker"},
	{method: http.MethodGet, path: "/api/v1/preset-segments"},
	{method: http.MethodGet, path: "/api/v1/preset-segments/{key}/list"},
}

func TestMountDeliverabilitySurfaceRegistersExactRoutesAndDependencies(t *testing.T) {
	router := chi.NewRouter()
	pool := new(db.Pool)
	bus := events.NewBus()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	history := new(tags.History)

	surface := MountDeliverabilitySurface(Deps{
		Router: router, Pool: pool, Bus: bus, Logger: logger, TagHistory: history,
	})

	if surface.Hub == nil {
		t.Fatal("deliverability hub dependencies were not returned")
	}
	if surface.Hub.Pool != pool || surface.Hub.Bus != bus || surface.Hub.Logger != logger {
		t.Fatal("deliverability hub did not receive the shared pool, bus, and logger")
	}
	assertExactDeliverabilityRoutes(t, router)
}

func TestMountDeliverabilitySurfacePreservesPackageOrder(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("deliverability.go")
	if err != nil {
		t.Fatalf("read deliverability.go: %v", err)
	}
	source := string(sourceBytes)
	ordered := []string{
		"tag_taxonomy.MountRoutes(",
		"growth_source.MountRoutes(",
		"isp_breakdown.MountRoutes(",
		"campaign_benchmarks.MountRoutes(",
		"campaign_to_template.MountRoutes(",
		"dns_health.MountRoutes(",
		"deliverability_hub.MountRoutes(",
		"firewall_attack_mode.MountRoutes(",
		"freq_caps.MountRoutes(",
		"inactive_keys.MountRoutes(",
		"from_name_picker.MountRoutes(",
		"preset_segments.MountRoutes(",
	}
	last := -1
	for _, marker := range ordered {
		index := strings.Index(source, marker)
		if index < 0 {
			t.Fatalf("deliverability.go is missing mount marker %q", marker)
		}
		if index <= last {
			t.Fatalf("deliverability mount marker %q is out of order", marker)
		}
		last = index
	}
}

func TestMountDeliverabilitySurfacePreservesScopeContracts(t *testing.T) {
	router := chi.NewRouter()
	MountDeliverabilitySurface(Deps{Router: router, Pool: new(db.Pool)})

	for _, route := range deliverabilityRouteContracts {
		route := route
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			withoutScope := serveDeliverabilityRoute(router, route, nil)
			if withoutScope.Code != http.StatusForbidden || !strings.Contains(withoutScope.Body.String(), "insufficient_scope") {
				t.Fatalf("no-scope status = %d body = %s, want scoped 403", withoutScope.Code, withoutScope.Body.String())
			}

			readScope := apikeys.ScopeReadReports
			if route.readSubscribers {
				readScope = apikeys.ScopeReadSubscribers
			}
			withReadScope := serveDeliverabilityRoute(router, route, []apikeys.Scope{readScope})
			if route.admin || route.writeSubscribers {
				if withReadScope.Code != http.StatusForbidden {
					t.Fatalf("read scope status = %d, want mutation 403", withReadScope.Code)
				}
			} else {
				assertScopeGatePassed(t, withReadScope)
			}

			withAdminScope := serveDeliverabilityRoute(router, route, []apikeys.Scope{apikeys.ScopeAdmin})
			assertScopeGatePassed(t, withAdminScope)
			if route.writeSubscribers {
				withWriteScope := serveDeliverabilityRoute(router, route, []apikeys.Scope{apikeys.ScopeWriteSubscribers})
				assertScopeGatePassed(t, withWriteScope)
			}
		})
	}
}

func TestMountDeliverabilitySurfaceUsesPassedAuthenticatedRouter(t *testing.T) {
	root := chi.NewRouter()
	root.Group(func(authenticated chi.Router) {
		authenticated.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Test-Authenticated-Boundary", "applied")
				next.ServeHTTP(w, r)
			})
		})
		MountDeliverabilitySurface(Deps{Router: authenticated, Pool: new(db.Pool)})
	})

	response := serveDeliverabilityRoute(root, deliverabilityRouteContract{
		method: http.MethodGet,
		path:   "/api/v1/dns-health",
	}, nil)
	if response.Header().Get("X-Test-Authenticated-Boundary") != "applied" {
		t.Fatal("deliverability route escaped the passed authenticated router middleware")
	}
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want scoped 403", response.Code)
	}
}

func TestMountDeliverabilitySurfaceRejectsMissingStructuralDependencies(t *testing.T) {
	tests := []struct {
		name string
		deps Deps
	}{
		{name: "all missing"},
		{name: "missing pool", deps: Deps{Router: chi.NewRouter()}},
		{name: "missing router", deps: Deps{Pool: new(db.Pool)}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			surface := MountDeliverabilitySurface(test.deps)
			if surface.Hub != nil {
				t.Fatal("invalid dependencies returned a hub worker dependency")
			}
			if test.deps.Router != nil && routeCount(t, test.deps.Router) != 0 {
				t.Fatal("invalid dependencies registered partial routes")
			}
		})
	}
}

func TestNewIncludesCompleteDeliverabilitySurface(t *testing.T) {
	router := chi.NewRouter()
	New(Deps{Router: router, Pool: new(db.Pool)})
	assertExactDeliverabilityRoutes(t, router)
}

func assertExactDeliverabilityRoutes(t *testing.T, router chi.Router) {
	t.Helper()
	type routeKey struct {
		method string
		path   string
	}
	want := make(map[routeKey]bool, len(deliverabilityRouteContracts))
	for _, route := range deliverabilityRouteContracts {
		want[routeKey{method: route.method, path: route.path}] = true
	}
	seen := make(map[routeKey]bool, len(want))
	err := chi.Walk(router, func(method, path string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		key := routeKey{method: method, path: path}
		if !want[key] {
			t.Errorf("unexpected deliverability route %s %s", method, path)
		}
		seen[key] = true
		return nil
	})
	if err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}
	for key := range want {
		if !seen[key] {
			t.Errorf("missing deliverability route %s %s", key.method, key.path)
		}
	}
	if len(seen) != len(want) {
		t.Fatalf("registered route count = %d, want %d", len(seen), len(want))
	}
}

func serveDeliverabilityRoute(router http.Handler, route deliverabilityRouteContract, scopes []apikeys.Scope) *httptest.ResponseRecorder {
	path := strings.NewReplacer(
		"{tag_id}", "tag-id",
		"{id}", "00000000-0000-0000-0000-000000000001",
		"{key}", "engaged_30d",
	).Replace(route.path)
	request := httptest.NewRequest(route.method, path, http.NoBody)
	ctx := middleware.WithAPIKeyAuth(request.Context())
	ctx = apikeys.WithScopes(ctx, scopes)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request.WithContext(ctx))
	return response
}

func assertScopeGatePassed(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	switch response.Code {
	case http.StatusForbidden, http.StatusNotFound, http.StatusMethodNotAllowed:
		t.Fatalf("scope gate did not pass: status = %d body = %s", response.Code, response.Body.String())
	}
}

func routeCount(t *testing.T, router chi.Router) int {
	t.Helper()
	count := 0
	if err := chi.Walk(router, func(string, string, http.Handler, ...func(http.Handler) http.Handler) error {
		count++
		return nil
	}); err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}
	return count
}
