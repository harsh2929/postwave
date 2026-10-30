// SPDX-License-Identifier: AGPL-3.0-only

package workers

import (
	"context"
	"errors"
	"log/slog"

	"github.com/postwave/postwave/apps/api/internal/loyalty_integrations"
	"github.com/postwave/postwave/apps/api/internal/review_integrations"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/server"
	"github.com/postwave/postwave/apps/api/internal/subscription_integrations"
)

func StartReviewIntegrationBackfills(ctx context.Context, logger *slog.Logger, surface server.CustomerLifecycleIntegrationsSurface) {
	if surface.ReviewRepository == nil || surface.ReviewDependencies == nil {
		return
	}
	yotpoWorker := &review_integrations.YotpoBackfillWorker{
		Deps:       surface.ReviewDependencies,
		Store:      surface.ReviewRepository,
		Backfiller: surface.YotpoWorkerBackfiller,
		Logger:     surface.ReviewDependencies.Logger,
	}
	safego.Go(logger, "yotpo-backfill-worker", func() {
		if err := yotpoWorker.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			logger.Warn("yotpo backfill worker exited", "err", err.Error())
		}
	})

	for _, registration := range reviewIntegrationBackfills(surface) {
		registration := registration
		worker := &review_integrations.ReviewBackfillWorker{
			Provider:   registration.provider,
			Deps:       surface.ReviewDependencies,
			Store:      surface.ReviewRepository,
			Backfiller: registration.backfiller,
			Logger:     surface.ReviewDependencies.Logger,
		}
		safego.Go(logger, registration.name+"-backfill-worker", func() {
			if err := worker.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				logger.Warn(registration.name+" backfill worker exited", "err", err.Error())
			}
		})
	}
}

type reviewIntegrationBackfill struct {
	name       string
	provider   string
	backfiller review_integrations.ReviewBackfiller
}

func reviewIntegrationBackfills(surface server.CustomerLifecycleIntegrationsSurface) []reviewIntegrationBackfill {
	deps := surface.ReviewDependencies
	if deps == nil {
		return nil
	}
	return []reviewIntegrationBackfill{
		{name: "judge-me", provider: review_integrations.ProviderJudgeMe, backfiller: deps.JudgeMeBackfiller},
		{name: "okendo", provider: review_integrations.ProviderOkendo, backfiller: deps.OkendoBackfiller},
		{name: "loox", provider: review_integrations.ProviderLoox, backfiller: deps.LooxBackfiller},
		{name: "stamped", provider: review_integrations.ProviderStamped, backfiller: deps.StampedBackfiller},
		{name: "trustpilot", provider: review_integrations.ProviderTrustpilot, backfiller: deps.TrustpilotBackfiller},
		{name: "reviews-io", provider: review_integrations.ProviderReviewsIO, backfiller: deps.ReviewsIOBackfiller},
		{name: "bazaarvoice", provider: review_integrations.ProviderBazaarvoice, backfiller: deps.BazaarvoiceBackfiller},
		{name: "powerreviews", provider: review_integrations.ProviderPowerReviews, backfiller: deps.PowerReviewsBackfiller},
	}
}

func StartLoyaltyIntegrationBackfills(ctx context.Context, logger *slog.Logger, surface server.CustomerLifecycleIntegrationsSurface) {
	if surface.LoyaltyRepository == nil || surface.LoyaltyDependencies == nil {
		return
	}
	smileWorker := &loyalty_integrations.SmileBackfillWorker{
		Deps:       surface.LoyaltyDependencies,
		Store:      surface.LoyaltyRepository,
		Backfiller: surface.SmileWorkerBackfiller,
		Logger:     surface.LoyaltyDependencies.Logger,
	}
	safego.Go(logger, "smile-backfill-worker", func() {
		if err := smileWorker.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			logger.Warn("smile backfill worker exited", "err", err.Error())
		}
	})

	for _, registration := range loyaltyIntegrationBackfills(surface) {
		registration := registration
		worker := &loyalty_integrations.LoyaltyBackfillWorker{
			Provider:   registration.provider,
			Deps:       surface.LoyaltyDependencies,
			Store:      surface.LoyaltyRepository,
			Backfiller: registration.backfiller,
			Logger:     surface.LoyaltyDependencies.Logger,
		}
		safego.Go(logger, registration.name+"-backfill-worker", func() {
			if err := worker.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				logger.Warn(registration.name+" backfill worker exited", "err", err.Error())
			}
		})
	}
}

type loyaltyIntegrationBackfill struct {
	name       string
	provider   string
	backfiller loyalty_integrations.LoyaltyBackfiller
}

func loyaltyIntegrationBackfills(surface server.CustomerLifecycleIntegrationsSurface) []loyaltyIntegrationBackfill {
	deps := surface.LoyaltyDependencies
	if deps == nil {
		return nil
	}
	return []loyaltyIntegrationBackfill{
		{name: "loyaltylion", provider: loyalty_integrations.ProviderLoyaltyLion, backfiller: deps.LoyaltyLionBackfiller},
		{name: "rivo", provider: loyalty_integrations.ProviderRivo, backfiller: deps.RivoBackfiller},
		{name: "referralcandy", provider: loyalty_integrations.ProviderReferralCandy, backfiller: deps.ReferralCandyBackfiller},
		{name: "friendbuy", provider: loyalty_integrations.ProviderFriendbuy, backfiller: deps.FriendbuyBackfiller},
	}
}

func StartSubscriptionIntegrationBackfills(ctx context.Context, logger *slog.Logger, surface server.CustomerLifecycleIntegrationsSurface) {
	if surface.SubscriptionRepository == nil || surface.SubscriptionDependencies == nil {
		return
	}
	rechargeWorker := &subscription_integrations.RechargeBackfillWorker{
		Deps:       surface.SubscriptionDependencies,
		Store:      surface.SubscriptionRepository,
		Backfiller: surface.RechargeWorkerBackfiller,
		Logger:     surface.SubscriptionDependencies.Logger,
	}
	safego.Go(logger, "recharge-backfill-worker", func() {
		if err := rechargeWorker.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			logger.Warn("recharge backfill worker exited", "err", err.Error())
		}
	})

	for _, registration := range subscriptionIntegrationBackfills(surface) {
		registration := registration
		worker := &subscription_integrations.SubscriptionBackfillWorker{
			Provider:   registration.provider,
			Deps:       surface.SubscriptionDependencies,
			Store:      surface.SubscriptionRepository,
			Backfiller: registration.backfiller,
			Logger:     surface.SubscriptionDependencies.Logger,
		}
		safego.Go(logger, registration.name+"-backfill-worker", func() {
			if err := worker.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
				logger.Warn(registration.name+" backfill worker exited", "err", err.Error())
			}
		})
	}
}

type subscriptionIntegrationBackfiller interface {
	BackfillPage(context.Context, string, subscription_integrations.Integration, string) (subscription_integrations.SyncRequest, error)
}

type subscriptionIntegrationBackfill struct {
	name       string
	provider   string
	backfiller subscriptionIntegrationBackfiller
}

func subscriptionIntegrationBackfills(surface server.CustomerLifecycleIntegrationsSurface) []subscriptionIntegrationBackfill {
	deps := surface.SubscriptionDependencies
	if deps == nil {
		return nil
	}
	return []subscriptionIntegrationBackfill{
		{name: "skio", provider: subscription_integrations.ProviderSkio, backfiller: deps.SkioBackfiller},
		{name: "aftership", provider: subscription_integrations.ProviderAfterShip, backfiller: deps.AfterShipBackfiller},
		{name: "shipstation", provider: subscription_integrations.ProviderShipStation, backfiller: deps.ShipStationBackfiller},
		{name: "chargebee", provider: subscription_integrations.ProviderChargebee, backfiller: deps.ChargebeeBackfiller},
		{name: "loop-subscriptions", provider: subscription_integrations.ProviderLoopSubscriptions, backfiller: deps.LoopSubscriptionsBackfiller},
		{name: "appstle", provider: subscription_integrations.ProviderAppstle, backfiller: deps.AppstleBackfiller},
		{name: "seal-subscriptions", provider: subscription_integrations.ProviderSealSubscriptions, backfiller: deps.SealBackfiller},
		{name: "bold-subscriptions", provider: subscription_integrations.ProviderBoldSubscriptions, backfiller: deps.BoldBackfiller},
	}
}
