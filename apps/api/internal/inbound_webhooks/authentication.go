// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const inboundSignatureMaxClockSkew = 5 * time.Minute

const inboundReplayKeyPrefix = "event:v1:"

var (
	errMissingTimestamp = errors.New("missing X-Moosewave-Timestamp")
	errBadTimestamp     = errors.New("X-Moosewave-Timestamp must be unix seconds")
	errStaleTimestamp   = errors.New("signature timestamp outside the replay window")
	errMissingEventID   = errors.New("stable webhook event id is required")
	errEventIDTooLong   = errors.New("webhook event id is too long")
	errSignatureFormat  = errors.New("X-Moosewave-Signature must be v2=<hex_hmac_sha256>")
)

func validateInboundTimestamp(raw string, now time.Time) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return errMissingTimestamp
	}
	unix, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return errBadTimestamp
	}
	drift := now.Sub(time.Unix(unix, 0))
	if drift < 0 {
		drift = -drift
	}
	if drift > inboundSignatureMaxClockSkew {
		return errStaleTimestamp
	}
	return nil
}

// authenticatedInboundPayloadV2 binds the sender's stable event identity into
// the HMAC alongside timestamp and exact body bytes. Length-prefixing makes
// the input unambiguous even when an event id contains periods or other
// delimiters.
//
// Exact bytes:
//
//	v2:<timestamp-byte-length>:<timestamp>:<event-id-byte-length>:<event-id>:<raw-body>
func authenticatedInboundPayloadV2(
	timestamp string,
	eventID string,
	body []byte,
) []byte {
	timestamp = strings.TrimSpace(timestamp)
	eventID = strings.TrimSpace(eventID)
	timestampLength := strconv.Itoa(len(timestamp))
	eventIDLength := strconv.Itoa(len(eventID))
	out := make(
		[]byte,
		0,
		3+len(timestampLength)+1+len(timestamp)+1+
			len(eventIDLength)+1+len(eventID)+1+len(body),
	)
	out = append(out, "v2:"...)
	out = append(out, timestampLength...)
	out = append(out, ':')
	out = append(out, timestamp...)
	out = append(out, ':')
	out = append(out, eventIDLength...)
	out = append(out, ':')
	out = append(out, eventID...)
	out = append(out, ':')
	out = append(out, body...)
	return out
}

func legacyTimestampedPayload(timestamp string, body []byte) []byte {
	out := make([]byte, 0, len(timestamp)+1+len(body))
	out = append(out, strings.TrimSpace(timestamp)...)
	out = append(out, '.')
	out = append(out, body...)
	return out
}

func parseInboundSignature(raw string) (version, digest string, err error) {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "v2=") {
		digest = strings.TrimPrefix(raw, "v2=")
		if len(digest) != sha256.Size*2 {
			return "", "", errSignatureFormat
		}
		if _, decodeErr := hex.DecodeString(digest); decodeErr != nil {
			return "", "", errSignatureFormat
		}
		return "v2", digest, nil
	}
	// Raw 64-character hex is the pre-v2 contract. It is recognizable here so
	// a deployment can opt into a bounded migration window explicitly; callers
	// must never silently downgrade a malformed/newer version.
	if len(raw) == sha256.Size*2 {
		if _, decodeErr := hex.DecodeString(raw); decodeErr == nil {
			return "v1", raw, nil
		}
	}
	return "", "", errSignatureFormat
}

func inboundWebhookEventIdentity(h http.Header) (string, error) {
	raw := firstNonBlank(
		h.Get("X-Moosewave-Event-Id"),
		h.Get("X-Postwave-Event-Id"),
		h.Get("X-Event-Id"),
		h.Get("X-GitHub-Delivery"),
		h.Get("X-Linear-Delivery"),
		h.Get("X-Stripe-Event-Id"),
	)
	if raw == "" {
		return "", errMissingEventID
	}
	if len(raw) > 512 {
		return "", errEventIDTooLong
	}
	return raw, nil
}

// inboundWebhookReplayKey requires a sender-stable identity. Known provider
// delivery headers remain supported, but a sender without one must set the
// canonical X-Moosewave-Event-Id header. The legacy header spelling remains
// read-compatible during migration. The value is hashed before persistence
// so an untrusted header cannot create unbounded or PII-bearing index entries.
func inboundWebhookReplayKey(h http.Header) (string, error) {
	raw, err := inboundWebhookEventIdentity(h)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(raw))
	return inboundReplayKeyPrefix + hex.EncodeToString(sum[:]), nil
}
