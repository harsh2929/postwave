// SPDX-License-Identifier: AGPL-3.0-only

// Package internalsign authenticates exact request bodies crossing a Moosewave
// service boundary. It is deliberately independent of HTTP middleware so both
// clients and handlers can share one canonical frame without importing one
// another's service packages.
package internalsign

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	TimestampHeader  = "X-Postwave-Internal-Timestamp"
	RequestIDHeader  = "X-Postwave-Internal-Request-ID"
	SignatureHeader  = "X-Postwave-Internal-Signature"
	Version          = "postwave.internal-request.v1"
	DefaultTolerance = 5 * time.Minute
)

var (
	ErrMissingSecret    = errors.New("internal signature: secret is required")
	ErrWeakSecret       = errors.New("internal signature: every secret must contain at least 32 bytes")
	ErrMissingHeaders   = errors.New("internal signature: required headers are missing")
	ErrInvalidTimestamp = errors.New("internal signature: invalid timestamp")
	ErrStaleTimestamp   = errors.New("internal signature: timestamp outside replay window")
	ErrInvalidSignature = errors.New("internal signature: invalid signature")
	ErrInvalidRequest   = errors.New("internal signature: invalid request identity")
)

// Headers is the complete signed-header set. RequestID is a stable operation
// identity, not a random per-attempt nonce: the receiving durable store uses it
// to make a replay converge instead of repeating a side effect.
type Headers struct {
	Timestamp string
	RequestID string
	Signature string
}

// Sign returns headers authenticating the method, escaped path, stable request
// identity, timestamp, and exact raw body. Query strings are intentionally not
// accepted by this internal contract.
func Sign(secret, method, path, requestID string, body []byte, now time.Time) (Headers, error) {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return Headers{}, ErrMissingSecret
	}
	method, path, requestID, err := normalizeIdentity(method, path, requestID)
	if err != nil {
		return Headers{}, err
	}
	timestamp := strconv.FormatInt(now.UTC().Unix(), 10)
	signature := compute(secret, canonicalFrame(method, path, timestamp, requestID, body))
	return Headers{Timestamp: timestamp, RequestID: requestID, Signature: "v1=" + signature}, nil
}

// Verify accepts a comma-separated rotation set. Every configured key is
// compared in constant time and the full set is always traversed.
func Verify(secrets, method, path string, body []byte, headers Headers, now time.Time, tolerance time.Duration) error {
	accepted := parseSecrets(secrets)
	if len(accepted) == 0 {
		return ErrMissingSecret
	}
	method, path, requestID, err := normalizeIdentity(method, path, headers.RequestID)
	if err != nil {
		return err
	}
	timestamp := strings.TrimSpace(headers.Timestamp)
	provided := strings.TrimSpace(headers.Signature)
	if timestamp == "" || provided == "" {
		return ErrMissingHeaders
	}
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return ErrInvalidTimestamp
	}
	if tolerance <= 0 {
		tolerance = DefaultTolerance
	}
	delta := now.UTC().Sub(time.Unix(seconds, 0).UTC())
	if delta < -tolerance || delta > tolerance {
		return ErrStaleTimestamp
	}
	if !strings.HasPrefix(provided, "v1=") {
		return ErrInvalidSignature
	}
	providedBytes, err := hex.DecodeString(strings.TrimPrefix(provided, "v1="))
	if err != nil || len(providedBytes) != sha256.Size {
		return ErrInvalidSignature
	}
	frame := canonicalFrame(method, path, timestamp, requestID, body)
	matched := 0
	for _, secret := range accepted {
		want, _ := hex.DecodeString(compute(secret, frame))
		matched |= subtle.ConstantTimeCompare(providedBytes, want)
	}
	if matched != 1 {
		return ErrInvalidSignature
	}
	return nil
}

func Apply(header http.Header, signed Headers) {
	header.Set(TimestampHeader, signed.Timestamp)
	header.Set(RequestIDHeader, signed.RequestID)
	header.Set(SignatureHeader, signed.Signature)
}

func FromHTTP(header http.Header) Headers {
	return Headers{
		Timestamp: header.Get(TimestampHeader),
		RequestID: header.Get(RequestIDHeader),
		Signature: header.Get(SignatureHeader),
	}
}

// PrimarySecret returns the first value in a rotation set. Callers sign with
// this value while verifiers accept the complete set during overlap rotation.
func PrimarySecret(secrets string) (string, error) {
	parsed := parseSecrets(secrets)
	if len(parsed) == 0 {
		return "", ErrMissingSecret
	}
	for _, secret := range parsed {
		if len([]byte(secret)) < 32 {
			return "", ErrWeakSecret
		}
	}
	return parsed[0], nil
}

func canonicalFrame(method, path, timestamp, requestID string, body []byte) []byte {
	digest := sha256.Sum256(body)
	return []byte(fmt.Sprintf("%s\n%s\n%s\n%s\n%s\n%s",
		Version, method, path, timestamp, requestID, hex.EncodeToString(digest[:])))
}

func compute(secret string, frame []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(frame)
	return hex.EncodeToString(mac.Sum(nil))
}

func normalizeIdentity(method, path, requestID string) (string, string, string, error) {
	method = strings.ToUpper(strings.TrimSpace(method))
	path = strings.TrimSpace(path)
	requestID = strings.TrimSpace(requestID)
	if method == "" || path == "" || !strings.HasPrefix(path, "/") || strings.ContainsAny(path, "?#\r\n") ||
		requestID == "" || len(requestID) > 128 || strings.ContainsAny(requestID, "\x00\r\n") {
		return "", "", "", ErrInvalidRequest
	}
	return method, path, requestID, nil
}

func parseSecrets(raw string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, 2)
	for _, value := range strings.Split(raw, ",") {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, duplicate := seen[value]; duplicate {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}
