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

	"github.com/postwave/postwave/apps/api/internal/a11y"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/bot_open_filter"
	"github.com/postwave/postwave/apps/api/internal/cohorts"
	"github.com/postwave/postwave/apps/api/internal/consent"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/deliverability_control"
	"github.com/postwave/postwave/apps/api/internal/domain_warmup"
	"github.com/postwave/postwave/apps/api/internal/exports"
	"github.com/postwave/postwave/apps/api/internal/goals"
	"github.com/postwave/postwave/apps/api/internal/list_health"
	"github.com/postwave/postwave/apps/api/internal/maintenance"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/partition_rotator"
	"github.com/postwave/postwave/apps/api/internal/predictive"
	"github.com/postwave/postwave/apps/api/internal/privacy_portal"
	"github.com/postwave/postwave/apps/api/internal/sar"
	"github.com/postwave/postwave/apps/api/internal/scheduled_reports"
	"github.com/postwave/postwave/apps/api/internal/sender_reputation"
)

func TestReportingComplianceToolsMatchEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newReportingComplianceToolsDeps(actualRouter)
	MountReportingComplianceTools(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newReportingComplianceToolsDeps(referenceRouter)
	mountLegacyReportingComplianceTools(referenceDeps)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("migrated route count = %d, legacy route count = %d", len(actual), len(reference))
	}
	if len(actual) != 76 {
		t.Fatalf("reporting/compliance route count = %d, want 76", len(actual))
	}
	for index := range reference {
		got, want := actual[index], reference[index]
		if got.method != want.method || got.path != want.path || len(got.middlewares) != len(want.middlewares) {
			t.Fatalf("route[%d] = %s %s (%d middleware), want %s %s (%d)", index, got.method, got.path, len(got.middlewares), want.method, want.path, len(want.middlewares))
		}
		for _, scopes := range [][]apikeys.Scope{
			nil,
			{apikeys.ScopeReadReports},
			{apikeys.ScopeAdmin},
			{apikeys.ScopeReadReports, apikeys.ScopeAdmin},
		} {
			gotResponse := serveRouteMiddleware(got, scopes)
			wantResponse := serveRouteMiddleware(want, scopes)
			if gotResponse.Code != wantResponse.Code || gotResponse.Body.String() != wantResponse.Body.String() {
				t.Errorf("%s %s scopes %v = (%d,%q), want (%d,%q)", got.method, got.path, scopes, gotResponse.Code, gotResponse.Body.String(), wantResponse.Code, wantResponse.Body.String())
			}
		}
	}
}

func TestReportingComplianceToolsStructuralBoundaryOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	for _, deps := range []ReportingComplianceToolsDeps{
		{Pool: &db.Pool{}},
		{Router: chi.NewRouter()},
	} {
		MountReportingComplianceTools(deps)
		if deps.Router != nil && routeCount(t, deps.Router) != 0 {
			t.Fatal("structurally incomplete reporting/compliance dependencies registered routes")
		}
	}

	sourceBytes, err := os.ReadFile("reporting_compliance_tools.go")
	if err != nil {
		t.Fatalf("read reporting_compliance_tools.go: %v", err)
	}
	assertOrderedOccurrences(t, string(sourceBytes), []string{
		"exports.MountRetentionRoutes(",
		"a11y.MountRoutes(",
		"MountScoringRoutes(",
		"predictive.MountRoutes(",
		"goals.MountRoutes(",
		"cohorts.MountRoutes(",
		"scheduled_reports.MountRoutes(",
		"maintenance.MountAdminRoutes(",
		"partitionRoutes.MountRoutes(",
		"consent.MountRoutes(",
		"privacyPortal.MountRoutes(",
		"sender_reputation.MountRoutes(",
		"sar.MountRoutes(",
		"bot_open_filter.MountRoutes(",
		"domain_warmup.MountRoutes(",
		"deliverability_control.MountRoutes(",
		"list_health.MountRoutes(",
	})

	root := readAPICompositionRoot(t)
	mainSource := root.main
	assertOrderedOccurrences(t, mainSource, []string{
		"runNBPBuilder(outboxCtx, logger, nbpBuilder)",
		"apiserver.MountReportingComplianceTools(",
		"listHealthHistoryWorker :=",
	})
	for _, forbidden := range []string{
		"a11y.MountRoutes(r,",
		"predictive.MountRoutes(r,",
		"goals.MountRoutes(r,",
		"privacy_portal.Deps{Repo:",
		"list_health.MountRoutes(r,",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated reporting/compliance registration %q", forbidden)
		}
	}
}

func TestReportingCompliancePartitionRotatorRouteIsAdminScopedAndExecutable(t *testing.T) {
	router := chi.NewRouter()
	deps := newReportingComplianceToolsDeps(router)
	deps.PartitionRotator = &partition_rotator.Worker{}
	MountReportingComplianceTools(deps)

	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/partition-rotator/run", http.NoBody)
	request = request.WithContext(middleware.WithAPIKeyAuth(request.Context()))
	unauthorized := httptest.NewRecorder()
	router.ServeHTTP(unauthorized, request)
	if unauthorized.Code != http.StatusForbidden || !strings.Contains(unauthorized.Body.String(), "insufficient_scope") {
		t.Fatalf("unscoped route = (%d,%q), want scoped 403", unauthorized.Code, unauthorized.Body.String())
	}

	adminRequest := httptest.NewRequest(http.MethodPost, "/api/v1/admin/partition-rotator/run", http.NoBody)
	adminContext := middleware.WithAPIKeyAuth(adminRequest.Context())
	adminContext = apikeys.WithScopes(adminContext, []apikeys.Scope{apikeys.ScopeAdmin})
	adminResponse := httptest.NewRecorder()
	router.ServeHTTP(adminResponse, adminRequest.WithContext(adminContext))
	if adminResponse.Code != http.StatusInternalServerError || !strings.Contains(adminResponse.Body.String(), `"code":"rotate_failed"`) {
		t.Fatalf("admin route = (%d,%q), want handler's nil-pool 500", adminResponse.Code, adminResponse.Body.String())
	}
}

func newReportingComplianceToolsDeps(router chi.Router) ReportingComplianceToolsDeps {
	deps := ReportingComplianceToolsDeps{
		Router:                  router,
		Pool:                    &db.Pool{},
		Logger:                  slog.New(slog.NewTextHandler(io.Discard, nil)),
		ConsentCursorSigningKey: []byte("0123456789abcdef0123456789abcdef"),
	}
	deps.PartitionRotator = &partition_rotator.Worker{Pool: deps.Pool, Logger: deps.Logger}
	return deps
}

func mountLegacyReportingComplianceTools(deps ReportingComplianceToolsDeps) {
	router := deps.Router
	exports.MountRetentionRoutes(router, &exports.Deps{Pool: deps.Pool, Storage: deps.Storage, Logger: deps.Logger})
	a11y.MountRoutes(router, &a11y.Deps{})
	MountScoringRoutes(Deps{Router: router, Pool: deps.Pool})
	predictive.MountRoutes(router, &predictive.Deps{Repo: &predictive.Repo{Pool: deps.Pool}})
	goals.MountRoutes(router, &goals.Deps{Pool: deps.Pool, Logger: deps.Logger})
	cohorts.MountRoutes(router, &cohorts.Deps{Pool: deps.Pool})
	scheduled_reports.MountRoutes(router, &scheduled_reports.Deps{Pool: deps.Pool})
	maintenance.MountAdminRoutes(router, &maintenance.Deps{Pool: deps.Pool})
	(&partition_rotator.HandlerDeps{Worker: deps.PartitionRotator}).MountRoutes(
		router.With(apikeys.RequireScope(apikeys.ScopeAdmin)),
	)
	consent.MountRoutes(router, &consent.Deps{Pool: deps.Pool})
	(&privacy_portal.Deps{Repo: &privacy_portal.Repo{Pool: deps.Pool}}).MountRoutes(router)
	sender_reputation.MountRoutes(router, &sender_reputation.Deps{Pool: deps.Pool})
	sar.MountRoutes(router, &sar.Deps{Pool: deps.Pool})
	bot_open_filter.MountRoutes(router, &bot_open_filter.Deps{Pool: deps.Pool})
	domain_warmup.MountRoutes(router, &domain_warmup.Deps{Pool: deps.Pool})
	deliverability_control.MountRoutes(router, &deliverability_control.Deps{Repo: &deliverability_control.Repo{Pool: deps.Pool}})
	list_health.MountRoutes(router, &list_health.Deps{Pool: deps.Pool})
}
