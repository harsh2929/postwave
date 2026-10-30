// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/merge_fields"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/segments"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

type subscriberListSegmentRoute struct {
	method      string
	path        string
	middlewares []func(http.Handler) http.Handler
}

func TestMountSubscriberListSegmentSurfaceMatchesEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newSubscriberListSegmentDeps(actualRouter)
	MountSubscriberListSegmentSurface(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newSubscriberListSegmentDeps(referenceRouter)
	mountLegacySubscriberListSegmentSurface(referenceDeps)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("migrated route count = %d, legacy route count = %d", len(actual), len(reference))
	}
	if len(actual) != 194 {
		t.Fatalf("subscriber/list/segment route count = %d, want 194", len(actual))
	}

	scopeSets := []struct {
		name   string
		scopes []apikeys.Scope
	}{
		{name: "none"},
		{name: "read subscribers", scopes: []apikeys.Scope{apikeys.ScopeReadSubscribers}},
		{name: "write subscribers", scopes: []apikeys.Scope{apikeys.ScopeWriteSubscribers}},
		{name: "read reports", scopes: []apikeys.Scope{apikeys.ScopeReadReports}},
		{name: "admin", scopes: []apikeys.Scope{apikeys.ScopeAdmin}},
		{name: "read and write", scopes: []apikeys.Scope{apikeys.ScopeReadSubscribers, apikeys.ScopeWriteSubscribers}},
		{name: "all relevant", scopes: []apikeys.Scope{
			apikeys.ScopeReadSubscribers,
			apikeys.ScopeWriteSubscribers,
			apikeys.ScopeReadReports,
			apikeys.ScopeAdmin,
		}},
	}

	for index := range reference {
		want := reference[index]
		got := actual[index]
		if got.method != want.method || got.path != want.path {
			t.Fatalf("route[%d] = %s %s, want %s %s", index, got.method, got.path, want.method, want.path)
		}
		if len(got.middlewares) != len(want.middlewares) {
			t.Fatalf("%s %s middleware count = %d, want %d", got.method, got.path, len(got.middlewares), len(want.middlewares))
		}

		for _, scopeSet := range scopeSets {
			gotResponse := serveRouteMiddleware(got, scopeSet.scopes)
			wantResponse := serveRouteMiddleware(want, scopeSet.scopes)
			if gotResponse.Code != wantResponse.Code || gotResponse.Body.String() != wantResponse.Body.String() {
				t.Errorf(
					"%s %s with %s scopes = (%d, %q), want (%d, %q)",
					got.method,
					got.path,
					scopeSet.name,
					gotResponse.Code,
					gotResponse.Body.String(),
					wantResponse.Code,
					wantResponse.Body.String(),
				)
			}
		}
	}
}

func TestMountSubscriberListSegmentSurfacePreservesRegistrationOrder(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("subscriber_lists_segments.go")
	if err != nil {
		t.Fatalf("read subscriber_lists_segments.go: %v", err)
	}
	source := string(sourceBytes)
	ordered := []string{
		"segments.Mount(deps.Router, deps.Segments)",
		"segments.MountSchemaRoute(deps.Router, deps.Segments)",
		"segments.MountSavedRoutes(deps.Router, deps.Segments)",
		"segments.MountFolderRoutes(deps.Router, deps.Segments)",
		"segments.MountExtended(deps.Router, deps.Segments)",
		"segments.MountTemplatesRoute(deps.Router, deps.Segments)",
		"segments.MountDecayRoutes(deps.Router,",
		"mergeFieldsDeps.MountRoutes(deps.Router)",
		"subscribers.MountRead(deps.Router, deps.Subscribers)",
		"deps.Lists.MountRoutes(deps.Router)",
		"deps.Lists.MountAnalyticsRoutes(deps.Router)",
		"deps.Lists.MountGrowthRoutes(deps.Router)",
		"deps.Lists.MountVersionRoutes(deps.Router)",
		"deps.Lists.MountArchiveRoutes(deps.Router)",
		"deps.Lists.MountMergeFieldRoutes(deps.Router)",
		"deps.Lists.MountWebhookRoutes(deps.Router)",
		"deps.Lists.MountImportExportRoutes(deps.Router)",
		"subscribers.MountMergeRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountBulkMergeRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountTransformRuleRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountEngagementRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountCSVExportRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountTimelineRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountAttributeHistoryRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountSoftDeleteRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountAccountLinkRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountFederationRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountCatalogAttributesRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountReplenishmentCadenceRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountDemographicsRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountPredictionMetadataRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountDataExportRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountConsentReceiptRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountErasureReceiptRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountJurisdictionRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountBulkRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountImportTemplateRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountIdentityGraphRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountMultiEmailRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountChannelConsentRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountSendTimesRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountGroupMembershipRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountSubscriberEventRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountAuditLogRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountIdentifierTransformRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountPIIConfigRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountGppRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountDecisionExplanationRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountLookalikeRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountPreSendRefineRoutes(deps.Router, deps.Subscribers)",
		"subscribers.MountGrowthRoutes(deps.Router, deps.Subscribers)",
		"deps.IdempotentLists.MountIdempotentRoutes(deps.Router)",
		"subscribers.MountWrite(deps.Router, deps.Subscribers)",
		"subscribers.MountIdentifyRoutes(deps.Router, deps.Subscribers)",
	}

	last := -1
	for _, marker := range ordered {
		index := strings.Index(source, marker)
		if index < 0 {
			t.Fatalf("subscriber_lists_segments.go is missing mount marker %q", marker)
		}
		if index <= last {
			t.Fatalf("mount marker %q is out of order", marker)
		}
		last = index
	}
	if len(ordered) != 54 {
		t.Fatalf("mount-call contract contains %d entries, want 54", len(ordered))
	}
}

func TestMountSubscriberListSegmentSurfacePreservesDependencyIdentity(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("subscriber_lists_segments.go")
	if err != nil {
		t.Fatalf("read subscriber_lists_segments.go: %v", err)
	}
	source := string(sourceBytes)
	if got := strings.Count(source, "deps.Subscribers)"); got != 37 {
		t.Fatalf("shared subscriber dependency uses = %d, want 37", got)
	}
	if got := strings.Count(source, "deps.Segments)"); got != 6 {
		t.Fatalf("shared segment dependency uses = %d, want 6", got)
	}
	for _, marker := range []string{
		"DecayStore: deps.SegmentDecayStore,",
		"AIProvider: deps.Segments.AIProvider,",
		"Logger:     deps.Logger,",
		"Repo:   &merge_fields.Repo{Pool: deps.Pool}",
		"Logger: deps.Logger",
		"deps.Lists.MountRoutes(deps.Router)",
		"deps.IdempotentLists.MountIdempotentRoutes(deps.Router)",
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("dependency identity contract missing %q", marker)
		}
	}
}

func TestMountSubscriberListSegmentSurfaceUsesPassedAuthenticatedRouter(t *testing.T) {
	root := chi.NewRouter()
	root.Group(func(authenticated chi.Router) {
		authenticated.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Test-Authenticated-Boundary", "applied")
				next.ServeHTTP(w, r)
			})
		})
		deps := newSubscriberListSegmentDeps(authenticated)
		MountSubscriberListSegmentSurface(deps)
	})

	request := httptest.NewRequest(http.MethodGet, "/api/v1/segments", http.NoBody)
	request = request.WithContext(middleware.WithAPIKeyAuth(request.Context()))
	response := httptest.NewRecorder()
	root.ServeHTTP(response, request)
	if response.Header().Get("X-Test-Authenticated-Boundary") != "applied" {
		t.Fatal("migrated route escaped the passed authenticated router middleware")
	}
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "insufficient_scope") {
		t.Fatalf("status = %d body = %s, want scoped 403", response.Code, response.Body.String())
	}
}

func TestSubscriberListSegmentMountsRejectMissingStructuralDependencies(t *testing.T) {
	valid := newSubscriberListSegmentDeps(chi.NewRouter())
	tests := []struct {
		name  string
		deps  Deps
		mount func(Deps)
	}{
		{name: "segments missing router", deps: Deps{Segments: valid.Segments}, mount: MountSegmentRoutes},
		{name: "segments missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountSegmentRoutes},
		{name: "decay missing router", deps: Deps{Segments: valid.Segments, SegmentDecayStore: valid.SegmentDecayStore}, mount: MountSegmentDecayRoutes},
		{name: "decay missing segment deps", deps: Deps{Router: chi.NewRouter(), SegmentDecayStore: valid.SegmentDecayStore}, mount: MountSegmentDecayRoutes},
		{name: "decay missing store", deps: Deps{Router: chi.NewRouter(), Segments: valid.Segments}, mount: MountSegmentDecayRoutes},
		{name: "merge fields missing router", deps: Deps{Pool: valid.Pool}, mount: MountMergeFieldRoutes},
		{name: "merge fields missing pool", deps: Deps{Router: chi.NewRouter()}, mount: MountMergeFieldRoutes},
		{name: "subscriber read missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountSubscriberReadRoutes},
		{name: "lists missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountListRoutes},
		{name: "subscriber merge missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountSubscriberMergeRoutes},
		{name: "subscriber profile missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountSubscriberProfileRoutes},
		{name: "subscriber growth missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountSubscriberGrowthRoutes},
		{name: "idempotent lists missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountIdempotentListRoutes},
		{name: "subscriber write missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountSubscriberWriteRoutes},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			test.mount(test.deps)
			if test.deps.Router != nil && routeCount(t, test.deps.Router) != 0 {
				t.Fatal("invalid dependencies registered partial routes")
			}
		})
	}
}

func TestMountSubscriberListSegmentSurfaceRejectsEveryIncompleteDependencyBag(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Deps)
	}{
		{name: "router", mutate: func(deps *Deps) { deps.Router = nil }},
		{name: "pool", mutate: func(deps *Deps) { deps.Pool = nil }},
		{name: "subscribers", mutate: func(deps *Deps) { deps.Subscribers = nil }},
		{name: "lists", mutate: func(deps *Deps) { deps.Lists = nil }},
		{name: "idempotent lists", mutate: func(deps *Deps) { deps.IdempotentLists = nil }},
		{name: "segments", mutate: func(deps *Deps) { deps.Segments = nil }},
		{name: "decay store", mutate: func(deps *Deps) { deps.SegmentDecayStore = nil }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			deps := newSubscriberListSegmentDeps(chi.NewRouter())
			test.mutate(&deps)
			MountSubscriberListSegmentSurface(deps)
			if deps.Router != nil && routeCount(t, deps.Router) != 0 {
				t.Fatal("incomplete dependency bag registered a partial surface")
			}
		})
	}
}

func TestNewIncludesCompleteSubscriberListSegmentSurface(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newSubscriberListSegmentDeps(actualRouter)
	New(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newSubscriberListSegmentDeps(referenceRouter)
	MountDeliverabilitySurface(referenceDeps)
	mountLegacySubscriberListSegmentSurface(referenceDeps)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("server.New route count = %d, want %d", len(actual), len(reference))
	}
	for index := range reference {
		if actual[index].method != reference[index].method || actual[index].path != reference[index].path {
			t.Fatalf(
				"server.New route[%d] = %s %s, want %s %s",
				index,
				actual[index].method,
				actual[index].path,
				reference[index].method,
				reference[index].path,
			)
		}
	}
}

func newSubscriberListSegmentDeps(router chi.Router) Deps {
	pool := new(db.Pool)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	listDeps := lists.New("http://listmonk.invalid", "user", "password")
	listDeps.Repo = &lists.Repo{Pool: pool}
	listDeps.Logger = logger
	idempotentListDeps := lists.New("http://listmonk.invalid", "user", "password")
	idempotentListDeps.Repo = &lists.Repo{Pool: pool}
	idempotentListDeps.Logger = logger
	return Deps{
		Router:            router,
		Pool:              pool,
		Logger:            logger,
		Subscribers:       &subscribers.Deps{Repo: &subscribers.Repo{Pool: pool}, Logger: logger},
		Lists:             listDeps,
		IdempotentLists:   idempotentListDeps,
		Segments:          &segments.Deps{Repo: &segments.Repo{Pool: pool}, Logger: logger},
		SegmentDecayStore: &segments.DecayRepo{Pool: pool},
	}
}

func mountLegacySubscriberListSegmentSurface(deps Deps) {
	segments.Mount(deps.Router, deps.Segments)
	segments.MountSchemaRoute(deps.Router, deps.Segments)
	segments.MountSavedRoutes(deps.Router, deps.Segments)
	segments.MountFolderRoutes(deps.Router, deps.Segments)
	segments.MountExtended(deps.Router, deps.Segments)
	segments.MountTemplatesRoute(deps.Router, deps.Segments)
	segments.MountDecayRoutes(deps.Router, &segments.DecayDeps{
		DecayStore: deps.SegmentDecayStore,
		AIProvider: deps.Segments.AIProvider,
		Logger:     deps.Logger,
	})
	(&merge_fields.Deps{Repo: &merge_fields.Repo{Pool: deps.Pool}}).MountRoutes(deps.Router)
	subscribers.MountRead(deps.Router, deps.Subscribers)
	deps.Lists.MountRoutes(deps.Router)
	deps.Lists.MountAnalyticsRoutes(deps.Router)
	deps.Lists.MountGrowthRoutes(deps.Router)
	deps.Lists.MountVersionRoutes(deps.Router)
	deps.Lists.MountArchiveRoutes(deps.Router)
	deps.Lists.MountMergeFieldRoutes(deps.Router)
	deps.Lists.MountWebhookRoutes(deps.Router)
	deps.Lists.MountImportExportRoutes(deps.Router)
	subscribers.MountMergeRoutes(deps.Router, deps.Subscribers)
	subscribers.MountBulkMergeRoutes(deps.Router, deps.Subscribers)
	subscribers.MountTransformRuleRoutes(deps.Router, deps.Subscribers)
	subscribers.MountEngagementRoutes(deps.Router, deps.Subscribers)
	subscribers.MountCSVExportRoutes(deps.Router, deps.Subscribers)
	subscribers.MountTimelineRoutes(deps.Router, deps.Subscribers)
	subscribers.MountAttributeHistoryRoutes(deps.Router, deps.Subscribers)
	subscribers.MountSoftDeleteRoutes(deps.Router, deps.Subscribers)
	subscribers.MountAccountLinkRoutes(deps.Router, deps.Subscribers)
	subscribers.MountFederationRoutes(deps.Router, deps.Subscribers)
	subscribers.MountCatalogAttributesRoutes(deps.Router, deps.Subscribers)
	subscribers.MountReplenishmentCadenceRoutes(deps.Router, deps.Subscribers)
	subscribers.MountDemographicsRoutes(deps.Router, deps.Subscribers)
	subscribers.MountPredictionMetadataRoutes(deps.Router, deps.Subscribers)
	subscribers.MountDataExportRoutes(deps.Router, deps.Subscribers)
	subscribers.MountConsentReceiptRoutes(deps.Router, deps.Subscribers)
	subscribers.MountErasureReceiptRoutes(deps.Router, deps.Subscribers)
	subscribers.MountJurisdictionRoutes(deps.Router, deps.Subscribers)
	subscribers.MountBulkRoutes(deps.Router, deps.Subscribers)
	subscribers.MountImportTemplateRoutes(deps.Router, deps.Subscribers)
	subscribers.MountIdentityGraphRoutes(deps.Router, deps.Subscribers)
	subscribers.MountMultiEmailRoutes(deps.Router, deps.Subscribers)
	subscribers.MountChannelConsentRoutes(deps.Router, deps.Subscribers)
	subscribers.MountSendTimesRoutes(deps.Router, deps.Subscribers)
	subscribers.MountGroupMembershipRoutes(deps.Router, deps.Subscribers)
	subscribers.MountSubscriberEventRoutes(deps.Router, deps.Subscribers)
	subscribers.MountAuditLogRoutes(deps.Router, deps.Subscribers)
	subscribers.MountIdentifierTransformRoutes(deps.Router, deps.Subscribers)
	subscribers.MountPIIConfigRoutes(deps.Router, deps.Subscribers)
	subscribers.MountGppRoutes(deps.Router, deps.Subscribers)
	subscribers.MountDecisionExplanationRoutes(deps.Router, deps.Subscribers)
	subscribers.MountLookalikeRoutes(deps.Router, deps.Subscribers)
	subscribers.MountPreSendRefineRoutes(deps.Router, deps.Subscribers)
	subscribers.MountGrowthRoutes(deps.Router, deps.Subscribers)
	deps.IdempotentLists.MountIdempotentRoutes(deps.Router)
	subscribers.MountWrite(deps.Router, deps.Subscribers)
	subscribers.MountIdentifyRoutes(deps.Router, deps.Subscribers)
}

func subscriberListSegmentRoutes(t *testing.T, router chi.Router) []subscriberListSegmentRoute {
	t.Helper()
	var routes []subscriberListSegmentRoute
	if err := chi.Walk(router, func(method, path string, _ http.Handler, middlewares ...func(http.Handler) http.Handler) error {
		routes = append(routes, subscriberListSegmentRoute{method: method, path: path, middlewares: middlewares})
		return nil
	}); err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}
	sort.Slice(routes, func(i, j int) bool {
		if routes[i].path == routes[j].path {
			return routes[i].method < routes[j].method
		}
		return routes[i].path < routes[j].path
	})
	return routes
}

func serveRouteMiddleware(route subscriberListSegmentRoute, scopes []apikeys.Scope) *httptest.ResponseRecorder {
	terminal := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(299)
		_, _ = w.Write([]byte("scope-passed"))
	})
	var handler http.Handler = terminal
	for index := len(route.middlewares) - 1; index >= 0; index-- {
		handler = route.middlewares[index](handler)
	}
	request := httptest.NewRequest(route.method, materializeRoutePath(route.path), http.NoBody)
	ctx := middleware.WithAPIKeyAuth(request.Context())
	ctx = apikeys.WithScopes(ctx, scopes)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request.WithContext(ctx))
	return response
}

func materializeRoutePath(path string) string {
	for {
		open := strings.IndexByte(path, '{')
		if open < 0 {
			return path
		}
		closeOffset := strings.IndexByte(path[open:], '}')
		if closeOffset < 0 {
			return path
		}
		closeIndex := open + closeOffset
		path = path[:open] + "00000000-0000-0000-0000-000000000001" + path[closeIndex+1:]
	}
}
