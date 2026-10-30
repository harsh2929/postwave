// SPDX-License-Identifier: AGPL-3.0-only

package billing

import (
	"os"
	"strings"
)

// Provider identifies the system that owns a billing customer or
// subscription. It is deliberately separate from commerce integrations:
// connecting a customer's Stripe store does not make Stripe Moosewave's
// subscription collection provider.
type Provider string

const (
	ProviderDodo   Provider = "dodo"
	ProviderStripe Provider = "stripe"
)

// configuredProvider returns the explicitly selected provider. New protected
// Moosewave environments default to Dodo; local/self-host development keeps
// the legacy Stripe default so existing setups do not change without an
// operator choice.
func configuredProvider() Provider {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("BILLING_PROVIDER"))) {
	case "dodo", "dodopayments", "dodo_payments":
		return ProviderDodo
	case "stripe":
		return ProviderStripe
	default:
		if isProtectedBillingRuntime() {
			return ProviderDodo
		}
		return ProviderStripe
	}
}

func providerCustomerID(st *BillingState, provider Provider) string {
	if st == nil {
		return ""
	}
	if st.Provider == provider && strings.TrimSpace(st.CustomerID) != "" {
		return strings.TrimSpace(st.CustomerID)
	}
	if provider == ProviderStripe {
		return strings.TrimSpace(st.StripeCustomerID)
	}
	return ""
}
