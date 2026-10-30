// SPDX-License-Identifier: MIT

// Package stripeconnect contains the shared Stripe Connect reader used by
// source adapters whose paid-newsletter subscriptions live in a connected
// Stripe account rather than the source ESP API.
package stripeconnect

import (
	"context"
	"fmt"
	"os"
	"time"

	stripe "github.com/stripe/stripe-go/v79"
	"github.com/stripe/stripe-go/v79/client"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

// ListSubscriptions paginates subscriptions from a connected Stripe account
// and normalizes them into canonical paid-subscription records.
func ListSubscriptions(ctx context.Context, accountID string, source canonical.SourcePlatform) ([]canonical.PaidSub, error) {
	if accountID == "" {
		return nil, fmt.Errorf("stripe connect account id required: %w", adapter.ErrAuth)
	}
	key := os.Getenv("STRIPE_SECRET_KEY")
	if key == "" {
		return nil, fmt.Errorf("STRIPE_SECRET_KEY not set: %w", adapter.ErrAuth)
	}

	api := &client.API{}
	api.Init(key, nil)

	params := &stripe.SubscriptionListParams{
		Status: stripe.String("all"),
	}
	params.Limit = stripe.Int64(100)
	params.AddExpand("data.customer")
	params.SetStripeAccount(accountID)
	params.Context = ctx

	iter := api.Subscriptions.List(params)
	out := []canonical.PaidSub{}
	for iter.Next() {
		sub := iter.Subscription()
		ps := canonical.PaidSub{
			StripeSubscriptionID: sub.ID,
			Status:               string(sub.Status),
			SourcePlatform:       source,
		}
		if sub.Customer != nil {
			ps.StripeCustomerID = sub.Customer.ID
			ps.Email = sub.Customer.Email
		}
		if len(sub.Items.Data) > 0 && sub.Items.Data[0].Price != nil {
			ps.StripePriceID = sub.Items.Data[0].Price.ID
		}
		if sub.CurrentPeriodEnd != 0 {
			ps.CurrentPeriodEnd = time.Unix(sub.CurrentPeriodEnd, 0).UTC()
		}
		if sub.TrialEnd != 0 {
			t := time.Unix(sub.TrialEnd, 0).UTC()
			ps.TrialEnd = &t
		}
		out = append(out, ps)
	}
	if err := iter.Err(); err != nil {
		return nil, fmt.Errorf("stripe list subscriptions: %w", err)
	}
	return out, nil
}
