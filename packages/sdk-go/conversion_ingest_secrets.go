package postwave

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	conversionIngestSecretsPath = "/api/v1/conversions/ingest-secrets"
	conversionSecretNotice      = "This is the only time the secret is shown. Store it now; it cannot be recovered, only replaced."

	// ConversionIngestSecretAmbiguousIssueRecovery is the only safe recovery
	// after a lost/invalid issuance response. Never retry issuance blindly.
	ConversionIngestSecretAmbiguousIssueRecovery = "list signing-key metadata, identify any newly issued key ID, revoke it, then issue a replacement; never retry issuance blindly"
)

var (
	conversionIngestSecretKeyIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
	conversionIngestSecretValuePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$`)
)

type ConversionEmailHMACProjectionStatus string

const (
	ConversionEmailHMACProjectionPending ConversionEmailHMACProjectionStatus = "pending"
	ConversionEmailHMACProjectionReady   ConversionEmailHMACProjectionStatus = "ready"
	ConversionEmailHMACProjectionFailed  ConversionEmailHMACProjectionStatus = "failed"
)

type ConversionEmailHMACProjectionErrorCode string

const (
	ConversionEmailHMACSecretUnavailable    ConversionEmailHMACProjectionErrorCode = "secret_unavailable"
	ConversionEmailHMACProjectionFailedCode ConversionEmailHMACProjectionErrorCode = "projection_failed"
)

// ConversionIngestSecretSummary is metadata only. It can never contain the
// plaintext signing secret or subscriber/projection counts.
type ConversionIngestSecretSummary struct {
	KeyID                       string
	Label                       string
	CreatedAt                   time.Time
	RevokedAt                   *time.Time
	IdentityProjectionStatus    ConversionEmailHMACProjectionStatus
	IdentityProjectionErrorCode *ConversionEmailHMACProjectionErrorCode
	IdentityProjectionUpdatedAt time.Time
}

// IssuedConversionIngestSecret contains the only plaintext copy returned by
// the API. Store Secret immediately in a secret manager, then discard it.
type IssuedConversionIngestSecret struct {
	KeyID                       string
	Label                       string
	CreatedAt                   time.Time
	IdentityProjectionStatus    ConversionEmailHMACProjectionStatus
	IdentityProjectionUpdatedAt time.Time
	Secret                      string
	Notice                      string
}

type ConversionIngestSecretPage struct {
	Items      []ConversionIngestSecretSummary
	NextCursor string
}

type ConversionIngestSecretListOptions struct {
	// Limit defaults to 100 and must be between 1 and 100 when set.
	Limit int
	// Cursor must be passed unchanged from the preceding page.
	Cursor string
}

type ConversionIngestSecretsResource struct{ client *Client }

// AmbiguousConversionIngestSecretIssueError means issuance may have committed
// although its one-time response was lost or invalid. It intentionally retains
// no response/cause payload because malformed responses can still contain the
// only plaintext copy of the secret and exceptions are commonly logged.
type AmbiguousConversionIngestSecretIssueError struct{}

func (*AmbiguousConversionIngestSecretIssueError) Error() string {
	return "postwave: signing-key issuance is ambiguous; " +
		ConversionIngestSecretAmbiguousIssueRecovery
}

// RecoveryInstruction returns the only safe recovery procedure.
func (*AmbiguousConversionIngestSecretIssueError) RecoveryInstruction() string {
	return ConversionIngestSecretAmbiguousIssueRecovery
}

func ambiguousConversionIngestSecretIssue() error {
	return &AmbiguousConversionIngestSecretIssueError{}
}

type conversionIngestSecretWire struct {
	KeyID                       json.RawMessage `json:"key_id"`
	Secret                      json.RawMessage `json:"secret"`
	Label                       json.RawMessage `json:"label"`
	CreatedAt                   json.RawMessage `json:"created_at"`
	RevokedAt                   json.RawMessage `json:"revoked_at"`
	IdentityProjectionStatus    json.RawMessage `json:"identity_projection_status"`
	IdentityProjectionErrorCode json.RawMessage `json:"identity_projection_error_code"`
	IdentityProjectionUpdatedAt json.RawMessage `json:"identity_projection_updated_at"`
}

type conversionIngestSecretIssueWire struct {
	Secret json.RawMessage `json:"secret"`
	Notice json.RawMessage `json:"notice"`
}

type conversionIngestSecretPageWire struct {
	Items      json.RawMessage `json:"items"`
	NextCursor json.RawMessage `json:"next_cursor"`
}

func decodeClosedOne(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("response contains trailing JSON")
	}
	return nil
}

func requiredWireString(raw json.RawMessage, field string) (string, error) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", fmt.Errorf("missing %s", field)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("invalid %s", field)
	}
	return value, nil
}

func optionalWireString(raw json.RawMessage, field string) (*string, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("invalid null %s", field)
	}
	value, err := requiredWireString(raw, field)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

func safeConversionSecretText(value string, maxRunes int, allowEmpty bool) bool {
	if !utf8.ValidString(value) || value != strings.TrimSpace(value) ||
		(!allowEmpty && value == "") || utf8.RuneCountInString(value) > maxRunes {
		return false
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			return false
		}
	}
	return true
}

func safeConversionSecretCursor(value string) bool {
	return value != "" && len(value) <= 512 && safeConversionSecretText(value, 512, false)
}

func parseConversionSecretTime(raw json.RawMessage, field string) (time.Time, error) {
	value, err := requiredWireString(raw, field)
	if err != nil {
		return time.Time{}, err
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid %s", field)
	}
	return parsed, nil
}

func parseConversionIngestSecretSummary(
	raw []byte,
	allowSecret bool,
) (ConversionIngestSecretSummary, string, error) {
	var wire conversionIngestSecretWire
	if err := decodeClosedOne(raw, &wire); err != nil {
		return ConversionIngestSecretSummary{}, "", errors.New("invalid closed signing-key object")
	}
	keyID, err := requiredWireString(wire.KeyID, "key_id")
	if err != nil || !conversionIngestSecretKeyIDPattern.MatchString(keyID) {
		return ConversionIngestSecretSummary{}, "", errors.New("invalid signing-key id")
	}
	label, err := requiredWireString(wire.Label, "label")
	if err != nil || !safeConversionSecretText(label, 128, true) {
		return ConversionIngestSecretSummary{}, "", errors.New("invalid signing-key label")
	}
	createdAt, err := parseConversionSecretTime(wire.CreatedAt, "created_at")
	if err != nil {
		return ConversionIngestSecretSummary{}, "", err
	}
	updatedAt, err := parseConversionSecretTime(
		wire.IdentityProjectionUpdatedAt,
		"identity_projection_updated_at",
	)
	if err != nil {
		return ConversionIngestSecretSummary{}, "", err
	}
	statusValue, err := requiredWireString(
		wire.IdentityProjectionStatus,
		"identity_projection_status",
	)
	status := ConversionEmailHMACProjectionStatus(statusValue)
	if err != nil || (status != ConversionEmailHMACProjectionPending &&
		status != ConversionEmailHMACProjectionReady &&
		status != ConversionEmailHMACProjectionFailed) {
		return ConversionIngestSecretSummary{}, "", errors.New("invalid identity projection status")
	}
	if allowSecret && status != ConversionEmailHMACProjectionPending {
		return ConversionIngestSecretSummary{}, "", errors.New("new signing key did not start with pending projection")
	}
	errorValue, err := optionalWireString(
		wire.IdentityProjectionErrorCode,
		"identity_projection_error_code",
	)
	if err != nil {
		return ConversionIngestSecretSummary{}, "", err
	}
	var errorCode *ConversionEmailHMACProjectionErrorCode
	if status == ConversionEmailHMACProjectionFailed {
		if errorValue == nil {
			return ConversionIngestSecretSummary{}, "", errors.New("failed projection omits its error code")
		}
		parsed := ConversionEmailHMACProjectionErrorCode(*errorValue)
		if parsed != ConversionEmailHMACSecretUnavailable &&
			parsed != ConversionEmailHMACProjectionFailedCode {
			return ConversionIngestSecretSummary{}, "", errors.New("invalid identity projection error code")
		}
		errorCode = &parsed
	} else if errorValue != nil {
		return ConversionIngestSecretSummary{}, "", errors.New("non-failed projection exposes an error code")
	}
	var revokedAt *time.Time
	if allowSecret && len(wire.RevokedAt) != 0 {
		return ConversionIngestSecretSummary{}, "", errors.New("issued signing key exposes revoked_at")
	}
	if len(wire.RevokedAt) != 0 {
		parsed, parseErr := parseConversionSecretTime(wire.RevokedAt, "revoked_at")
		if parseErr != nil {
			return ConversionIngestSecretSummary{}, "", parseErr
		}
		revokedAt = &parsed
	}
	secret := ""
	if allowSecret {
		secret, err = requiredWireString(wire.Secret, "secret")
		if err != nil || !conversionIngestSecretValuePattern.MatchString(secret) {
			return ConversionIngestSecretSummary{}, "", errors.New("invalid reveal-once signing secret")
		}
	} else if len(wire.Secret) != 0 {
		return ConversionIngestSecretSummary{}, "", errors.New("listable signing-key metadata contains secret material")
	}
	return ConversionIngestSecretSummary{
		KeyID: keyID, Label: label, CreatedAt: createdAt, RevokedAt: revokedAt,
		IdentityProjectionStatus:    status,
		IdentityProjectionErrorCode: errorCode,
		IdentityProjectionUpdatedAt: updatedAt,
	}, secret, nil
}

// List returns one bounded metadata-only page. Follow NextCursor explicitly;
// this method never auto-fetches an unbounded key catalog.
func (r *ConversionIngestSecretsResource) List(
	ctx context.Context,
	options ...ConversionIngestSecretListOptions,
) (*ConversionIngestSecretPage, error) {
	if r == nil || r.client == nil {
		return nil, errors.New("postwave: conversion ingest secrets client is unavailable")
	}
	if len(options) > 1 {
		return nil, errors.New("postwave: signing-key list accepts at most one options value")
	}
	input := ConversionIngestSecretListOptions{Limit: 100}
	if len(options) == 1 {
		input = options[0]
		if input.Limit == 0 {
			input.Limit = 100
		}
	}
	if input.Limit < 1 || input.Limit > 100 {
		return nil, errors.New("postwave: signing-key list limit must be from 1 to 100")
	}
	if input.Cursor != "" && !safeConversionSecretCursor(input.Cursor) {
		return nil, errors.New("postwave: signing-key cursor must be a bounded opaque value")
	}
	query := url.Values{"limit": []string{strconv.Itoa(input.Limit)}}
	if input.Cursor != "" {
		query.Set("cursor", input.Cursor)
	}
	var raw json.RawMessage
	if err := r.client.request(ctx, http.MethodGet,
		conversionIngestSecretsPath+"?"+query.Encode(), nil, &raw); err != nil {
		return nil, err
	}
	var wire conversionIngestSecretPageWire
	if err := decodeClosedOne(raw, &wire); err != nil || len(wire.Items) == 0 {
		return nil, errors.New("postwave: invalid closed signing-key page")
	}
	var itemRaw []json.RawMessage
	if err := json.Unmarshal(wire.Items, &itemRaw); err != nil || itemRaw == nil || len(itemRaw) > 100 {
		return nil, errors.New("postwave: invalid bounded signing-key page")
	}
	items := make([]ConversionIngestSecretSummary, 0, len(itemRaw))
	seen := make(map[string]struct{}, len(itemRaw))
	for _, item := range itemRaw {
		parsed, _, err := parseConversionIngestSecretSummary(item, false)
		if err != nil {
			return nil, fmt.Errorf("postwave: invalid signing-key page item: %w", err)
		}
		if _, duplicate := seen[parsed.KeyID]; duplicate {
			return nil, errors.New("postwave: signing-key page contains duplicate key ids")
		}
		seen[parsed.KeyID] = struct{}{}
		items = append(items, parsed)
	}
	nextCursor := ""
	if len(wire.NextCursor) != 0 {
		var nextErr error
		nextCursor, nextErr = requiredWireString(wire.NextCursor, "next_cursor")
		if nextErr != nil || !safeConversionSecretCursor(nextCursor) {
			return nil, errors.New("postwave: invalid signing-key next cursor")
		}
		if nextCursor == input.Cursor {
			return nil, errors.New("postwave: signing-key page repeated its request cursor")
		}
	}
	return &ConversionIngestSecretPage{Items: items, NextCursor: nextCursor}, nil
}

// Issue performs exactly one HTTP attempt without Idempotency-Key. If the
// transport result or 201 body is ambiguous, follow
// ConversionIngestSecretAmbiguousIssueRecovery; never call Issue blindly with
// the same intent.
func (r *ConversionIngestSecretsResource) Issue(
	ctx context.Context,
	label string,
) (*IssuedConversionIngestSecret, error) {
	if r == nil || r.client == nil {
		return nil, errors.New("postwave: conversion ingest secrets client is unavailable")
	}
	if !safeConversionSecretText(label, 128, true) {
		return nil, errors.New("postwave: signing-key label must be at most 128 characters without controls")
	}
	var raw json.RawMessage
	body := map[string]string{}
	if label != "" {
		body["label"] = label
	}
	if err := r.client.requestRevealOnce(ctx, conversionIngestSecretsPath,
		body, &raw); err != nil {
		var apiErr *Error
		if errors.As(err, &apiErr) && apiErr.Status > 0 && apiErr.Status < 500 {
			return nil, apiErr
		}
		return nil, ambiguousConversionIngestSecretIssue()
	}
	var wire conversionIngestSecretIssueWire
	if err := decodeClosedOne(raw, &wire); err != nil || len(wire.Secret) == 0 {
		return nil, ambiguousConversionIngestSecretIssue()
	}
	notice, err := requiredWireString(wire.Notice, "notice")
	if err != nil || notice != conversionSecretNotice {
		return nil, ambiguousConversionIngestSecretIssue()
	}
	summary, secret, err := parseConversionIngestSecretSummary(wire.Secret, true)
	if err != nil || summary.Label != label {
		return nil, ambiguousConversionIngestSecretIssue()
	}
	return &IssuedConversionIngestSecret{
		KeyID:                       summary.KeyID,
		Label:                       summary.Label,
		CreatedAt:                   summary.CreatedAt,
		IdentityProjectionStatus:    summary.IdentityProjectionStatus,
		IdentityProjectionUpdatedAt: summary.IdentityProjectionUpdatedAt,
		Secret:                      secret,
		Notice:                      notice,
	}, nil
}

// Revoke permanently disables and cryptoshreds one exact key.
func (r *ConversionIngestSecretsResource) Revoke(
	ctx context.Context,
	keyID string,
) error {
	if r == nil || r.client == nil {
		return errors.New("postwave: conversion ingest secrets client is unavailable")
	}
	if !conversionIngestSecretKeyIDPattern.MatchString(keyID) {
		return errors.New("postwave: signing-key id must be exactly 32 lowercase hexadecimal characters")
	}
	var raw json.RawMessage
	if err := r.client.request(ctx, http.MethodPost,
		conversionIngestSecretsPath+"/"+url.PathEscape(keyID)+"/revoke",
		nil, &raw); err != nil {
		return err
	}
	var response struct {
		Revoked json.RawMessage `json:"revoked"`
	}
	if err := decodeClosedOne(raw, &response); err != nil ||
		!bytes.Equal(bytes.TrimSpace(response.Revoked), []byte("true")) {
		return errors.New("postwave: invalid signing-key revocation receipt")
	}
	return nil
}
