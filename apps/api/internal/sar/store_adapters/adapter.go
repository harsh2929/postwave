// SPDX-License-Identifier: AGPL-3.0-only
//
// Package store_adapters implements the per-provider customer search + delete
// operations the SUB-053 DSAR fan-out orchestrator drives. Each provider
// (Shopify, WooCommerce, Stripe, Square) gets its own adapter implementing the
// Adapter interface; the orchestrator (apps/api/internal/sar/dsar_fanout.go)
// selects one by commerce_integrations.provider.
//
// Design notes:
//   - Adapters are thin HTTP clients against each provider's REST API. The
//     base URL + HTTP client are injectable so tests drive an httptest.Server
//     without real credentials or network access.
//   - SearchCustomer locates the data subject by email and returns the
//     provider-side customer id + the raw payload (which the orchestrator
//     stores as the compliance receipt evidence).
//   - DeleteCustomer issues the provider's erasure/anonymise call and returns a
//     receipt URL proving the action. Stripe has no hard customer delete that
//     guarantees PII removal in the same way; its adapter anonymises (clears
//     name/email/metadata) instead — documented per-adapter.
//   - Every method takes the integration's settings (decoded credentials +
//     shop domain) so one adapter instance can serve many tenants.

package store_adapters

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// Provider names — mirror commerce_integrations.provider (migration 0028) and
// the dsar_policies / dsar_store_responses CHECK constraints.
const (
	ProviderShopify     = "shopify"
	ProviderWooCommerce = "woocommerce"
	ProviderStripe      = "stripe"
	ProviderSquare      = "square"
)

// ErrUnsupportedProvider is returned by For when no adapter matches.
var ErrUnsupportedProvider = errors.New("store_adapters: unsupported provider")

// Config carries the per-integration connection details an adapter needs. It
// is assembled by the orchestrator from a commerce_integrations row
// (shop_domain + the decoded settings jsonb).
type Config struct {
	// BaseURL overrides the provider's default API host. Empty = use the
	// provider default (or shop-domain-derived host). Tests set this to an
	// httptest.Server URL.
	BaseURL string
	// ShopDomain is the store's domain (Shopify *.myshopify.com, WooCommerce
	// site URL). Empty for Stripe/Square.
	ShopDomain string
	// AccessToken / APIKey is the provider credential.
	AccessToken string
	// APISecret is the secondary credential where the provider needs a pair
	// (WooCommerce consumer key/secret).
	APISecret string
	// HTTPClient is the client used for outbound calls. nil = a default
	// client with a 10s timeout.
	HTTPClient *http.Client
}

func (c Config) client() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return &http.Client{Timeout: 10 * time.Second}
}

// CustomerMatch is the result of a SearchCustomer call.
type CustomerMatch struct {
	Found      bool           // a customer matching the email was located
	CustomerID string         // provider-side id (empty when !Found)
	Raw        map[string]any // raw provider payload for the receipt/audit
}

// DeleteResult is the result of a DeleteCustomer call.
type DeleteResult struct {
	// Status is one of the dsar_store_responses statuses the orchestrator
	// persists: "deleted" (erasure issued) or "error".
	Status string
	// ReceiptURL points at the provider's deletion receipt (webhook receipt
	// URL or API response location) proving the action.
	ReceiptURL string
	// Raw is the provider response (or {"error": ...}) for the audit trail.
	Raw map[string]any
}

// Adapter is the per-provider DSAR contract.
type Adapter interface {
	// Provider returns the provider name (one of the Provider* constants).
	Provider() string
	// SearchCustomer locates the subject by email.
	SearchCustomer(ctx context.Context, cfg Config, email string) (CustomerMatch, error)
	// DeleteCustomer issues the provider's erasure/anonymise for a customer
	// id previously returned by SearchCustomer.
	DeleteCustomer(ctx context.Context, cfg Config, customerID string) (DeleteResult, error)
}

// For returns the adapter for a provider name. Unknown providers yield
// ErrUnsupportedProvider.
func For(provider string) (Adapter, error) {
	switch provider {
	case ProviderShopify:
		return ShopifyAdapter{}, nil
	case ProviderWooCommerce:
		return WooCommerceAdapter{}, nil
	case ProviderStripe:
		return StripeAdapter{}, nil
	case ProviderSquare:
		return SquareAdapter{}, nil
	default:
		return nil, ErrUnsupportedProvider
	}
}
