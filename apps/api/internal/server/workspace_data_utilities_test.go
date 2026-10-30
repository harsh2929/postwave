// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/aicompose"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/cdp_transforms"
	"github.com/postwave/postwave/apps/api/internal/customobjects"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/klaviyo_migrate"
	"github.com/postwave/postwave/apps/api/internal/retention"
	"github.com/postwave/postwave/apps/api/internal/settings"
	"github.com/postwave/postwave/apps/api/internal/translations"
)

func TestWorkspaceDataUtilitiesMatchEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newWorkspaceDataUtilitiesDeps(actualRouter)
	MountWorkspaceDataUtilities(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newWorkspaceDataUtilitiesDeps(referenceRouter)
	mountLegacyWorkspaceDataUtilities(referenceDeps)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("migrated route count = %d, legacy route count = %d", len(actual), len(reference))
	}
	if len(actual) != 39 {
		t.Fatalf("workspace-data utility route count = %d, want 39", len(actual))
	}
	for index := range reference {
		got, want := actual[index], reference[index]
		if got.method != want.method || got.path != want.path || len(got.middlewares) != len(want.middlewares) {
			t.Fatalf("route[%d] = %s %s (%d middleware), want %s %s (%d)", index, got.method, got.path, len(got.middlewares), want.method, want.path, len(want.middlewares))
		}
		for _, scopes := range [][]apikeys.Scope{
			nil,
			{apikeys.ScopeReadSubscribers},
			{apikeys.ScopeWriteSubscribers},
			{apikeys.ScopeAdmin},
			{apikeys.ScopeReadSubscribers, apikeys.ScopeWriteSubscribers, apikeys.ScopeAdmin},
		} {
			gotResponse := serveRouteMiddleware(got, scopes)
			wantResponse := serveRouteMiddleware(want, scopes)
			if gotResponse.Code != wantResponse.Code || gotResponse.Body.String() != wantResponse.Body.String() {
				t.Errorf("%s %s scopes %v = (%d,%q), want (%d,%q)", got.method, got.path, scopes, gotResponse.Code, gotResponse.Body.String(), wantResponse.Code, wantResponse.Body.String())
			}
		}
	}
}

func TestWorkspaceDataUtilitiesBoundaryOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	for _, incomplete := range []WorkspaceDataUtilitiesDeps{
		{Pool: &db.Pool{}},
		{Router: chi.NewRouter()},
	} {
		MountWorkspaceDataUtilities(incomplete)
		if incomplete.Router != nil && routeCount(t, incomplete.Router) != 0 {
			t.Fatal("structurally incomplete workspace-data dependencies registered routes")
		}
	}

	sourceBytes, err := os.ReadFile("workspace_data_utilities.go")
	if err != nil {
		t.Fatalf("read workspace_data_utilities.go: %v", err)
	}
	assertOrderedOccurrences(t, string(sourceBytes), []string{
		"settings.WorkspaceDeps",
		"settings.NotificationsDeps",
		"settings.PrivacyDeps",
		"settings.EmailComplianceDeps",
		"settings.SendTimeOptimizationDeps",
		"retentionRoutes.MountRoutes(",
		"customobjects.NewPostgresStore(",
		"customObjectRoutes.MountRoutes(",
		"customObjectRoutes.MountProfileLinkRoutes(",
		"cdp_transforms.MountRoutes(",
		"MountApplyRoutes(",
		"translations.MountRoutes(",
		"klaviyo_migrate.MountRoutes(",
	})

	root := readAPICompositionRoot(t)
	mainSource := root.main
	assertOrderedOccurrences(t, mainSource, []string{
		`"segment-event-worker"`,
		"apiserver.MountWorkspaceDataUtilities(",
		"apiserver.MountEngagementPreferencesAndWebhooks(",
	})
	for _, forbidden := range []string{
		"settings.WorkspaceDeps{",
		"customobjects.NewPostgresStore(",
		"cdp_transforms.MountRoutes(r)",
		"\n\t\ttranslations.MountRoutes(r,",
		"klaviyo_migrate.MountRoutes(r,",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated workspace-data composition %q", forbidden)
		}
	}
}

func newWorkspaceDataUtilitiesDeps(router chi.Router) WorkspaceDataUtilitiesDeps {
	pool := &db.Pool{}
	return WorkspaceDataUtilitiesDeps{
		Router:           router,
		Pool:             pool,
		Logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		RetentionSweeper: &retention.Sweeper{Pool: pool},
		VoiceServiceURL:  "http://voice.invalid",
	}
}

func mountLegacyWorkspaceDataUtilities(deps WorkspaceDataUtilitiesDeps) {
	router := deps.Router
	(&settings.WorkspaceDeps{Repo: &settings.WorkspaceRepo{Pool: deps.Pool}}).MountRoutes(router)
	(&settings.NotificationsDeps{Repo: &settings.NotificationsRepo{Pool: deps.Pool}}).MountRoutes(router)
	(&settings.PrivacyDeps{Repo: &settings.PrivacyRepo{Pool: deps.Pool}}).MountRoutes(router)
	(&settings.EmailComplianceDeps{Repo: &settings.EmailComplianceRepo{Pool: deps.Pool}}).MountRoutes(router)
	(&settings.SendTimeOptimizationDeps{Repo: &settings.SendTimeOptimizationRepo{Pool: deps.Pool}, Logger: deps.Logger}).MountRoutes(router)
	(&retention.HandlerDeps{Sweeper: deps.RetentionSweeper}).MountRoutes(router)
	if store, err := customobjects.NewPostgresStore(deps.Pool); err == nil {
		customObjectRoutes := &customobjects.Deps{Store: store, Logger: deps.Logger}
		customObjectRoutes.MountRoutes(router)
		customObjectRoutes.MountProfileLinkRoutes(router)
	}
	cdp_transforms.MountRoutes(router)
	(&cdp_transforms.Deps{Pool: deps.Pool}).MountApplyRoutes(router)
	translations.MountRoutes(router, &translations.Deps{
		Pool: deps.Pool, AI: &translations.HTTPAIGateway{Voice: aicompose.NewHTTPVoiceClient(deps.VoiceServiceURL, deps.InternalAPIToken)}, Logger: deps.Logger,
	})
	klaviyo_migrate.MountRoutes(router, &klaviyo_migrate.Deps{Logger: deps.Logger})
}
