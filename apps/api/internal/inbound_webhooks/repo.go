// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
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

// Package-level persistence sentinels.
var (
	ErrNotFound           = errors.New("inbound_webhooks: not found")
	ErrReplayConflict     = errors.New("inbound_webhooks: event id was reused with different payload")
	ErrPayloadNotRetained = errors.New("inbound_webhooks: event payload was not retained")
	ErrUnverifiedEvent    = errors.New("inbound_webhooks: event signature was not verified")
	ErrInvalidTrigger     = errors.New("inbound_webhooks: invalid trigger configuration")
)

const destroyedInboundSecretSentinel = "tombstone:destroyed"

// Endpoint is the public projection (secret omitted from list).
type Endpoint struct {
	ID          string    `json:"id"`
	TenantID    string    `json:"tenantId"`
	Slug        string    `json:"slug"`
	Name        string    `json:"name"`
	Enabled     bool      `json:"enabled"`
	TransformJQ string    `json:"transform_jq,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
}

// CreateResponse returns the freshly-minted plaintext signing secret once.
type CreateResponse struct {
	Endpoint Endpoint `json:"endpoint"`
	Secret   string   `json:"secret"`
}

// Repo wraps pgx with endpoint + event CRUD.
// EnvelopeCipher is the envelope-encryption boundary the inbound-
// webhooks package needs to wrap/unwrap signing secrets at rest.
// Mirrors outbound_webhooks.EnvelopeEncryptor so callers can pass
// the same crypto instance. See C1 in PRODUCTION_READINESS.md.
type EnvelopeCipher interface {
	Encrypt(ctx context.Context, plaintext []byte) ([]byte, error)
	Decrypt(ctx context.Context, blob, legacyKEK []byte) ([]byte, error)
}

type Repo struct {
	Pool *db.Pool
	// Cipher (when set) envelope-encrypts new secrets at write time
	// and decrypts secret_envelope at read time. nil = legacy
	// plaintext mode (back-compat for tests + dev clusters that
	// haven't configured a KEK).
	Cipher    EnvelopeCipher
	LegacyKEK []byte
}

func newSlug() (string, error) {
	var b [9]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("inbound_webhooks: generate slug: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

func newSecret() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("inbound_webhooks: generate secret: %w", err)
	}
	return "iwh_" + hex.EncodeToString(b[:]), nil
}

// SignatureValid reports whether the supplied hex signature matches an
// HMAC-SHA256 of body keyed by secret. Constant-time compare.
func SignatureValid(secret string, body []byte, sigHex string) bool {
	if strings.TrimSpace(secret) == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	want := mac.Sum(nil)
	got, err := hex.DecodeString(sigHex)
	if err != nil {
		return false
	}
	return hmac.Equal(want, got)
}

// Create inserts a new endpoint and returns the plaintext secret
// exactly ONCE. When Cipher is configured (production), the secret
// is envelope-encrypted into secret_envelope; the legacy plaintext
// `secret` column gets a sentinel "envelope" value so the NOT NULL
// constraint is satisfied without leaking the real secret. When
// Cipher is nil (dev/legacy), falls back to plaintext-only.
func (r *Repo) Create(ctx context.Context, tenantID, name string) (*CreateResponse, error) {
	return r.CreateWithOptions(ctx, tenantID, name, "")
}

func (r *Repo) CreateWithOptions(ctx context.Context, tenantID, name, transformJQ string) (*CreateResponse, error) {
	if err := ValidateTransformJQ(transformJQ); err != nil {
		return nil, err
	}
	slug, err := newSlug()
	if err != nil {
		return nil, err
	}
	secret, err := newSecret()
	if err != nil {
		return nil, err
	}
	legacyValue, envelope, err := r.encodeSecretForStorage(ctx, secret)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var ep Endpoint
	row := tx.QueryRow(ctx, `
INSERT INTO inbound_webhook_endpoints (tenant_id, slug, secret, secret_envelope, name, enabled, transform_jq)
VALUES ($1::uuid, $2, $3, $4, $5, true, NULLIF($6, ''))
RETURNING id::text, tenant_id::text, slug, name, enabled, COALESCE(transform_jq, ''), created_at`,
		tenantID, slug, legacyValue, envelope, name, strings.TrimSpace(transformJQ))
	if err := row.Scan(&ep.ID, &ep.TenantID, &ep.Slug, &ep.Name, &ep.Enabled, &ep.TransformJQ, &ep.CreatedAt); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &CreateResponse{Endpoint: ep, Secret: secret}, nil
}

// encodeSecretForStorage is the single write-side policy for inbound signing
// material. Deployments with an envelope cipher never place the plaintext in
// the legacy NOT NULL column; older local/dev deployments retain the legacy
// fallback until the column can be removed in a later schema migration.
func (r *Repo) encodeSecretForStorage(ctx context.Context, secret string) (legacyValue string, envelope []byte, err error) {
	if r.Cipher == nil {
		return secret, nil, nil
	}
	envelope, err = r.Cipher.Encrypt(ctx, []byte(secret))
	if err != nil {
		return "", nil, fmt.Errorf("inbound_webhooks: encrypt secret: %w", err)
	}
	return "envelope:do-not-use", envelope, nil
}

// LookupSecret returns the plaintext signing secret for an endpoint.
// Prefers secret_envelope (decrypts via Cipher); falls back to the
// legacy plaintext `secret` column for rows created before C1's
// migration. Used by the receive-path signature verification.
func (r *Repo) LookupSecret(ctx context.Context, slug string) (string, string, error) {
	if slug == "" {
		return "", "", ErrNotFound
	}
	// This is a public receive path — no tenant context yet.
	// inbound_webhook_endpoints has a permissive lookup-by-slug
	// policy (added with the table). Use a bare pool query.
	var tenantID, plain string
	var envelope []byte
	err := r.Pool.QueryRow(ctx, `
SELECT tenant_id::text, secret, secret_envelope
  FROM inbound_webhook_endpoints
 WHERE slug = $1 AND enabled = true AND deleted_at IS NULL`, slug).Scan(&tenantID, &plain, &envelope)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", ErrNotFound
		}
		return "", "", err
	}
	if len(envelope) > 0 && r.Cipher != nil {
		secretBytes, derr := r.Cipher.Decrypt(ctx, envelope, r.LegacyKEK)
		if derr != nil {
			return "", "", fmt.Errorf("inbound_webhooks: decrypt: %w", derr)
		}
		return tenantID, string(secretBytes), nil
	}
	if plain != "" && plain != "envelope:do-not-use" {
		return tenantID, plain, nil
	}
	return "", "", ErrNotFound
}

// List returns the tenant's endpoints (no secrets). When q is non-empty
// it filters by name OR slug substring (case-insensitive ILIKE).
func (r *Repo) List(ctx context.Context, tenantID, q string) ([]Endpoint, error) {
	items, _, err := r.ListPage(ctx, tenantID, q, pagination.MaxLimit, pagination.Cursor{})
	return items, err
}

// ListPage returns one stable newest-first page. The cursor pins to
// (created_at,id), so newly-created endpoints cannot make later pages overlap
// or skip rows while an operator is paging through a large workspace.
func (r *Repo) ListPage(ctx context.Context, tenantID, q string, limit int, cursor pagination.Cursor) ([]Endpoint, string, error) {
	if limit < 1 || limit > pagination.MaxLimit {
		limit = pagination.DefaultLimit
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	args := []any{tenantID, q}
	cursorPredicate := ""
	if cursor.ID != "" {
		cursorPredicate = " AND (created_at, id::text) < ($3::timestamptz, $4)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	args = append(args, limit+1)
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, slug, name, enabled, COALESCE(transform_jq, ''), created_at
FROM inbound_webhook_endpoints
WHERE tenant_id = $1::uuid
  AND deleted_at IS NULL
  AND ($2 = '' OR (name ILIKE '%' || $2 || '%' OR slug ILIKE '%' || $2 || '%'))
`+cursorPredicate+`
ORDER BY created_at DESC, id::text DESC
LIMIT $`+fmt.Sprint(len(args)), args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []Endpoint{}
	for rows.Next() {
		var ep Endpoint
		if err := rows.Scan(&ep.ID, &ep.TenantID, &ep.Slug, &ep.Name, &ep.Enabled, &ep.TransformJQ, &ep.CreatedAt); err != nil {
			return nil, "", err
		}
		out = append(out, ep)
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

// Get returns one endpoint for a tenant. Secret is intentionally omitted.
func (r *Repo) Get(ctx context.Context, tenantID, id string) (Endpoint, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return Endpoint{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var ep Endpoint
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, slug, name, enabled, COALESCE(transform_jq, ''), created_at
FROM inbound_webhook_endpoints
WHERE tenant_id = $1::uuid AND id::text = $2 AND deleted_at IS NULL`, tenantID, id)
	if err := row.Scan(&ep.ID, &ep.TenantID, &ep.Slug, &ep.Name, &ep.Enabled, &ep.TransformJQ, &ep.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Endpoint{}, ErrNotFound
		}
		return Endpoint{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Endpoint{}, err
	}
	return ep, nil
}

type EndpointPatch struct {
	Name        *string
	Enabled     *bool
	TransformJQ *string
}

func (r *Repo) UpdateEndpoint(ctx context.Context, tenantID, id string, p EndpointPatch) (Endpoint, error) {
	if p.TransformJQ != nil {
		if err := ValidateTransformJQ(*p.TransformJQ); err != nil {
			return Endpoint{}, err
		}
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return Endpoint{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var ep Endpoint
	row := tx.QueryRow(ctx, `
UPDATE inbound_webhook_endpoints SET
    name = COALESCE($3, name),
    enabled = COALESCE($4, enabled),
    transform_jq = CASE WHEN $5 THEN NULLIF($6, '') ELSE transform_jq END,
    updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2 AND deleted_at IS NULL
RETURNING id::text, tenant_id::text, slug, name, enabled, COALESCE(transform_jq, ''), created_at`,
		tenantID, id, strPtr(p.Name), boolPtr(p.Enabled), p.TransformJQ != nil, strPtr(p.TransformJQ))
	if err := row.Scan(&ep.ID, &ep.TenantID, &ep.Slug, &ep.Name, &ep.Enabled, &ep.TransformJQ, &ep.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Endpoint{}, ErrNotFound
		}
		return Endpoint{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Endpoint{}, err
	}
	return ep, nil
}

func (r *Repo) GetTransformJQ(ctx context.Context, tenantID, id string) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var expr string
	err = tx.QueryRow(ctx, `
SELECT COALESCE(transform_jq, '')
  FROM inbound_webhook_endpoints
 WHERE tenant_id = $1::uuid AND id::text = $2 AND deleted_at IS NULL`, tenantID, id).Scan(&expr)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return expr, nil
}

// RotateSecret rotates the endpoint signing secret with a 24h
// grace window during which both the new (primary) and the prior
// (secondary) secret verify. After the grace window the janitor
// (or the next rotation) clears the secondary columns.
//
// Audit fixes (webhook-rotation):
//
//	C2 (no grace window): now demotes the current secret to
//	    `secondary_secret` with `secondary_expires_at = now() + 24h`
//	    so in-flight upstream retries signed under it still verify.
//	C3 (envelope no-op): explicitly copies `secret_envelope` to
//	    `secondary_secret_envelope` and clears the new envelope
//	    (the new plaintext secret takes its place in `secret`
//	    until the next envelope wrap). Without this the rotation
//	    was silently a no-op for envelope-encrypted endpoints.
const rotationGraceWindow = 24 * time.Hour

func (r *Repo) RotateSecret(ctx context.Context, tenantID, id string) (*CreateResponse, error) {
	secret, err := newSecret()
	if err != nil {
		return nil, err
	}
	legacyValue, envelope, err := r.encodeSecretForStorage(ctx, secret)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var ep Endpoint
	row := tx.QueryRow(ctx, `
UPDATE inbound_webhook_endpoints
   SET secondary_secret          = secret,
       secondary_secret_envelope = secret_envelope,
       secondary_expires_at      = now() + $4::interval,
       secret                    = $3,
       secret_envelope           = $5
 WHERE tenant_id = $1::uuid AND id::text = $2 AND deleted_at IS NULL
RETURNING id::text, tenant_id::text, slug, name, enabled, COALESCE(transform_jq, ''), created_at`,
		tenantID, id, legacyValue, fmt.Sprintf("%d seconds", int(rotationGraceWindow.Seconds())), envelope)
	if err := row.Scan(&ep.ID, &ep.TenantID, &ep.Slug, &ep.Name, &ep.Enabled, &ep.TransformJQ, &ep.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &CreateResponse{Endpoint: ep, Secret: secret}, nil
}

// Delete tombstones an endpoint and revokes ingest immediately. Retained
// events and durable action evidence remain until the tenant's configured
// retention pass can safely purge the endpoint.
func (r *Repo) Delete(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE inbound_webhook_endpoints
   SET enabled = false,
       deleted_at = now(),
       secret = $3,
       secret_envelope = NULL,
       secondary_secret = NULL,
       secondary_secret_envelope = NULL,
       secondary_expires_at = NULL,
       secret_storage_state = 'destroyed',
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND deleted_at IS NULL`, tenantID, id, destroyedInboundSecretSentinel)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// LookupBySlug uses the SECURITY DEFINER helper to resolve an endpoint
// without a tenant context (the public ingest path doesn't have one
// yet). The helper bypasses FORCE RLS by virtue of being SECURITY
// DEFINER; we can't replace it with a direct SELECT here.
//
// As of C1 (PRODUCTION_READINESS.md), the returned `secret` is the
// plaintext signing secret regardless of whether the row is stored in
// the legacy plaintext column or the new envelope-encrypted column.
// When the legacy column is the sentinel ("envelope:do-not-use") AND
// a Cipher is wired, we open a tenant-scoped tx and read +
// decrypt secret_envelope. Otherwise legacy plaintext.
func (r *Repo) LookupBySlug(ctx context.Context, slug string) (id, tenantID, secret string, enabled bool, err error) {
	row := r.Pool.QueryRow(ctx,
		`SELECT id::text, tenant_id::text, secret, enabled
         FROM inbound_webhook_lookup($1)`, slug)
	var plain string
	if err := row.Scan(&id, &tenantID, &plain, &enabled); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", "", false, ErrNotFound
		}
		return "", "", "", false, err
	}
	if plain != "envelope:do-not-use" {
		// Legacy plaintext row OR pre-C1 endpoint.
		return id, tenantID, plain, enabled, nil
	}
	// Envelope path: re-read secret_envelope under a tenant tx so
	// the RLS policy admits it (FORCE RLS blocks bare-pool reads of
	// this column; the SECURITY DEFINER helper above returns only
	// the columns it lists, hence the second query).
	if r.Cipher == nil {
		return "", "", "", false, fmt.Errorf("inbound_webhooks: envelope row but no cipher configured")
	}
	tx, terr := db.WithTenant(ctx, r.Pool, tenantID)
	if terr != nil {
		return "", "", "", false, terr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var envelope []byte
	if err := tx.QueryRow(ctx,
		`SELECT secret_envelope FROM inbound_webhook_endpoints WHERE id::text = $1 AND deleted_at IS NULL`,
		id).Scan(&envelope); err != nil {
		return "", "", "", false, fmt.Errorf("inbound_webhooks: load envelope: %w", err)
	}
	secretBytes, derr := r.Cipher.Decrypt(ctx, envelope, r.LegacyKEK)
	if derr != nil {
		return "", "", "", false, fmt.Errorf("inbound_webhooks: decrypt: %w", derr)
	}
	return id, tenantID, string(secretBytes), enabled, nil
}

// LookupSecondarySecret returns the secondary (rotation-grace)
// signing secret for an endpoint, or "" if no grace window is
// active. Resolves the envelope-encrypted variant when present
// (same logic as LookupBySlug). Audit fix (webhook-rotation C2):
// dual-verify path during the 24h grace window.
func (r *Repo) LookupSecondarySecret(ctx context.Context, tenantID, id string) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var plain *string
	var envelope []byte
	var expiresAt *time.Time
	if err := tx.QueryRow(ctx,
		`SELECT secondary_secret, secondary_secret_envelope, secondary_expires_at
		   FROM inbound_webhook_endpoints WHERE id::text = $1 AND deleted_at IS NULL`,
		id).Scan(&plain, &envelope, &expiresAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	if expiresAt == nil || time.Now().After(*expiresAt) {
		return "", nil // no grace window or expired
	}
	if plain != nil && *plain != "" && *plain != "envelope:do-not-use" {
		return *plain, nil
	}
	if len(envelope) > 0 && r.Cipher != nil {
		decrypted, derr := r.Cipher.Decrypt(ctx, envelope, r.LegacyKEK)
		if derr != nil {
			return "", derr
		}
		return string(decrypted), nil
	}
	return "", nil
}

// InboundEvent is the read projection returned by ListEvents. The body
// column is `bytea` on disk; we expose it as a UTF-8 string for the
// detail slideover, falling back to the empty string when the bytes
// aren't valid UTF-8 (the slideover renders headers + signature_valid
// even when the body is opaque).
type InboundEvent struct {
	ID             int64             `json:"id"`
	EndpointID     string            `json:"endpoint_id"`
	Headers        map[string]string `json:"headers"`
	Body           string            `json:"body"`
	SignatureValid bool              `json:"signature_valid"`
	ReceivedAt     time.Time         `json:"received_at"`
}

func projectInboundEventBody(body []byte) string {
	if !utf8.Valid(body) {
		return ""
	}
	return string(body)
}

// ListEvents returns the most-recent N inbound events for a webhook
// endpoint, newest first. The limit is clamped to [1, 500] by the caller;
// the repo defends against zero/negative values by treating them as the
// default of 50 events. Tenant scoping is enforced by RLS.
func (r *Repo) ListEvents(ctx context.Context, tenantID, endpointID string, limit int) ([]InboundEvent, error) {
	items, _, err := r.ListEventsPage(ctx, tenantID, endpointID, limit, pagination.Cursor{})
	return items, err
}

func (r *Repo) ListEventsPage(ctx context.Context, tenantID, endpointID string, limit int, cursor pagination.Cursor) ([]InboundEvent, string, error) {
	if !validTriggerResourceID(endpointID) {
		return nil, "", ErrNotFound
	}
	if limit <= 0 || limit > pagination.MaxLimit {
		limit = pagination.DefaultLimit
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockNondeletedInboundEndpoint(ctx, tx, tenantID, endpointID); err != nil {
		return nil, "", err
	}
	args := []any{endpointID}
	cursorPredicate := ""
	if cursor.ID != "" {
		cursorID, parseErr := strconv.ParseInt(cursor.ID, 10, 64)
		if parseErr != nil {
			return nil, "", pagination.ErrInvalidCursor
		}
		cursorPredicate = " AND (received_at, id) < ($2::timestamptz, $3::bigint)"
		args = append(args, cursor.SortKey.UTC(), cursorID)
	}
	args = append(args, limit+1)
	rows, err := tx.Query(ctx, `
SELECT id, endpoint_id::text, headers, body_bytes, signature_valid, received_at
FROM inbound_events
WHERE endpoint_id::text = $1
`+cursorPredicate+`
ORDER BY received_at DESC, id DESC
LIMIT $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []InboundEvent{}
	for rows.Next() {
		var (
			ev      InboundEvent
			headers []byte
			body    []byte
		)
		if err := rows.Scan(&ev.ID, &ev.EndpointID, &headers, &body, &ev.SignatureValid, &ev.ReceivedAt); err != nil {
			return nil, "", err
		}
		ev.Headers = map[string]string{}
		if len(headers) > 0 {
			// Best-effort: a malformed jsonb cell shouldn't poison the
			// list response. We keep the row with empty headers and let
			// the UI render the rest.
			_ = json.Unmarshal(headers, &ev.Headers)
		}
		ev.Body = projectInboundEventBody(body)
		out = append(out, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	trimmed, hasMore := pagination.HasMore(out, limit)
	nextCursor := ""
	if hasMore && len(trimmed) > 0 {
		last := trimmed[len(trimmed)-1]
		nextCursor = pagination.Encode(pagination.Cursor{
			SortKey: last.ReceivedAt,
			ID:      strconv.FormatInt(last.ID, 10),
		})
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	return trimmed, nextCursor, nil
}

// ---------------------------------------------------------------------
// Trigger CRUD (inbound_webhook_triggers, migration 0090)
// ---------------------------------------------------------------------

func validTriggerResourceID(value string) bool {
	_, err := uuid.Parse(strings.TrimSpace(value))
	return err == nil
}

// lockNondeletedInboundEndpoint establishes a stable admin/read boundary for
// nested endpoint resources. Disabled endpoints remain administrable; a
// tombstone that commits first is nondisclosing ErrNotFound, while a delete
// racing behind this lock waits for the bounded transaction to finish.
func lockNondeletedInboundEndpoint(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, endpointID string,
) error {
	if !validTriggerResourceID(endpointID) {
		return ErrNotFound
	}
	var lockedID string
	if err := tx.QueryRow(ctx, `
SELECT id::text
  FROM inbound_webhook_endpoints
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND deleted_at IS NULL
 FOR SHARE`, tenantID, endpointID).Scan(&lockedID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	return nil
}

// lockEnabledInboundEndpoint establishes the lifecycle boundary for trigger
// planning. FOR SHARE prevents an endpoint disable/tombstone UPDATE from
// committing until the transaction has frozen its action intents. A shutdown
// that commits first makes this lookup return ErrNotFound.
//
// Consequently, work that acquired this lock before an operator shutdown may
// finish committing; no transaction that starts planning after the shutdown
// commits can enqueue new work.
func lockEnabledInboundEndpoint(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, endpointID string,
) error {
	if !validTriggerResourceID(endpointID) {
		return ErrNotFound
	}
	var lockedID string
	if err := tx.QueryRow(ctx, `
SELECT id::text
  FROM inbound_webhook_endpoints
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND enabled = true
   AND deleted_at IS NULL
 FOR SHARE`, tenantID, endpointID).Scan(&lockedID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	return nil
}

// ListTriggers returns every trigger row for a webhook endpoint
// (active and inactive), newest first.
func (r *Repo) ListTriggers(ctx context.Context, tenantID, webhookID string) ([]Trigger, error) {
	if !validTriggerResourceID(webhookID) {
		return nil, ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockNondeletedInboundEndpoint(ctx, tx, tenantID, webhookID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, webhook_id::text, name, active,
       match_jsonpath, match_operator, match_value,
       email_jsonpath, action_type, action_target_id,
       fired_count, last_fired_at, created_at, updated_at
FROM inbound_webhook_triggers
WHERE tenant_id = $1::uuid
  AND webhook_id = $2::uuid
ORDER BY created_at DESC`, tenantID, webhookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Trigger{}
	for rows.Next() {
		var tr Trigger
		var matchValue *string
		if err := rows.Scan(&tr.ID, &tr.TenantID, &tr.WebhookID, &tr.Name, &tr.Active,
			&tr.MatchJSONPath, &tr.MatchOperator, &matchValue,
			&tr.EmailJSONPath, &tr.ActionType, &tr.ActionTargetID,
			&tr.FiredCount, &tr.LastFiredAt, &tr.CreatedAt, &tr.UpdatedAt); err != nil {
			return nil, err
		}
		tr.MatchValue = matchValue
		out = append(out, tr)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ListActive returns active triggers only while their tenant-owned parent is
// enabled and not tombstoned. The canonical receive/replay path uses the
// transaction-local variant in action_outbox_repo.go so this lifecycle lock is
// held until durable action intents commit.
func (r *Repo) ListActive(ctx context.Context, tenantID, webhookID string) ([]Trigger, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockEnabledInboundEndpoint(ctx, tx, tenantID, webhookID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, webhook_id::text, name, active,
       match_jsonpath, match_operator, match_value,
       email_jsonpath, action_type, action_target_id,
       fired_count, last_fired_at, created_at, updated_at
FROM inbound_webhook_triggers
WHERE tenant_id = $1::uuid
  AND webhook_id = $2::uuid
  AND active = true
FOR SHARE`, tenantID, webhookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Trigger{}
	for rows.Next() {
		var tr Trigger
		var matchValue *string
		if err := rows.Scan(&tr.ID, &tr.TenantID, &tr.WebhookID, &tr.Name, &tr.Active,
			&tr.MatchJSONPath, &tr.MatchOperator, &matchValue,
			&tr.EmailJSONPath, &tr.ActionType, &tr.ActionTargetID,
			&tr.FiredCount, &tr.LastFiredAt, &tr.CreatedAt, &tr.UpdatedAt); err != nil {
			return nil, err
		}
		tr.MatchValue = matchValue
		out = append(out, tr)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// CreateTrigger inserts a new trigger beneath a tenant-owned endpoint. The
// parent id is a separate argument so callers cannot smuggle a different
// webhook identity through the request body.
func (r *Repo) CreateTrigger(ctx context.Context, tenantID, webhookID string, in Trigger) (*Trigger, error) {
	if !validTriggerResourceID(webhookID) {
		return nil, ErrNotFound
	}
	in, err := normalizeAndValidateTrigger(in)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockNondeletedInboundEndpoint(ctx, tx, tenantID, webhookID); err != nil {
		return nil, err
	}
	var tr Trigger
	var matchValue *string
	row := tx.QueryRow(ctx, `
INSERT INTO inbound_webhook_triggers
    (tenant_id, webhook_id, name, active, match_jsonpath, match_operator, match_value,
     email_jsonpath, action_type, action_target_id)
SELECT $1::uuid, endpoint.id, $3, $4, $5, $6, $7, $8, $9, $10
  FROM inbound_webhook_endpoints AS endpoint
 WHERE endpoint.tenant_id = $1::uuid
   AND endpoint.id = $2::uuid
   AND endpoint.deleted_at IS NULL
RETURNING id::text, tenant_id::text, webhook_id::text, name, active,
          match_jsonpath, match_operator, match_value,
          email_jsonpath, action_type, action_target_id,
          fired_count, last_fired_at, created_at, updated_at`,
		tenantID, webhookID, in.Name, in.Active,
		in.MatchJSONPath, in.MatchOperator, in.MatchValue,
		in.EmailJSONPath, in.ActionType, in.ActionTargetID)
	if err := row.Scan(&tr.ID, &tr.TenantID, &tr.WebhookID, &tr.Name, &tr.Active,
		&tr.MatchJSONPath, &tr.MatchOperator, &matchValue,
		&tr.EmailJSONPath, &tr.ActionType, &tr.ActionTargetID,
		&tr.FiredCount, &tr.LastFiredAt, &tr.CreatedAt, &tr.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	tr.MatchValue = matchValue
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &tr, nil
}

// UpdateTrigger locks and loads the tenant/parent-scoped row, merges the
// supplied fields, validates the complete resulting rule, then persists it.
// Returns ErrNotFound when the nested identity does not exist.
type TriggerPatch struct {
	Name           *string
	Active         *bool
	MatchJSONPath  *string
	MatchOperator  *string
	MatchValue     *string
	EmailJSONPath  *string
	ActionType     *string
	ActionTargetID *string
}

func (r *Repo) UpdateTrigger(ctx context.Context, tenantID, webhookID, id string, p TriggerPatch) (*Trigger, error) {
	if !validTriggerResourceID(webhookID) || !validTriggerResourceID(id) {
		return nil, ErrNotFound
	}
	p, err := normalizeAndValidateTriggerPatch(p)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockNondeletedInboundEndpoint(ctx, tx, tenantID, webhookID); err != nil {
		return nil, err
	}
	current, err := scanTriggerRow(tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, webhook_id::text, name, active,
       match_jsonpath, match_operator, match_value,
       email_jsonpath, action_type, action_target_id,
       fired_count, last_fired_at, created_at, updated_at
  FROM inbound_webhook_triggers
 WHERE tenant_id = $1::uuid
   AND webhook_id = $2::uuid
   AND id = $3::uuid
 FOR UPDATE`, tenantID, webhookID, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	merged, err := normalizeAndValidateTrigger(applyTriggerPatch(current, p))
	if err != nil {
		return nil, err
	}

	tr, err := scanTriggerRow(tx.QueryRow(ctx, `
UPDATE inbound_webhook_triggers SET
    name = $4,
    active = $5,
    match_jsonpath = $6,
    match_operator = $7,
    match_value = $8,
    email_jsonpath = $9,
    action_type = $10,
    action_target_id = $11,
    updated_at = now()
WHERE tenant_id = $1::uuid
  AND webhook_id = $2::uuid
  AND id = $3::uuid
RETURNING id::text, tenant_id::text, webhook_id::text, name, active,
          match_jsonpath, match_operator, match_value,
          email_jsonpath, action_type, action_target_id,
          fired_count, last_fired_at, created_at, updated_at`,
		tenantID, webhookID, id, merged.Name, merged.Active,
		merged.MatchJSONPath, merged.MatchOperator, merged.MatchValue,
		merged.EmailJSONPath, merged.ActionType, merged.ActionTargetID))
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &tr, nil
}

type triggerRowScanner interface {
	Scan(dest ...any) error
}

func scanTriggerRow(row triggerRowScanner) (Trigger, error) {
	var tr Trigger
	var matchValue *string
	if err := row.Scan(
		&tr.ID,
		&tr.TenantID,
		&tr.WebhookID,
		&tr.Name,
		&tr.Active,
		&tr.MatchJSONPath,
		&tr.MatchOperator,
		&matchValue,
		&tr.EmailJSONPath,
		&tr.ActionType,
		&tr.ActionTargetID,
		&tr.FiredCount,
		&tr.LastFiredAt,
		&tr.CreatedAt,
		&tr.UpdatedAt,
	); err != nil {
		return Trigger{}, err
	}
	tr.MatchValue = matchValue
	return tr, nil
}

// DeleteTrigger removes a trigger only when both nested route identities match.
func (r *Repo) DeleteTrigger(ctx context.Context, tenantID, webhookID, id string) error {
	if !validTriggerResourceID(webhookID) || !validTriggerResourceID(id) {
		return ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockNondeletedInboundEndpoint(ctx, tx, tenantID, webhookID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx,
		`DELETE FROM inbound_webhook_triggers
		  WHERE tenant_id = $1::uuid
		    AND webhook_id = $2::uuid
		    AND id = $3::uuid`,
		tenantID, webhookID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// RecordFire bumps the fired_count + last_fired_at on a trigger.
// Implementation of TriggerStore.RecordFire.
func (r *Repo) RecordFire(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx,
		`UPDATE inbound_webhook_triggers SET fired_count = fired_count + 1, last_fired_at = now()
         WHERE tenant_id=$1::uuid AND id::text = $2`, tenantID, id)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

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

// RecordEvent inserts one inbound_events row. sourceEventID is the SHA-256
// replay key derived from the sender's mandatory stable event identity. The
// partial unique index from migration 0157 deduplicates provider redeliveries.
// A duplicate is accepted only when its processed payload is byte-identical;
// identity reuse with different bytes returns ErrReplayConflict. Returns
// (existingID, true) for an exact retry and (newID, false) on first sight.
func (r *Repo) RecordEvent(ctx context.Context, tenantID, endpointID string, headersJSON []byte, body []byte, sigValid bool, sourceEventID string) (int64, bool, error) {
	sourceEventID = strings.TrimSpace(sourceEventID)
	if !strings.HasPrefix(sourceEventID, inboundReplayKeyPrefix) || len(sourceEventID) != len(inboundReplayKeyPrefix)+(sha256.Size*2) {
		return 0, false, fmt.Errorf("inbound_webhooks: invalid replay key")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rawDigest := sha256.Sum256(body)
	var id int64
	src := sourceEventID
	row := tx.QueryRow(ctx, `
INSERT INTO inbound_events (
    tenant_id, endpoint_id, headers, body_bytes, signature_valid,
    source_event_id, authenticated_raw_body_sha256
)
VALUES ($1::uuid, $2::uuid, $3::jsonb, $4, $5, $6, $7)
ON CONFLICT (endpoint_id, source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING
RETURNING id`, tenantID, endpointID, string(headersJSON), body, sigValid, src, rawDigest[:])
	switch scanErr := row.Scan(&id); {
	case scanErr == nil:
		// New row.
	case errors.Is(scanErr, pgx.ErrNoRows):
		// Conflict — fetch the existing row's id so the caller can
		// log a "duplicate received" without re-firing triggers.
		var existingBody, existingRawDigest []byte
		if err := tx.QueryRow(ctx, `
SELECT id, body_bytes, authenticated_raw_body_sha256 FROM inbound_events
 WHERE endpoint_id = $1::uuid AND source_event_id = $2
 ORDER BY id DESC LIMIT 1`, endpointID, src).Scan(&id, &existingBody, &existingRawDigest); err != nil {
			return 0, false, err
		}
		if len(existingRawDigest) == sha256.Size {
			if !hmac.Equal(existingRawDigest, rawDigest[:]) {
				return 0, false, ErrReplayConflict
			}
		} else if !hmac.Equal(existingBody, body) {
			return 0, false, ErrReplayConflict
		}
		if cerr := tx.Commit(ctx); cerr != nil {
			return 0, false, cerr
		}
		return id, true, nil
	default:
		return 0, false, scanErr
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, false, err
	}
	return id, false, nil
}
