// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/api_usage_dashboard"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/developer_marketplace"
	"github.com/postwave/postwave/apps/api/internal/dispatchcontrol"
	"github.com/postwave/postwave/apps/api/internal/integrations"
	"github.com/postwave/postwave/apps/api/internal/onboarding_progress"
	"github.com/postwave/postwave/apps/api/internal/reply_analytics"
	"github.com/postwave/postwave/apps/api/internal/resend_unopened"
	"github.com/postwave/postwave/apps/api/internal/subject_analyzer"
	"github.com/postwave/postwave/apps/api/internal/subscriber_notes"
	"github.com/postwave/postwave/apps/api/internal/uploads"
)

type PlatformCatalogRouteDeps struct {
	Router       chi.Router
	Pool         *db.Pool
	Logger       *slog.Logger
	ReviewSecret string
}

type PlatformCatalogSurface struct {
	APIUsage     *api_usage_dashboard.Deps
	Marketplace  *developer_marketplace.Deps
	Integrations *integrations.Deps
}

func MountPlatformCatalogRoutes(deps PlatformCatalogRouteDeps) PlatformCatalogSurface {
	if deps.Router == nil || deps.Pool == nil {
		return PlatformCatalogSurface{}
	}
	apiUsage := &api_usage_dashboard.Deps{Pool: deps.Pool}
	api_usage_dashboard.MountRoutes(deps.Router, apiUsage)
	marketplace := &developer_marketplace.Deps{
		Repo: &developer_marketplace.Repo{Pool: deps.Pool}, ReviewSecret: deps.ReviewSecret, Logger: deps.Logger,
	}
	developer_marketplace.MountRoutes(deps.Router, marketplace)
	integrationCatalog := &integrations.Deps{Pool: deps.Pool, Logger: deps.Logger}
	integrations.MountRoutes(deps.Router, integrationCatalog)
	return PlatformCatalogSurface{APIUsage: apiUsage, Marketplace: marketplace, Integrations: integrationCatalog}
}

type SubscriberCampaignInsightRouteDeps struct {
	Router               chi.Router
	Pool                 *db.Pool
	Logger               *slog.Logger
	Store                uploads.Store
	CampaignLiveDispatch dispatchcontrol.Gate
}

type SubscriberCampaignInsightSurface struct {
	Notes      *subscriber_notes.Deps
	Resend     *resend_unopened.Deps
	Replies    *reply_analytics.Deps
	Onboarding *onboarding_progress.Deps
	Subjects   *subject_analyzer.Deps
}

func MountSubscriberCampaignInsightRoutes(deps SubscriberCampaignInsightRouteDeps) SubscriberCampaignInsightSurface {
	if deps.Router == nil || deps.Pool == nil {
		return SubscriberCampaignInsightSurface{}
	}
	notes := &subscriber_notes.Deps{Pool: deps.Pool, Logger: deps.Logger, Store: deps.Store}
	subscriber_notes.MountRoutes(deps.Router, notes)
	resend := &resend_unopened.Deps{Pool: deps.Pool, LiveDispatch: deps.CampaignLiveDispatch}
	resend_unopened.MountRoutes(deps.Router, resend)
	MountSendWindowRoutes(Deps{Router: deps.Router, Pool: deps.Pool})
	replies := &reply_analytics.Deps{Pool: deps.Pool}
	reply_analytics.MountRoutes(deps.Router, replies)
	onboarding := &onboarding_progress.Deps{Pool: deps.Pool}
	onboarding_progress.MountRoutes(deps.Router, onboarding)
	subjects := &subject_analyzer.Deps{Pool: deps.Pool}
	subject_analyzer.MountRoutes(deps.Router, subjects)
	return SubscriberCampaignInsightSurface{
		Notes: notes, Resend: resend, Replies: replies, Onboarding: onboarding, Subjects: subjects,
	}
}
