// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
)

var (
	ErrMissingWebhookSecret    = errors.New("lead integrations: missing webhook secret")
	ErrMissingWebhookSignature = errors.New("lead integrations: missing webhook signature")
	ErrInvalidWebhookSignature = errors.New("lead integrations: invalid webhook signature")
)

func VerifyTypeformWebhookSignature(secret string, body []byte, header string) error {
	secret = strings.TrimSpace(secret)
	header = strings.TrimSpace(header)
	if secret == "" {
		return ErrMissingWebhookSecret
	}
	if header == "" {
		return ErrMissingWebhookSignature
	}
	signature := strings.TrimSpace(strings.TrimPrefix(header, "sha256="))
	if signature == "" || signature == header && !strings.HasPrefix(header, "sha256=") {
		return ErrMissingWebhookSignature
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return ErrInvalidWebhookSignature
	}
	return nil
}
