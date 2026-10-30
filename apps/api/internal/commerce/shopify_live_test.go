// SPDX-License-Identifier: AGPL-3.0-only
package commerce

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
)

// Shopify is the deepest native commerce connector (in-app OAuth, Admin GraphQL
// bulk import, registered+verified+cleaned privacy webhooks). These harnesses
// make it certifiable: the contract + webhook tests run credential-free in CI,
// while the bulk read path runs against a real shop when SHOPIFY_* env is set.

func shopifyLiveRequiredChecks() []string {
	checks := []string{"backfill_bulk_page", "webhook_signature_verify"}
	return append(checks, commerceLiveManualChecks(
		"manual_oauth_install",
		"manual_privacy_webhooks",
		"manual_app_uninstall",
	)...)
}

func TestShopifyLiveCertificationEvidenceContract(t *testing.T) {
	assertCommerceEvidenceContract(t, ProviderShopify, shopifyLiveRequiredChecks())
}

func TestShopifyLiveCertificationWebhookSignature(t *testing.T) {
	rec := commerceLiveRecorder(ProviderShopify)
	assertBase64HMACWebhookRoundTrip(t, rec, VerifyShopifyWebhookHMAC)
}

func TestShopifyLiveCertificationBackfillReadPath(t *testing.T) {
	requireCommerceLiveCertification(t)
	token := livecert.Env("SHOPIFY_ACCESS_TOKEN")
	shop := livecert.Env("SHOPIFY_SHOP_DOMAIN")
	if token == "" || shop == "" {
		t.Skip("SHOPIFY_ACCESS_TOKEN and SHOPIFY_SHOP_DOMAIN are required for live Shopify read certification")
	}
	rec := commerceLiveRecorder(ProviderShopify)
	integration := commerceLiveIntegration(ProviderShopify, map[string]any{
		"shop_domain":      shop,
		"myshopify_domain": shop,
	})
	integration.ShopDomain = shop
	integration.AccessToken = token

	backfiller := ShopifyAdminGraphQLBackfiller{
		HTTPClient: &http.Client{Timeout: 60 * time.Second},
		PageSize:   1,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	req, err := backfiller.BackfillPage(ctx, integration, livecert.Env("SHOPIFY_BACKFILL_CURSOR"))
	if err != nil {
		t.Fatalf("live Shopify Admin GraphQL bulk page failed: %v", err)
	}
	recordCommerceEvidence(t, rec, "backfill_bulk_page", map[string]any{
		"customers":      len(req.Customers),
		"products":       len(req.Products),
		"orders":         len(req.Orders),
		"events":         len(req.ProviderEvents),
		"cursor_present": strings.TrimSpace(req.Cursor) != "",
	})
	t.Logf("live Shopify bulk page ok: customers=%d products=%d orders=%d cursor_present=%t",
		len(req.Customers), len(req.Products), len(req.Orders), strings.TrimSpace(req.Cursor) != "")
}

func TestShopifyLiveCertificationReportCompleteness(t *testing.T) {
	validateCommerceLiveReport(t, ProviderShopify, shopifyLiveRequiredChecks())
}
