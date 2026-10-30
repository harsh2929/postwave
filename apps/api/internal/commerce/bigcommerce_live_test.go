// SPDX-License-Identifier: AGPL-3.0-only
package commerce

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
)

type bigCommerceLiveCredentialResolver struct{ creds BigCommerceCredentials }

func (r bigCommerceLiveCredentialResolver) ResolveBigCommerce(context.Context, string, Integration) (BigCommerceCredentials, error) {
	return r.creds, nil
}

func bigCommerceLiveRequiredChecks() []string {
	// BigCommerce programmatically registers and cleans up store/* webhooks.
	return commerceLiveRequiredChecks(bigCommerceObjectOrder, "manual_webhook_register_cleanup")
}

func TestBigCommerceLiveCertificationEvidenceContract(t *testing.T) {
	assertCommerceEvidenceContract(t, ProviderBigCommerce, bigCommerceLiveRequiredChecks())
}

// BigCommerce webhooks authenticate with a shared secret compared in constant
// time (X-Postwave-Webhook-Secret), not a body HMAC.
func TestBigCommerceLiveCertificationWebhookSignature(t *testing.T) {
	rec := commerceLiveRecorder(ProviderBigCommerce)
	secret := "bc_livecert_shared_secret"
	if err := verifyBigCommerceWebhookSecret(secret, secret); err != nil {
		t.Fatalf("bigcommerce webhook verifier rejected the configured secret: %v", err)
	}
	if err := verifyBigCommerceWebhookSecret(secret, secret+"-tampered"); err == nil {
		t.Fatal("bigcommerce webhook verifier accepted a mismatched secret")
	}
	recordCommerceEvidence(t, rec, "webhook_signature_verify", map[string]any{"algorithm": "shared_secret_constant_time"})
}

func TestBigCommerceLiveCertificationBackfillReadPaths(t *testing.T) {
	requireCommerceLiveCertification(t)
	storeHash := livecert.Env("BIGCOMMERCE_STORE_HASH")
	accessToken := livecert.Env("BIGCOMMERCE_ACCESS_TOKEN")
	if storeHash == "" || accessToken == "" {
		t.Skip("BIGCOMMERCE_STORE_HASH and BIGCOMMERCE_ACCESS_TOKEN are required for live BigCommerce read certification")
	}
	rec := commerceLiveRecorder(ProviderBigCommerce)
	backfiller := BigCommerceRESTBackfiller{
		HTTPClient:  &http.Client{Timeout: 20 * time.Second},
		Credentials: bigCommerceLiveCredentialResolver{creds: BigCommerceCredentials{AccessToken: accessToken}},
		APIBaseURL:  firstNonEmpty(livecert.Env("BIGCOMMERCE_API_BASE_URL"), "https://api.bigcommerce.com"),
		PageSize:    1,
	}
	integration := commerceLiveIntegration(ProviderBigCommerce, map[string]any{"store_hash": storeHash})
	runCommerceLiveBackfill(t, rec, backfiller, integration, bigCommerceObjectOrder, func(object string) string {
		return encodeBigCommerceBackfillCursor(bigCommerceBackfillState{Object: object})
	})
}

func TestBigCommerceLiveCertificationReportCompleteness(t *testing.T) {
	validateCommerceLiveReport(t, ProviderBigCommerce, bigCommerceLiveRequiredChecks())
}
