// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"testing"
)

func TestVerifyTypeformWebhookSignature(t *testing.T) {
	secret := "typeform-webhook-secret"
	body := []byte(`{"event_id":"evt_123","event_type":"form_response"}`)
	header := signTypeformWebhookTest(secret, body)

	if err := VerifyTypeformWebhookSignature(secret, body, header); err != nil {
		t.Fatalf("valid Typeform signature rejected: %v", err)
	}
	if err := VerifyTypeformWebhookSignature(secret, append(body, '\n'), header); !errors.Is(err, ErrInvalidWebhookSignature) {
		t.Fatalf("tampered body error = %v, want ErrInvalidWebhookSignature", err)
	}
	if err := VerifyTypeformWebhookSignature(secret, body, "not-prefixed"); !errors.Is(err, ErrMissingWebhookSignature) {
		t.Fatalf("malformed header error = %v, want ErrMissingWebhookSignature", err)
	}
	if err := VerifyTypeformWebhookSignature("", body, header); !errors.Is(err, ErrMissingWebhookSecret) {
		t.Fatalf("missing secret error = %v, want ErrMissingWebhookSecret", err)
	}
}

func signTypeformWebhookTest(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func TestVerifyFacebookLeadAdsWebhookSignature(t *testing.T) {
	secret := "meta-app-secret"
	body := []byte(`{"object":"page","entry":[{"id":"page_123","changes":[{"field":"leadgen","value":{"leadgen_id":"lead_1"}}]}]}`)
	header := signFacebookLeadAdsWebhookTest(secret, body)

	if err := VerifyFacebookLeadAdsWebhookSignature(secret, body, header); err != nil {
		t.Fatalf("valid Facebook Lead Ads signature rejected: %v", err)
	}
	if err := VerifyFacebookLeadAdsWebhookSignature(secret, append(body, '\n'), header); !errors.Is(err, ErrInvalidWebhookSignature) {
		t.Fatalf("tampered body error = %v, want ErrInvalidWebhookSignature", err)
	}
	if err := VerifyFacebookLeadAdsWebhookSignature(secret, body, "not-prefixed"); !errors.Is(err, ErrMissingWebhookSignature) {
		t.Fatalf("malformed header error = %v, want ErrMissingWebhookSignature", err)
	}
	if err := VerifyFacebookLeadAdsWebhookSignature(secret, body, "sha256=not-hex"); !errors.Is(err, ErrInvalidWebhookSignature) {
		t.Fatalf("bad hex error = %v, want ErrInvalidWebhookSignature", err)
	}
	if err := VerifyFacebookLeadAdsWebhookSignature("", body, header); !errors.Is(err, ErrMissingWebhookSecret) {
		t.Fatalf("missing secret error = %v, want ErrMissingWebhookSecret", err)
	}
}

func signFacebookLeadAdsWebhookTest(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}
