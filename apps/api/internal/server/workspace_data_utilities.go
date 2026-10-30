// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/aicompose"
	"github.com/postwave/postwave/apps/api/internal/cdp_transforms"
	"github.com/postwave/postwave/apps/api/internal/customobjects"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/klaviyo_migrate"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/retention"
	"github.com/postwave/postwave/apps/api/internal/settings"
	"github.com/postwave/postwave/apps/api/internal/translations"
)

type WorkspaceDataUtilitiesDeps struct {
	Router           chi.Router
	Pool             *db.Pool
	Logger           *slog.Logger
	RetentionSweeper *retention.Sweeper
	VoiceServiceURL  string
	InternalAPIToken string
	// Mailer + FromAddress power the notifications test-send action
	// (SETC-053); optional — a nil Mailer makes that endpoint return 503.
	Mailer      mailer.Mailer
	FromAddress string
}

func MountWorkspaceDataUtilities(deps WorkspaceDataUtilitiesDeps) {
	if deps.Router == nil || deps.Pool == nil {
		return
	}
	router := deps.Router
	(&settings.WorkspaceDeps{Repo: &settings.WorkspaceRepo{Pool: deps.Pool}}).MountRoutes(router)
	(&settings.NotificationsDeps{
		Repo:        &settings.NotificationsRepo{Pool: deps.Pool},
		Logger:      deps.Logger,
		Mailer:      deps.Mailer,
		FromAddress: deps.FromAddress,
	}).MountRoutes(router)
	(&settings.PrivacyDeps{Repo: &settings.PrivacyRepo{Pool: deps.Pool}}).MountRoutes(router)
	(&settings.EmailComplianceDeps{Repo: &settings.EmailComplianceRepo{Pool: deps.Pool}}).MountRoutes(router)
	(&settings.SendTimeOptimizationDeps{
		Repo: &settings.SendTimeOptimizationRepo{Pool: deps.Pool}, Logger: deps.Logger,
	}).MountRoutes(router)
	retentionRoutes := &retention.HandlerDeps{Sweeper: deps.RetentionSweeper}
	retentionRoutes.MountRoutes(router)
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
