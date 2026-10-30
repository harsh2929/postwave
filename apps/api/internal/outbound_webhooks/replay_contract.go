// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"crypto/sha256"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/idempotency"
)

var (
	ErrReplayIdempotencyRequired = errors.New("outbound_webhooks: replay idempotency key required")
	ErrReplayIdempotencyInvalid  = errors.New("outbound_webhooks: replay idempotency key invalid")
	ErrReplayConflict            = errors.New("outbound_webhooks: replay idempotency key reused for another delivery")
)

// ReplayDeliveryResult is the frozen response contract for a logical
// replay request. Idempotent retries return this exact identity and
// creation timestamp even if the child has since advanced beyond
// pending in the worker.
type ReplayDeliveryResult struct {
	DeliveryID   string    `json:"delivery_id"`
	ReplayedFrom string    `json:"replayed_from"`
	Status       string    `json:"status"`
	ReplayedAt   time.Time `json:"replayed_at"`
}

func requiredOutboundReplayIdempotencyKey(header http.Header) (string, error) {
	values := header.Values(idempotency.HeaderName)
	if len(values) != 1 {
		if len(values) == 0 {
			return "", ErrReplayIdempotencyRequired
		}
		return "", ErrReplayIdempotencyInvalid
	}
	return normalizeOutboundReplayIdempotencyKey(values[0])
}

func normalizeOutboundReplayIdempotencyKey(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", ErrReplayIdempotencyRequired
	}
	if len(value) > idempotency.MaxKeyLength ||
		!utf8.ValidString(value) ||
		strings.IndexFunc(value, unicode.IsControl) >= 0 {
		return "", ErrReplayIdempotencyInvalid
	}
	return value, nil
}

// outboundReplayKeyHash keeps caller-selected idempotency keys out of
// delivery evidence while binding the digest to this operation and tenant.
func outboundReplayKeyHash(tenantID, key string) []byte {
	sum := sha256.Sum256([]byte(
		"postwave:outbound-webhook-replay:v1\x00" + tenantID + "\x00" + key,
	))
	return sum[:]
}
