// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

import (
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"sort"
	"strconv"
	"strings"
	"time"
)

// VerifyLoyaltyLionWebhookSignature validates LoyaltyLion's base64 HMAC-SHA256
// webhook signature against the exact raw request body.
func VerifyLoyaltyLionWebhookSignature(secret string, body []byte, header string) bool {
	secret = strings.TrimSpace(secret)
	header = strings.TrimSpace(header)
	if secret == "" || header == "" {
		return false
	}
	got, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	return hmac.Equal(got, mac.Sum(nil))
}

// VerifySmileWebhookSignature validates Smile.io app webhooks. Smile signs the
// string "{Smile-Timestamp}.{raw_body}" with HMAC-SHA256 and base64 encodes it.
func VerifySmileWebhookSignature(secret string, body []byte, timestamp, signature string, now time.Time) bool {
	secret = strings.TrimSpace(secret)
	timestamp = strings.TrimSpace(timestamp)
	signature = strings.TrimSpace(signature)
	if secret == "" || timestamp == "" || signature == "" {
		return false
	}
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || seconds <= 0 {
		return false
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	sentAt := time.Unix(seconds, 0).UTC()
	if sentAt.Before(now.Add(-5*time.Minute)) || sentAt.After(now.Add(5*time.Minute)) {
		return false
	}
	got, err := base64.StdEncoding.DecodeString(signature)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestamp))
	_, _ = mac.Write([]byte("."))
	_, _ = mac.Write(body)
	return hmac.Equal(got, mac.Sum(nil))
}

// ReferralCandySignature returns the lower-case MD5 signature used by
// ReferralCandy signed API and webhook payload checks.
func ReferralCandySignature(secret string, parts ...string) string {
	hash := md5.New()
	_, _ = hash.Write([]byte(secret))
	for _, part := range parts {
		_, _ = hash.Write([]byte(part))
	}
	return hex.EncodeToString(hash.Sum(nil))
}

// ReferralCandyParameterSignature signs request parameters in deterministic key
// order. The signature field itself is ignored when callers pass a full query.
func ReferralCandyParameterSignature(secret string, params map[string]string) string {
	keys := make([]string, 0, len(params))
	for key := range params {
		if strings.EqualFold(key, "signature") {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+"="+params[key])
	}
	return ReferralCandySignature(secret, parts...)
}
