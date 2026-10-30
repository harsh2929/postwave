// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// Store wraps the pgx pool with outbound_webhooks + deliveries CRUD.
//
// All tenant-scoped methods open a tx via db.WithTenant so the RLS
// policy `tenant_visible` enforces isolation. Worker-side methods
// (FindMatching, ClaimPending, etc.) bind app.outbox_worker='true' so
// the permissive worker policies in 0088 admit the SELECT/UPDATE.
type Store struct {
	Pool         *db.Pool
	Cipher       EnvelopeEncryptor
	RequireHTTPS bool
	// LegacyKEK feeds Decrypt's backward-compat path; same value the
	// rest of the platform uses (cfg.SendingKEK). Optional — nil is
	// fine if you only ever decrypt envelope-format blobs.
	LegacyKEK []byte
}

// scanWebhook reads one row's worth of columns from a pgx scanner into
// w. The column order MUST match the SELECT lists below.
func scanWebhook(s pgx.Row, w *Webhook) error {
	var description, createdByUser *string
	var lastSucceeded, lastFailed *time.Time
	var signingPub, secondaryPub *string
	var secondaryExpires, rotatedAt *time.Time
	var listID *string
	var authRaw []byte
	var authState string
	var disabledReason *string
	var disabledAt *time.Time
	var urlState *string
	var filterExpression *string
	var transformJSON []byte
	if err := s.Scan(
		&w.ID, &w.TenantID, &w.URL, &description, &w.Events, &w.Active,
		&createdByUser, &w.CreatedAt, &w.UpdatedAt, &w.ConfigVersion,
		&lastSucceeded, &lastFailed, &w.ConsecutiveFailures,
		&w.SigningAlgorithm, &signingPub,
		&secondaryPub, &secondaryExpires, &rotatedAt,
		&listID,
		&authRaw, &authState,
		&disabledReason, &disabledAt, &urlState,
		&filterExpression, &transformJSON,
	); err != nil {
		return err
	}
	if listID != nil {
		w.ListID = *listID
	}
	if description != nil {
		w.Description = *description
	}
	if createdByUser != nil {
		w.CreatedByUserID = *createdByUser
	}
	if lastSucceeded != nil {
		w.LastSucceededAt = lastSucceeded
	}
	if lastFailed != nil {
		w.LastFailedAt = lastFailed
	}
	if signingPub != nil {
		w.SigningPublicKey = *signingPub
	}
	if secondaryPub != nil {
		w.SecondaryPublicKey = *secondaryPub
	}
	if secondaryExpires != nil {
		w.SecondaryExpiresAt = secondaryExpires
	}
	if rotatedAt != nil {
		w.RotatedAt = rotatedAt
	}
	w.AuthConfig = decodePublicAuthMetadata(authRaw)
	w.AuthConfigStatus = authState
	if disabledReason != nil {
		w.DisabledReason = *disabledReason
	}
	w.DisabledAt = disabledAt
	if urlState == nil {
		w.URLStatus = destinationStateLegacyPending
		w.URL = destinationDisplay(w.URL)
	} else {
		w.URLStatus = *urlState
		if w.URLStatus != destinationStateReady {
			w.URL = destinationDisplay(w.URL)
		}
	}
	w.DeliveryPolicyStatus = "ready"
	if filterExpression != nil {
		if len(*filterExpression) <= maxFilterExpressionBytes {
			w.FilterExpression = *filterExpression
		}
		if _, err := ParseFilter(*filterExpression); err != nil {
			w.DeliveryPolicyStatus = "invalid"
		}
	}
	if len(transformJSON) > 0 {
		var template map[string]any
		if err := json.Unmarshal(transformJSON, &template); err != nil {
			w.DeliveryPolicyStatus = "invalid"
		} else if err := ValidateTransform(template); err != nil {
			w.DeliveryPolicyStatus = "invalid"
		} else {
			w.TransformTemplate = template
		}
	}
	return nil
}

const webhookSelectColumns = `id::text, tenant_id::text, url, description, events, active,
        created_by_user_id::text, created_at, updated_at, config_version,
        last_succeeded_at, last_failed_at, consecutive_failures,
        signing_algorithm, signing_public_key,
        secondary_public_key, secondary_expires_at, rotated_at,
        list_id::text, COALESCE(auth_config, '{}'::jsonb),
        auth_config_state, disabled_reason, disabled_at, url_state,
        filter_expression, transform_template`

// encryptAuthConfig prepares the split receiver-auth storage representation:
// value-free JSONB metadata plus an envelope ciphertext. A nil normalized
// config is the explicit "no receiver auth" state.
func (s *Store) encryptAuthConfig(ctx context.Context, in *AuthConfig) (metadata, envelope []byte, err error) {
	normalized, err := normalizeAuthConfig(in)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: %v", ErrInvalidAuthConfig, err)
	}
	metadata, err = encodeAuthMetadata(normalized)
	if err != nil {
		return nil, nil, err
	}
	if normalized == nil {
		return metadata, nil, nil
	}
	if s.Cipher == nil {
		return nil, nil, ErrCipherUnconfigured
	}
	plaintext, err := json.Marshal(normalized)
	if err != nil {
		return nil, nil, err
	}
	envelope, err = s.Cipher.Encrypt(ctx, plaintext)
	if err != nil {
		return nil, nil, fmt.Errorf("encrypt receiver auth: %w", err)
	}
	if len(envelope) == 0 || len(envelope) > maxAuthEnvelopeBytes {
		return nil, nil, errors.New("encrypt receiver auth: invalid ciphertext size")
	}
	return metadata, envelope, nil
}

// Create persists a new webhook. Private signing material is envelope-
// encrypted before storage. The HMAC shared secret is returned once;
// asymmetric responses expose only the public verification key.
//
// Algorithm defaults to hmac_sha256 for backward compatibility. ECDSA
// and Ed25519 generate a keypair; the private key is envelope-encrypted
// at rest, the public key is stored in the clear so future GET calls
// can return it for subscriber verification.
func (s *Store) Create(ctx context.Context, tenantID, userID string, in CreateInput, requireHTTPS bool) (*CreateResponse, error) {
	description, err := normalizeDescription(in.Description)
	if err != nil {
		return nil, err
	}
	listID := strings.TrimSpace(in.ListID)
	if listID != "" {
		parsedListID, err := uuid.Parse(listID)
		if err != nil {
			return nil, ErrInvalidListID
		}
		listID = parsedListID.String()
	}
	urlDisplay, urlEnvelope, err := s.encodeDestination(ctx, in.URL, requireHTTPS)
	if err != nil {
		return nil, err
	}
	filterExpression, err := normalizeFilterExpression(in.FilterExpression)
	if err != nil {
		return nil, err
	}
	transformJSON, err := encodeTransformTemplate(in.TransformTemplate)
	if err != nil {
		return nil, err
	}
	events, err := validateEvents(in.Events)
	if err != nil {
		return nil, err
	}
	if s.Cipher == nil {
		return nil, ErrCipherUnconfigured
	}
	algorithm := in.Algorithm
	if algorithm == "" {
		algorithm = AlgorithmHMACSHA256
	}
	if !IsAllowedAlgorithm(algorithm) {
		return nil, fmt.Errorf("%w: unsupported signing algorithm %q", ErrInvalidEvent, algorithm)
	}
	authMetadata, authEnvelope, err := s.encryptAuthConfig(ctx, in.AuthConfig)
	if err != nil {
		return nil, err
	}
	mat, err := GenerateSigningMaterial(algorithm)
	if err != nil {
		return nil, fmt.Errorf("gen signing material: %w", err)
	}
	storeBytes, err := StoreEncode(mat)
	if err != nil {
		return nil, fmt.Errorf("encode signing material: %w", err)
	}
	envelope, err := s.Cipher.Encrypt(ctx, storeBytes)
	if err != nil {
		return nil, fmt.Errorf("encrypt secret: %w", err)
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if listID != "" {
		var mapped bool
		if err := tx.QueryRow(ctx, `
SELECT true
  FROM list_id_map
 WHERE tenant_id = $1::uuid
   AND postwave_uuid = $2::uuid
 FOR KEY SHARE`,
			tenantID, listID,
		).Scan(&mapped); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrListNotFound
			}
			return nil, err
		}
	}
	w := &Webhook{}
	row := tx.QueryRow(ctx, `
INSERT INTO outbound_webhooks
    (tenant_id, url, description, events, secret_envelope, created_by_user_id,
     signing_algorithm, signing_public_key, list_id, auth_config,
     auth_config_envelope, auth_config_state, url_envelope, url_state,
     filter_expression, transform_template)
VALUES ($1::uuid, $2, NULLIF($3, ''), $4, $5, NULLIF($6, '')::uuid,
        $7, NULLIF($8, ''), NULLIF($9, '')::uuid, $10::jsonb, $11, $12,
        $13, $14, NULLIF($15, ''), $16::jsonb)
RETURNING `+webhookSelectColumns,
		tenantID, urlDisplay, description, events, envelope, userID,
		algorithm, mat.PublicKeyPEM, listID, string(authMetadata), authEnvelope,
		authConfigStateReady, urlEnvelope, destinationStateReady,
		filterExpression, jsonbArg(transformJSON))
	if err := scanWebhook(row, w); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	resp := &CreateResponse{Webhook: w}
	if algorithm == AlgorithmHMACSHA256 {
		resp.SigningSecret = mat.Secret
	} else {
		resp.PublicKeyPEM = mat.PublicKeyPEM
	}
	return resp, nil
}

// Rotate generates fresh signing material for the webhook, demotes the
// existing key to "secondary" for the grace window, and returns the
// new shared HMAC secret or asymmetric public verification material.
// Asymmetric private material remains server-side.
//
// During the grace window (default 24h) the worker dual-signs every
// delivery so subscribers can verify against either key. After
// secondary_expires_at the janitor clears the secondary columns.
//
// graceWindow=0 uses 24h.
func (s *Store) Rotate(ctx context.Context, tenantID, id string, graceWindow time.Duration) (*CreateResponse, error) {
	if s.Cipher == nil {
		return nil, ErrCipherUnconfigured
	}
	if graceWindow <= 0 {
		graceWindow = 24 * time.Hour
	}

	// Step 1: load the row so we know which algorithm to generate.
	current, err := s.Get(ctx, tenantID, id)
	if err != nil {
		return nil, err
	}

	// Step 2: generate fresh material with the SAME algorithm. Operators
	// who want to switch algorithms create a new webhook.
	mat, err := GenerateSigningMaterial(current.SigningAlgorithm)
	if err != nil {
		return nil, fmt.Errorf("rotate: generate: %w", err)
	}
	storeBytes, err := StoreEncode(mat)
	if err != nil {
		return nil, err
	}
	newEnvelope, err := s.Cipher.Encrypt(ctx, storeBytes)
	if err != nil {
		return nil, fmt.Errorf("rotate: encrypt: %w", err)
	}

	expires := time.Now().UTC().Add(graceWindow)
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	w := &Webhook{}
	// Demote both halves of the currently committed key in the same UPDATE
	// that installs the replacement. PostgreSQL serializes concurrent updates to
	// this row and re-evaluates these old-column expressions against the winning
	// tuple, so ciphertext and public verification material cannot come from
	// different rotations and every displaced key receives its grace window.
	row := tx.QueryRow(ctx, `
UPDATE outbound_webhooks SET
	secret_envelope           = $3,
	signing_public_key        = NULLIF($4, ''),
	secondary_secret_envelope = secret_envelope,
	secondary_public_key      = signing_public_key,
	secondary_expires_at      = $6,
	rotated_at                = now(),
	updated_at                = now(),
	config_version            = config_version + 1
 WHERE tenant_id = $1::uuid
	AND id::text = $2
	AND signing_algorithm = $5
	AND deleted_at IS NULL
RETURNING `+webhookSelectColumns,
		tenantID, id, newEnvelope, mat.PublicKeyPEM,
		current.SigningAlgorithm, expires)
	if err := scanWebhook(row, w); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	resp := &CreateResponse{Webhook: w}
	if current.SigningAlgorithm == AlgorithmHMACSHA256 {
		resp.SigningSecret = mat.Secret
	} else {
		resp.PublicKeyPEM = mat.PublicKeyPEM
	}
	return resp, nil
}

// SweepExpiredSecondary clears secondary_* columns whose
// secondary_expires_at has passed. Returns the number of rows updated.
// Intended for a background janitor; safe to call without a tenant
// context (writes through the worker permissive policy).
func (s *Store) SweepExpiredSecondary(ctx context.Context) (int64, error) {
	tx, err := db.WithWorkerScope(ctx, s.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE outbound_webhooks SET
    secondary_secret_envelope = NULL,
    secondary_public_key      = NULL,
    secondary_expires_at      = NULL,
    updated_at                = now(),
    config_version            = config_version + CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END
 WHERE secondary_expires_at IS NOT NULL AND secondary_expires_at < now()`)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// List returns every webhook for the tenant, newest first.
func (s *Store) List(ctx context.Context, tenantID string) ([]Webhook, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+webhookSelectColumns+`
 FROM outbound_webhooks
 WHERE tenant_id = $1::uuid
   AND deleted_at IS NULL
 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Webhook{}
	for rows.Next() {
		var w Webhook
		if err := scanWebhook(rows, &w); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ListPage returns a stable newest-first operator page without changing List,
// which the delivery dispatcher intentionally uses to refresh its complete
// per-tenant subscription cache.
func (s *Store) ListPage(ctx context.Context, tenantID, query string, limit int, cursor pagination.Cursor) ([]Webhook, string, error) {
	if limit < 1 || limit > pagination.MaxLimit {
		limit = pagination.DefaultLimit
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	args := []any{tenantID, strings.TrimSpace(query)}
	cursorPredicate := ""
	if cursor.ID != "" {
		cursorPredicate = " AND (created_at, id::text) < ($3::timestamptz, $4)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	args = append(args, limit+1)
	rows, err := tx.Query(ctx, `
SELECT `+webhookSelectColumns+`
 FROM outbound_webhooks
 WHERE tenant_id = $1::uuid
   AND deleted_at IS NULL
   AND ($2 = '' OR description ILIKE '%' || $2 || '%'
                    OR url ILIKE '%' || $2 || '%'
                    OR array_to_string(events, ' ') ILIKE '%' || $2 || '%')
`+cursorPredicate+`
 ORDER BY created_at DESC, id::text DESC
 LIMIT $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []Webhook{}
	for rows.Next() {
		var webhook Webhook
		if err := scanWebhook(rows, &webhook); err != nil {
			return nil, "", err
		}
		out = append(out, webhook)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	trimmed, hasMore := pagination.HasMore(out, limit)
	nextCursor := ""
	if hasMore && len(trimmed) > 0 {
		last := trimmed[len(trimmed)-1]
		nextCursor = pagination.Encode(pagination.Cursor{SortKey: last.CreatedAt, ID: last.ID})
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	return trimmed, nextCursor, nil
}

// ListForListPage returns a stable, bounded page of canonical endpoints for
// one tenant-owned list. The dedicated list compatibility façade uses this
// instead of loading the tenant-wide dispatcher catalog and filtering it in
// memory.
func (s *Store) ListForListPage(
	ctx context.Context,
	tenantID string,
	listID string,
	limit int,
	cursor pagination.Cursor,
) ([]Webhook, string, error) {
	parsedListID, err := uuid.Parse(strings.TrimSpace(listID))
	if err != nil {
		return nil, "", ErrInvalidListID
	}
	if limit < 1 || limit > pagination.MaxLimit {
		limit = pagination.DefaultLimit
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	args := []any{tenantID, parsedListID.String()}
	cursorPredicate := ""
	if cursor.ID != "" {
		cursorPredicate = " AND (created_at, id::text) < ($3::timestamptz, $4)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	args = append(args, limit+1)
	rows, err := tx.Query(ctx, `
SELECT `+webhookSelectColumns+`
 FROM outbound_webhooks
 WHERE tenant_id = $1::uuid
   AND list_id = $2::uuid
   AND deleted_at IS NULL
`+cursorPredicate+`
 ORDER BY created_at DESC, id::text DESC
 LIMIT $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []Webhook{}
	for rows.Next() {
		var webhook Webhook
		if err := scanWebhook(rows, &webhook); err != nil {
			return nil, "", err
		}
		out = append(out, webhook)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	trimmed, hasMore := pagination.HasMore(out, limit)
	nextCursor := ""
	if hasMore && len(trimmed) > 0 {
		last := trimmed[len(trimmed)-1]
		nextCursor = pagination.Encode(pagination.Cursor{SortKey: last.CreatedAt, ID: last.ID})
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	return trimmed, nextCursor, nil
}

// Get fetches one webhook by id (within tenant).
func (s *Store) Get(ctx context.Context, tenantID, id string) (*Webhook, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	w := &Webhook{}
	row := tx.QueryRow(ctx, `
SELECT `+webhookSelectColumns+`
 FROM outbound_webhooks
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND deleted_at IS NULL`, tenantID, id)
	if err := scanWebhook(row, w); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return w, tx.Commit(ctx)
}

// Update applies a partial patch. URL/events are validated when present.
func (s *Store) Update(ctx context.Context, tenantID, id string, in UpdateInput, requireHTTPS bool) (*Webhook, error) {
	description := in.Description
	if description != nil {
		normalized, err := normalizeDescription(*description)
		if err != nil {
			return nil, err
		}
		description = &normalized
	}
	var urlDisplay any
	var urlEnvelope []byte
	urlChange := in.URL != nil
	if in.URL != nil {
		display, envelope, err := s.encodeDestination(ctx, *in.URL, requireHTTPS)
		if err != nil {
			return nil, err
		}
		urlDisplay = display
		urlEnvelope = envelope
	}
	var events []string
	if in.Events != nil {
		ev, err := validateEvents(*in.Events)
		if err != nil {
			return nil, err
		}
		events = ev
	}
	authChange := in.changesAuthConfig()
	var authMetadata, authEnvelope []byte
	var err error
	if authChange {
		authMetadata, authEnvelope, err = s.encryptAuthConfig(ctx, in.AuthConfig)
		if err != nil {
			return nil, err
		}
	}
	filterChange := in.changesFilterExpression()
	filterExpression := ""
	if in.FilterExpression != nil {
		filterExpression, err = normalizeFilterExpression(*in.FilterExpression)
		if err != nil {
			return nil, err
		}
	}
	transformChange := in.changesTransformTemplate()
	var transformJSON []byte
	if in.TransformTemplate != nil {
		transformJSON, err = encodeTransformTemplate(*in.TransformTemplate)
		if err != nil {
			return nil, err
		}
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	w := &Webhook{}
	row := tx.QueryRow(ctx, `
UPDATE outbound_webhooks SET
    url         = COALESCE($3, url),
    description = COALESCE($4, description),
    events      = COALESCE($5, events),
    active      = COALESCE($6, active),
    auth_config = CASE WHEN $7 THEN $8::jsonb ELSE auth_config END,
    auth_config_envelope = CASE WHEN $7 THEN $9::bytea ELSE auth_config_envelope END,
    auth_config_state = CASE WHEN $7 THEN $10 ELSE auth_config_state END,
    auth_config_restore_active = CASE WHEN $7 THEN NULL ELSE auth_config_restore_active END,
    disabled_reason = CASE
        WHEN $6::boolean IS NULL THEN disabled_reason
        WHEN $6::boolean THEN NULL
        ELSE 'manual'
    END,
    disabled_at = CASE
        WHEN $6::boolean IS NULL THEN disabled_at
        WHEN $6::boolean THEN NULL
        ELSE now()
    END,
    consecutive_failures = CASE
        WHEN $6::boolean IS TRUE THEN 0
        ELSE consecutive_failures
    END,
    url_envelope = CASE WHEN $11 THEN $12::bytea ELSE url_envelope END,
    url_state = CASE WHEN $11 THEN 'ready' ELSE url_state END,
    filter_expression = CASE WHEN $13 THEN NULLIF($14, '') ELSE filter_expression END,
    transform_template = CASE WHEN $15 THEN $16::jsonb ELSE transform_template END,
    updated_at  = now(),
    config_version = config_version + CASE WHEN
        ($7::boolean AND (
            auth_config IS DISTINCT FROM $8::jsonb
            OR auth_config_envelope IS DISTINCT FROM $9::bytea
            OR auth_config_state IS DISTINCT FROM $10::text
            OR auth_config_restore_active IS NOT NULL
        )) OR $11::boolean
        OR ($5::text[] IS NOT NULL AND events IS DISTINCT FROM $5::text[])
        OR ($6::boolean IS NOT NULL AND active IS DISTINCT FROM $6::boolean)
        OR ($13::boolean AND filter_expression IS DISTINCT FROM NULLIF($14, ''))
        OR ($15::boolean AND transform_template IS DISTINCT FROM $16::jsonb)
        THEN 1 ELSE 0 END
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND deleted_at IS NULL
RETURNING `+webhookSelectColumns,
		tenantID, id,
		urlDisplay,
		strPtr(description),
		eventsArg(events),
		boolPtr(in.Active),
		authChange,
		jsonbArg(authMetadata),
		authEnvelope,
		authConfigStateReady,
		urlChange,
		urlEnvelope,
		filterChange,
		filterExpression,
		transformChange,
		jsonbArg(transformJSON),
	)
	if err := scanWebhook(row, w); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if w.Active {
		if err := validateActivationReadiness(w); err != nil {
			return nil, err
		}
		if err := resumePausedDeliveries(ctx, tx, tenantID, id); err != nil {
			return nil, err
		}
		if in.Active != nil && *in.Active {
			if err := finalizeOperatorNotifications(
				ctx,
				tx,
				tenantID,
				id,
				"endpoint re-enabled before notification delivery",
			); err != nil {
				return nil, err
			}
		}
	} else if !w.Active {
		if err := pauseDisabledDeliveries(ctx, tx, tenantID, id); err != nil {
			return nil, err
		}
	}
	return w, tx.Commit(ctx)
}

func validateActivationReadiness(webhook *Webhook) error {
	if webhook == nil {
		return ErrNotFound
	}
	switch webhook.AuthConfigStatus {
	case authConfigStateReady:
	case authConfigStateLegacyPending:
		return ErrAuthConfigPending
	default:
		return ErrAuthConfigInvalid
	}
	switch webhook.URLStatus {
	case destinationStateReady:
	case destinationStateLegacyPending:
		return ErrDestinationPending
	default:
		return ErrDestinationInvalid
	}
	if webhook.DeliveryPolicyStatus != "ready" {
		return ErrDeliveryPolicyInvalid
	}
	return nil
}

func resumePausedDeliveries(ctx context.Context, tx pgx.Tx, tenantID, webhookID string) error {
	_, err := tx.Exec(ctx, `
UPDATE outbound_webhook_deliveries
   SET next_attempt_at = now(),
       auth_config_paused_at = NULL,
       disabled_paused_at = NULL,
       url_paused_at = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL
 WHERE tenant_id = $1::uuid
   AND webhook_id = $2::uuid
   AND status = 'pending'
   AND (
       auth_config_paused_at IS NOT NULL
       OR disabled_paused_at IS NOT NULL
       OR url_paused_at IS NOT NULL
   )
   AND EXISTS (
       SELECT 1
         FROM outbound_webhooks AS parent
        WHERE parent.id = outbound_webhook_deliveries.webhook_id
          AND parent.tenant_id = outbound_webhook_deliveries.tenant_id
          AND parent.deleted_at IS NULL
          AND parent.active = true
          AND parent.auth_config_state = 'ready'
          AND parent.url_state = 'ready'
   )`,
		tenantID, webhookID)
	return err
}

func pauseDisabledDeliveries(ctx context.Context, tx pgx.Tx, tenantID, webhookID string) error {
	_, err := tx.Exec(ctx, `
UPDATE outbound_webhook_deliveries
   SET next_attempt_at = NULL,
       disabled_paused_at = COALESCE(disabled_paused_at, now()),
       lease_owner = NULL,
       lease_expires_at = NULL
 WHERE tenant_id = $1::uuid
   AND webhook_id = $2::uuid
   AND status = 'pending'`,
		tenantID, webhookID)
	return err
}

func finalizeDeletedDeliveries(
	ctx context.Context,
	tx pgx.Tx,
	tenantID,
	webhookID string,
) error {
	_, err := tx.Exec(ctx, `
UPDATE outbound_webhook_deliveries
   SET status = 'skipped',
       next_attempt_at = NULL,
       last_error = COALESCE(last_error, 'endpoint deleted by operator'),
       disabled_paused_at = COALESCE(disabled_paused_at, now()),
       lease_owner = NULL,
       lease_expires_at = NULL
 WHERE tenant_id = $1::uuid
   AND webhook_id = $2::uuid
   AND status = 'pending'`,
		tenantID, webhookID,
	)
	return err
}

func finalizeOperatorNotifications(
	ctx context.Context,
	tx pgx.Tx,
	tenantID,
	webhookID,
	reason string,
) error {
	_, err := tx.Exec(ctx, `
UPDATE outbound_webhook_operator_notifications
   SET status = 'exhausted',
       next_attempt_at = NULL,
       last_error = $3,
       exhausted_at = now(),
       lease_owner = NULL,
       lease_expires_at = NULL
 WHERE tenant_id = $1::uuid
   AND webhook_id = $2::uuid
   AND status IN ('pending', 'sending')`,
		tenantID, webhookID, truncate(reason, 512),
	)
	return err
}

// tombstoneWebhookSet is the one definition of a deleted endpoint: stopped,
// stamped, and stripped of every secret and destination it held. The row
// itself survives as delivery evidence until the retention sweeper purges it.
const tombstoneWebhookSet = `
   SET active = false,
       deleted_at = now(),
       disabled_reason = 'manual',
       disabled_at = COALESCE(disabled_at, now()),
       secret_envelope = ''::bytea,
       secondary_secret_envelope = NULL,
       secondary_public_key = NULL,
       secondary_expires_at = NULL,
       url_envelope = NULL,
       url_state = 'invalid',
       auth_config = '{}'::jsonb,
       auth_config_envelope = NULL,
       auth_config_state = 'invalid',
       auth_config_restore_active = NULL,
       url_restore_active = NULL,
       updated_at = now(),
       config_version = config_version + 1`

// Delete tombstones and stops a webhook while preserving delivery evidence
// until the tenant's retention sweeper can safely purge it.
func (s *Store) Delete(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE outbound_webhooks`+tombstoneWebhookSet+`
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND deleted_at IS NULL`,
		tenantID, id,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err := finalizeDeletedDeliveries(ctx, tx, tenantID, id); err != nil {
		return err
	}
	if err := finalizeOperatorNotifications(
		ctx,
		tx,
		tenantID,
		id,
		"endpoint deleted by operator",
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// DeleteListScopedTx tombstones every live endpoint scoped to listUUID, inside
// the caller's tenant transaction, exactly as Delete tombstones one. It is the
// list-deletion half of the endpoint lifecycle: an endpoint scoped to a list
// that no longer exists can never fire again, and leaving it live would keep a
// destination and signing secret attached to nothing. Returns the number of
// endpoints tombstoned.
func DeleteListScopedTx(ctx context.Context, tx pgx.Tx, tenantID, listUUID string) (int, error) {
	rows, err := tx.Query(ctx, `
UPDATE outbound_webhooks`+tombstoneWebhookSet+`
 WHERE tenant_id = $1::uuid
   AND list_id = $2::uuid
   AND deleted_at IS NULL
RETURNING id::text`,
		tenantID, listUUID,
	)
	if err != nil {
		return 0, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, id := range ids {
		if err := finalizeDeletedDeliveries(ctx, tx, tenantID, id); err != nil {
			return 0, err
		}
		if err := finalizeOperatorNotifications(ctx, tx, tenantID, id,
			"endpoint deleted with its list"); err != nil {
			return 0, err
		}
	}
	return len(ids), nil
}

// SoftDelete sets active=false (the webhook keeps its row + history but
// stops receiving deliveries). Idempotent.
func (s *Store) SoftDelete(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx,
		`UPDATE outbound_webhooks
		    SET active = false,
		        disabled_reason = 'manual',
		        disabled_at = now(),
		        updated_at = now(),
		        config_version = config_version + CASE WHEN active THEN 1 ELSE 0 END
		  WHERE tenant_id = $1::uuid
		    AND id::text = $2
		    AND deleted_at IS NULL`,
		tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if err := pauseDisabledDeliveries(ctx, tx, tenantID, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// EnqueueDelivery inserts a pending delivery row scheduled for now. The
// source event id is unique per webhook, so retries, Redis echoes and recovery
// scans converge on one customer delivery rather than double-posting.
// Returns an empty id with nil error when the event was already enqueued.
func (s *Store) EnqueueDelivery(ctx context.Context, tenantID, webhookID, eventType, sourceEventID string, payloadJSON []byte) (string, error) {
	if strings.TrimSpace(sourceEventID) == "" {
		return "", errors.New("outbound_webhooks: source event id required")
	}
	if _, err := uuid.Parse(sourceEventID); err != nil {
		return "", errors.New("outbound_webhooks: source event id must be a UUID")
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		filterExpr    *string
		transformJSON []byte
	)
	if err := tx.QueryRow(ctx, `
SELECT filter_expression, transform_template
  FROM outbound_webhooks
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND deleted_at IS NULL
   AND active = true
   AND auth_config_state = 'ready'
   AND url_state = 'ready'
 FOR UPDATE`,
		tenantID, webhookID,
	).Scan(&filterExpr, &transformJSON); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if err := tx.Commit(ctx); err != nil {
				return "", err
			}
			return "", nil
		}
		return "", err
	}
	if filterExpr != nil && strings.TrimSpace(*filterExpr) != "" {
		if _, err := ParseFilter(*filterExpr); err != nil {
			return "", ErrDeliveryPolicyInvalid
		}
	}
	if len(transformJSON) > 0 {
		var transform map[string]any
		if err := json.Unmarshal(transformJSON, &transform); err != nil {
			return "", ErrDeliveryPolicyInvalid
		}
		if err := ValidateTransform(transform); err != nil {
			return "", ErrDeliveryPolicyInvalid
		}
	}
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO outbound_webhook_deliveries
    (tenant_id, webhook_id, event_type, source_event_id, payload, next_attempt_at, status)
VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, now(), 'pending')
ON CONFLICT (tenant_id, webhook_id, source_event_id)
    WHERE source_event_id IS NOT NULL AND parent_delivery_id IS NULL
DO NOTHING
RETURNING id::text`,
		tenantID, webhookID, eventType, sourceEventID, string(payloadJSON),
	).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			if err := tx.Commit(ctx); err != nil {
				return "", err
			}
			return "", nil
		}
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

// ReplayDelivery clones an existing delivery row into a new row and
// queues the clone. The original row is left untouched so the audit
// trail is preserved AND so receivers that dedupe on the X-Postwave-
// Delivery header don't silently swallow the replay (the new row
// gets a fresh UUID).
//
// Pre-C5 behaviour: this function MUTATED the original row in place
// (reset attempt_count, cleared failure trail, set next_attempt_at)
// — that breaks receiver-side dedup (same delivery id ⇒ "we already
// saw this"). It also destroyed the failure history that operators
// rely on for debugging the original failure.
//
// New row carries:
//   - same webhook_id + event_type + payload
//   - new id, status='pending', attempt_count=0
//   - parent_delivery_id pointing at the original
//
// Returns a frozen replay response or ErrNotFound if the original row
// doesn't exist. Pending deliveries cannot be replayed: cloning an
// in-flight row would race the normal retry worker and can double-send
// the same business event. Idempotency keys are tenant-global for this
// operation: the same key and source return the original child, while
// reuse for another source fails with ErrReplayConflict.
func (s *Store) ReplayDelivery(
	ctx context.Context,
	tenantID, deliveryID, idempotencyKey string,
) (ReplayDeliveryResult, error) {
	idempotencyKey, err := normalizeOutboundReplayIdempotencyKey(idempotencyKey)
	if err != nil {
		return ReplayDeliveryResult{}, err
	}
	parsedDeliveryID, err := uuid.Parse(strings.TrimSpace(deliveryID))
	if err != nil {
		return ReplayDeliveryResult{}, ErrNotFound
	}
	deliveryID = parsedDeliveryID.String()
	replayKeyHash := outboundReplayKeyHash(tenantID, idempotencyKey)
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return ReplayDeliveryResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Return the frozen response before inspecting current endpoint state.
	// A retry after response loss must remain stable even if the worker has
	// since delivered the child or an operator disabled/tombstoned its parent.
	if existing, found, loadErr := loadOutboundReplayByKeyTx(
		ctx,
		tx,
		tenantID,
		replayKeyHash,
	); loadErr != nil {
		return ReplayDeliveryResult{}, loadErr
	} else if found {
		if existing.ReplayedFrom != deliveryID {
			return ReplayDeliveryResult{}, ErrReplayConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return ReplayDeliveryResult{}, err
		}
		return existing, nil
	}

	var (
		sourceStatus  string
		active        bool
		authState     string
		urlState      string
		filterExpr    *string
		transformJSON []byte
	)
	if err := tx.QueryRow(ctx, `
SELECT delivery.status, webhook.active, webhook.auth_config_state,
       COALESCE(webhook.url_state, 'legacy_pending'),
       webhook.filter_expression, webhook.transform_template
  FROM outbound_webhook_deliveries AS delivery
  JOIN outbound_webhooks AS webhook
    ON webhook.id = delivery.webhook_id
   AND webhook.tenant_id = delivery.tenant_id
 WHERE delivery.tenant_id = $1::uuid
   AND delivery.id::text = $2
   AND webhook.deleted_at IS NULL
 FOR SHARE OF delivery, webhook`,
		tenantID, deliveryID,
	).Scan(
		&sourceStatus,
		&active,
		&authState,
		&urlState,
		&filterExpr,
		&transformJSON,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ReplayDeliveryResult{}, ErrNotFound
		}
		return ReplayDeliveryResult{}, err
	}
	if sourceStatus == "pending" {
		return ReplayDeliveryResult{}, ErrDeliveryInProgress
	}
	if !active {
		return ReplayDeliveryResult{}, ErrWebhookInactive
	}
	switch authState {
	case authConfigStateReady:
	case authConfigStateLegacyPending:
		return ReplayDeliveryResult{}, ErrAuthConfigPending
	default:
		return ReplayDeliveryResult{}, ErrAuthConfigInvalid
	}
	switch urlState {
	case destinationStateReady:
	case destinationStateLegacyPending:
		return ReplayDeliveryResult{}, ErrDestinationPending
	default:
		return ReplayDeliveryResult{}, ErrDestinationInvalid
	}
	if filterExpr != nil && strings.TrimSpace(*filterExpr) != "" {
		if _, err := ParseFilter(*filterExpr); err != nil {
			return ReplayDeliveryResult{}, ErrDeliveryPolicyInvalid
		}
	}
	if len(transformJSON) > 0 {
		var transform map[string]any
		if err := json.Unmarshal(transformJSON, &transform); err != nil {
			return ReplayDeliveryResult{}, ErrDeliveryPolicyInvalid
		}
		if err := ValidateTransform(transform); err != nil {
			return ReplayDeliveryResult{}, ErrDeliveryPolicyInvalid
		}
	}
	var result ReplayDeliveryResult
	err = tx.QueryRow(ctx, `
INSERT INTO outbound_webhook_deliveries (
    tenant_id, webhook_id, event_type, source_event_id, payload,
    status, attempt_count, next_attempt_at, parent_delivery_id,
    replay_idempotency_hash, replayed_at
)
SELECT tenant_id, webhook_id, event_type, source_event_id, payload,
       'pending', 0, now(), id, $3, now()
  FROM outbound_webhook_deliveries
 WHERE tenant_id = $1::uuid AND id::text = $2
ON CONFLICT (tenant_id, replay_idempotency_hash)
    WHERE replay_idempotency_hash IS NOT NULL
DO NOTHING
RETURNING id::text, parent_delivery_id::text, replayed_at`,
		tenantID, deliveryID, replayKeyHash,
	).Scan(&result.DeliveryID, &result.ReplayedFrom, &result.ReplayedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			existing, found, loadErr := loadOutboundReplayByKeyTx(
				ctx,
				tx,
				tenantID,
				replayKeyHash,
			)
			if loadErr != nil {
				return ReplayDeliveryResult{}, loadErr
			}
			if !found {
				return ReplayDeliveryResult{}, ErrNotFound
			}
			if existing.ReplayedFrom != deliveryID {
				return ReplayDeliveryResult{}, ErrReplayConflict
			}
			result = existing
		} else {
			return ReplayDeliveryResult{}, err
		}
	}
	result.Status = "pending"
	if err := tx.Commit(ctx); err != nil {
		return ReplayDeliveryResult{}, err
	}
	return result, nil
}

func loadOutboundReplayByKeyTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	replayKeyHash []byte,
) (ReplayDeliveryResult, bool, error) {
	var result ReplayDeliveryResult
	if err := tx.QueryRow(ctx, `
SELECT id::text, parent_delivery_id::text, replayed_at
  FROM outbound_webhook_deliveries
 WHERE tenant_id = $1::uuid
   AND replay_idempotency_hash = $2
 FOR SHARE`,
		tenantID,
		replayKeyHash,
	).Scan(
		&result.DeliveryID,
		&result.ReplayedFrom,
		&result.ReplayedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ReplayDeliveryResult{}, false, nil
		}
		return ReplayDeliveryResult{}, false, err
	}
	result.Status = "pending"
	return result, true, nil
}

// PendingDelivery is the worker's view of a row it claimed. Includes
// the webhook URL + tenant id so the worker can sign + POST without a
// second DB round-trip per delivery.
type PendingDelivery struct {
	ID            string
	TenantID      string
	WebhookID     string
	URL           string
	EventType     string
	SourceEventID string
	Payload       []byte
	AttemptCount  int
	LeaseOwner    string
}

// AcquireLease atomically picks up to `limit` pending deliveries whose
// next_attempt_at <= now() AND (lease_expires_at IS NULL OR
// lease_expires_at < now()), stamps them with the caller's owner id +
// an expiry, and returns the leased rows. Uses SELECT FOR UPDATE SKIP
// LOCKED so concurrent workers across replicas never collide on the
// same row.
//
// Compared to ClaimPending (the legacy entry point), AcquireLease does
// NOT null next_attempt_at. That matters when a worker dies mid-flight:
// the row stays status='pending' with its original next_attempt_at,
// and the lease_expires_at check naturally lets the next sweep pick
// it up after leaseDuration elapses — no orphaned rows.
//
// On row finalisation (MarkDelivered/MarkFailure) the lease columns
// become irrelevant: MarkDelivered flips status='delivered' (so the
// 'pending' filter excludes it) and MarkFailure either reschedules
// the row (next_attempt_at moves to the future + lease cleared, so the
// next sweep re-leases when due) or marks it exhausted.
func (s *Store) AcquireLease(ctx context.Context, owner string, limit int, leaseDuration time.Duration) ([]PendingDelivery, error) {
	if limit <= 0 {
		limit = 50
	}
	if leaseDuration <= 0 {
		leaseDuration = 60 * time.Second
	}
	if owner == "" {
		return nil, fmt.Errorf("AcquireLease: owner required")
	}
	conn, err := s.Pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', true)"); err != nil {
		return nil, fmt.Errorf("set worker scope: %w", err)
	}
	// pgx maps time.Duration to interval natively via $3::interval but
	// the planner is fussier if we pass it as microseconds — encode as
	// the canonical "Nus" literal so we don't depend on driver-specific
	// duration→interval translation.
	leaseInterval := fmt.Sprintf("%d microseconds", leaseDuration.Microseconds())
	rows, err := tx.Query(ctx, `
WITH picked AS (
  SELECT d.id
    FROM outbound_webhook_deliveries d
   WHERE d.status = 'pending'
     AND d.next_attempt_at IS NOT NULL
     AND d.next_attempt_at <= now()
     AND (d.lease_expires_at IS NULL OR d.lease_expires_at < now())
     AND EXISTS (
         SELECT 1
           FROM outbound_webhooks AS parent
          WHERE parent.id = d.webhook_id
            AND parent.tenant_id = d.tenant_id
            AND parent.deleted_at IS NULL
            AND parent.active = true
            AND parent.auth_config_state = 'ready'
            AND parent.url_state = 'ready'
     )
   ORDER BY d.next_attempt_at ASC
   FOR UPDATE SKIP LOCKED
   LIMIT $1
)
UPDATE outbound_webhook_deliveries d
   SET lease_owner      = $2,
       lease_expires_at = now() + $3::interval
  FROM picked c
  JOIN outbound_webhooks w ON w.id = (
    SELECT webhook_id FROM outbound_webhook_deliveries WHERE id = c.id
  )
   AND w.tenant_id = (
     SELECT tenant_id FROM outbound_webhook_deliveries WHERE id = c.id
   )
   AND w.deleted_at IS NULL
 WHERE d.id = c.id
 RETURNING d.id::text, d.tenant_id::text, d.webhook_id::text, w.url,
           d.event_type, COALESCE(d.source_event_id::text, ''),
           d.payload::text, d.attempt_count`,
		limit, owner, leaseInterval)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PendingDelivery{}
	for rows.Next() {
		var p PendingDelivery
		var payload string
		if err := rows.Scan(
			&p.ID, &p.TenantID, &p.WebhookID, &p.URL,
			&p.EventType, &p.SourceEventID, &payload, &p.AttemptCount,
		); err != nil {
			return nil, err
		}
		p.Payload = []byte(payload)
		p.LeaseOwner = owner
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ReleaseLease clears the lease on `id` WITHOUT changing status — used
// when a worker is cancelled mid-batch (graceful shutdown) so the row
// becomes immediately eligible for another worker instead of waiting
// for the lease to expire. The owner check guards against a stale
// worker accidentally clearing a lease another worker has since
// acquired (e.g. if the stale worker's HTTP call wins the race after
// the lease expired and another worker stole the row).
func (s *Store) ReleaseLease(ctx context.Context, id, owner string) error {
	if id == "" || owner == "" {
		return fmt.Errorf("ReleaseLease: id and owner required")
	}
	conn, err := s.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', true)"); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
UPDATE outbound_webhook_deliveries
   SET lease_owner      = NULL,
       lease_expires_at = NULL
 WHERE id::text = $1
   AND lease_owner = $2`,
		id, owner); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ClaimPending pulls up to `limit` pending deliveries whose
// next_attempt_at <= now() and atomically marks them as in-flight by
// nulling next_attempt_at (so a sibling worker on another replica
// won't re-claim the same row before we update it). Worker context.
//
// Deprecated: prefer AcquireLease, which survives a worker crash
// (stale leases recover automatically). ClaimPending is kept for
// callers that haven't migrated yet.
func (s *Store) ClaimPending(ctx context.Context, limit int) ([]PendingDelivery, error) {
	if limit <= 0 {
		limit = 50
	}
	conn, err := s.Pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', true)"); err != nil {
		return nil, fmt.Errorf("set worker scope: %w", err)
	}
	rows, err := tx.Query(ctx, `
WITH claimed AS (
  SELECT d.id
    FROM outbound_webhook_deliveries d
   WHERE d.status = 'pending'
     AND d.next_attempt_at IS NOT NULL
     AND d.next_attempt_at <= now()
     AND EXISTS (
         SELECT 1
           FROM outbound_webhooks AS parent
          WHERE parent.id = d.webhook_id
            AND parent.tenant_id = d.tenant_id
            AND parent.deleted_at IS NULL
            AND parent.active = true
            AND parent.auth_config_state = 'ready'
            AND parent.url_state = 'ready'
     )
   ORDER BY d.next_attempt_at
   FOR UPDATE SKIP LOCKED
   LIMIT $1
)
UPDATE outbound_webhook_deliveries d
   SET next_attempt_at = NULL
  FROM claimed c
  JOIN outbound_webhooks w ON w.id = (
    SELECT webhook_id FROM outbound_webhook_deliveries WHERE id = c.id
  )
   AND w.tenant_id = (
     SELECT tenant_id FROM outbound_webhook_deliveries WHERE id = c.id
   )
   AND w.deleted_at IS NULL
 WHERE d.id = c.id
 RETURNING d.id::text, d.tenant_id::text, d.webhook_id::text, w.url,
           d.event_type, COALESCE(d.source_event_id::text, ''),
           d.payload::text, d.attempt_count`,
		limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PendingDelivery{}
	for rows.Next() {
		var p PendingDelivery
		var payload string
		if err := rows.Scan(
			&p.ID, &p.TenantID, &p.WebhookID, &p.URL,
			&p.EventType, &p.SourceEventID, &payload, &p.AttemptCount,
		); err != nil {
			return nil, err
		}
		p.Payload = []byte(payload)
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// MarkDelivered finalises a delivery as successful + bumps the
// webhook's last_succeeded_at + clears consecutive_failures. Worker
// context.
func (s *Store) MarkDelivered(ctx context.Context, p PendingDelivery, statusCode int, respBody string) error {
	conn, err := s.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', true)"); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
UPDATE outbound_webhook_deliveries SET
    attempt_count                 = attempt_count + 1,
    status                        = 'delivered',
    last_status_code              = $2,
    last_response_body_truncated  = NULLIF($3, ''),
    last_error                    = NULL,
    delivered_at                  = now(),
    next_attempt_at               = NULL,
    lease_owner                   = NULL,
    lease_expires_at              = NULL
 WHERE id::text = $1
   AND tenant_id = $5::uuid
   AND webhook_id = $6::uuid
   AND status = 'pending'
   AND (
       $4 = ''
       OR (lease_owner = $4 AND lease_expires_at > now())
   )`,
		p.ID, statusCode, truncate(respBody, MaxResponseBodyBytes),
		p.LeaseOwner, p.TenantID, p.WebhookID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrLeaseLost
	}
	parentTag, err := tx.Exec(ctx, `
UPDATE outbound_webhooks SET
    last_succeeded_at    = now(),
    consecutive_failures = CASE WHEN active THEN 0 ELSE consecutive_failures END,
    updated_at           = now()
 WHERE id::text = $1
   AND tenant_id = $2::uuid
   AND deleted_at IS NULL`,
		p.WebhookID, p.TenantID,
	)
	if err != nil {
		return err
	}
	if parentTag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// MarkFailure either schedules the next retry or finalises the row as
// 'exhausted'. Also bumps consecutive_failures on the parent webhook
// and auto-disables it once it crosses AutoDisableThreshold. autoDisabled
// returns true when this call flipped active=false. The same transaction
// enqueues the durable operator notification; callers use the boolean only
// for metrics/log context.
func (s *Store) MarkFailure(
	ctx context.Context,
	p PendingDelivery,
	statusCode int,
	respBody string,
	failure error,
	skipRetry bool,
) (status string, autoDisabled bool, err error) {
	conn, err := s.Pool.Acquire(ctx)
	if err != nil {
		return "", false, err
	}
	defer conn.Release()
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', true)"); err != nil {
		return "", false, err
	}
	nextAttempt := p.AttemptCount + 1
	var newStatus string
	var nextAt any // time.Time or nil
	if skipRetry || nextAttempt > MaxAttempts || nextAttempt-1 >= len(BackoffSchedule) {
		newStatus = "exhausted"
		nextAt = nil
	} else {
		newStatus = "pending"
		nextAt = time.Now().UTC().Add(BackoffSchedule[nextAttempt-1])
	}
	failureMsg := ""
	if failure != nil {
		failureMsg, _ = redactInspectablePlaygroundText(failure.Error(), nil)
		failureMsg = truncate(failureMsg, 1024)
	}
	statusCodePtr := any(nil)
	if statusCode > 0 {
		statusCodePtr = statusCode
	}
	tag, err := tx.Exec(ctx, `
UPDATE outbound_webhook_deliveries SET
    attempt_count                 = attempt_count + 1,
    status                        = $2,
    last_status_code              = $3,
    last_response_body_truncated  = NULLIF($4, ''),
    last_error                    = NULLIF($5, ''),
    next_attempt_at               = $6,
    lease_owner                   = NULL,
    lease_expires_at              = NULL
 WHERE id::text = $1
   AND tenant_id = $8::uuid
   AND webhook_id = $9::uuid
   AND status = 'pending'
   AND (
       $7 = ''
       OR (lease_owner = $7 AND lease_expires_at > now())
   )`,
		p.ID, newStatus, statusCodePtr, truncate(respBody, MaxResponseBodyBytes),
		failureMsg, nextAt, p.LeaseOwner, p.TenantID, p.WebhookID)
	if err != nil {
		return "", false, err
	}
	if tag.RowsAffected() != 1 {
		return "", false, ErrLeaseLost
	}
	// Bump the webhook's failure counters. We do this even on retry
	// so consecutive_failures reflects every failed attempt — that's
	// what the auto-disable threshold is checking.
	var newCount int
	var active bool
	if err := tx.QueryRow(ctx, `
UPDATE outbound_webhooks SET
    last_failed_at       = now(),
    consecutive_failures = consecutive_failures + 1,
    updated_at           = now()
 WHERE id::text = $1
   AND tenant_id = $2::uuid
   AND deleted_at IS NULL
RETURNING consecutive_failures, active`,
		p.WebhookID, p.TenantID,
	).Scan(&newCount, &active); err != nil {
		return "", false, err
	}
	if active && newCount >= AutoDisableThreshold {
		if _, err := tx.Exec(ctx, `
UPDATE outbound_webhooks
   SET active = false,
       disabled_reason = 'auto_failures',
       disabled_at = now(),
       updated_at = now(),
       config_version = config_version + 1
 WHERE id::text = $1
   AND tenant_id = $2::uuid
   AND deleted_at IS NULL
   AND active = true`,
			p.WebhookID, p.TenantID,
		); err != nil {
			return "", false, err
		}
		if err := pauseDisabledDeliveries(ctx, tx, p.TenantID, p.WebhookID); err != nil {
			return "", false, err
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO outbound_webhook_operator_notifications (
    tenant_id, webhook_id, kind, status, next_attempt_at
)
VALUES ($1::uuid, $2::uuid, 'auto_disabled', 'pending', now())`,
			p.TenantID, p.WebhookID,
		); err != nil {
			return "", false, err
		}
		autoDisabled = true
	}
	if err := tx.Commit(ctx); err != nil {
		return "", false, err
	}
	return newStatus, autoDisabled, nil
}

// strPtr / boolPtr / eventsArg coerce optional Update fields into pgx
// args. nil means "leave unchanged" (the SQL above wraps each in
// COALESCE).
func strPtr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func boolPtr(p *bool) any {
	if p == nil {
		return nil
	}
	return *p
}

func eventsArg(ev []string) any {
	if ev == nil {
		return nil
	}
	return ev
}

func jsonbArg(raw []byte) any {
	if len(raw) == 0 {
		return nil
	}
	return string(raw)
}

// truncate makes untrusted diagnostic text safe for PostgreSQL/JSON and caps
// it in bytes without splitting a UTF-8 code point. Receiver response bodies
// are arbitrary bytes, so they may otherwise contain malformed UTF-8 or NUL,
// both of which can make an outcome-recording transaction fail.
func truncate(s string, maxBytes int) string {
	s = strings.ReplaceAll(s, "\x00", "")
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "\uFFFD")
	}
	if maxBytes <= 0 || len(s) <= maxBytes {
		return s
	}
	end := maxBytes
	for end > 0 && !utf8.RuneStart(s[end]) {
		end--
	}
	return s[:end]
}
