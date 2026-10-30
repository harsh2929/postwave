package postwave

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	maxConversionSigningKeyIDBytes = 200
	maxConversionIdempotencyBytes  = 200
	maxConversionBatchItems        = 500
)

type SignedConversionCredentials struct {
	// KeyID is the non-secret identifier of one live conversion signing key.
	KeyID string
	// Secret stays local and is never placed in an HTTP header or body.
	Secret string
}

type SignedConversionIdentity struct {
	// EmailHMACSHA256 is HMAC-SHA256(signing secret, lower(trim(email))).
	// The signed request's KeyID supplies the tenant/key namespace.
	EmailHMACSHA256 string `json:"email_hmac_sha256,omitempty"`
	ClickID         string `json:"click_id,omitempty"`
	ExternalID      string `json:"external_id,omitempty"`
}

type SignedConversionInput struct {
	EventName  string                   `json:"event_name"`
	OccurredAt *time.Time               `json:"occurred_at,omitempty"`
	Identity   SignedConversionIdentity `json:"identity"`
	// Value is a JSON number in major currency units. json.Number preserves the
	// exact decimal bytes (for example 129.00) instead of round-tripping through
	// binary floating point before signing.
	Value    *json.Number   `json:"value,omitempty"`
	Currency string         `json:"currency,omitempty"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

type SignedConversionReceipt struct {
	Accepted      int     `json:"accepted"`
	ConversionIDs []int64 `json:"conversion_ids"`
	KeyID         string  `json:"key_id"`
}

type SignedConversionIngestOptions struct {
	// IdempotencyKey should be stable across process-level retries. Empty mints
	// one key per logical SDK call and reuses it for transport retries.
	IdempotencyKey string
	// Timestamp is primarily useful for deterministic jobs/tests. Zero means now.
	Timestamp time.Time
}

type ConversionIngestResource struct{ client *Client }

func (r *ConversionIngestResource) Ingest(
	ctx context.Context,
	input *SignedConversionInput,
	credentials SignedConversionCredentials,
	options ...SignedConversionIngestOptions,
) (*SignedConversionReceipt, error) {
	if input == nil {
		return nil, fmt.Errorf("postwave: signed conversion input is required")
	}
	if err := validateSignedConversionInput(*input); err != nil {
		return nil, err
	}
	body, err := json.Marshal(input)
	if err != nil {
		return nil, fmt.Errorf("postwave: marshal signed conversion: %w", err)
	}
	return r.send(ctx, "/api/public/conversions/ingest", body, credentials, firstSignedConversionOptions(options))
}

func (r *ConversionIngestResource) IngestBatch(
	ctx context.Context,
	inputs []SignedConversionInput,
	credentials SignedConversionCredentials,
	options ...SignedConversionIngestOptions,
) (*SignedConversionReceipt, error) {
	if len(inputs) < 1 || len(inputs) > maxConversionBatchItems {
		return nil, fmt.Errorf("postwave: conversion batch must contain 1 to %d items", maxConversionBatchItems)
	}
	for _, input := range inputs {
		if err := validateSignedConversionInput(input); err != nil {
			return nil, err
		}
	}
	body, err := json.Marshal(struct {
		Conversions []SignedConversionInput `json:"conversions"`
	}{Conversions: inputs})
	if err != nil {
		return nil, fmt.Errorf("postwave: marshal signed conversion batch: %w", err)
	}
	return r.send(ctx, "/api/public/conversions/ingest/batch", body, credentials, firstSignedConversionOptions(options))
}

// ComputeConversionIngestSignature returns the lowercase key-bound v2 HMAC
// over timestamp, key id, and exact raw body bytes.
func ComputeConversionIngestSignature(
	secret, keyID string,
	timestamp int64,
	body []byte,
) (string, error) {
	if err := validateSignedConversionCredentials(SignedConversionCredentials{KeyID: keyID, Secret: secret}); err != nil {
		return "", err
	}
	if timestamp <= 0 {
		return "", fmt.Errorf("postwave: conversion timestamp must be positive Unix seconds")
	}
	timestampText := strconv.FormatInt(timestamp, 10)
	prefix := "postwave-conversion-v2\n" + strconv.Itoa(len([]byte(keyID))) + "\n" +
		keyID + strconv.Itoa(len([]byte(timestampText))) + "\n" + timestampText
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(prefix))
	_, _ = mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil)), nil
}

func ComputeConversionIngestSignatureHeader(
	secret, keyID string,
	timestamp int64,
	body []byte,
) (string, error) {
	digest, err := ComputeConversionIngestSignature(secret, keyID, timestamp, body)
	if err != nil {
		return "", err
	}
	return "keyid=" + keyID + ",v2=" + digest, nil
}

// ComputeConversionEmailHMACSHA256 derives the only email pseudonym accepted
// by signed conversion ingest. Callers send the digest, never the address, and
// sign the request with the same credential whose secret is supplied here.
func ComputeConversionEmailHMACSHA256(secret, email string) (string, error) {
	if strings.TrimSpace(secret) == "" {
		return "", fmt.Errorf("postwave: conversion signing Secret must not be empty")
	}
	normalized := strings.ToLower(strings.TrimSpace(email))
	if normalized == "" {
		return "", fmt.Errorf("postwave: conversion email must not be empty")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(normalized))
	return hex.EncodeToString(mac.Sum(nil)), nil
}

func (r *ConversionIngestResource) send(
	ctx context.Context,
	path string,
	body []byte,
	credentials SignedConversionCredentials,
	options SignedConversionIngestOptions,
) (*SignedConversionReceipt, error) {
	if r == nil || r.client == nil {
		return nil, fmt.Errorf("postwave: conversion ingest client is unavailable")
	}
	if err := validateSignedConversionCredentials(credentials); err != nil {
		return nil, err
	}
	idempotencyKey := options.IdempotencyKey
	if idempotencyKey == "" {
		idempotencyKey = newIdempotencyKey()
	}
	if !validSignedConversionIdempotencyKey(idempotencyKey) {
		return nil, fmt.Errorf("postwave: conversion Idempotency-Key must be 1-200 UTF-8 bytes without controls or surrounding whitespace")
	}
	now := options.Timestamp
	if now.IsZero() {
		now = time.Now()
	}
	timestamp := now.Unix()
	signature, err := ComputeConversionIngestSignatureHeader(
		credentials.Secret, credentials.KeyID, timestamp, body,
	)
	if err != nil {
		return nil, err
	}

	var lastErr error
	for attempt := 0; attempt <= r.client.maxRetries; attempt++ {
		if attempt > 0 && !sleepCtx(ctx, backoff(attempt)) {
			return nil, ctx.Err()
		}
		request, err := http.NewRequestWithContext(
			ctx, http.MethodPost, r.client.baseURL+path, bytes.NewReader(body),
		)
		if err != nil {
			return nil, err
		}
		// This public operation is authenticated only by its HMAC. Deliberately
		// omit the client's dashboard bearer and tenant headers.
		request.Header.Set("Accept", "application/json")
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("User-Agent", userAgent)
		request.Header.Set("Idempotency-Key", idempotencyKey)
		request.Header.Set("X-Postwave-Timestamp", strconv.FormatInt(timestamp, 10))
		request.Header.Set("X-Postwave-Signature", signature)

		response, err := r.client.httpClient.Do(request)
		if err != nil {
			lastErr = err
			continue
		}
		responseBody, readErr := io.ReadAll(io.LimitReader(response.Body, 16<<20))
		response.Body.Close()
		if readErr != nil {
			lastErr = readErr
			continue
		}
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			var receipt SignedConversionReceipt
			if err := json.Unmarshal(responseBody, &receipt); err != nil {
				return nil, fmt.Errorf("postwave: decode conversion receipt: %w", err)
			}
			return &receipt, nil
		}

		apiErr := decodeSignedConversionError(response.StatusCode, responseBody)
		if response.StatusCode == http.StatusTooManyRequests ||
			(response.StatusCode >= 500 && response.StatusCode != http.StatusNotImplemented) {
			lastErr = apiErr
			if delay := retryAfter(response.Header.Get("Retry-After")); delay > 0 && attempt < r.client.maxRetries {
				if !sleepCtx(ctx, delay) {
					return nil, ctx.Err()
				}
			}
			continue
		}
		return nil, apiErr
	}
	if lastErr == nil {
		lastErr = &Error{Status: 0, Code: "exhausted", Message: "exhausted retries"}
	}
	return nil, lastErr
}

func decodeSignedConversionError(status int, body []byte) *Error {
	apiErr := &Error{Status: status}
	var flat struct {
		Code    string `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &flat) == nil && flat.Code != "" {
		apiErr.Code = flat.Code
		apiErr.Message = flat.Message
		return apiErr
	}
	var nested errorEnvelope
	if json.Unmarshal(body, &nested) == nil && nested.Error != nil {
		apiErr.Code = nested.Error.Code
		apiErr.Message = nested.Error.Message
		apiErr.RequestID = nested.Error.RequestID
	}
	return apiErr
}

func validateSignedConversionCredentials(credentials SignedConversionCredentials) error {
	keyID := credentials.KeyID
	if keyID == "" || keyID != strings.TrimSpace(keyID) ||
		len(keyID) > maxConversionSigningKeyIDBytes || !utf8.ValidString(keyID) ||
		strings.Contains(keyID, ",") || containsSDKControl(keyID) {
		return fmt.Errorf("postwave: conversion signing KeyID must be 1-200 UTF-8 bytes without commas, controls, or surrounding whitespace")
	}
	if strings.TrimSpace(credentials.Secret) == "" {
		return fmt.Errorf("postwave: conversion signing Secret must not be empty")
	}
	return nil
}

func validSignedConversionIdempotencyKey(value string) bool {
	return value != "" && value == strings.TrimSpace(value) &&
		len(value) <= maxConversionIdempotencyBytes && utf8.ValidString(value) &&
		!containsSDKControl(value)
}

func validateSignedConversionInput(input SignedConversionInput) error {
	eventName := strings.TrimSpace(input.EventName)
	if eventName == "" || utf8.RuneCountInString(eventName) > 128 || containsSDKControl(eventName) {
		return fmt.Errorf("postwave: conversion EventName is required")
	}
	if strings.TrimSpace(input.Identity.ClickID) == "" &&
		strings.TrimSpace(input.Identity.EmailHMACSHA256) == "" &&
		strings.TrimSpace(input.Identity.ExternalID) == "" {
		return fmt.Errorf("postwave: conversion Identity requires ClickID, EmailHMACSHA256, or ExternalID")
	}
	if hash := strings.TrimSpace(input.Identity.EmailHMACSHA256); hash != "" {
		decoded, err := hex.DecodeString(hash)
		if len(hash) != 64 || strings.ToLower(hash) != hash || err != nil || len(decoded) != sha256.Size {
			return fmt.Errorf("postwave: conversion EmailHMACSHA256 must be 64 lowercase hexadecimal characters")
		}
	}
	if input.Value == nil && strings.TrimSpace(input.Currency) != "" {
		return fmt.Errorf("postwave: conversion Currency requires Value")
	}
	if input.Value != nil {
		currency := strings.TrimSpace(input.Currency)
		if len(currency) != 3 ||
			!((currency[0] >= 'A' && currency[0] <= 'Z') || (currency[0] >= 'a' && currency[0] <= 'z')) ||
			!((currency[1] >= 'A' && currency[1] <= 'Z') || (currency[1] >= 'a' && currency[1] <= 'z')) ||
			!((currency[2] >= 'A' && currency[2] <= 'Z') || (currency[2] >= 'a' && currency[2] <= 'z')) {
			return fmt.Errorf("postwave: conversion Value requires a three-letter Currency")
		}
	}
	return nil
}

func containsSDKControl(value string) bool {
	for _, current := range value {
		if unicode.IsControl(current) {
			return true
		}
	}
	return false
}

func firstSignedConversionOptions(values []SignedConversionIngestOptions) SignedConversionIngestOptions {
	if len(values) == 0 {
		return SignedConversionIngestOptions{}
	}
	return values[0]
}
