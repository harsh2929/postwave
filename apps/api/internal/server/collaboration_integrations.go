// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/discordint"
	"github.com/postwave/postwave/apps/api/internal/slackint"
	"github.com/postwave/postwave/apps/api/internal/teamsint"
)

type CollaborationIntegrationDeps struct {
	Router      chi.Router
	SlackRepo   *slackint.Repo
	SlackOAuth  *slackint.OAuthDeps
	DiscordRepo *discordint.Repo
	TeamsRepo   *teamsint.Repo
}

type CollaborationIntegrationSurface struct {
	Slack      *slackint.Deps
	SlackOAuth *slackint.OAuthDeps
	Discord    *discordint.Deps
	Teams      *teamsint.Deps
}

func MountCollaborationIntegrations(deps CollaborationIntegrationDeps) CollaborationIntegrationSurface {
	if deps.Router == nil || deps.SlackRepo == nil || deps.SlackOAuth == nil || deps.DiscordRepo == nil || deps.TeamsRepo == nil {
		return CollaborationIntegrationSurface{}
	}

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

	return CollaborationIntegrationSurface{
		Slack: slackRoutes, SlackOAuth: deps.SlackOAuth, Discord: discordRoutes, Teams: teamsRoutes,
	}
}
