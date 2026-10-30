// SPDX-License-Identifier: AGPL-3.0-only
package commerce

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
)

type stripeLiveCredentialResolver struct{ creds StripeCredentials }

func (r stripeLiveCredentialResolver) ResolveStripe(context.Context, string, Integration) (StripeCredentials, error) {
	return r.creds, nil
}

func stripeLiveRequiredChecks() []string {
	return commerceLiveRequiredChecks(stripeBackfillObjectOrder)
}

func TestStripeLiveCertificationEvidenceContract(t *testing.T) {
	assertCommerceEvidenceContract(t, ProviderStripe, stripeLiveRequiredChecks())
}

// stripeSignatureHeader reproduces Stripe's `t=<unix>,v1=<hex>` scheme over
// "<timestamp>.<body>" for the credential-free verifier round-trip.
func stripeSignatureHeader(secret string, body []byte, ts time.Time) string {
	unix := strconv.FormatInt(ts.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(unix))
	mac.Write([]byte("."))
	mac.Write(body)
	return "t=" + unix + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

func TestStripeLiveCertificationWebhookSignature(t *testing.T) {
	rec := commerceLiveRecorder(ProviderStripe)
	secret := "whsec_livecert_stripe"
	body := []byte(`{"id":"evt_livecert","object":"event"}`)
	ts := time.Unix(1_700_000_000, 0)

	if err := VerifyStripeWebhookSignature(secret, stripeSignatureHeader(secret, body, ts), body, ts, time.Minute); err != nil {
		t.Fatalf("stripe webhook verifier rejected a valid signature: %v", err)
	}
	tampered := append(append([]byte{}, body...), '!')
	if err := VerifyStripeWebhookSignature(secret, stripeSignatureHeader(secret, tampered, ts), body, ts, time.Minute); err == nil {
		t.Fatal("stripe webhook verifier accepted a tampered signature")
	}
	recordCommerceEvidence(t, rec, "webhook_signature_verify", map[string]any{"algorithm": "stripe_t_v1_hmac_sha256"})
}

func TestStripeLiveCertificationBackfillReadPaths(t *testing.T) {
	requireCommerceLiveCertification(t)
	apiKey := livecert.Env("STRIPE_API_KEY")
	if apiKey == "" {
		t.Skip("STRIPE_API_KEY (a restricted read key) is required for live Stripe read certification")
	}
	rec := commerceLiveRecorder(ProviderStripe)
	backfiller := StripeRESTBackfiller{
		HTTPClient:  &http.Client{Timeout: 20 * time.Second},
		Credentials: stripeLiveCredentialResolver{creds: StripeCredentials{APIKey: apiKey}},
		APIBaseURL:  firstNonEmpty(livecert.Env("STRIPE_API_BASE_URL"), "https://api.stripe.com"),
		PageSize:    1,
	}
	integration := commerceLiveIntegration(ProviderStripe, map[string]any{"account_id": livecert.Env("STRIPE_ACCOUNT_ID")})
	runCommerceLiveBackfill(t, rec, backfiller, integration, stripeBackfillObjectOrder, func(object string) string {
		return encodeStripeBackfillCursor(stripeBackfillState{Object: object})
	})
}

func TestStripeLiveCertificationReportCompleteness(t *testing.T) {
	validateCommerceLiveReport(t, ProviderStripe, stripeLiveRequiredChecks())
}
