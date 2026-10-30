// SPDX-License-Identifier: AGPL-3.0-only
package subscription_integrations

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
)

var (
	ErrMissingWebhookSecret    = errors.New("subscription integrations: missing webhook secret")
	ErrMissingWebhookSignature = errors.New("subscription integrations: missing webhook signature")
	ErrInvalidWebhookSignature = errors.New("subscription integrations: invalid webhook signature")
)

func VerifyRechargeWebhookSignature(clientSecret string, body []byte, header string) error {
	clientSecret = strings.TrimSpace(clientSecret)
	header = strings.TrimSpace(header)
	if clientSecret == "" {
		return ErrMissingWebhookSecret
	}
	if header == "" {
		return ErrMissingWebhookSignature
	}
	sum := sha256.Sum256(append([]byte(clientSecret), body...))
	expected := hex.EncodeToString(sum[:])
	if !hmac.Equal([]byte(strings.ToLower(expected)), []byte(strings.ToLower(header))) {
		return ErrInvalidWebhookSignature
	}
	return nil
}

func VerifyAfterShipTrackingWebhookSignature(webhookSecret string, body []byte, header string) error {
	return verifyBase64HMACSHA256(webhookSecret, body, header)
}

func verifyBase64HMACSHA256(secret string, body []byte, header string) error {
	secret = strings.TrimSpace(secret)
	header = strings.TrimSpace(header)
	if secret == "" {
		return ErrMissingWebhookSecret
	}
	if header == "" {
		return ErrMissingWebhookSignature
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(header)) {
		return ErrInvalidWebhookSignature
	}
	return nil
}
