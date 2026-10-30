// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pushsuppressions"
	"github.com/postwave/postwave/apps/api/internal/sms"
	"github.com/postwave/postwave/apps/api/internal/social_capture"
	"github.com/postwave/postwave/apps/api/internal/sto_content_optimizer"
)

type MessagingEngagementRouteDeps struct {
	Router                          chi.Router
	Pool                            *db.Pool
	Logger                          *slog.Logger
	SMS                             *sms.Deps
	SocialCapture                   *social_capture.Deps
	PushSuppressionCursorSigningKey []byte
}

type MessagingEngagementSurface struct {
	SMS              *sms.Deps
	PushSuppressions *pushsuppressions.Deps
	ContentOptimizer *sto_content_optimizer.Deps
	SocialCapture    *social_capture.Deps
}

func MountMessagingEngagementRoutes(deps MessagingEngagementRouteDeps) MessagingEngagementSurface {
	if deps.Router == nil || deps.Pool == nil || deps.SMS == nil || deps.SocialCapture == nil {
		return MessagingEngagementSurface{}
	}
	deps.SMS.MountRoutes(deps.Router)
	pushSuppressions := &pushsuppressions.Deps{
		Pool: deps.Pool, Logger: deps.Logger,
		CursorSigningKey: append([]byte(nil), deps.PushSuppressionCursorSigningKey...),
	}
	pushSuppressions.MountRoutes(deps.Router)
	contentOptimizer := &sto_content_optimizer.Deps{
		Pool: deps.Pool, Repo: &sto_content_optimizer.Repo{Pool: deps.Pool}, Logger: deps.Logger,
	}
	contentOptimizer.MountRoutes(deps.Router)
	social_capture.MountRoutes(deps.Router, deps.SocialCapture)
	deps.SMS.MountInboxRoutes(deps.Router)
	deps.SMS.MountInboxExtraRoutes(deps.Router)
	return MessagingEngagementSurface{
		SMS: deps.SMS, PushSuppressions: pushSuppressions,
		ContentOptimizer: contentOptimizer, SocialCapture: deps.SocialCapture,
	}
}
