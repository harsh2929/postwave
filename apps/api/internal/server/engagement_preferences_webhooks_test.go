// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/preferences"
	"github.com/postwave/postwave/apps/api/internal/subscription_types"
	"github.com/postwave/postwave/apps/api/internal/webhooks"
)

func TestEngagementPreferencesAndWebhooksMatchEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newEngagementPreferencesWebhookDeps(actualRouter)
	actualSurface := MountEngagementPreferencesAndWebhooks(actualDeps)
	MountLegacyWebhookReplayRoute(actualRouter, actualSurface)

	referenceRouter := chi.NewRouter()
	referenceDeps := newEngagementPreferencesWebhookDeps(referenceRouter)
	mountLegacyEngagementPreferencesAndWebhooks(referenceDeps)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("migrated route count = %d, legacy route count = %d", len(actual), len(reference))
	}
	if len(actual) != 32 {
		t.Fatalf("engagement/preferences/webhook route count = %d, want 32", len(actual))
	}
	for index := range reference {
		got, want := actual[index], reference[index]
		if got.method != want.method || got.path != want.path || len(got.middlewares) != len(want.middlewares) {
			t.Fatalf("route[%d] = %s %s (%d middleware), want %s %s (%d)", index, got.method, got.path, len(got.middlewares), want.method, want.path, len(want.middlewares))
		}
		for _, scopes := range [][]apikeys.Scope{
			nil,
			{apikeys.ScopeReadSubscribers},
			{apikeys.ScopeWriteSubscribers},
			{apikeys.ScopeAdmin},
			{apikeys.ScopeReadSubscribers, apikeys.ScopeWriteSubscribers, apikeys.ScopeAdmin},
		} {
			gotResponse := serveRouteMiddleware(got, scopes)
			wantResponse := serveRouteMiddleware(want, scopes)
			if gotResponse.Code != wantResponse.Code || gotResponse.Body.String() != wantResponse.Body.String() {
				t.Errorf("%s %s scopes %v = (%d,%q), want (%d,%q)", got.method, got.path, scopes, gotResponse.Code, gotResponse.Body.String(), wantResponse.Code, wantResponse.Body.String())
			}
		}
	}
}

func TestEngagementWebhookSurfacePreservesSharedDependencyIdentity(t *testing.T) {
	t.Parallel()

	deps := newEngagementPreferencesWebhookDeps(chi.NewRouter())
	surface := MountEngagementPreferencesAndWebhooks(deps)
	if surface.Webhooks == nil {
		t.Fatal("complete dependencies returned a nil webhook surface")
	}
	if surface.Webhooks.Repo != deps.WebhookRepo || surface.Webhooks.EnvelopeCipher != deps.EnvelopeCipher ||
		surface.Webhooks.Outbox != deps.Outbox || surface.Webhooks.Logger != deps.Logger ||
		surface.Webhooks.HTTPClient != webhooks.DefaultClient {
		t.Fatal("webhook surface changed shared repository, cipher, outbox, logger, or HTTP-client identity")
	}

	for _, incomplete := range []EngagementPreferencesWebhookDeps{
		{Pool: deps.Pool, WebhookRepo: deps.WebhookRepo},
		{Router: chi.NewRouter(), WebhookRepo: deps.WebhookRepo},
		{Router: chi.NewRouter(), Pool: deps.Pool},
	} {
		incompleteSurface := MountEngagementPreferencesAndWebhooks(incomplete)
		MountLegacyWebhookReplayRoute(incomplete.Router, incompleteSurface)
		if incompleteSurface.Webhooks != nil {
			t.Fatal("structurally incomplete dependencies returned a webhook surface")
		}
		if incomplete.Router != nil && routeCount(t, incomplete.Router) != 0 {
			t.Fatal("structurally incomplete dependencies registered partial routes")
		}
	}

	replayOnlyRouter := chi.NewRouter()
	MountLegacyWebhookReplayRoute(replayOnlyRouter, EngagementPreferencesWebhookSurface{})
	if routeCount(t, replayOnlyRouter) != 0 {
		t.Fatal("nil webhook surface registered the replay route")
	}
}

func TestEngagementPreferencesWebhookRegistrationOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("engagement_preferences_webhooks.go")
	if err != nil {
		t.Fatalf("read engagement_preferences_webhooks.go: %v", err)
	}
	assertOrderedOccurrences(t, string(sourceBytes), []string{
		"preferencesRoutes :=",
		`Get("/api/v1/topics"`,
		`Post("/api/v1/subscribers/{email}/topics/{topicId}/unsubscribe"`,
		"subscriptionTypeRoutes :=",
		`Get("/api/v1/subscription-types"`,
		`Delete("/api/v1/subscribers/{id}/subscription-types/{type_id}/opt-out"`,
		"webhookRoutes :=",
		`Get("/api/v1/webhooks"`,
		`Get("/api/v1/webhooks/{id}/deliveries/{delivery_id}"`,
		`Patch("/api/v1/webhooks/{id}/environment"`,
		"return EngagementPreferencesWebhookSurface",
		"func MountLegacyWebhookReplayRoute",
		`Post(`,
		`"/api/v1/webhooks/{id}/deliveries/{delivery_id}/replay"`,
	})

	root := readAPICompositionRoot(t)
	mainSource := root.main
	assertOrderedOccurrences(t, mainSource, []string{
		"outboundWebhooksStore :=",
		"OutboundWebhooks:   outboundWebhooksStore,",
		"apiserver.MountListRoutes(",
		"apiserver.MountWorkspaceDataUtilities(",
		"apiserver.MountEngagementPreferencesAndWebhooks(",
		"apiworkers.StartWebhookAlertSender(",
		"apiserver.MountLegacyWebhookReplayRoute(",
		"outboundWebhooksDeps :=",
		"Store:                      outboundWebhooksStore,",
		"outboundWebhooksDeps.MountRoutes(",
		"apiworkers.StartOutboundWebhookWorkers(",
		"Store:         outboundWebhooksStore,",
	})
	for _, forbidden := range []string{
		"prefDeps :=",
		"subTypeDeps :=",
		"whDeps :=",
		`r.With(admin).Get("/api/v1/webhooks"`,
		`r.With(admin).Post("/api/v1/webhooks/{id}/deliveries/{delivery_id}/replay"`,
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated engagement/preferences/webhook composition %q", forbidden)
		}
	}
}

type engagementWebhookCipher struct {
	marker int
}

func (*engagementWebhookCipher) Encrypt(_ context.Context, plaintext []byte) ([]byte, error) {
	return plaintext, nil
}

func newEngagementPreferencesWebhookDeps(router chi.Router) EngagementPreferencesWebhookDeps {
	pool := &db.Pool{}
	return EngagementPreferencesWebhookDeps{
		Router:         router,
		Pool:           pool,
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		WebhookRepo:    &webhooks.Repo{Pool: pool},
		EnvelopeCipher: &engagementWebhookCipher{marker: 1},
		Outbox:         &outbox.Repo{Pool: pool},
	}
}

func mountLegacyEngagementPreferencesAndWebhooks(deps EngagementPreferencesWebhookDeps) {
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
	router.With(admin).Post("/api/v1/webhooks/{id}/deliveries/{delivery_id}/replay", webhookRoutes.Replay)
}
