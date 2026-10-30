// SPDX-License-Identifier: AGPL-3.0-only
package workers

import (
	"context"
	"errors"
	"log/slog"

	"github.com/postwave/postwave/apps/api/internal/inbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/safego"
)

func NewInboundWebhookSecretMaintenanceWorker(
	repo *inbound_webhooks.Repo,
	logger *slog.Logger,
) *inbound_webhooks.SecretMaintenanceWorker {
	if repo == nil || repo.Pool == nil || repo.Cipher == nil {
		return nil
	}
	return &inbound_webhooks.SecretMaintenanceWorker{
		Repo:   repo,
		Logger: logger,
	}
}

func StartInboundWebhookSecretMaintenanceWorker(
	ctx context.Context,
	repo *inbound_webhooks.Repo,
	logger *slog.Logger,
) *inbound_webhooks.SecretMaintenanceWorker {
	worker := NewInboundWebhookSecretMaintenanceWorker(repo, logger)
	if worker == nil {
		return nil
	}
	safego.Go(logger, "inbound-webhook-secret-maintenance", func() {
		if err := worker.Run(ctx); err != nil && !errors.Is(err, context.Canceled) && logger != nil {
			logger.Warn("inbound webhook secret maintenance worker exited",
				"error_code", "worker_exited")
		}
	})
	return worker
}
