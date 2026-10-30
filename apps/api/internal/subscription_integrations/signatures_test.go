// SPDX-License-Identifier: AGPL-3.0-only
package subscription_integrations

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"testing"
)

func TestVerifyRechargeWebhookSignature(t *testing.T) {
	secret := "recharge-api-client-secret"
	body := []byte(`{"topic":"subscription/updated","subscription":{"id":123}}`)
	header := signRechargeWebhookTest(secret, body)

	if err := VerifyRechargeWebhookSignature(secret, body, header); err != nil {
		t.Fatalf("valid Recharge signature rejected: %v", err)
	}
	if err := VerifyRechargeWebhookSignature(secret, append(body, '\n'), header); !errors.Is(err, ErrInvalidWebhookSignature) {
		t.Fatalf("tampered body error = %v, want ErrInvalidWebhookSignature", err)
	}
	if err := VerifyRechargeWebhookSignature("", body, header); !errors.Is(err, ErrMissingWebhookSecret) {
		t.Fatalf("missing secret error = %v, want ErrMissingWebhookSecret", err)
	}
}

func signRechargeWebhookTest(secret string, body []byte) string {
	sum := sha256.Sum256(append([]byte(secret), body...))
	return hex.EncodeToString(sum[:])
}

func TestVerifyAfterShipTrackingWebhookSignature(t *testing.T) {
	secret := "aftership-webhook-secret"
	body := []byte(`{"event":"tracking_update","tracking":{"slug":"usps"}}`)
	header := signBase64WebhookTest(secret, body)

	if err := VerifyAfterShipTrackingWebhookSignature(secret, body, header); err != nil {
		t.Fatalf("valid AfterShip signature rejected: %v", err)
	}
	if err := VerifyAfterShipTrackingWebhookSignature(secret, append(body, '\n'), header); !errors.Is(err, ErrInvalidWebhookSignature) {
		t.Fatalf("tampered body error = %v, want ErrInvalidWebhookSignature", err)
	}
	if err := VerifyAfterShipTrackingWebhookSignature("", body, header); !errors.Is(err, ErrMissingWebhookSecret) {
		t.Fatalf("missing secret error = %v, want ErrMissingWebhookSecret", err)
	}
}

func signBase64WebhookTest(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}
