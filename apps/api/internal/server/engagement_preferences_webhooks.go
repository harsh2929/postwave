// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/preferences"
	"github.com/postwave/postwave/apps/api/internal/subscription_types"
	"github.com/postwave/postwave/apps/api/internal/webhooks"
)

type EngagementPreferencesWebhookDeps struct {
	Router         chi.Router
	Pool           *db.Pool
	Logger         *slog.Logger
	WebhookRepo    *webhooks.Repo
	EnvelopeCipher webhooks.SecretWrapper
	Outbox         *outbox.Repo
}

type EngagementPreferencesWebhookSurface struct {
	Webhooks *webhooks.Deps
}

func MountEngagementPreferencesAndWebhooks(deps EngagementPreferencesWebhookDeps) EngagementPreferencesWebhookSurface {
	if deps.Router == nil || deps.Pool == nil || deps.WebhookRepo == nil {
		return EngagementPreferencesWebhookSurface{}
	}
	router := deps.Router
	preferencesRoutes := &preferences.Deps{Repo: &preferences.Repo{Pool: deps.Pool}}
	router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/topics", preferencesRoutes.ListTopics)
	router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/topics", preferencesRoutes.CreateTopic)
	router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Patch("/api/v1/topics/{id}", preferencesRoutes.UpdateTopic)
	router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/topics/{id}", preferencesRoutes.DeleteTopic)
	router.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/subscribers/{email}/topics", preferencesRoutes.ListSubscriberTopics)
	router.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Put("/api/v1/subscribers/{email}/topics", preferencesRoutes.PutSubscriberTopics)
	router.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post("/api/v1/subscribers/{email}/topics/{topicId}/subscribe", preferencesRoutes.SubscribeSubscriberTopic)
	router.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post("/api/v1/subscribers/{email}/topics/{topicId}/unsubscribe", preferencesRoutes.UnsubscribeSubscriberTopic)

	subscriptionTypeRoutes := &subscription_types.Deps{Repo: &subscription_types.Repo{Pool: deps.Pool}}
	router.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/subscription-types", subscriptionTypeRoutes.List)
	router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/subscription-types", subscriptionTypeRoutes.Create)
	router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Patch("/api/v1/subscription-types/{id}", subscriptionTypeRoutes.Update)
	router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/subscription-types/{id}", subscriptionTypeRoutes.Delete)
	router.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/subscribers/{id}/subscription-types", subscriptionTypeRoutes.ListForSubscriber)
	router.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post("/api/v1/subscribers/{id}/subscription-types/{type_id}/opt-out", subscriptionTypeRoutes.OptOut)
	router.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Delete("/api/v1/subscribers/{id}/subscription-types/{type_id}/opt-out", subscriptionTypeRoutes.OptIn)

	webhookRoutes := &webhooks.Deps{
		Repo: deps.WebhookRepo, HTTPClient: webhooks.DefaultClient, EnvelopeCipher: deps.EnvelopeCipher,
		Outbox: deps.Outbox, Logger: deps.Logger,
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	router.With(admin).Get("/api/v1/webhooks", webhookRoutes.List)
	router.With(admin).Post("/api/v1/webhooks", webhookRoutes.Create)
	router.With(admin).Patch("/api/v1/webhooks/{id}", webhookRoutes.Update)
	router.With(admin).Delete("/api/v1/webhooks/{id}", webhookRoutes.Delete)
	router.With(admin).Post("/api/v1/webhooks/{id}/test", webhookRoutes.Test)
	router.With(admin).Post("/api/v1/webhooks/{id}/rotate-secret", webhookRoutes.RotateSecret)
	router.With(admin).Get("/api/v1/webhooks/{id}/deliveries", webhookRoutes.Deliveries)
	router.With(admin).Get("/api/v1/webhooks/{id}/deliveries/{delivery_id}", webhookRoutes.GetDelivery)
	router.With(admin).Get("/api/v1/webhooks/{id}/health", webhookRoutes.HealthHandler)
	router.With(admin).Post("/api/v1/webhooks/{id}/re-enable", webhookRoutes.ReEnableHandler)
	router.With(admin).Get("/api/v1/webhooks/alert-prefs", webhookRoutes.GetAlertPrefsHandler)
	router.With(admin).Put("/api/v1/webhooks/alert-prefs", webhookRoutes.PutAlertPrefsHandler)
	router.With(admin).Get("/api/v1/webhooks/{id}/test-payloads", webhookRoutes.ListTestPayloadsHandler)
	router.With(admin).Post("/api/v1/webhooks/{id}/test-payloads", webhookRoutes.CreateTestPayloadHandler)
	router.With(admin).Delete("/api/v1/webhooks/test-payloads/{id}", webhookRoutes.DeleteTestPayloadHandler)
	router.With(admin).Patch("/api/v1/webhooks/{id}/environment", webhookRoutes.SetEnvironmentHandler)
	return EngagementPreferencesWebhookSurface{Webhooks: webhookRoutes}
}

func MountLegacyWebhookReplayRoute(router chi.Router, surface EngagementPreferencesWebhookSurface) {
	if router == nil || surface.Webhooks == nil {
		return
	}
	router.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post(
		"/api/v1/webhooks/{id}/deliveries/{delivery_id}/replay",
		surface.Webhooks.Replay,
	)
}
