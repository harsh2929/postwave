// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"context"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/flowbuilder"
	"github.com/postwave/postwave/apps/api/internal/loyalty_integrations"
	"github.com/postwave/postwave/apps/api/internal/review_integrations"
	"github.com/postwave/postwave/apps/api/internal/reviews"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/subscription_integrations"
	"github.com/postwave/postwave/apps/api/internal/track"
)

// CustomerLifecycleSecretResolver is the common trusted-secret contract used
// by review, loyalty, and subscription provider clients.
type CustomerLifecycleSecretResolver interface {
	Get(context.Context, string) (string, error)
	GetJSON(context.Context, string, any) error
}

// CustomerLifecycleIntegrationsDeps carries the process-wide identities that
// cannot be reconstructed solely from the shared pool.
type CustomerLifecycleIntegrationsDeps struct {
	ReviewStorage      reviews.Storage
	ReviewFlowEvents   reviews.FlowEventEmitter
	SubscriberProfiles *subscribers.Repo
	Secrets            CustomerLifecycleSecretResolver
	PublicBaseURL      string
}

// CustomerLifecycleIntegrationsSurface is one shared graph for the native
// review, loyalty, and subscription routes plus their companion workers. The
// three special worker backfillers intentionally remain distinct values to
// preserve the previous composition root's dependency identity.
type CustomerLifecycleIntegrationsSurface struct {
	Reviews                  *reviews.Deps
	ReviewRepository         *review_integrations.Repo
	ReviewDependencies       *review_integrations.Deps
	YotpoWorkerBackfiller    review_integrations.ReviewBackfiller
	LoyaltyRepository        *loyalty_integrations.Repo
	LoyaltyDependencies      *loyalty_integrations.Deps
	SmileWorkerBackfiller    loyalty_integrations.LoyaltyBackfiller
	SubscriptionRepository   *subscription_integrations.Repo
	SubscriptionDependencies *subscription_integrations.Deps
	RechargeWorkerBackfiller subscription_integrations.RechargeBackfiller
}

// NewCustomerLifecycleIntegrationsSurface assembles the complete graph without
// mounting routes. main.go uses the focused mount helpers below so each worker
// launch retains its exact position between the three route families.
func NewCustomerLifecycleIntegrationsSurface(deps Deps) CustomerLifecycleIntegrationsSurface {
	if deps.Pool == nil || deps.CustomerLifecycleIntegrations == nil {
		return CustomerLifecycleIntegrationsSurface{}
	}

	graph := deps.CustomerLifecycleIntegrations
	logger := deps.Log()
	reviewDeps := &reviews.Deps{
		Repo:       &reviews.Repo{Pool: deps.Pool},
		Storage:    graph.ReviewStorage,
		PublicBase: graph.PublicBaseURL,
		FlowEvents: graph.ReviewFlowEvents,
	}
	reviewRepository := &review_integrations.Repo{Pool: deps.Pool}
	reviewDependencies := &review_integrations.Deps{
		Repo:           reviewRepository,
		Reviews:        review_integrations.ProductReviewSink{Repo: reviewDeps.Repo},
		Profiles:       review_integrations.ReviewerProfileSink{Repo: graph.SubscriberProfiles},
		Events:         review_integrations.TrackEventSink{Repo: lifecycleIntegrationTrackRepo(deps)},
		Products:       reviewRepository,
		Logger:         logger,
		WebhookSecrets: graph.Secrets,
		JudgeMeBackfiller: review_integrations.JudgeMeRESTBackfiller{
			Credentials: review_integrations.JudgeMeSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		YotpoBackfiller: review_integrations.YotpoRESTBackfiller{
			Credentials: review_integrations.YotpoSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		OkendoBackfiller: review_integrations.OkendoRESTBackfiller{
			Credentials: review_integrations.OkendoSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		LooxBackfiller: review_integrations.LooxRESTBackfiller{
			Credentials: review_integrations.LooxSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		TrustpilotBackfiller: review_integrations.TrustpilotRESTBackfiller{
			Credentials: review_integrations.TrustpilotSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		StampedBackfiller: review_integrations.StampedRESTBackfiller{
			Credentials: review_integrations.StampedSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		ReviewsIOBackfiller: review_integrations.ReviewsIORESTBackfiller{
			Credentials: review_integrations.ReviewsIOSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		BazaarvoiceBackfiller: review_integrations.BazaarvoiceRESTBackfiller{
			Credentials: review_integrations.BazaarvoiceSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		PowerReviewsBackfiller: review_integrations.PowerReviewsRESTBackfiller{
			Credentials: review_integrations.PowerReviewsSecretsCredentialResolver{Secrets: graph.Secrets},
		},
	}

	loyaltyRepository := &loyalty_integrations.Repo{Pool: deps.Pool}
	loyaltyDependencies := &loyalty_integrations.Deps{
		Repo:           loyaltyRepository,
		Profiles:       loyalty_integrations.LoyaltyProfileSink{Repo: graph.SubscriberProfiles},
		Events:         loyalty_integrations.TrackEventSink{Repo: lifecycleIntegrationTrackRepo(deps)},
		Logger:         logger,
		WebhookSecrets: graph.Secrets,
		SmileBackfiller: loyalty_integrations.SmileRESTBackfiller{
			Credentials: loyalty_integrations.SmileSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		LoyaltyLionBackfiller: loyalty_integrations.LoyaltyLionRESTBackfiller{
			Credentials: loyalty_integrations.LoyaltyLionSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		RivoBackfiller: loyalty_integrations.RivoRESTBackfiller{
			Credentials: loyalty_integrations.RivoSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		ReferralCandyBackfiller: loyalty_integrations.ReferralCandyRESTBackfiller{
			Credentials: loyalty_integrations.ReferralCandySecretsCredentialResolver{Secrets: graph.Secrets},
		},
		FriendbuyBackfiller: loyalty_integrations.FriendbuyRESTBackfiller{
			Credentials: loyalty_integrations.FriendbuySecretsCredentialResolver{Secrets: graph.Secrets},
		},
	}

	subscriptionRepository := &subscription_integrations.Repo{Pool: deps.Pool}
	subscriptionDependencies := &subscription_integrations.Deps{
		Repo:           subscriptionRepository,
		Profiles:       subscription_integrations.SubscriberLifecycleSink{Repo: graph.SubscriberProfiles},
		Events:         subscription_integrations.TrackEventSink{Repo: lifecycleIntegrationTrackRepo(deps)},
		Logger:         logger,
		WebhookSecrets: graph.Secrets,
		RechargeBackfiller: subscription_integrations.RechargeRESTBackfiller{
			Credentials: subscription_integrations.RechargeSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		AfterShipBackfiller: subscription_integrations.AfterShipRESTBackfiller{
			Credentials: subscription_integrations.AfterShipSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		ShipStationBackfiller: subscription_integrations.ShipStationRESTBackfiller{
			Credentials: subscription_integrations.ShipStationSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		SkioBackfiller: subscription_integrations.SkioGraphQLBackfiller{
			Credentials: subscription_integrations.SkioSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		ChargebeeBackfiller: subscription_integrations.ChargebeeRESTBackfiller{
			Credentials: subscription_integrations.ChargebeeSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		LoopSubscriptionsBackfiller: subscription_integrations.LoopSubscriptionsRESTBackfiller{
			Credentials: subscription_integrations.LoopSubscriptionsSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		SealBackfiller: subscription_integrations.SealRESTBackfiller{
			Credentials: subscription_integrations.SealSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		AppstleBackfiller: subscription_integrations.AppstleRESTBackfiller{
			Credentials: subscription_integrations.AppstleSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		BoldBackfiller: subscription_integrations.BoldRESTBackfiller{
			Credentials: subscription_integrations.BoldSecretsCredentialResolver{Secrets: graph.Secrets},
		},
	}

	return CustomerLifecycleIntegrationsSurface{
		Reviews:            reviewDeps,
		ReviewRepository:   reviewRepository,
		ReviewDependencies: reviewDependencies,
		YotpoWorkerBackfiller: review_integrations.YotpoRESTBackfiller{
			Credentials: review_integrations.YotpoSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		LoyaltyRepository:   loyaltyRepository,
		LoyaltyDependencies: loyaltyDependencies,
		SmileWorkerBackfiller: loyalty_integrations.SmileRESTBackfiller{
			Credentials: loyalty_integrations.SmileSecretsCredentialResolver{Secrets: graph.Secrets},
		},
		SubscriptionRepository:   subscriptionRepository,
		SubscriptionDependencies: subscriptionDependencies,
		RechargeWorkerBackfiller: subscription_integrations.RechargeRESTBackfiller{
			Credentials: subscription_integrations.RechargeSecretsCredentialResolver{Secrets: graph.Secrets},
		},
	}
}

func lifecycleIntegrationTrackRepo(deps Deps) *track.Repo {
	return &track.Repo{Pool: deps.Pool, FlowRuns: &flowbuilder.Repo{Pool: deps.Pool}}
}

func MountReviewLifecycleRoutes(router chi.Router, surface CustomerLifecycleIntegrationsSurface) {
	if router == nil || surface.Reviews == nil || surface.ReviewDependencies == nil {
		return
	}
	reviews.MountRoutes(router, surface.Reviews)
	review_integrations.MountRoutes(router, surface.ReviewDependencies)
	review_integrations.MountPublicRoutes(router, surface.ReviewDependencies)
}

func MountLoyaltyLifecycleRoutes(router chi.Router, surface CustomerLifecycleIntegrationsSurface) {
	if router == nil || surface.LoyaltyDependencies == nil {
		return
	}
	loyalty_integrations.MountRoutes(router, surface.LoyaltyDependencies)
	loyalty_integrations.MountPublicRoutes(router, surface.LoyaltyDependencies)
}

func MountSubscriptionLifecycleRoutes(router chi.Router, surface CustomerLifecycleIntegrationsSurface) {
	if router == nil || surface.SubscriptionDependencies == nil {
		return
	}
	subscription_integrations.MountRoutes(router, surface.SubscriptionDependencies)
	subscription_integrations.MountPublicRoutes(router, surface.SubscriptionDependencies)
}

func MountCustomerLifecycleIntegrationsSurface(deps Deps) CustomerLifecycleIntegrationsSurface {
	if deps.Router == nil {
		return CustomerLifecycleIntegrationsSurface{}
	}
	surface := NewCustomerLifecycleIntegrationsSurface(deps)
	MountReviewLifecycleRoutes(deps.Router, surface)
	MountLoyaltyLifecycleRoutes(deps.Router, surface)
	MountSubscriptionLifecycleRoutes(deps.Router, surface)
	return surface
}
