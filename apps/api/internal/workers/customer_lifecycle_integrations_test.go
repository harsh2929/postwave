// SPDX-License-Identifier: AGPL-3.0-only

package workers

import (
	"testing"

	"github.com/postwave/postwave/apps/api/internal/loyalty_integrations"
	"github.com/postwave/postwave/apps/api/internal/review_integrations"
	"github.com/postwave/postwave/apps/api/internal/server"
	"github.com/postwave/postwave/apps/api/internal/subscription_integrations"
)

func TestCustomerLifecycleBackfillInventoriesPreserveOrderAndProviderIdentity(t *testing.T) {
	t.Parallel()

	reviewDeps := &review_integrations.Deps{
		JudgeMeBackfiller:      review_integrations.JudgeMeRESTBackfiller{},
		OkendoBackfiller:       review_integrations.OkendoRESTBackfiller{},
		LooxBackfiller:         review_integrations.LooxRESTBackfiller{},
		StampedBackfiller:      review_integrations.StampedRESTBackfiller{},
		TrustpilotBackfiller:   review_integrations.TrustpilotRESTBackfiller{},
		ReviewsIOBackfiller:    review_integrations.ReviewsIORESTBackfiller{},
		BazaarvoiceBackfiller:  review_integrations.BazaarvoiceRESTBackfiller{},
		PowerReviewsBackfiller: review_integrations.PowerReviewsRESTBackfiller{},
	}
	loyaltyDeps := &loyalty_integrations.Deps{
		LoyaltyLionBackfiller:   loyalty_integrations.LoyaltyLionRESTBackfiller{},
		RivoBackfiller:          loyalty_integrations.RivoRESTBackfiller{},
		ReferralCandyBackfiller: loyalty_integrations.ReferralCandyRESTBackfiller{},
		FriendbuyBackfiller:     loyalty_integrations.FriendbuyRESTBackfiller{},
	}
	subscriptionDeps := &subscription_integrations.Deps{
		SkioBackfiller:              subscription_integrations.SkioGraphQLBackfiller{},
		AfterShipBackfiller:         subscription_integrations.AfterShipRESTBackfiller{},
		ShipStationBackfiller:       subscription_integrations.ShipStationRESTBackfiller{},
		ChargebeeBackfiller:         subscription_integrations.ChargebeeRESTBackfiller{},
		LoopSubscriptionsBackfiller: subscription_integrations.LoopSubscriptionsRESTBackfiller{},
		AppstleBackfiller:           subscription_integrations.AppstleRESTBackfiller{},
		SealBackfiller:              subscription_integrations.SealRESTBackfiller{},
		BoldBackfiller:              subscription_integrations.BoldRESTBackfiller{},
	}
	surface := server.CustomerLifecycleIntegrationsSurface{
		ReviewDependencies:       reviewDeps,
		LoyaltyDependencies:      loyaltyDeps,
		SubscriptionDependencies: subscriptionDeps,
	}

	reviewBackfills := reviewIntegrationBackfills(surface)
	reviewIdentities := make([]workerIdentity, 0, len(reviewBackfills))
	for _, backfill := range reviewBackfills {
		if backfill.backfiller == nil {
			t.Fatalf("review worker %q has a nil backfiller", backfill.name)
		}
		reviewIdentities = append(reviewIdentities, workerIdentity{name: backfill.name, provider: backfill.provider})
	}
	assertWorkerIdentities(t, reviewIdentities, []workerIdentity{
		{name: "judge-me", provider: review_integrations.ProviderJudgeMe},
		{name: "okendo", provider: review_integrations.ProviderOkendo},
		{name: "loox", provider: review_integrations.ProviderLoox},
		{name: "stamped", provider: review_integrations.ProviderStamped},
		{name: "trustpilot", provider: review_integrations.ProviderTrustpilot},
		{name: "reviews-io", provider: review_integrations.ProviderReviewsIO},
		{name: "bazaarvoice", provider: review_integrations.ProviderBazaarvoice},
		{name: "powerreviews", provider: review_integrations.ProviderPowerReviews},
	})
	loyaltyBackfills := loyaltyIntegrationBackfills(surface)
	loyaltyIdentities := make([]workerIdentity, 0, len(loyaltyBackfills))
	for _, backfill := range loyaltyBackfills {
		if backfill.backfiller == nil {
			t.Fatalf("loyalty worker %q has a nil backfiller", backfill.name)
		}
		loyaltyIdentities = append(loyaltyIdentities, workerIdentity{name: backfill.name, provider: backfill.provider})
	}
	assertWorkerIdentities(t, loyaltyIdentities, []workerIdentity{
		{name: "loyaltylion", provider: loyalty_integrations.ProviderLoyaltyLion},
		{name: "rivo", provider: loyalty_integrations.ProviderRivo},
		{name: "referralcandy", provider: loyalty_integrations.ProviderReferralCandy},
		{name: "friendbuy", provider: loyalty_integrations.ProviderFriendbuy},
	})
	subscriptionBackfills := subscriptionIntegrationBackfills(surface)
	subscriptionIdentities := make([]workerIdentity, 0, len(subscriptionBackfills))
	for _, backfill := range subscriptionBackfills {
		if backfill.backfiller == nil {
			t.Fatalf("subscription worker %q has a nil backfiller", backfill.name)
		}
		subscriptionIdentities = append(subscriptionIdentities, workerIdentity{name: backfill.name, provider: backfill.provider})
	}
	assertWorkerIdentities(t, subscriptionIdentities, []workerIdentity{
		{name: "skio", provider: subscription_integrations.ProviderSkio},
		{name: "aftership", provider: subscription_integrations.ProviderAfterShip},
		{name: "shipstation", provider: subscription_integrations.ProviderShipStation},
		{name: "chargebee", provider: subscription_integrations.ProviderChargebee},
		{name: "loop-subscriptions", provider: subscription_integrations.ProviderLoopSubscriptions},
		{name: "appstle", provider: subscription_integrations.ProviderAppstle},
		{name: "seal-subscriptions", provider: subscription_integrations.ProviderSealSubscriptions},
		{name: "bold-subscriptions", provider: subscription_integrations.ProviderBoldSubscriptions},
	})
}

type workerIdentity struct {
	name     string
	provider string
}

func assertWorkerIdentities(t *testing.T, got, want []workerIdentity) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("worker inventory length = %d, want %d", len(got), len(want))
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("worker[%d] = %+v, want %+v", index, got[index], want[index])
		}
	}
}
