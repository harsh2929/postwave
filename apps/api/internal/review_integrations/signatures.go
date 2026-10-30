// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// VerifyJudgeMeWebhookSignature validates Judge.me's JUDGEME-HMAC-SHA256
// header against the exact raw request body.
func VerifyJudgeMeWebhookSignature(secret string, body []byte, header string) bool {
	secret = strings.TrimSpace(secret)
	header = strings.TrimSpace(header)
	header = strings.TrimPrefix(header, "sha256=")
	if secret == "" || header == "" {
		return false
	}
	got, err := hex.DecodeString(header)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	return hmac.Equal(got, mac.Sum(nil))
}
