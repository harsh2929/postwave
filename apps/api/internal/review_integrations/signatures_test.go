// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestVerifyJudgeMeWebhookSignature(t *testing.T) {
	secret := "judgeme_webhook_secret"
	body := []byte(`{"review":{"id":123,"rating":5}}`)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	header := hex.EncodeToString(mac.Sum(nil))

	if !VerifyJudgeMeWebhookSignature(secret, body, header) {
		t.Fatal("expected Judge.me signature to verify")
	}
	if !VerifyJudgeMeWebhookSignature(secret, body, "sha256="+header) {
		t.Fatal("expected prefixed Judge.me signature to verify")
	}
	if VerifyJudgeMeWebhookSignature(secret, []byte(`{"tampered":true}`), header) {
		t.Fatal("expected tampered Judge.me payload to fail verification")
	}
	if VerifyJudgeMeWebhookSignature(secret, body, "not-hex") {
		t.Fatal("expected malformed Judge.me signature to fail verification")
	}
}
