// SPDX-License-Identifier: AGPL-3.0-only
package webhooks

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrNotFound is returned when a webhook lookup misses.
var ErrNotFound = errors.New("webhooks: not found")

// Repo wraps the pgx pool with webhook + delivery CRUD.
type Repo struct {
	Pool *db.Pool
}

// NewSecret returns a fresh signing secret (whsec_ + 32 byte hex).
func NewSecret() (string, error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("webhooks: rand: %w", err)
	}
	return "whsec_" + hex.EncodeToString(buf[:]), nil
}

// HashSecret returns the hex SHA-256 of the supplied secret. Storage format
// matches what `apikeys.hash` produces — both surfaces are append-only.
func HashSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// SignBody produces the HMAC-SHA256 hex signature of body using secret.
// Used by the dispatcher and the test-event handler.
func SignBody(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// List returns the tenant's webhooks newest-first, with the most recent
// delivery joined in.
func (r *Repo) List(ctx context.Context, tenantID string) ([]Webhook, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT w.id::text, w.tenant_id::text, w.url, w.events, w.status,
       COALESCE(w.environment, 'production'),
       w.created_at, w.updated_at,
       d.id, d.event, d.status_code, d.attempt, d.response_ms,
       COALESCE(d.error, ''), d.at
FROM webhooks w
LEFT JOIN LATERAL (
  SELECT id, event, status_code, attempt, response_ms, error, at
  FROM webhook_deliveries
  WHERE webhook_id = w.id
  ORDER BY at DESC LIMIT 1
) d ON true
WHERE w.tenant_id = $1::uuid
ORDER BY w.created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Webhook{}
	for rows.Next() {
		var (
			w           Webhook
			eventsRaw   []string
			dID         *int64
			dEvent      *string
			dStatusCode *int
			dAttempt    *int
			dResponseMS *int
			dError      *string
			dAt         *time.Time
		)
		if err := rows.Scan(&w.ID, &w.TenantID, &w.URL, &eventsRaw, &w.Status,
			&w.Environment,
			&w.CreatedAt, &w.UpdatedAt,
			&dID, &dEvent, &dStatusCode, &dAttempt, &dResponseMS, &dError, &dAt); err != nil {
			return nil, err
		}
		w.Events = make([]EventType, len(eventsRaw))
		for i, e := range eventsRaw {
			w.Events[i] = EventType(e)
		}
		if dID != nil && dAt != nil {
			w.LastDelivery = &Delivery{
				ID: *dID, WebhookID: w.ID, Event: *dEvent,
				StatusCode: *dStatusCode, Attempt: *dAttempt,
				ResponseMS: *dResponseMS, Error: derefStr(dError), At: *dAt,
			}
		}
		out = append(out, w)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// Get fetches a single webhook (without joining last-delivery — callers who
// need that should use ListDeliveries).
func (r *Repo) Get(ctx context.Context, tenantID, id string) (*Webhook, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	w, err := scanOne(ctx, tx, "id::text = $1", id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return w, nil
}

// Create inserts a new webhook with the supplied (already-hashed) secret
// and an optional envelope-encrypted copy of the plaintext. The envelope
// is what the dispatcher uses to sign deliveries; the hash is what
// breach-resistance relies on. Pass envelope=nil to retain V1 unsigned
// behaviour (test deployments without a KEK configured).
// RotateSecret replaces a webhook's signing secret (SETA-035). Returns
// ErrNotFound when no row matches for the tenant. The caller reveals the
// new plaintext once via CreateResponse, exactly like Create.
func (r *Repo) RotateSecret(ctx context.Context, tenantID, id, secretHash string, envelope []byte) (*Webhook, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var w Webhook
	var eventsRaw []string
	row := tx.QueryRow(ctx, `
UPDATE webhooks SET secret_hash = $1, secret_envelope = $2, updated_at = now()
WHERE id::text = $3 AND tenant_id = $4::uuid
RETURNING id::text, tenant_id::text, url, events, status, created_at, updated_at`,
		secretHash, envelope, id, tenantID)
	if err := row.Scan(&w.ID, &w.TenantID, &w.URL, &eventsRaw, &w.Status,
		&w.CreatedAt, &w.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	w.Events = make([]EventType, len(eventsRaw))
	for i, e := range eventsRaw {
		w.Events[i] = EventType(e)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &w, nil
}

func (r *Repo) Create(ctx context.Context, tenantID string, in CreateInput, secretHash string, envelope []byte) (*Webhook, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	events := make([]string, len(in.Events))
	for i, e := range in.Events {
		events[i] = string(e)
	}

	var w Webhook
	var eventsRaw []string
	row := tx.QueryRow(ctx, `
INSERT INTO webhooks (tenant_id, url, events, secret_hash, secret_envelope, status)
VALUES ($1::uuid, $2, $3, $4, $5, 'active')
RETURNING id::text, tenant_id::text, url, events, status, created_at, updated_at`,
		tenantID, in.URL, events, secretHash, envelope)
	if err := row.Scan(&w.ID, &w.TenantID, &w.URL, &eventsRaw, &w.Status,
		&w.CreatedAt, &w.UpdatedAt); err != nil {
		return nil, err
	}
	w.Events = make([]EventType, len(eventsRaw))
	for i, e := range eventsRaw {
		w.Events[i] = EventType(e)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &w, nil
}

// LoadSecretEnvelope returns the envelope bytes for a webhook id (or nil
// if the row was created before 0039 / passed envelope=nil at create).
// Worker-only path: bypasses RLS via the outbox-worker GUC same as
// outbox.Repo.Claim does.
func (r *Repo) LoadSecretEnvelope(ctx context.Context, tenantID, webhookID string) ([]byte, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var env []byte
	err = tx.QueryRow(ctx,
		`SELECT secret_envelope FROM webhooks WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, webhookID,
	).Scan(&env)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return env, tx.Commit(ctx)
}

// Update applies a sparse patch.
func (r *Repo) Update(ctx context.Context, tenantID, id string, in UpdateInput) (*Webhook, error) {
	cur, err := r.Get(ctx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if in.URL != nil {
		cur.URL = *in.URL
	}
	if in.Events != nil {
		cur.Events = *in.Events
	}
	if in.Status != nil {
		cur.Status = *in.Status
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	events := make([]string, len(cur.Events))
	for i, e := range cur.Events {
		events[i] = string(e)
	}
	row := tx.QueryRow(ctx, `
UPDATE webhooks SET url=$1, events=$2, status=$3, updated_at=now()
WHERE id::text = $4
RETURNING updated_at`, cur.URL, events, cur.Status, id)
	if err := row.Scan(&cur.UpdatedAt); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return cur, nil
}

// Delete removes a webhook (cascades to webhook_deliveries).
func (r *Repo) Delete(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM webhooks WHERE id::text = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// RecordDelivery appends one webhook_deliveries row WITHOUT a payload
// snapshot. Kept for the existing Test-endpoint code path which has
// no useful payload to retain.
func (r *Repo) RecordDelivery(ctx context.Context, tenantID string, d Delivery) error {
	return r.RecordDeliveryWithPayload(ctx, tenantID, d, nil)
}

// RecordDeliveryWithPayload appends one webhook_deliveries row WITH
// the wire-format payload bytes for later replay. nil payload is
// fine — the column is nullable; replay surfaces missing-payload
// rows with a clear "payload not retained" error.
func (r *Repo) RecordDeliveryWithPayload(ctx context.Context, tenantID string, d Delivery, payload []byte) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO webhook_deliveries (webhook_id, tenant_id, event, status_code,
                                 attempt, response_ms, error, payload_bytes, at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, NULLIF($7, ''), $8, now())`,
		d.WebhookID, tenantID, d.Event, d.StatusCode, d.Attempt, d.ResponseMS, d.Error, payload); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// LoadDeliveryPayload fetches the stored payload for a past delivery
// so the Replay endpoint can re-fire it. Returns ErrNotFound when
// the row doesn't exist OR when the payload column is NULL (legacy
// rows pre-0050; the handler surfaces "payload not retained").
func (r *Repo) LoadDeliveryPayload(ctx context.Context, tenantID string, deliveryID int64) (webhookID, eventType string, payload []byte, err error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", "", nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, `
SELECT webhook_id::text, event, payload_bytes
  FROM webhook_deliveries
 WHERE tenant_id = $1::uuid AND id = $2`,
		tenantID, deliveryID,
	).Scan(&webhookID, &eventType, &payload); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", nil, ErrNotFound
		}
		return "", "", nil, err
	}
	return webhookID, eventType, payload, tx.Commit(ctx)
}

// GetDeliveryDetail returns one delivery + its retained request payload for the
// inspector (SETA-004). Scoped by BOTH webhook_id and delivery id so a delivery
// can only be read through its own webhook's URL (a mismatched {id} → 404). A
// NULL payload_bytes yields PayloadRetained=false with the metadata intact.
func (r *Repo) GetDeliveryDetail(ctx context.Context, tenantID, webhookID string, deliveryID int64) (*DeliveryDetail, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var d DeliveryDetail
	var payload []byte
	if err := tx.QueryRow(ctx, `
SELECT id, webhook_id::text, event, status_code, attempt, response_ms,
       COALESCE(error, ''), payload_bytes, at
  FROM webhook_deliveries
 WHERE tenant_id = $1::uuid AND webhook_id::text = $2 AND id = $3`,
		tenantID, webhookID, deliveryID,
	).Scan(&d.ID, &d.WebhookID, &d.Event, &d.StatusCode, &d.Attempt,
		&d.ResponseMS, &d.Error, &payload, &d.At); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if len(payload) > 0 {
		d.RequestBody = string(payload)
		d.PayloadRetained = true
	}
	return &d, tx.Commit(ctx)
}

// ListDeliveries returns recent deliveries for a webhook, newest-first.
func (r *Repo) ListDeliveries(ctx context.Context, tenantID, webhookID string, limit int, beforeID int64) ([]Delivery, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Keyset cursor on the monotonic id (SETA-036): id < beforeID pages
	// backwards through time without OFFSET drift. beforeID = 0 = first page.
	rows, err := tx.Query(ctx, `
SELECT id, webhook_id::text, event, status_code, attempt, response_ms,
       COALESCE(error, ''), at
FROM webhook_deliveries
WHERE webhook_id::text = $1 AND ($3 = 0 OR id < $3)
ORDER BY id DESC
LIMIT $2`, webhookID, limit, beforeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Delivery{}
	for rows.Next() {
		var d Delivery
		if err := rows.Scan(&d.ID, &d.WebhookID, &d.Event, &d.StatusCode,
			&d.Attempt, &d.ResponseMS, &d.Error, &d.At); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func scanOne(ctx context.Context, tx pgx.Tx, where, arg string) (*Webhook, error) {
	var w Webhook
	var eventsRaw []string
	q := `SELECT id::text, tenant_id::text, url, events, status,
       COALESCE(environment, 'production'),
       created_at, updated_at
FROM webhooks WHERE ` + where + ` LIMIT 1`
	row := tx.QueryRow(ctx, q, arg)
	if err := row.Scan(&w.ID, &w.TenantID, &w.URL, &eventsRaw, &w.Status,
		&w.Environment,
		&w.CreatedAt, &w.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	w.Events = make([]EventType, len(eventsRaw))
	for i, e := range eventsRaw {
		w.Events[i] = EventType(e)
	}
	return &w, nil
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
