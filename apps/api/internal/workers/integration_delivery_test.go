// SPDX-License-Identifier: AGPL-3.0-only

package workers

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/audience_destinations"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/integration_writeback"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/server"
	"github.com/postwave/postwave/apps/api/internal/webhooks"
)

type integrationMailerStub struct{}

func (*integrationMailerStub) Send(context.Context, mailer.Message) error { return nil }

type audienceSecretsStub struct{}

func (*audienceSecretsStub) Get(context.Context, string) (string, error) { return "", nil }
func (*audienceSecretsStub) GetJSON(context.Context, string, any) error  { return nil }

func TestIntegrationDeliverySurfacesPreserveDependencyIdentity(t *testing.T) {
	t.Parallel()

	pool := &db.Pool{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	legacyRepo := &webhooks.Repo{Pool: pool}
	legacyMailer := &integrationMailerStub{}
	alert := NewWebhookAlertSender(WebhookAlertSenderDeps{
		Pool: pool, Repo: legacyRepo, Mailer: legacyMailer, Logger: logger,
	})
	if alert == nil || alert.Pool != pool || alert.Repo != legacyRepo || alert.Mailer != legacyMailer || alert.Logger != logger {
		t.Fatal("legacy webhook alert sender changed dependency identity")
	}

	store := &outbound_webhooks.Store{Pool: pool}
	outbound := NewOutboundWebhookWorkersSurface(OutboundWebhookWorkerDeps{
		Pool: pool, Store: store, Mailer: legacyMailer, From: "alerts@example.test",
		PublicBaseURL: "https://app.example.test", Logger: logger,
	})
	if outbound.AuthRewrap == nil || outbound.AuthRewrap.Store != store || outbound.AuthRewrap.Logger != logger {
		t.Fatal("outbound webhook receiver-auth rewrap worker changed dependency identity")
	}
	if outbound.DestinationRewrap == nil ||
		outbound.DestinationRewrap.Store != store ||
		outbound.DestinationRewrap.Logger != logger {
		t.Fatal("outbound webhook destination rewrap worker changed dependency identity")
	}
	if outbound.Delivery == nil || outbound.Delivery.Store != store || outbound.Delivery.Logger != logger || outbound.Delivery.HTTPClient == nil {
		t.Fatal("outbound webhook delivery worker changed dependency identity or secure client construction")
	}
	if outbound.Notifications == nil || outbound.Notifications.Pool != pool ||
		outbound.Notifications.Logger != logger {
		t.Fatal("outbound webhook notification outbox worker changed dependency identity")
	}
	notifier, ok := outbound.Notifications.Notifier.(*outbound_webhooks.EmailAutoDisableNotifier)
	if !ok || notifier.Pool != pool || notifier.Mailer != legacyMailer ||
		notifier.From != "alerts@example.test" ||
		notifier.PublicBaseURL != "https://app.example.test" {
		t.Fatal("outbound webhook auto-disable notifier is not fully wired")
	}
	if _, ok := outbound.Delivery.Metrics.(*outbound_webhooks.PrometheusMetrics); !ok {
		t.Fatal("outbound webhook production metrics sink is not wired")
	}
	if outbound.Redaction == nil || outbound.Redaction.Pool != pool || outbound.Redaction.Logger != logger {
		t.Fatal("outbound webhook redaction worker changed dependency identity")
	}

	syncRepo := &audience_destinations.Repo{Pool: pool}
	syncRunner := &audience_destinations.SyncRunner{Repo: syncRepo, Logger: logger}
	writeback := &integration_writeback.Deps{Logger: logger}
	adapters := audience_destinations.AdapterRegistry{"test": nil}
	secrets := &audienceSecretsStub{}
	audience := NewAudienceActivationWorkersSurface(AudienceActivationWorkerDeps{
		Pool: pool,
		Surface: server.AudienceActivationSurface{
			SyncRepo: syncRepo, SyncRunner: syncRunner, Writeback: writeback, Adapters: adapters,
		},
		Secrets: secrets,
		Logger:  logger,
	})
	if audience.SyncScheduler == nil || audience.SyncScheduler.Pool != pool || audience.SyncScheduler.Runner != syncRunner || audience.SyncScheduler.Logger != logger {
		t.Fatal("audience sync scheduler changed dependency identity")
	}
	if audience.ProviderDiagnostics == nil || audience.ProviderDiagnostics.Repo != syncRepo || audience.ProviderDiagnostics.Logger != logger ||
		len(audience.ProviderDiagnostics.Adapters) != 1 {
		t.Fatal("audience provider diagnostics changed graph identity")
	}
	resolver, ok := audience.ProviderDiagnostics.CredentialResolver.(audience_destinations.SecretsAudienceCredentialResolver)
	if !ok || resolver.Secrets != secrets {
		t.Fatal("audience provider diagnostics changed secret-resolver identity")
	}
	if audience.WritebackScheduler == nil || audience.WritebackScheduler.Pool != pool || audience.WritebackScheduler.Deps != writeback || audience.WritebackScheduler.Logger != logger {
		t.Fatal("integration write-back scheduler changed dependency identity")
	}
}

// The composition root hands the alert worker the configured platform sender,
// or "" when none is configured. Both must reach the worker unchanged: the
// configured sender is the only one a non-moosewave.com SES identity can send,
// and "" is what lets the worker keep its own default.
func TestWebhookAlertSenderCarriesTheSenderItIsGiven(t *testing.T) {
	t.Parallel()

	pool := &db.Pool{}
	repo := &webhooks.Repo{Pool: pool}
	for _, from := range []string{"Staging <noreply@staging.example.test>", ""} {
		alert := NewWebhookAlertSender(WebhookAlertSenderDeps{Pool: pool, Repo: repo, From: from})
		if alert == nil {
			t.Fatal("complete legacy webhook dependencies returned no worker")
		}
		if alert.From != from {
			t.Fatalf("webhook alert sender From = %q, want %q", alert.From, from)
		}
	}
}

func TestIntegrationDeliverySurfacesHonorStructuralNilBoundaries(t *testing.T) {
	t.Parallel()

	pool := &db.Pool{}
	if got := NewWebhookAlertSender(WebhookAlertSenderDeps{}); got != nil {
		t.Fatal("incomplete legacy webhook dependencies returned a worker")
	}
	if got := NewOutboundWebhookWorkersSurface(OutboundWebhookWorkerDeps{Pool: pool}); got != (OutboundWebhookWorkersSurface{}) {
		t.Fatal("incomplete outbound webhook dependencies returned workers")
	}
	if got := NewAudienceActivationWorkersSurface(AudienceActivationWorkerDeps{Pool: pool}); got != (AudienceActivationWorkersSurface{}) {
		t.Fatal("incomplete audience activation dependencies returned workers")
	}
	store := &outbound_webhooks.Store{Pool: pool}
	outbound := NewOutboundWebhookWorkersSurface(OutboundWebhookWorkerDeps{Pool: pool, Store: store})
	if outbound.AuthRewrap == nil || outbound.DestinationRewrap == nil ||
		outbound.Delivery == nil || outbound.Notifications == nil ||
		outbound.Redaction == nil {
		t.Fatal("complete outbound webhook dependencies did not return workers")
	}
}

func TestIntegrationDeliveryLaunchOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	workerBytes, err := os.ReadFile("integration_delivery.go")
	if err != nil {
		t.Fatalf("read integration_delivery.go: %v", err)
	}
	assertOperationalSourceOrder(t, string(workerBytes), []string{
		`"webhook-alert-sender"`,
		`"outbound-webhooks-auth-rewrap"`,
		`"outbound-webhooks-destination-rewrap"`,
		`"outbound-webhooks-worker"`,
		`"outbound-webhooks-operator-notifications"`,
		`"outbound-webhooks-redaction"`,
		`"audience-syncs-scheduler"`,
		`"audience-provider-diagnostics"`,
		`"integration-writeback-scheduler"`,
	})

	root := readAPICompositionRoot(t)
	mainSource := root.main
	assertOperationalSourceOrder(t, mainSource, []string{
		"apiworkers.StartWebhookAlertSender(outboxCtx,",
		"apiworkers.StartOutboundWebhookWorkers(outboxCtx,",
		"apiserver.MountAudienceActivationSurface(",
		"apiworkers.StartAudienceActivationWorkers(outboxCtx,",
	})
	for _, forbidden := range []string{
		"alertSender :=",
		"outboundWebhooksDispatcher :=",
		"outboundWebhooksWorker :=",
		"redactionWorker :=",
		"audienceSyncScheduler :=",
		"audienceProviderDiagnosticsPoller :=",
		"writebackScheduler :=",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated integration-delivery composition %q", forbidden)
		}
	}
}
