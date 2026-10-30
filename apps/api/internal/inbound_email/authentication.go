// SPDX-License-Identifier: AGPL-3.0-only
package inbound_email

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
)

const inboundEmailSignatureMaxClockSkew = 5 * time.Minute

const sha256HexLength = sha256.Size * 2

var (
	errInboundEmailSecretUnavailable = errors.New("inbound email signing secret is unavailable")
	errInboundEmailMissingTimestamp  = errors.New("missing X-Postwave-Inbound-Timestamp")
	errInboundEmailBadTimestamp      = errors.New("X-Postwave-Inbound-Timestamp must be unix seconds")
	errInboundEmailStaleTimestamp    = errors.New("inbound email signature timestamp is outside the replay window")
	errInboundEmailBadSignature      = errors.New("inbound email signature is invalid")
	errInboundEmailMissingEventID    = errors.New("stable inbound email event id or Message-ID is required")
	errInboundEmailEventIDTooLong    = errors.New("inbound email event id is too long")
)

func authenticateInboundEmail(secret []byte, body []byte, timestamp, signature string, now time.Time) error {
	if len(secret) == 0 {
		return errInboundEmailSecretUnavailable
	}
	timestamp = strings.TrimSpace(timestamp)
	if timestamp == "" {
		return errInboundEmailMissingTimestamp
	}
	unix, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return errInboundEmailBadTimestamp
	}
	drift := now.Sub(time.Unix(unix, 0))
	if drift < 0 {
		drift = -drift
	}
	if drift > inboundEmailSignatureMaxClockSkew {
		return errInboundEmailStaleTimestamp
	}
	signed := make([]byte, 0, len(timestamp)+1+len(body))
	signed = append(signed, timestamp...)
	signed = append(signed, '.')
	signed = append(signed, body...)
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(signed)
	want := mac.Sum(nil)
	got, err := hex.DecodeString(strings.TrimSpace(signature))
	if err != nil || !hmac.Equal(want, got) {
		return errInboundEmailBadSignature
	}
	return nil
}

func inboundEmailReplayKey(eventID string) (string, error) {
	eventID = strings.TrimSpace(eventID)
	if eventID == "" {
		return "", errInboundEmailMissingEventID
	}
	if len(eventID) > 512 {
		return "", errInboundEmailEventIDTooLong
	}
	sum := sha256.Sum256([]byte(eventID))
	return "event:v1:" + hex.EncodeToString(sum[:]), nil
}

func inboundEmailBodyHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}
