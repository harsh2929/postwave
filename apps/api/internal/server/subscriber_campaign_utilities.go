// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/campaign_clone"
	"github.com/postwave/postwave/apps/api/internal/control_group"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/dedupeinfo"
	"github.com/postwave/postwave/apps/api/internal/dispatchcontrol"
	"github.com/postwave/postwave/apps/api/internal/email_validator"
	"github.com/postwave/postwave/apps/api/internal/feature_flags"
	"github.com/postwave/postwave/apps/api/internal/holdout"
	"github.com/postwave/postwave/apps/api/internal/html2text"
	"github.com/postwave/postwave/apps/api/internal/recipient_tz_send"
	"github.com/postwave/postwave/apps/api/internal/soft_bounce_recovery"
	"github.com/postwave/postwave/apps/api/internal/spam_trap_guard"
	"github.com/postwave/postwave/apps/api/internal/subscriber_dedupe"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
	"github.com/postwave/postwave/apps/api/internal/utm_tagging"
)

type SubscriberCampaignUtilitiesDeps struct {
	Router               chi.Router
	Pool                 *db.Pool
	Logger               *slog.Logger
	Suppressions         *suppressions.Store
	CampaignLiveDispatch dispatchcontrol.Gate
}

type SubscriberProtectionSurface struct {
	SpamTrapWorker *spam_trap_guard.Worker
}

func MountSubscriberProtectionUtilities(deps SubscriberCampaignUtilitiesDeps) SubscriberProtectionSurface {
	if deps.Router == nil || deps.Pool == nil {
		return SubscriberProtectionSurface{}
	}
	email_validator.MountRoutes(deps.Router, &email_validator.Deps{})
	holdout.MountRoutes(deps.Router, &holdout.Deps{Pool: deps.Pool})
	control_group.MountRoutes(deps.Router, &control_group.Deps{Repo: &control_group.Repo{Pool: deps.Pool}})
	subscriber_dedupe.MountRoutes(deps.Router, &subscriber_dedupe.Deps{Pool: deps.Pool})
	dedupeinfo.MountRoutes(deps.Router, &dedupeinfo.Deps{Repo: &dedupeinfo.Repo{Pool: deps.Pool}, Logger: deps.Logger})
	soft_bounce_recovery.MountRoutes(deps.Router, &soft_bounce_recovery.Deps{Pool: deps.Pool})
	spam_trap_guard.MountRoutes(deps.Router, &spam_trap_guard.Deps{Pool: deps.Pool, Suppressions: deps.Suppressions})
	return SubscriberProtectionSurface{SpamTrapWorker: &spam_trap_guard.Worker{
		Pool: deps.Pool, Logger: deps.Logger, Suppressions: deps.Suppressions,
	}}
}

func MountCampaignDeliveryUtilities(deps SubscriberCampaignUtilitiesDeps) {
	if deps.Router == nil || deps.Pool == nil {
		return
	}
	utm_tagging.MountRoutes(deps.Router, &utm_tagging.Deps{Pool: deps.Pool})
	recipient_tz_send.MountRoutes(deps.Router, &recipient_tz_send.Deps{
		Pool: deps.Pool, LiveDispatch: deps.CampaignLiveDispatch,
	})
	campaign_clone.MountRoutes(deps.Router, &campaign_clone.Deps{Pool: deps.Pool})
	html2text.MountRoutes(deps.Router, &html2text.Deps{})
	feature_flags.MountRoutes(deps.Router, &feature_flags.Deps{Pool: deps.Pool})
}
