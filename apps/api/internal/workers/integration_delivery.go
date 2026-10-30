// SPDX-License-Identifier: AGPL-3.0-only

package workers

import (
	"context"
	"errors"
	"log/slog"

	"github.com/postwave/postwave/apps/api/internal/audience_destinations"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/integration_writeback"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/server"
	"github.com/postwave/postwave/apps/api/internal/webhooks"
)

type WebhookAlertSenderDeps struct {
	Pool   *db.Pool
	Repo   *webhooks.Repo
	Mailer mailer.Mailer
	// From is the alert email's sender. Empty keeps the AlertSender's own
	// default, which only a moosewave.com SES identity can send.
	From   string
	Logger *slog.Logger
}

func NewWebhookAlertSender(deps WebhookAlertSenderDeps) *webhooks.AlertSender {
	if deps.Pool == nil || deps.Repo == nil {
		return nil
	}
	return &webhooks.AlertSender{
		Pool: deps.Pool, Repo: deps.Repo, Mailer: deps.Mailer, From: deps.From, Logger: deps.Logger,
	}
}

func StartWebhookAlertSender(ctx context.Context, deps WebhookAlertSenderDeps) *webhooks.AlertSender {
	worker := NewWebhookAlertSender(deps)
	if worker != nil {
		safego.Go(deps.Logger, "webhook-alert-sender", func() { worker.Run(ctx) })
	}
	return worker
}

type OutboundWebhookWorkerDeps struct {
	Pool          *db.Pool
	Store         *outbound_webhooks.Store
	Mailer        mailer.Mailer
	From          string
	PublicBaseURL string
	// Fanout, when wired, adds the in-app feed / web push / SSE / native mobile
	// push legs to the auto-disable alert (COMMERCE#3). nil keeps the historical
	// email-only behaviour, so a deployment without the notification stack is
	// unchanged rather than broken.
	Fanout *notifyfanout.Fanout
	Logger *slog.Logger
}

type OutboundWebhookWorkersSurface struct {
	AuthRewrap        *outbound_webhooks.AuthConfigRewrapWorker
	DestinationRewrap *outbound_webhooks.DestinationRewrapWorker
	Delivery          *outbound_webhooks.Worker
	Notifications     *outbound_webhooks.AutoDisableNotificationWorker
	Redaction         *outbound_webhooks.RedactionWorker
}

func NewOutboundWebhookWorkersSurface(deps OutboundWebhookWorkerDeps) OutboundWebhookWorkersSurface {
	if deps.Pool == nil || deps.Store == nil {
		return OutboundWebhookWorkersSurface{}
	}
	delivery := outbound_webhooks.NewWorker(deps.Store, deps.Logger)
	delivery.Metrics = &outbound_webhooks.PrometheusMetrics{}
	email := &outbound_webhooks.EmailAutoDisableNotifier{
		Pool:          deps.Pool,
		Mailer:        deps.Mailer,
		From:          deps.From,
		PublicBaseURL: deps.PublicBaseURL,
	}
	// COMMERCE#3 — the alert now reaches the phone as well as the inbox. The
	// fanout leg runs FIRST and the email LAST: the outbox worker retries on a
	// returned error, and only the fanout is safe to re-run (it dedupes on
	// DedupeKey). See MultiAutoDisableNotifier.
	var notifier outbound_webhooks.AutoDisableNotifier = email
	if deps.Fanout != nil {
		notifier = outbound_webhooks.MultiAutoDisableNotifier{
			&outbound_webhooks.FanoutAutoDisableNotifier{
				Pool:   deps.Pool,
				Fanout: deps.Fanout,
				Logger: deps.Logger,
			},
			email,
		}
	}
	return OutboundWebhookWorkersSurface{
		AuthRewrap:        &outbound_webhooks.AuthConfigRewrapWorker{Store: deps.Store, Logger: deps.Logger},
		DestinationRewrap: &outbound_webhooks.DestinationRewrapWorker{Store: deps.Store, Logger: deps.Logger},
		Delivery:          delivery,
		Notifications: &outbound_webhooks.AutoDisableNotificationWorker{
			Pool: deps.Pool, Notifier: notifier, Logger: deps.Logger,
		},
		Redaction: &outbound_webhooks.RedactionWorker{Pool: deps.Pool, Logger: deps.Logger},
	}
}

func StartOutboundWebhookWorkers(ctx context.Context, deps OutboundWebhookWorkerDeps) OutboundWebhookWorkersSurface {
	surface := NewOutboundWebhookWorkersSurface(deps)
	if surface.AuthRewrap != nil {
		safego.Go(deps.Logger, "outbound-webhooks-auth-rewrap", func() {
			if err := surface.AuthRewrap.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				deps.Logger.Warn("outbound_webhooks: receiver-auth rewrap worker exited", "err", err.Error())
			}
		})
	}
	if surface.DestinationRewrap != nil {
		safego.Go(deps.Logger, "outbound-webhooks-destination-rewrap", func() {
			if err := surface.DestinationRewrap.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				deps.Logger.Warn("outbound_webhooks: destination rewrap worker exited", "err", err.Error())
			}
		})
	}
	if surface.Delivery != nil {
		safego.Go(deps.Logger, "outbound-webhooks-worker", func() {
			if err := surface.Delivery.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				deps.Logger.Warn("outbound_webhooks: worker exited", "err", err.Error())
			}
		})
	}
	if surface.Notifications != nil {
		safego.Go(deps.Logger, "outbound-webhooks-operator-notifications", func() {
			if err := surface.Notifications.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				deps.Logger.Warn("outbound_webhooks: notification worker exited", "err", err.Error())
			}
		})
	}
	if surface.Redaction != nil {
		safego.Go(deps.Logger, "outbound-webhooks-redaction", func() {
			if err := surface.Redaction.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				deps.Logger.Warn("outbound_webhooks: redaction worker exited", "err", err.Error())
			}
		})
	}
	return surface
}

type AudienceActivationWorkerDeps struct {
	Pool    *db.Pool
	Surface server.AudienceActivationSurface
	Secrets audience_destinations.AudienceRuntimeSecretResolver
	Logger  *slog.Logger
}

type AudienceActivationWorkersSurface struct {
	SyncScheduler       *audience_destinations.SyncScheduler
	ProviderDiagnostics *audience_destinations.ProviderDiagnosticsPoller
	WritebackScheduler  *integration_writeback.Scheduler
}

func NewAudienceActivationWorkersSurface(deps AudienceActivationWorkerDeps) AudienceActivationWorkersSurface {
	if deps.Pool == nil || deps.Surface.SyncRepo == nil || deps.Surface.SyncRunner == nil || deps.Surface.Writeback == nil {
		return AudienceActivationWorkersSurface{}
	}
	return AudienceActivationWorkersSurface{
		SyncScheduler: &audience_destinations.SyncScheduler{
			Pool: deps.Pool, Runner: deps.Surface.SyncRunner, Logger: deps.Logger,
		},
		ProviderDiagnostics: &audience_destinations.ProviderDiagnosticsPoller{
			Repo:               deps.Surface.SyncRepo,
			Adapters:           deps.Surface.Adapters,
			CredentialResolver: audience_destinations.SecretsAudienceCredentialResolver{Secrets: deps.Secrets},
			Logger:             deps.Logger,
		},
		WritebackScheduler: &integration_writeback.Scheduler{
			Pool: deps.Pool, Deps: deps.Surface.Writeback, Logger: deps.Logger,
		},
	}
}

func StartAudienceActivationWorkers(ctx context.Context, deps AudienceActivationWorkerDeps) AudienceActivationWorkersSurface {
	surface := NewAudienceActivationWorkersSurface(deps)
	if surface.SyncScheduler != nil {
		safego.Go(deps.Logger, "audience-syncs-scheduler", func() {
			if err := surface.SyncScheduler.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				deps.Logger.Warn("audience_syncs: scheduler exited", "err", err.Error())
			}
		})
	}
	if surface.ProviderDiagnostics != nil {
		safego.Go(deps.Logger, "audience-provider-diagnostics", func() {
			if err := surface.ProviderDiagnostics.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				deps.Logger.Warn("audience_provider_diagnostics: poller exited", "err", err.Error())
			}
		})
	}
	if surface.WritebackScheduler != nil {
		safego.Go(deps.Logger, "integration-writeback-scheduler", func() {
			if err := surface.WritebackScheduler.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				deps.Logger.Warn("integration_writeback: scheduler exited", "err", err.Error())
			}
		})
	}
	return surface
}
