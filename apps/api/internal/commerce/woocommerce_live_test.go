// SPDX-License-Identifier: AGPL-3.0-only
package commerce

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
)

type wooCommerceLiveCredentialResolver struct{ creds WooCommerceCredentials }

func (r wooCommerceLiveCredentialResolver) ResolveWooCommerce(context.Context, string, Integration) (WooCommerceCredentials, error) {
	return r.creds, nil
}

func wooCommerceLiveRequiredChecks() []string {
	// WooCommerce programmatically registers and cleans up wc/v3 webhooks.
	return commerceLiveRequiredChecks(woocommerceObjectOrder, "manual_webhook_register_cleanup")
}

func TestWooCommerceLiveCertificationEvidenceContract(t *testing.T) {
	assertCommerceEvidenceContract(t, ProviderWooCommerce, wooCommerceLiveRequiredChecks())
}

func TestWooCommerceLiveCertificationWebhookSignature(t *testing.T) {
	rec := commerceLiveRecorder(ProviderWooCommerce)
	assertBase64HMACWebhookRoundTrip(t, rec, VerifyWooCommerceWebhookSignature)
}

func TestWooCommerceLiveCertificationBackfillReadPaths(t *testing.T) {
	requireCommerceLiveCertification(t)
	storeURL := livecert.Env("WOOCOMMERCE_STORE_URL")
	consumerKey := livecert.Env("WOOCOMMERCE_CONSUMER_KEY")
	consumerSecret := livecert.Env("WOOCOMMERCE_CONSUMER_SECRET")
	if storeURL == "" || consumerKey == "" || consumerSecret == "" {
		t.Skip("WOOCOMMERCE_STORE_URL, WOOCOMMERCE_CONSUMER_KEY and WOOCOMMERCE_CONSUMER_SECRET are required for live WooCommerce read certification")
	}
	rec := commerceLiveRecorder(ProviderWooCommerce)
	backfiller := WooCommerceRESTBackfiller{
		HTTPClient:  &http.Client{Timeout: 20 * time.Second},
		Credentials: wooCommerceLiveCredentialResolver{creds: WooCommerceCredentials{ConsumerKey: consumerKey, ConsumerSecret: consumerSecret}},
		PageSize:    1,
	}
	integration := commerceLiveIntegration(ProviderWooCommerce, map[string]any{"store_url": storeURL})
	runCommerceLiveBackfill(t, rec, backfiller, integration, woocommerceObjectOrder, func(object string) string {
		return encodeWooCommerceBackfillCursor(wooCommerceBackfillState{Object: object})
	})
}

func TestWooCommerceLiveCertificationReportCompleteness(t *testing.T) {
	validateCommerceLiveReport(t, ProviderWooCommerce, wooCommerceLiveRequiredChecks())
}
