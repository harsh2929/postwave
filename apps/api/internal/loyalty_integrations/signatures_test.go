// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

func TestVerifyLoyaltyLionWebhookSignature(t *testing.T) {
	secret := "loyaltylion_webhook_secret"
	body := []byte(`{"event":"points_approved","customer":{"id":42}}`)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	header := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	if !VerifyLoyaltyLionWebhookSignature(secret, body, header) {
		t.Fatal("expected LoyaltyLion signature to verify")
	}
	if VerifyLoyaltyLionWebhookSignature(secret, []byte(`{"tampered":true}`), header) {
		t.Fatal("expected tampered LoyaltyLion payload to fail verification")
	}
	if VerifyLoyaltyLionWebhookSignature(secret, body, "not-base64") {
		t.Fatal("expected malformed LoyaltyLion signature to fail verification")
	}
}

func TestReferralCandySignatures(t *testing.T) {
	secret := "referralcandy_api_secret"
	params := map[string]string{
		"timestamp":  "2026-06-17T00:00:00Z",
		"accessID":   "acc_123",
		"campaignID": "camp_123",
		"signature":  "ignored",
	}
	want := ReferralCandySignature(secret, "accessID=acc_123", "campaignID=camp_123", "timestamp=2026-06-17T00:00:00Z")
	if got := ReferralCandyParameterSignature(secret, params); got != want {
		t.Fatalf("parameter signature mismatch: got %s want %s", got, want)
	}
}
