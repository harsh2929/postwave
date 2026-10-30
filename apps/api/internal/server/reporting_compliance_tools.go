// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"log/slog"

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
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/partition_rotator"
	"github.com/postwave/postwave/apps/api/internal/predictive"
	"github.com/postwave/postwave/apps/api/internal/privacy_portal"
	"github.com/postwave/postwave/apps/api/internal/sar"
	"github.com/postwave/postwave/apps/api/internal/scheduled_reports"
	"github.com/postwave/postwave/apps/api/internal/sender_reputation"
)

type ReportingComplianceToolsDeps struct {
	Router                  chi.Router
	Pool                    *db.Pool
	Logger                  *slog.Logger
	Storage                 exports.Storage
	PartitionRotator        *partition_rotator.Worker
	ConsentCursorSigningKey []byte
	PlaygroundSubjectAccess sar.PlaygroundSubjectAccess
}

func MountReportingComplianceTools(deps ReportingComplianceToolsDeps) {
	if deps.Router == nil || deps.Pool == nil {
		return
	}
	router := deps.Router
	exports.MountRetentionRoutes(router, &exports.Deps{Pool: deps.Pool, Storage: deps.Storage, Logger: deps.Logger})
	a11y.MountRoutes(router, &a11y.Deps{})
	MountScoringRoutes(Deps{Router: router, Pool: deps.Pool})
	predictive.MountRoutes(router, &predictive.Deps{Repo: &predictive.Repo{Pool: deps.Pool}})
	goals.MountRoutes(router, &goals.Deps{Pool: deps.Pool, Logger: deps.Logger})
	cohorts.MountRoutes(router, &cohorts.Deps{Pool: deps.Pool})
	scheduled_reports.MountRoutes(router, &scheduled_reports.Deps{Pool: deps.Pool})
	maintenance.MountAdminRoutes(router, &maintenance.Deps{Pool: deps.Pool})
	partitionRoutes := &partition_rotator.HandlerDeps{Worker: deps.PartitionRotator}
	partitionRoutes.MountRoutes(router.With(apikeys.RequireScope(apikeys.ScopeAdmin)))
	consent.MountRoutes(router, &consent.Deps{
		Pool:             deps.Pool,
		Logger:           deps.Logger,
		Outbox:           &outbox.Repo{Pool: deps.Pool},
		CursorSigningKey: append([]byte(nil), deps.ConsentCursorSigningKey...),
	})
	privacyPortal := &privacy_portal.Deps{Repo: &privacy_portal.Repo{Pool: deps.Pool}}
	privacyPortal.MountRoutes(router)
	sender_reputation.MountRoutes(router, &sender_reputation.Deps{Pool: deps.Pool})
	sar.MountRoutes(router, &sar.Deps{
		Pool: deps.Pool, Logger: deps.Logger,
		PlaygroundSubjectAccess: deps.PlaygroundSubjectAccess,
	})
	bot_open_filter.MountRoutes(router, &bot_open_filter.Deps{Pool: deps.Pool})
	domain_warmup.MountRoutes(router, &domain_warmup.Deps{Pool: deps.Pool})
	deliverability_control.MountRoutes(router, &deliverability_control.Deps{Repo: &deliverability_control.Repo{Pool: deps.Pool}})
	list_health.MountRoutes(router, &list_health.Deps{Pool: deps.Pool})
}
