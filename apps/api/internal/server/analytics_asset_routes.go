// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/analytics"
	"github.com/postwave/postwave/apps/api/internal/assets"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/postwave/postwave/apps/api/internal/holdout"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/reporting"
)

type AnalyticsReportingRouteDeps struct {
	Router                 chi.Router
	Pool                   *db.Pool
	Logger                 *slog.Logger
	HumanEngagementEnabled bool
}

type AnalyticsReportingSurface struct {
	Analytics                *analytics.ExtendedDeps
	EngagementClassification *engagementclassification.HandlerDeps
	Reporting                *reporting.Deps
}

func MountAnalyticsReportingRoutes(deps AnalyticsReportingRouteDeps) AnalyticsReportingSurface {
	if deps.Router == nil || deps.Pool == nil {
		return AnalyticsReportingSurface{}
	}
	var surface AnalyticsReportingSurface
	deps.Router.Group(func(router chi.Router) {
		router.Use(httpcache.WithPolicy(httpcache.HeavyRead()))
		surface.Analytics = analytics.NewExtendedWithLogger(deps.Pool, deps.Logger)
		surface.Analytics.HumanEngagementEnabled = deps.HumanEngagementEnabled
		surface.Analytics.MountRoutes(router)
		engagementRepo := &engagementclassification.Repo{Pool: deps.Pool}
		surface.EngagementClassification = &engagementclassification.HandlerDeps{
			Store:        engagementRepo,
			ReachRelease: engagementRepo,
			PoweredLift:  holdoutPoweredLiftAdapter{store: holdout.NewLiftResultStore(deps.Pool)},
			Logger:       deps.Logger,
		}
		surface.EngagementClassification.MountRoutes(router)
		surface.Reporting = &reporting.Deps{Repo: &reporting.Repo{Pool: deps.Pool}, Logger: deps.Logger}
		reporting.MountRoutes(router, surface.Reporting)
	})
	return surface
}

type AssetLibraryRouteDeps struct {
	Router  chi.Router
	Pool    *db.Pool
	Storage assets.Storage
	Logger  *slog.Logger
}

func MountAssetLibraryRoutes(deps AssetLibraryRouteDeps) *assets.Deps {
	if deps.Router == nil || deps.Pool == nil {
		return nil
	}
	assetRoutes := &assets.Deps{Repo: &assets.Repo{Pool: deps.Pool}, Storage: deps.Storage, Logger: deps.Logger}
	assetRoutes.MountRoutes(deps.Router)
	assetRoutes.MountFolderRoutes(deps.Router)
	assetRoutes.MountBulkRoutes(deps.Router)
	return assetRoutes
}
