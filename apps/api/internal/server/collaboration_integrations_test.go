// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/discordint"
	"github.com/postwave/postwave/apps/api/internal/slackint"
	"github.com/postwave/postwave/apps/api/internal/teamsint"
)

func TestCollaborationIntegrationsMatchEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newCollaborationIntegrationDeps(actualRouter)
	MountCollaborationIntegrations(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newCollaborationIntegrationDeps(referenceRouter)
	mountLegacyCollaborationIntegrations(referenceDeps)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("migrated route count = %d, legacy route count = %d", len(actual), len(reference))
	}
	if len(actual) != 22 {
		t.Fatalf("collaboration integration route count = %d, want 22", len(actual))
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

func TestCollaborationIntegrationSurfacePreservesSharedDependencyIdentity(t *testing.T) {
	t.Parallel()

	deps := newCollaborationIntegrationDeps(chi.NewRouter())
	surface := MountCollaborationIntegrations(deps)
	if surface.Slack == nil || surface.Discord == nil || surface.Teams == nil {
		t.Fatal("complete dependencies returned an incomplete collaboration surface")
	}
	if surface.Slack.Repo != deps.SlackRepo || surface.Slack.Logger != nil ||
		surface.SlackOAuth != deps.SlackOAuth || surface.Discord.Repo != deps.DiscordRepo ||
		surface.Discord.Logger != nil || surface.Teams.Repo != deps.TeamsRepo || surface.Teams.Logger != nil {
		t.Fatal("collaboration surface changed repository, OAuth, or legacy nil-logger identity")
	}

	for _, incomplete := range []CollaborationIntegrationDeps{
		{SlackRepo: deps.SlackRepo, SlackOAuth: deps.SlackOAuth, DiscordRepo: deps.DiscordRepo, TeamsRepo: deps.TeamsRepo},
		{Router: chi.NewRouter(), SlackOAuth: deps.SlackOAuth, DiscordRepo: deps.DiscordRepo, TeamsRepo: deps.TeamsRepo},
		{Router: chi.NewRouter(), SlackRepo: deps.SlackRepo, DiscordRepo: deps.DiscordRepo, TeamsRepo: deps.TeamsRepo},
		{Router: chi.NewRouter(), SlackRepo: deps.SlackRepo, SlackOAuth: deps.SlackOAuth, TeamsRepo: deps.TeamsRepo},
		{Router: chi.NewRouter(), SlackRepo: deps.SlackRepo, SlackOAuth: deps.SlackOAuth, DiscordRepo: deps.DiscordRepo},
	} {
		incompleteSurface := MountCollaborationIntegrations(incomplete)
		if incompleteSurface.Slack != nil || incompleteSurface.SlackOAuth != nil || incompleteSurface.Discord != nil || incompleteSurface.Teams != nil {
			t.Fatal("structurally incomplete dependencies returned a partial collaboration surface")
		}
		if incomplete.Router != nil && routeCount(t, incomplete.Router) != 0 {
			t.Fatal("structurally incomplete dependencies registered partial routes")
		}
	}
}

func TestCollaborationIntegrationRegistrationOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("collaboration_integrations.go")
	if err != nil {
		t.Fatalf("read collaboration_integrations.go: %v", err)
	}
	assertOrderedOccurrences(t, string(sourceBytes), []string{
		"slackRoutes :=",
		`Get("/api/v1/integrations/slack"`,
		`Delete("/api/v1/integrations/slack-workspace"`,
		`Get("/api/v1/slack/oauth/start"`,
		`Get("/api/v1/integrations/slack/availability"`,
		"discordRoutes :=",
		`Get("/api/v1/integrations/discord"`,
		`Delete("/api/v1/integrations/discord/{id}"`,
		"teamsRoutes :=",
		`Get("/api/v1/integrations/teams"`,
		`Delete("/api/v1/integrations/teams/{id}"`,
	})

	root := readAPICompositionRoot(t)
	mainSource := root.main
	assertOrderedOccurrences(t, mainSource, []string{
		"apiserver.MountConversionAdminRoutes(r, pool)",
		"apiserver.MountCollaborationIntegrations(",
		"apiserver.MountCampaignABTestRoutes(",
	})
	for _, forbidden := range []string{
		"slackDeps :=",
		"discordDeps :=",
		"teamsDeps :=",
		`r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/integrations/slack"`,
		`r.Get("/api/v1/integrations/slack/availability"`,
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated collaboration integration composition %q", forbidden)
		}
	}
}

func newCollaborationIntegrationDeps(router chi.Router) CollaborationIntegrationDeps {
	pool := &db.Pool{}
	return CollaborationIntegrationDeps{
		Router:      router,
		SlackRepo:   &slackint.Repo{Pool: pool},
		SlackOAuth:  &slackint.OAuthDeps{},
		DiscordRepo: &discordint.Repo{Pool: pool},
		TeamsRepo:   &teamsint.Repo{Pool: pool},
	}
}

func mountLegacyCollaborationIntegrations(deps CollaborationIntegrationDeps) {
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	slackRoutes := &slackint.Deps{Repo: deps.SlackRepo}
	deps.Router.With(admin).Get("/api/v1/integrations/slack", slackRoutes.List)
	deps.Router.With(admin).Post("/api/v1/integrations/slack", slackRoutes.Create)
	deps.Router.With(admin).Patch("/api/v1/integrations/slack/{id}", slackRoutes.Update)
	deps.Router.With(admin).Delete("/api/v1/integrations/slack/{id}", slackRoutes.Delete)
	deps.Router.With(admin).Post("/api/v1/integrations/slack/{id}/test", slackRoutes.Test)
	deps.Router.With(admin).Get("/api/v1/integrations/slack/{id}/deliveries", slackRoutes.Deliveries)
	deps.Router.With(admin).Get("/api/v1/integrations/slack-workspace", slackRoutes.GetWorkspaceConnection)
	deps.Router.With(admin).Delete("/api/v1/integrations/slack-workspace", slackRoutes.DisconnectWorkspaceConnection)
	deps.Router.With(admin).Get("/api/v1/slack/oauth/start", deps.SlackOAuth.OAuthStartHandler)
	deps.Router.Get("/api/v1/integrations/slack/availability", deps.SlackOAuth.AvailabilityHandler)

	discordRoutes := &discordint.Deps{Repo: deps.DiscordRepo}
	deps.Router.With(admin).Get("/api/v1/integrations/discord", discordRoutes.List)
	deps.Router.With(admin).Post("/api/v1/integrations/discord", discordRoutes.Create)
	deps.Router.With(admin).Patch("/api/v1/integrations/discord/{id}", discordRoutes.Update)
	deps.Router.With(admin).Delete("/api/v1/integrations/discord/{id}", discordRoutes.Delete)
	deps.Router.With(admin).Post("/api/v1/integrations/discord/{id}/test", discordRoutes.Test)
	deps.Router.With(admin).Get("/api/v1/integrations/discord/{id}/deliveries", discordRoutes.Deliveries)

	teamsRoutes := &teamsint.Deps{Repo: deps.TeamsRepo}
	deps.Router.With(admin).Get("/api/v1/integrations/teams", teamsRoutes.List)
	deps.Router.With(admin).Post("/api/v1/integrations/teams", teamsRoutes.Create)
	deps.Router.With(admin).Patch("/api/v1/integrations/teams/{id}", teamsRoutes.Update)
	deps.Router.With(admin).Delete("/api/v1/integrations/teams/{id}", teamsRoutes.Delete)
	deps.Router.With(admin).Post("/api/v1/integrations/teams/{id}/test", teamsRoutes.Test)
	deps.Router.With(admin).Get("/api/v1/integrations/teams/{id}/deliveries", teamsRoutes.Deliveries)
}
