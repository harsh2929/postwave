// SPDX-License-Identifier: AGPL-3.0-only

package consent

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	consentReadSchemaVersion     = 1
	defaultConsentReadLimit      = 200
	maxConsentReadLimit          = 1000
	maxConsentCursorBytes        = 8192
	maxConsentSourceBytes        = 512
	maxConsentResponseBytes      = 16 << 20
	maxConsentStateBytes         = 128
	maxConsentSubjectIDBytes     = 512
	maxConsentPolicyVersionBytes = 256
	maxConsentUserAgentBytes     = 2 << 10
	maxConsentSourceDetailBytes  = 16 << 10
	maxConsentNarrativeBytes     = 64 << 10
	maxConsentPreferencesBytes   = 64 << 10
	// Keep room for the maximum encoded cursor plus the page object, exact
	// source-plane values, snapshot timestamp, workspace UUID, and worst-case
	// JSON escaping of the deprecated 320-byte subject address. Row bytes are
	// measured exactly; the full envelope is conservatively reserved and then
	// hard-checked by marshalConsentPage before the audit/commit boundary.
	consentResponseEnvelopeReserveBytes = maxConsentCursorBytes + (16 << 10)
	consentCursorVersion                = 1
	minConsentCursorSigningKeyBytes     = 32
)

var (
	receiptSourcePlanes = []string{"consent_receipts", "consent_records"}
	eventSourcePlanes   = []string{"consent_events"}
)

type consentReceiptPage struct {
	SchemaVersion int       `json:"schema_version"`
	WorkspaceID   string    `json:"workspace_id"`
	SnapshotAt    time.Time `json:"snapshot_at"`
	SourcePlanes  []string  `json:"source_planes"`
	Receipts      []Receipt `json:"receipts"`
	Email         string    `json:"email,omitempty"`
	Count         int       `json:"count"`
	HasMore       bool      `json:"has_more"`
	NextCursor    string    `json:"next_cursor,omitempty"`
}

type consentEventPage struct {
	SchemaVersion int       `json:"schema_version"`
	WorkspaceID   string    `json:"workspace_id"`
	SnapshotAt    time.Time `json:"snapshot_at"`
	SourcePlanes  []string  `json:"source_planes"`
	Events        []Event   `json:"events"`
	Count         int       `json:"count"`
	HasMore       bool      `json:"has_more"`
	NextCursor    string    `json:"next_cursor,omitempty"`
}

type receiptReadFilter struct {
	Source string
	Since  *time.Time
	Email  string
}

type eventReadFilter struct {
	SubjectType string
	Category    string
	Action      string
	Since       *time.Time
}

type consentPagePosition struct {
	SnapshotAt         time.Time
	VisibilitySnapshot string
	RecordedAt         time.Time
	Kind               string
	ID                 string
}

type consentCursorEnvelope struct {
	Version     int    `json:"v"`
	WorkspaceID string `json:"workspace_id"`
	Scope       string `json:"scope"`
	FilterHash  string `json:"filter_hash"`
	SnapshotAt  string `json:"snapshot_at"`
	Visibility  string `json:"visibility"`
	RecordedAt  string `json:"recorded_at"`
	Kind        string `json:"kind,omitempty"`
	ID          string `json:"id"`
}

type consentRows interface {
	Close()
	Err() error
	Next() bool
	Scan(dest ...any) error
}

// List serves a deterministic, snapshot-watermarked page over the two receipt
// planes. It deliberately does not return a workspace-wide total: callers can
// only claim what the bounded page and its explicit source_planes establish.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	prepareSensitiveResponse(w)
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, 401, "no_tenant", "tenant authentication is required")
		return
	}
	if !validConsentCursorSigningKey(d.CursorSigningKey) {
		writeConsentCursorUnavailable(w)
		return
	}
	query, inputErr := parseConsentQuery(r)
	if inputErr != nil {
		writeConsentInputError(w, inputErr)
		return
	}
	limit, filter, rawCursor, inputErr := readReceiptParams(query, false)
	if inputErr != nil {
		writeConsentInputError(w, inputErr)
		return
	}
	binding := receiptFilterBinding("receipts", filter)
	position, inputErr := decodeConsentCursor(d.CursorSigningKey, rawCursor, tenant.ID, "receipts", binding, true)
	if inputErr != nil {
		writeConsentInputError(w, inputErr)
		return
	}

	tx, err := db.WithTenantOptions(r.Context(), d.Pool, tenant.ID, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	snapshotAt, visibility, err := consentSnapshot(r.Context(), tx, position)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	rows, err := queryReceiptPage(r.Context(), tx, tenant.ID, filter, snapshotAt, visibility, position, limit+1)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	receipts, hasMore, err := materializeReceiptPage(rows, limit, snapshotAt)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	next, err := nextReceiptCursor(d.CursorSigningKey, receipts, hasMore, tenant.ID, "receipts", binding, snapshotAt, visibility)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	page := consentReceiptPage{
		SchemaVersion: consentReadSchemaVersion,
		WorkspaceID:   tenant.ID,
		SnapshotAt:    snapshotAt,
		SourcePlanes:  append([]string(nil), receiptSourcePlanes...),
		Receipts:      receipts,
		Count:         len(receipts),
		HasMore:       hasMore,
		NextCursor:    next,
	}
	payload, err := marshalConsentPage(page)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := auditConsentRead(r.Context(), tx, r, "consent.read.receipts", map[string]any{
		"schema_version":        consentReadSchemaVersion,
		"source_planes":         append([]string(nil), receiptSourcePlanes...),
		"row_count":             len(receipts),
		"has_more":              hasMore,
		"source_filter_present": filter.Source != "",
		"time_filter_present":   filter.Since != nil,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeMarshaledConsentPage(w, payload)
}

// ByEmail returns the same explicit two-plane projection, filter-bound to one
// exact normalized address. The address never enters audit metadata, resource
// identity, or an error response. The deprecated URL already exposes it to
// infrastructure logs. The cursor carries only a domain-separated keyed
// filter binding inside an authenticated envelope, never a plaintext or
// offline-dictionary-testable subject value. The cursor still must not be
// treated as durable evidence or logged.
func (d *Deps) ByEmail(w http.ResponseWriter, r *http.Request) {
	prepareSensitiveResponse(w)
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, 401, "no_tenant", "tenant authentication is required")
		return
	}
	if !validConsentCursorSigningKey(d.CursorSigningKey) {
		writeConsentCursorUnavailable(w)
		return
	}
	email, err := normalizeTrackingEmail(chi.URLParam(r, "email"))
	if err != nil {
		writeConsentInputError(w, newConsentInputError("invalid_email", "subscriber email is invalid"))
		return
	}
	query, inputErr := parseConsentQuery(r)
	if inputErr != nil {
		writeConsentInputError(w, inputErr)
		return
	}
	limit, filter, rawCursor, inputErr := readReceiptParams(query, true)
	if inputErr != nil {
		writeConsentInputError(w, inputErr)
		return
	}
	filter.Email = email
	binding := receiptFilterBinding("subject_history", filter)
	position, inputErr := decodeConsentCursor(d.CursorSigningKey, rawCursor, tenant.ID, "subject_history", binding, true)
	if inputErr != nil {
		writeConsentInputError(w, inputErr)
		return
	}

	tx, err := db.WithTenantOptions(r.Context(), d.Pool, tenant.ID, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	snapshotAt, visibility, err := consentSnapshot(r.Context(), tx, position)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	rows, err := queryReceiptPage(r.Context(), tx, tenant.ID, filter, snapshotAt, visibility, position, limit+1)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	receipts, hasMore, err := materializeReceiptPage(rows, limit, snapshotAt)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	next, err := nextReceiptCursor(d.CursorSigningKey, receipts, hasMore, tenant.ID, "subject_history", binding, snapshotAt, visibility)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	page := consentReceiptPage{
		SchemaVersion: consentReadSchemaVersion,
		WorkspaceID:   tenant.ID,
		SnapshotAt:    snapshotAt,
		SourcePlanes:  append([]string(nil), receiptSourcePlanes...),
		Receipts:      receipts,
		Email:         email,
		Count:         len(receipts),
		HasMore:       hasMore,
		NextCursor:    next,
	}
	payload, err := marshalConsentPage(page)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := auditConsentRead(r.Context(), tx, r, "consent.read.subject_history", map[string]any{
		"schema_version":         consentReadSchemaVersion,
		"source_planes":          append([]string(nil), receiptSourcePlanes...),
		"row_count":              len(receipts),
		"has_more":               hasMore,
		"subject_filter_present": true,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeMarshaledConsentPage(w, payload)
}

// ListEvents serves the third, explicitly separate ledger plane. It does not
// merge visitor preference events into subscriber receipts or imply that the
// three ledgers form one reconciled legal history.
func (d *Deps) ListEvents(w http.ResponseWriter, r *http.Request) {
	prepareSensitiveResponse(w)
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, 401, "no_tenant", "tenant authentication is required")
		return
	}
	if !validConsentCursorSigningKey(d.CursorSigningKey) {
		writeConsentCursorUnavailable(w)
		return
	}
	query, inputErr := parseConsentQuery(r)
	if inputErr != nil {
		writeConsentInputError(w, inputErr)
		return
	}
	limit, filter, rawCursor, inputErr := readEventParams(query)
	if inputErr != nil {
		writeConsentInputError(w, inputErr)
		return
	}
	binding := eventFilterBinding(filter)
	position, inputErr := decodeConsentCursor(d.CursorSigningKey, rawCursor, tenant.ID, "events", binding, false)
	if inputErr != nil {
		writeConsentInputError(w, inputErr)
		return
	}

	tx, err := db.WithTenantOptions(r.Context(), d.Pool, tenant.ID, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	snapshotAt, visibility, err := consentSnapshot(r.Context(), tx, position)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	rows, err := queryEventPage(r.Context(), tx, tenant.ID, filter, snapshotAt, visibility, position, limit+1)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	events, hasMore, err := materializeEventPage(rows, limit, snapshotAt)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	next, err := nextEventCursor(d.CursorSigningKey, events, hasMore, tenant.ID, binding, snapshotAt, visibility)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	page := consentEventPage{
		SchemaVersion: consentReadSchemaVersion,
		WorkspaceID:   tenant.ID,
		SnapshotAt:    snapshotAt,
		SourcePlanes:  append([]string(nil), eventSourcePlanes...),
		Events:        events,
		Count:         len(events),
		HasMore:       hasMore,
		NextCursor:    next,
	}
	payload, err := marshalConsentPage(page)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := auditConsentRead(r.Context(), tx, r, "consent.read.events", map[string]any{
		"schema_version":              consentReadSchemaVersion,
		"source_planes":               append([]string(nil), eventSourcePlanes...),
		"row_count":                   len(events),
		"has_more":                    hasMore,
		"subject_type_filter_present": filter.SubjectType != "",
		"category_filter_present":     filter.Category != "",
		"action_filter_present":       filter.Action != "",
		"time_filter_present":         filter.Since != nil,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeMarshaledConsentPage(w, payload)
}

func readReceiptParams(values url.Values, byEmail bool) (int, receiptReadFilter, string, *consentInputError) {
	allowed := map[string]struct{}{"limit": {}, "cursor": {}}
	if !byEmail {
		allowed["source"] = struct{}{}
		allowed["since"] = struct{}{}
	}
	if err := validateSingleQueryValues(values, allowed); err != nil {
		return 0, receiptReadFilter{}, "", err
	}
	limit, err := readConsentLimit(values.Get("limit"))
	if err != nil {
		return 0, receiptReadFilter{}, "", err
	}
	filter := receiptReadFilter{}
	if raw, present := exactQueryValue(values, "source"); present {
		if !boundedConsentToken(raw, maxConsentSourceBytes) {
			return 0, receiptReadFilter{}, "", newConsentInputError("invalid_source", "source must be a bounded non-empty token")
		}
		filter.Source = raw
	}
	if raw, present := exactQueryValue(values, "since"); present {
		parsed, parseErr := time.Parse(time.RFC3339Nano, raw)
		if parseErr != nil {
			return 0, receiptReadFilter{}, "", newConsentInputError("invalid_since", "since must be an RFC3339 timestamp")
		}
		parsed = parsed.UTC()
		filter.Since = &parsed
	}
	return limit, filter, values.Get("cursor"), nil
}

func parseConsentQuery(r *http.Request) (url.Values, *consentInputError) {
	if r == nil || r.URL == nil || r.URL.RawQuery == "" {
		return url.Values{}, nil
	}
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		// net/url can return a partial map together with an error. Never process
		// that partial result: a malformed escape or semicolon must not make an
		// attacker-controlled filter disappear into endpoint defaults.
		return nil, newConsentInputError("invalid_query", "query string is malformed")
	}
	return values, nil
}

func readEventParams(values url.Values) (int, eventReadFilter, string, *consentInputError) {
	allowed := map[string]struct{}{
		"limit": {}, "cursor": {}, "subject_type": {}, "category": {}, "action": {}, "since": {},
	}
	if err := validateSingleQueryValues(values, allowed); err != nil {
		return 0, eventReadFilter{}, "", err
	}
	limit, err := readConsentLimit(values.Get("limit"))
	if err != nil {
		return 0, eventReadFilter{}, "", err
	}
	filter := eventReadFilter{}
	if raw, present := exactQueryValue(values, "subject_type"); present {
		if _, ok := allowedSubjectTypes[raw]; !ok {
			return 0, eventReadFilter{}, "", newConsentInputError("invalid_subject_type", "subject_type is not supported")
		}
		filter.SubjectType = raw
	}
	if raw, present := exactQueryValue(values, "category"); present {
		if _, ok := allowedCategories[raw]; !ok {
			return 0, eventReadFilter{}, "", newConsentInputError("invalid_category", "category is not supported")
		}
		filter.Category = raw
	}
	if raw, present := exactQueryValue(values, "action"); present {
		if _, ok := allowedActions[raw]; !ok {
			return 0, eventReadFilter{}, "", newConsentInputError("invalid_action", "action is not supported")
		}
		filter.Action = raw
	}
	if raw, present := exactQueryValue(values, "since"); present {
		parsed, parseErr := time.Parse(time.RFC3339Nano, raw)
		if parseErr != nil {
			return 0, eventReadFilter{}, "", newConsentInputError("invalid_since", "since must be an RFC3339 timestamp")
		}
		parsed = parsed.UTC()
		filter.Since = &parsed
	}
	return limit, filter, values.Get("cursor"), nil
}

type consentInputError struct {
	code    string
	message string
}

func (e *consentInputError) Error() string { return e.code }

func newConsentInputError(code, message string) *consentInputError {
	return &consentInputError{code: code, message: message}
}

func writeConsentInputError(w http.ResponseWriter, err *consentInputError) {
	if err == nil {
		return
	}
	httperror.Write(w, 400, err.code, err.message)
}

func validateSingleQueryValues(values url.Values, allowed map[string]struct{}) *consentInputError {
	for key, entries := range values {
		if _, ok := allowed[key]; !ok {
			return newConsentInputError("invalid_query", "query contains an unsupported parameter")
		}
		if len(entries) != 1 {
			return newConsentInputError("invalid_query", "query parameters must not be repeated")
		}
		if entries[0] == "" || entries[0] != strings.TrimSpace(entries[0]) {
			return newConsentInputError("invalid_query", "query parameter values must be non-empty and canonical")
		}
	}
	return nil
}

func exactQueryValue(values url.Values, key string) (string, bool) {
	entries, ok := values[key]
	if !ok || len(entries) != 1 {
		return "", false
	}
	return entries[0], true
}

func readConsentLimit(raw string) (int, *consentInputError) {
	if raw == "" {
		return defaultConsentReadLimit, nil
	}
	for _, char := range raw {
		if char < '0' || char > '9' {
			return 0, newConsentInputError("invalid_limit", "limit must be an integer from 1 through 1000")
		}
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 || limit > maxConsentReadLimit {
		return 0, newConsentInputError("invalid_limit", "limit must be an integer from 1 through 1000")
	}
	return limit, nil
}

func receiptFilterBinding(scope string, filter receiptReadFilter) string {
	since := ""
	if filter.Since != nil {
		since = filter.Since.UTC().Format(time.RFC3339Nano)
	}
	return consentFilterHash(struct {
		Scope  string `json:"scope"`
		Source string `json:"source,omitempty"`
		Since  string `json:"since,omitempty"`
		Email  string `json:"email,omitempty"`
	}{scope, filter.Source, since, filter.Email})
}

func eventFilterBinding(filter eventReadFilter) string {
	since := ""
	if filter.Since != nil {
		since = filter.Since.UTC().Format(time.RFC3339Nano)
	}
	return consentFilterHash(struct {
		SubjectType string `json:"subject_type,omitempty"`
		Category    string `json:"category,omitempty"`
		Action      string `json:"action,omitempty"`
		Since       string `json:"since,omitempty"`
	}{filter.SubjectType, filter.Category, filter.Action, since})
}

func consentFilterHash(value any) string {
	// This is canonical request-binding material, not a digest. The value never
	// leaves process memory: encodeConsentCursor turns it into a domain-separated
	// HMAC before placing it in the signed envelope. Keeping raw canonical input
	// here makes it impossible to accidentally reintroduce an unsalted subject
	// digest that can be tested against an offline email dictionary.
	raw, _ := json.Marshal(value)
	return string(raw)
}

func validConsentCursorSigningKey(key []byte) bool {
	return len(key) >= minConsentCursorSigningKeyBytes
}

func writeConsentCursorUnavailable(w http.ResponseWriter) {
	httperror.Write(w, http.StatusServiceUnavailable, "consent_cursor_unavailable", "consent evidence pagination is temporarily unavailable")
}

func consentCursorMAC(key []byte, domain string, parts ...string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte("postwave:consent:" + domain + ":v1"))
	for _, part := range parts {
		_, _ = mac.Write([]byte{0})
		_, _ = mac.Write([]byte(part))
	}
	return mac.Sum(nil)
}

func consentFilterBindingMAC(key []byte, workspaceID, scope, binding string) string {
	return base64.RawURLEncoding.EncodeToString(
		consentCursorMAC(key, "filter-binding", workspaceID, scope, binding),
	)
}

func encodeConsentCursor(key []byte, workspaceID, scope, binding string, position consentPagePosition) (string, error) {
	if !validConsentCursorSigningKey(key) {
		return "", errors.New("consent: cursor signing key is unavailable")
	}
	if !validPGSnapshot(position.VisibilitySnapshot) {
		return "", errors.New("consent: visibility snapshot is invalid")
	}
	envelope := consentCursorEnvelope{
		Version:     consentCursorVersion,
		WorkspaceID: workspaceID,
		Scope:       scope,
		FilterHash:  consentFilterBindingMAC(key, workspaceID, scope, binding),
		SnapshotAt:  position.SnapshotAt.UTC().Format(time.RFC3339Nano),
		Visibility:  position.VisibilitySnapshot,
		RecordedAt:  position.RecordedAt.UTC().Format(time.RFC3339Nano),
		Kind:        position.Kind,
		ID:          position.ID,
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		return "", fmt.Errorf("consent: encode cursor: %w", err)
	}
	payload := base64.RawURLEncoding.EncodeToString(raw)
	signature := base64.RawURLEncoding.EncodeToString(consentCursorMAC(key, "cursor-envelope", payload))
	encoded := payload + "." + signature
	if len(encoded) > maxConsentCursorBytes {
		return "", errors.New("consent: database visibility snapshot exceeds cursor budget")
	}
	return encoded, nil
}

func decodeConsentCursor(key []byte, raw, workspaceID, scope, binding string, receipt bool) (consentPagePosition, *consentInputError) {
	if raw == "" {
		return consentPagePosition{}, nil
	}
	if !validConsentCursorSigningKey(key) || len(raw) > maxConsentCursorBytes || raw != strings.TrimSpace(raw) {
		return consentPagePosition{}, newConsentInputError("invalid_cursor", "cursor is invalid for this request")
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return consentPagePosition{}, newConsentInputError("invalid_cursor", "cursor is invalid for this request")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || base64.RawURLEncoding.EncodeToString(signature) != parts[1] ||
		!hmac.Equal(signature, consentCursorMAC(key, "cursor-envelope", parts[0])) {
		return consentPagePosition{}, newConsentInputError("invalid_cursor", "cursor is invalid for this request")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return consentPagePosition{}, newConsentInputError("invalid_cursor", "cursor is invalid for this request")
	}
	if base64.RawURLEncoding.EncodeToString(decoded) != parts[0] {
		return consentPagePosition{}, newConsentInputError("invalid_cursor", "cursor is invalid for this request")
	}
	decoder := json.NewDecoder(bytes.NewReader(decoded))
	decoder.DisallowUnknownFields()
	var envelope consentCursorEnvelope
	if err := decoder.Decode(&envelope); err != nil {
		return consentPagePosition{}, newConsentInputError("invalid_cursor", "cursor is invalid for this request")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return consentPagePosition{}, newConsentInputError("invalid_cursor", "cursor is invalid for this request")
	}
	canonical, err := json.Marshal(envelope)
	if err != nil || !bytes.Equal(canonical, decoded) {
		// Only accept the exact representation emitted by encodeConsentCursor.
		// This canonicality gate rejects duplicate JSON members, alternate field
		// ordering, whitespace, and noncanonical times in addition to the HMAC.
		return consentPagePosition{}, newConsentInputError("invalid_cursor", "cursor is invalid for this request")
	}
	if envelope.Version != consentCursorVersion ||
		envelope.WorkspaceID != workspaceID ||
		envelope.Scope != scope ||
		!hmac.Equal([]byte(envelope.FilterHash), []byte(consentFilterBindingMAC(key, workspaceID, scope, binding))) ||
		!validPGSnapshot(envelope.Visibility) {
		return consentPagePosition{}, newConsentInputError("invalid_cursor", "cursor is invalid for this request")
	}
	snapshotAt, err := time.Parse(time.RFC3339Nano, envelope.SnapshotAt)
	if err != nil || snapshotAt.IsZero() {
		return consentPagePosition{}, newConsentInputError("invalid_cursor", "cursor is invalid for this request")
	}
	recordedAt, err := time.Parse(time.RFC3339Nano, envelope.RecordedAt)
	if err != nil || recordedAt.IsZero() || recordedAt.After(snapshotAt) {
		return consentPagePosition{}, newConsentInputError("invalid_cursor", "cursor is invalid for this request")
	}
	if receipt {
		if !validReceiptIdentity(envelope.Kind, envelope.ID) {
			return consentPagePosition{}, newConsentInputError("invalid_cursor", "cursor is invalid for this request")
		}
	} else if envelope.Kind != "" || !validUUID(envelope.ID) {
		return consentPagePosition{}, newConsentInputError("invalid_cursor", "cursor is invalid for this request")
	}
	return consentPagePosition{
		SnapshotAt:         snapshotAt.UTC(),
		VisibilitySnapshot: envelope.Visibility,
		RecordedAt:         recordedAt.UTC(),
		Kind:               envelope.Kind,
		ID:                 envelope.ID,
	}, nil
}

func consentSnapshot(ctx context.Context, tx pgx.Tx, position consentPagePosition) (time.Time, string, error) {
	if !position.SnapshotAt.IsZero() {
		if !validPGSnapshot(position.VisibilitySnapshot) {
			return time.Time{}, "", errors.New("consent: cursor visibility snapshot is invalid")
		}
		return position.SnapshotAt.UTC(), position.VisibilitySnapshot, nil
	}
	var snapshot time.Time
	var visibility string
	if err := tx.QueryRow(ctx, `
SELECT clock_timestamp(), pg_current_snapshot()::text`).Scan(&snapshot, &visibility); err != nil {
		return time.Time{}, "", fmt.Errorf("consent: read snapshot boundary: %w", err)
	}
	if !validPGSnapshot(visibility) {
		return time.Time{}, "", errors.New("consent: database returned an invalid visibility snapshot")
	}
	return snapshot.UTC(), visibility, nil
}

func queryReceiptPage(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	filter receiptReadFilter,
	snapshot time.Time,
	visibility string,
	position consentPagePosition,
	limit int,
) (pgx.Rows, error) {
	var sinceArg, cursorAt any
	if filter.Since != nil {
		sinceArg = filter.Since.UTC()
	}
	if !position.RecordedAt.IsZero() {
		cursorAt = position.RecordedAt.UTC()
	}
	rows, err := tx.Query(ctx, `
SELECT id, subscriber_email, prev_state, new_state, source, source_detail,
       ip, user_agent, privacy_policy_version, captured_text, at,
       recorded_at, kind
  FROM (
        SELECT receipt.id::text AS id,
               receipt.subscriber_email,
               COALESCE(receipt.prev_state, '') AS prev_state,
               receipt.new_state,
               receipt.source,
               COALESCE(receipt.source_detail, '') AS source_detail,
               COALESCE(host(receipt.ip), '') AS ip,
               COALESCE(receipt.user_agent, '') AS user_agent,
               COALESCE(receipt.privacy_policy_version, '') AS privacy_policy_version,
               COALESCE(receipt.captured_text, '') AS captured_text,
               receipt.at AS at,
               COALESCE(receipt.recorded_at, receipt.at) AS recorded_at,
               'receipt'::text AS kind
          FROM consent_receipts AS receipt
		 WHERE receipt.tenant_id = $1::uuid
		   AND ($2::text = '' OR receipt.source = $2::text)
		   AND ($3::timestamptz IS NULL OR receipt.at >= $3::timestamptz)
		   AND ($4::text = '' OR receipt.subscriber_email = $4::text)
		   AND (
		       receipt.recorded_xid IS NULL OR
		       pg_visible_in_snapshot(receipt.recorded_xid, $6::pg_snapshot)
		   )
        UNION ALL
        SELECT proof.id::text AS id,
               proof.email::text AS subscriber_email,
               ''::text AS prev_state,
               proof.consent_status AS new_state,
               proof.source,
               COALESCE(proof.source_url, '') AS source_detail,
               COALESCE(host(proof.ip_addr), '') AS ip,
               COALESCE(proof.user_agent, '') AS user_agent,
               ''::text AS privacy_policy_version,
               ''::text AS captured_text,
               proof.captured_at AS at,
               COALESCE(proof.recorded_at, proof.created_at) AS recorded_at,
               'proof'::text AS kind
          FROM consent_records AS proof
		 WHERE proof.tenant_id = $1::uuid
		   AND ($2::text = '' OR proof.source = $2::text)
		   AND ($3::timestamptz IS NULL OR proof.captured_at >= $3::timestamptz)
		   AND ($4::text = '' OR proof.email = $4::citext)
		   AND (
		       proof.recorded_xid IS NULL OR
		       pg_visible_in_snapshot(proof.recorded_xid, $6::pg_snapshot)
		   )
	   ) AS ledger
 WHERE ledger.recorded_at <= $5::timestamptz
   AND (
		$7::timestamptz IS NULL OR
		(ledger.recorded_at, ledger.kind, ledger.id) <
		($7::timestamptz, $8::text, $9::text)
   )
 ORDER BY ledger.recorded_at DESC, ledger.kind DESC, ledger.id DESC
	LIMIT $10`,
		tenantID, filter.Source, sinceArg, filter.Email, snapshot,
		visibility, cursorAt, position.Kind, position.ID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("consent: query receipt evidence page: %w", err)
	}
	return rows, nil
}

func queryEventPage(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	filter eventReadFilter,
	snapshot time.Time,
	visibility string,
	position consentPagePosition,
	limit int,
) (pgx.Rows, error) {
	var sinceArg, cursorAt any
	if filter.Since != nil {
		sinceArg = filter.Since.UTC()
	}
	if !position.RecordedAt.IsZero() {
		cursorAt = position.RecordedAt.UTC()
	}
	rows, err := tx.Query(ctx, `
SELECT event.id::text,
       COALESCE(event.decision_id::text, ''),
       event.subject_type,
       COALESCE(event.subject_id, ''),
       COALESCE(event.subject_email::text, ''),
       event.channel,
       event.category,
       event.action,
       event.source,
       event.policy_version,
       COALESCE(event.preferences, '{}'::jsonb),
       COALESCE(event.proof_text, ''),
       COALESCE(host(event.ip), ''),
       COALESCE(event.user_agent, ''),
       event.created_at,
       COALESCE(event.recorded_at, event.created_at) AS recorded_at
  FROM consent_events AS event
 WHERE event.tenant_id = $1::uuid
   AND ($2::text = '' OR event.subject_type = $2::text)
   AND ($3::text = '' OR event.category = $3::text)
   AND ($4::text = '' OR event.action = $4::text)
   AND ($5::timestamptz IS NULL OR event.created_at >= $5::timestamptz)
   AND COALESCE(event.recorded_at, event.created_at) <= $6::timestamptz
   AND (
       event.recorded_xid IS NULL OR
       pg_visible_in_snapshot(event.recorded_xid, $7::pg_snapshot)
   )
   AND (
		$8::timestamptz IS NULL OR
		(COALESCE(event.recorded_at, event.created_at), event.id) <
		($8::timestamptz, $9::uuid)
   )
 ORDER BY COALESCE(event.recorded_at, event.created_at) DESC, event.id DESC
	LIMIT $10`,
		tenantID, filter.SubjectType, filter.Category, filter.Action, sinceArg,
		snapshot, visibility, cursorAt, nullableUUID(position.ID), limit,
	)
	if err != nil {
		return nil, fmt.Errorf("consent: query event evidence page: %w", err)
	}
	return rows, nil
}

func nullableUUID(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func validPGSnapshot(value string) bool {
	if value == "" || len(value) > 4096 || value != strings.TrimSpace(value) {
		return false
	}
	parts := strings.Split(value, ":")
	if len(parts) != 3 {
		return false
	}
	parseXID := func(raw string) (uint64, bool) {
		if raw == "" || len(raw) > 20 {
			return 0, false
		}
		for _, char := range raw {
			if char < '0' || char > '9' {
				return 0, false
			}
		}
		parsed, err := strconv.ParseUint(raw, 10, 64)
		return parsed, err == nil
	}
	xmin, ok := parseXID(parts[0])
	if !ok {
		return false
	}
	xmax, ok := parseXID(parts[1])
	if !ok || xmax < xmin {
		return false
	}
	if parts[2] == "" {
		return true
	}
	var previous uint64
	for index, raw := range strings.Split(parts[2], ",") {
		xid, ok := parseXID(raw)
		if !ok || xid < xmin || xid >= xmax || (index > 0 && xid <= previous) {
			return false
		}
		previous = xid
	}
	return true
}

func materializeReceiptPage(rows consentRows, limit int, snapshot time.Time) ([]Receipt, bool, error) {
	if rows == nil {
		return nil, false, errors.New("consent: receipt rows required")
	}
	defer rows.Close()
	out := make([]Receipt, 0, limit+1)
	serializedBytes := consentResponseEnvelopeReserveBytes
	for rows.Next() {
		var receipt Receipt
		if err := rows.Scan(
			&receipt.ID,
			&receipt.SubscriberEmail,
			&receipt.PrevState,
			&receipt.NewState,
			&receipt.Source,
			&receipt.SourceDetail,
			&receipt.IP,
			&receipt.UserAgent,
			&receipt.PrivacyPolicyVersion,
			&receipt.CapturedText,
			&receipt.At,
			&receipt.RecordedAt,
			&receipt.Kind,
		); err != nil {
			return nil, false, fmt.Errorf("consent: scan receipt evidence row: %w", err)
		}
		receipt.At = receipt.At.UTC()
		receipt.RecordedAt = receipt.RecordedAt.UTC()
		if err := validateReceiptRow(receipt, snapshot); err != nil {
			return nil, false, err
		}
		encodedRow, err := json.Marshal(receipt)
		if err != nil {
			return nil, false, fmt.Errorf("consent: encode receipt evidence row: %w", err)
		}
		if len(out) >= limit ||
			(len(out) > 0 && serializedBytes+len(encodedRow)+1 > maxConsentResponseBytes) {
			rows.Close()
			return out, true, nil
		}
		out = append(out, receipt)
		serializedBytes += len(encodedRow) + 1
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("consent: iterate receipt evidence rows: %w", err)
	}
	return out, false, nil
}

func materializeEventPage(rows consentRows, limit int, snapshot time.Time) ([]Event, bool, error) {
	if rows == nil {
		return nil, false, errors.New("consent: event rows required")
	}
	defer rows.Close()
	out := make([]Event, 0, limit+1)
	serializedBytes := consentResponseEnvelopeReserveBytes
	for rows.Next() {
		var event Event
		var preferences []byte
		if err := rows.Scan(
			&event.ID,
			&event.DecisionID,
			&event.SubjectType,
			&event.SubjectID,
			&event.SubjectEmail,
			&event.Channel,
			&event.Category,
			&event.Action,
			&event.Source,
			&event.PolicyVersion,
			&preferences,
			&event.ProofText,
			&event.IP,
			&event.UserAgent,
			&event.CreatedAt,
			&event.RecordedAt,
		); err != nil {
			return nil, false, fmt.Errorf("consent: scan event evidence row: %w", err)
		}
		if len(preferences) > maxConsentPreferencesBytes {
			return nil, false, errors.New("consent: event preferences exceed response contract")
		}
		event.Preferences = map[string]any{}
		if len(preferences) > 0 {
			decoder := json.NewDecoder(bytes.NewReader(preferences))
			decoder.UseNumber()
			if err := decoder.Decode(&event.Preferences); err != nil {
				return nil, false, fmt.Errorf("consent: decode event preferences: %w", err)
			}
			var extra any
			if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
				return nil, false, errors.New("consent: event preferences contain trailing data")
			}
		}
		event.CreatedAt = event.CreatedAt.UTC()
		event.RecordedAt = event.RecordedAt.UTC()
		if err := validateEventRow(event, snapshot); err != nil {
			return nil, false, err
		}
		encodedRow, err := json.Marshal(event)
		if err != nil {
			return nil, false, fmt.Errorf("consent: encode event evidence row: %w", err)
		}
		if len(out) >= limit ||
			(len(out) > 0 && serializedBytes+len(encodedRow)+1 > maxConsentResponseBytes) {
			rows.Close()
			return out, true, nil
		}
		out = append(out, event)
		serializedBytes += len(encodedRow) + 1
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("consent: iterate event evidence rows: %w", err)
	}
	return out, false, nil
}

func nextReceiptCursor(key []byte, receipts []Receipt, hasMore bool, workspaceID, scope, binding string, snapshot time.Time, visibility string) (string, error) {
	if !hasMore || len(receipts) == 0 {
		return "", nil
	}
	last := receipts[len(receipts)-1]
	return encodeConsentCursor(key, workspaceID, scope, binding, consentPagePosition{
		SnapshotAt:         snapshot,
		VisibilitySnapshot: visibility,
		RecordedAt:         last.RecordedAt,
		Kind:               last.Kind,
		ID:                 last.ID,
	})
}

func nextEventCursor(key []byte, events []Event, hasMore bool, workspaceID, binding string, snapshot time.Time, visibility string) (string, error) {
	if !hasMore || len(events) == 0 {
		return "", nil
	}
	last := events[len(events)-1]
	return encodeConsentCursor(key, workspaceID, "events", binding, consentPagePosition{
		SnapshotAt:         snapshot,
		VisibilitySnapshot: visibility,
		RecordedAt:         last.RecordedAt,
		ID:                 last.ID,
	})
}

func auditConsentRead(ctx context.Context, tx pgx.Tx, r *http.Request, action string, metadata map[string]any) error {
	meta := middleware.AuditMetaFromRequest(r)
	// The evidence-read audit is an attribution record, not a second PII
	// ledger. Request network and browser identifiers are intentionally scrubbed
	// along with all subject/filter values before the fail-closed insert.
	meta.IP = ""
	meta.UserAgent = ""
	meta.SessionID = ""
	meta.ClientEventSeq = 0
	// db.Audit normally injects correlation_id into metadata. This read family
	// keeps the metadata allowlist exact; actor/user attribution remains in the
	// typed audit columns rather than expanding the consent evidence payload.
	meta.RequestID = ""
	if err := db.Audit(ctx, tx, meta, action, "consent_evidence", "", metadata); err != nil {
		return fmt.Errorf("consent: audit sensitive read: %w", err)
	}
	return nil
}

func marshalConsentPage(page any) ([]byte, error) {
	payload, err := json.Marshal(page)
	if err != nil {
		return nil, fmt.Errorf("consent: encode evidence page: %w", err)
	}
	if len(payload)+1 > maxConsentResponseBytes {
		return nil, errors.New("consent: evidence page exceeds response byte budget")
	}
	return append(payload, '\n'), nil
}

func writeMarshaledConsentPage(w http.ResponseWriter, payload []byte) {
	prepareSensitiveResponse(w)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(200)
	_, _ = w.Write(payload)
}

func validateReceiptRow(receipt Receipt, snapshot time.Time) error {
	if !validReceiptIdentity(receipt.Kind, receipt.ID) {
		return errors.New("consent: receipt identity violates response contract")
	}
	if !validConsentEmailShape(receipt.SubscriberEmail) {
		return errors.New("consent: receipt email violates response contract")
	}
	validState := false
	if receipt.Kind == "receipt" {
		switch receipt.NewState {
		case "subscribed", "unsubscribed", "bounced", "complained", "pending":
			validState = true
		}
	} else {
		_, validState = validProofStatus[receipt.NewState]
	}
	if !validState || !boundedConsentToken(receipt.Source, 512) {
		return errors.New("consent: receipt state or source violates response contract")
	}
	if !optionalConsentToken(receipt.PrevState, maxConsentStateBytes) ||
		!optionalConsentNarrative(receipt.SourceDetail, maxConsentSourceDetailBytes) ||
		!optionalConsentToken(receipt.IP, 64) ||
		!optionalConsentToken(receipt.UserAgent, maxConsentUserAgentBytes) ||
		!optionalConsentToken(receipt.PrivacyPolicyVersion, maxConsentPolicyVersionBytes) ||
		!optionalConsentNarrative(receipt.CapturedText, maxConsentNarrativeBytes) {
		return errors.New("consent: receipt text violates response contract")
	}
	if receipt.At.IsZero() || receipt.RecordedAt.IsZero() || receipt.RecordedAt.After(snapshot) {
		return errors.New("consent: receipt chronology violates response contract")
	}
	return nil
}

func validateEventRow(event Event, snapshot time.Time) error {
	if !validUUID(event.ID) || (event.DecisionID != "" && !validUUID(event.DecisionID)) {
		return errors.New("consent: event identity violates response contract")
	}
	if event.SubjectID == "" && event.SubjectEmail == "" {
		return errors.New("consent: event subject identity violates response contract")
	}
	if _, ok := allowedSubjectTypes[event.SubjectType]; !ok {
		return errors.New("consent: event subject type violates response contract")
	}
	if _, ok := allowedChannels[event.Channel]; !ok {
		return errors.New("consent: event channel violates response contract")
	}
	if _, ok := allowedCategories[event.Category]; !ok {
		return errors.New("consent: event category violates response contract")
	}
	if _, ok := allowedActions[event.Action]; !ok {
		return errors.New("consent: event action violates response contract")
	}
	if !optionalConsentToken(event.SubjectID, maxConsentSubjectIDBytes) ||
		(event.SubjectEmail != "" && !validConsentEmailShape(event.SubjectEmail)) ||
		!boundedConsentToken(event.Source, maxConsentSourceBytes) ||
		!boundedConsentToken(event.PolicyVersion, maxConsentPolicyVersionBytes) ||
		!optionalConsentNarrative(event.ProofText, maxConsentNarrativeBytes) ||
		!optionalConsentToken(event.IP, 64) ||
		!optionalConsentToken(event.UserAgent, maxConsentUserAgentBytes) {
		return errors.New("consent: event evidence violates response contract")
	}
	if event.CreatedAt.IsZero() || event.RecordedAt.IsZero() || event.RecordedAt.After(snapshot) {
		return errors.New("consent: event chronology violates response contract")
	}
	return nil
}

func validReceiptIdentity(kind, id string) bool {
	switch kind {
	case "receipt":
		if len(id) == 0 || len(id) > 20 || id[0] == '0' {
			return false
		}
		value, err := strconv.ParseInt(id, 10, 64)
		return err == nil && value > 0
	case "proof":
		return validUUID(id)
	default:
		return false
	}
}

func validUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil &&
		parsed.Version() >= 1 && parsed.Version() <= 8 &&
		parsed.Variant() == uuid.RFC4122 &&
		parsed.String() == value
}

func validConsentEmailShape(value string) bool {
	if !boundedConsentToken(value, 320) || value != strings.TrimSpace(value) {
		return false
	}
	first := strings.IndexByte(value, '@')
	return first > 0 && first == strings.LastIndexByte(value, '@') && first < len(value)-1
}

func boundedConsentToken(value string, maxRunes int) bool {
	return value != "" && value == strings.TrimSpace(value) &&
		utf8.ValidString(value) && len(value) <= maxRunes && utf8.RuneCountInString(value) <= maxRunes &&
		!containsConsentControl(value)
}

func optionalConsentToken(value string, maxRunes int) bool {
	return value == "" || boundedConsentToken(value, maxRunes)
}

func optionalConsentNarrative(value string, maxRunes int) bool {
	if value == "" {
		return true
	}
	return utf8.ValidString(value) && strings.TrimSpace(value) != "" &&
		len(value) <= maxRunes && utf8.RuneCountInString(value) <= maxRunes && !containsConsentBidiOrNUL(value)
}

func containsConsentControl(value string) bool {
	if containsConsentBidiOrNUL(value) {
		return true
	}
	for _, char := range value {
		if unicode.IsControl(char) {
			return true
		}
	}
	return false
}

func containsConsentBidiOrNUL(value string) bool {
	for _, char := range value {
		switch {
		case char == 0,
			char == '\ufeff',
			char == '\u061c',
			char == '\u200e',
			char == '\u200f',
			char >= '\u202a' && char <= '\u202e',
			char >= '\u2066' && char <= '\u206f':
			return true
		}
	}
	return false
}
