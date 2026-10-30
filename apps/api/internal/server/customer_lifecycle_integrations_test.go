// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/loyalty_integrations"
	"github.com/postwave/postwave/apps/api/internal/review_integrations"
	"github.com/postwave/postwave/apps/api/internal/reviews"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/subscription_integrations"
)

func TestCustomerLifecycleIntegrationMountsMatchEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newCustomerLifecycleIntegrationDeps(actualRouter)
	actualSurface := NewCustomerLifecycleIntegrationsSurface(actualDeps)
	MountReviewLifecycleRoutes(actualRouter, actualSurface)
	MountLoyaltyLifecycleRoutes(actualRouter, actualSurface)
	MountSubscriptionLifecycleRoutes(actualRouter, actualSurface)

	referenceRouter := chi.NewRouter()
	referenceDeps := newCustomerLifecycleIntegrationDeps(referenceRouter)
	referenceSurface := NewCustomerLifecycleIntegrationsSurface(referenceDeps)
	reviews.MountRoutes(referenceRouter, referenceSurface.Reviews)
	review_integrations.MountRoutes(referenceRouter, referenceSurface.ReviewDependencies)
	review_integrations.MountPublicRoutes(referenceRouter, referenceSurface.ReviewDependencies)
	loyalty_integrations.MountRoutes(referenceRouter, referenceSurface.LoyaltyDependencies)
	loyalty_integrations.MountPublicRoutes(referenceRouter, referenceSurface.LoyaltyDependencies)
	subscription_integrations.MountRoutes(referenceRouter, referenceSurface.SubscriptionDependencies)
	subscription_integrations.MountPublicRoutes(referenceRouter, referenceSurface.SubscriptionDependencies)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("migrated route count = %d, legacy route count = %d", len(actual), len(reference))
	}
	if len(actual) != 65 {
		t.Fatalf("customer-lifecycle route count = %d, want 65", len(actual))
	}
	for index := range reference {
		got, want := actual[index], reference[index]
		if got.method != want.method || got.path != want.path || len(got.middlewares) != len(want.middlewares) {
			t.Fatalf("route[%d] = %s %s (%d middleware), want %s %s (%d)", index, got.method, got.path, len(got.middlewares), want.method, want.path, len(want.middlewares))
		}
		for _, scopes := range [][]apikeys.Scope{nil, {apikeys.ScopeReadReports}, {apikeys.ScopeAdmin}, {apikeys.ScopeReadReports, apikeys.ScopeAdmin}} {
			gotResponse := serveRouteMiddleware(got, scopes)
			wantResponse := serveRouteMiddleware(want, scopes)
			if gotResponse.Code != wantResponse.Code || gotResponse.Body.String() != wantResponse.Body.String() {
				t.Errorf("%s %s scopes %v = (%d,%q), want (%d,%q)", got.method, got.path, scopes, gotResponse.Code, gotResponse.Body.String(), wantResponse.Code, wantResponse.Body.String())
			}
		}
	}
}

func TestCustomerLifecycleIntegrationsPreserveGraphAndWorkerIdentity(t *testing.T) {
	t.Parallel()

	deps := newCustomerLifecycleIntegrationDeps(chi.NewRouter())
	surface := NewCustomerLifecycleIntegrationsSurface(deps)
	if surface.Reviews == nil || surface.ReviewRepository == nil || surface.ReviewDependencies == nil ||
		surface.LoyaltyRepository == nil || surface.LoyaltyDependencies == nil ||
		surface.SubscriptionRepository == nil || surface.SubscriptionDependencies == nil {
		t.Fatal("customer-lifecycle surface returned an incomplete graph")
	}
	if surface.Reviews.Repo.Pool != deps.Pool || surface.ReviewRepository.Pool != deps.Pool ||
		surface.LoyaltyRepository.Pool != deps.Pool || surface.SubscriptionRepository.Pool != deps.Pool {
		t.Fatal("customer-lifecycle graph changed pool identity")
	}
	if surface.Reviews.Storage != deps.CustomerLifecycleIntegrations.ReviewStorage ||
		surface.Reviews.FlowEvents != deps.CustomerLifecycleIntegrations.ReviewFlowEvents ||
		surface.Reviews.PublicBase != "https://public.example" {
		t.Fatal("review surface changed storage, flow-event, or public-base identity")
	}
	if surface.ReviewDependencies.Repo != surface.ReviewRepository ||
		surface.ReviewDependencies.Products != surface.ReviewRepository ||
		surface.LoyaltyDependencies.Repo != surface.LoyaltyRepository ||
		surface.SubscriptionDependencies.Repo != surface.SubscriptionRepository {
		t.Fatal("integration handlers changed repository identity")
	}
	if surface.ReviewDependencies.WebhookSecrets != deps.CustomerLifecycleIntegrations.Secrets ||
		surface.LoyaltyDependencies.WebhookSecrets != deps.CustomerLifecycleIntegrations.Secrets ||
		surface.SubscriptionDependencies.WebhookSecrets != deps.CustomerLifecycleIntegrations.Secrets {
		t.Fatal("integration handlers changed secrets identity")
	}
	if surface.YotpoWorkerBackfiller == nil || surface.SmileWorkerBackfiller == nil || surface.RechargeWorkerBackfiller == nil {
		t.Fatal("special provider worker backfillers were not preserved")
	}
}

func TestNewIncludesCompleteCustomerLifecycleIntegrationsSurface(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newCustomerLifecycleIntegrationDeps(actualRouter)
	New(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newCustomerLifecycleIntegrationDeps(referenceRouter)
	MountDeliverabilitySurface(referenceDeps)
	referenceSurface := NewCustomerLifecycleIntegrationsSurface(referenceDeps)
	reviews.MountRoutes(referenceRouter, referenceSurface.Reviews)
	review_integrations.MountRoutes(referenceRouter, referenceSurface.ReviewDependencies)
	review_integrations.MountPublicRoutes(referenceRouter, referenceSurface.ReviewDependencies)
	loyalty_integrations.MountRoutes(referenceRouter, referenceSurface.LoyaltyDependencies)
	loyalty_integrations.MountPublicRoutes(referenceRouter, referenceSurface.LoyaltyDependencies)
	subscription_integrations.MountRoutes(referenceRouter, referenceSurface.SubscriptionDependencies)
	subscription_integrations.MountPublicRoutes(referenceRouter, referenceSurface.SubscriptionDependencies)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("server.New route count = %d, want %d", len(actual), len(reference))
	}
	for index := range reference {
		if actual[index].method != reference[index].method || actual[index].path != reference[index].path || len(actual[index].middlewares) != len(reference[index].middlewares) {
			t.Fatalf("server.New route[%d] = %s %s (%d middleware), want %s %s (%d)", index, actual[index].method, actual[index].path, len(actual[index].middlewares), reference[index].method, reference[index].path, len(reference[index].middlewares))
		}
	}
}

func TestCustomerLifecycleIntegrationStructuralNilAndMainPlacement(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*Deps)
	}{
		{name: "pool", mutate: func(deps *Deps) { deps.Pool = nil }},
		{name: "graph", mutate: func(deps *Deps) { deps.CustomerLifecycleIntegrations = nil }},
	} {
		t.Run(test.name, func(t *testing.T) {
			deps := newCustomerLifecycleIntegrationDeps(chi.NewRouter())
			test.mutate(&deps)
			surface := NewCustomerLifecycleIntegrationsSurface(deps)
			if surface.Reviews != nil || surface.ReviewRepository != nil || surface.LoyaltyRepository != nil || surface.SubscriptionRepository != nil {
				t.Fatal("structurally incomplete dependencies returned a partial graph")
			}
		})
	}

	root := readAPICompositionRoot(t)
	source := root.main
	assertOrderedOccurrences(t, source, []string{
		"customerLifecycleSurface := apiserver.NewCustomerLifecycleIntegrationsSurface(",
		"apiserver.MountReviewLifecycleRoutes(r, customerLifecycleSurface)",
		"apiworkers.StartReviewIntegrationBackfills(outboxCtx, logger, customerLifecycleSurface)",
		"apiserver.MountLoyaltyLifecycleRoutes(r, customerLifecycleSurface)",
		"apiworkers.StartLoyaltyIntegrationBackfills(outboxCtx, logger, customerLifecycleSurface)",
		"apiserver.MountSubscriptionLifecycleRoutes(r, customerLifecycleSurface)",
		"apiworkers.StartSubscriptionIntegrationBackfills(outboxCtx, logger, customerLifecycleSurface)",
		"apiserver.MountSendingIdentityRoutes(",
	})
	for _, forbidden := range []string{
		"reviewIntegrationsDeps := &review_integrations.Deps{",
		"loyaltyIntegrationsDeps := &loyalty_integrations.Deps{",
		"subscriptionIntegrationsDeps := &subscription_integrations.Deps{",
		"YotpoBackfillWorker{",
		"SmileBackfillWorker{",
		"RechargeBackfillWorker{",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated customer-lifecycle composition %q", forbidden)
		}
	}
}

func newCustomerLifecycleIntegrationDeps(router chi.Router) Deps {
	pool := &db.Pool{}
	return Deps{
		Router: router,
		Pool:   pool,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		CustomerLifecycleIntegrations: &CustomerLifecycleIntegrationsDeps{
			ReviewStorage:      customerLifecycleStorageStub{},
			ReviewFlowEvents:   customerLifecycleFlowStub{},
			SubscriberProfiles: &subscribers.Repo{Pool: pool},
			Secrets:            supportIntegrationSecretStub{},
			PublicBaseURL:      "https://public.example",
		},
	}
}

type customerLifecycleStorageStub struct{}

func (customerLifecycleStorageStub) PresignGet(context.Context, string, string, time.Duration) (string, error) {
	return "https://asset.example", nil
}

type customerLifecycleFlowStub struct{}

func (customerLifecycleFlowStub) EmitFlowEvent(context.Context, string, reviews.FlowEvent) {}
