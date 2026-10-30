// SPDX-License-Identifier: AGPL-3.0-only
package workers

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/inbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/safego"
)

type InboundWebhookActionWorkerDeps struct {
	Repo                 *inbound_webhooks.Repo
	Executor             inbound_webhooks.ActionExecutor
	AutomationServiceURL string
	InternalAPIToken     string
	HTTPClient           *http.Client
	Logger               *slog.Logger
	MatchLogger          func(inbound_webhooks.Match)
}

func NewInboundWebhookActionWorker(
	deps InboundWebhookActionWorkerDeps,
) *inbound_webhooks.ActionWorker {
	if deps.Repo == nil || deps.Repo.Pool == nil {
		return nil
	}
	return &inbound_webhooks.ActionWorker{
		Repo:                 deps.Repo,
		Executor:             deps.Executor,
		AutomationServiceURL: deps.AutomationServiceURL,
		InternalAPIToken:     deps.InternalAPIToken,
		HTTPClient:           deps.HTTPClient,
		Logger:               deps.Logger,
		MatchLogger:          deps.MatchLogger,
	}
}

func StartInboundWebhookActionWorker(
	ctx context.Context,
	deps InboundWebhookActionWorkerDeps,
) *inbound_webhooks.ActionWorker {
	worker := NewInboundWebhookActionWorker(deps)
	if worker == nil {
		return nil
	}
	safego.Go(deps.Logger, "inbound-webhook-actions", func() {
		if err := worker.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			if deps.Logger != nil {
				deps.Logger.Warn("inbound webhook action worker exited",
					"error_code", "worker_exited")
			}
		}
	})
	return worker
}
