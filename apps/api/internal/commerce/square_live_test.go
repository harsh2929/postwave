// SPDX-License-Identifier: AGPL-3.0-only
package commerce

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
)

type squareLiveCredentialResolver struct{ creds SquareCredentials }

func (r squareLiveCredentialResolver) ResolveSquare(context.Context, string, Integration) (SquareCredentials, error) {
	return r.creds, nil
}

func squareLiveRequiredChecks() []string {
	return commerceLiveRequiredChecks(squareBackfillObjectOrder)
}

func TestSquareLiveCertificationEvidenceContract(t *testing.T) {
	assertCommerceEvidenceContract(t, ProviderSquare, squareLiveRequiredChecks())
}

// Square signs over the concatenation of the notification URL and the raw body,
// base64-encoded, so the verifier round-trip must bind the same URL.
func TestSquareLiveCertificationWebhookSignature(t *testing.T) {
	rec := commerceLiveRecorder(ProviderSquare)
	key := "sq_livecert_signature_key"
	notificationURL := "https://example.test/api/public/commerce/square/webhooks"
	body := []byte(`{"type":"payment.updated","event_id":"livecert"}`)

	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(notificationURL))
	mac.Write(body)
	header := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	if err := VerifySquareWebhookSignature(key, notificationURL, body, header); err != nil {
		t.Fatalf("square webhook verifier rejected a valid signature: %v", err)
	}
	if err := VerifySquareWebhookSignature(key, notificationURL, append(append([]byte{}, body...), '!'), header); err == nil {
		t.Fatal("square webhook verifier accepted a tampered body")
	}
	recordCommerceEvidence(t, rec, "webhook_signature_verify", map[string]any{"algorithm": "square_url_plus_body_hmac_sha256"})
}

func TestSquareLiveCertificationBackfillReadPaths(t *testing.T) {
	requireCommerceLiveCertification(t)
	accessToken := livecert.Env("SQUARE_ACCESS_TOKEN")
	if accessToken == "" {
		t.Skip("SQUARE_ACCESS_TOKEN is required for live Square read certification")
	}
	rec := commerceLiveRecorder(ProviderSquare)
	backfiller := SquareRESTBackfiller{
		HTTPClient:  &http.Client{Timeout: 20 * time.Second},
		Credentials: squareLiveCredentialResolver{creds: SquareCredentials{AccessToken: accessToken, WebhookSignatureKey: livecert.Env("SQUARE_WEBHOOK_SIGNATURE_KEY")}},
		APIBaseURL:  firstNonEmpty(livecert.Env("SQUARE_API_BASE_URL"), "https://connect.squareup.com"),
		PageSize:    1,
	}
	integration := commerceLiveIntegration(ProviderSquare, map[string]any{
		"merchant_id": livecert.Env("SQUARE_MERCHANT_ID"),
		"location_id": livecert.Env("SQUARE_LOCATION_ID"),
	})
	runCommerceLiveBackfill(t, rec, backfiller, integration, squareBackfillObjectOrder, func(object string) string {
		return encodeSquareBackfillCursor(squareBackfillState{Object: object})
	})
}

func TestSquareLiveCertificationReportCompleteness(t *testing.T) {
	validateCommerceLiveReport(t, ProviderSquare, squareLiveRequiredChecks())
}
