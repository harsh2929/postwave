// SPDX-License-Identifier: AGPL-3.0-only
//
// Package freq_caps is the GAP-LS-088 next-generation frequency-cap
// surface: per-channel + per-message-type + per-applies-to-segment
// independent counters layered on top of the existing tenant-level
// frequency package (which only supports a single "max sends per N
// hours" rule per tenant).
//
// Benchmarks:
//   - Iterable: per-channel & per-type independent counters
//     (https://support.iterable.com/hc/en-us/articles/15342990564372)
//   - Customer.io: workspace + global + campaign tiers
//     (https://docs.customer.io/journeys/message-limits/)
//   - Braze: channel-based rate limiting
//     (https://www.braze.com/docs/releases/2026/3_5_26)
//   - Marketo Communication Limits
//     (https://experienceleague.adobe.com/en/docs/marketo/...)
//
// Surfaces (see handlers.go):
//
//	GET    /api/v1/frequency-caps            (read:reports)
//	POST   /api/v1/frequency-caps            (admin)
//	PATCH  /api/v1/frequency-caps/{id}       (admin)
//	DELETE /api/v1/frequency-caps/{id}       (admin)
//	POST   /api/v1/frequency-caps/{id}/test  (admin) — dry-run a single email
//
// Schema (shipped by migration 1978):
//
//	frequency_caps:
//	  id            uuid PK
//	  tenant_id     uuid NOT NULL → tenants(id)
//	  label         text
//	  channel       text NOT NULL CHECK IN ('email','sms','push','*')
//	  message_type  text NOT NULL  -- 'transactional' | 'marketing' |
//	                                  'newsletter' | 'product_update' |
//	                                  '*' (matches any)
//	  max_count     int  NOT NULL CHECK (max_count > 0)
//	  window_seconds int NOT NULL CHECK (window_seconds BETWEEN 60 AND 2592000)
//	  applies_to    text NOT NULL DEFAULT 'all'  -- 'all' | segment uuid | tag
//	  active        bool NOT NULL DEFAULT true
//	  created_at    timestamptz NOT NULL DEFAULT now()
//	  updated_at    timestamptz NOT NULL DEFAULT now()
//	  -- RLS: tenant_isolation via app.tenant_id GUC.
//
//	frequency_cap_events (append-only counter source):
//	  id                bigserial PK
//	  tenant_id         uuid NOT NULL
//	  subscriber_email  citext NOT NULL
//	  channel           text NOT NULL
//	  message_type      text NOT NULL
//	  campaign_id       uuid    NULL
//	  sent_at           timestamptz NOT NULL DEFAULT now()
//	  -- INDEX (tenant_id, subscriber_email, channel, message_type, sent_at DESC)
//	  -- RLS: same as frequency_caps.
//
// SENDLOOP ENFORCEMENT STATUS: campaigns/automation_email.go calls WouldDefer
// before dispatch, but RecordSent still has no production caller. Until a
// successful-send path records the counter durably, configured caps cannot
// claim complete enforcement; the helper and CRUD/dry-run surface are only a
// qualified foundation.

package freq_caps

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Cap is one operator-configured frequency rule.
type Cap struct {
	ID            string    `json:"id"`
	Label         string    `json:"label"`
	Channel       string    `json:"channel"`
	MessageType   string    `json:"message_type"`
	MaxCount      int       `json:"max_count"`
	WindowSeconds int       `json:"window_seconds"`
	AppliesTo     string    `json:"applies_to"`
	Active        bool      `json:"active"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// CapDecision is the result of evaluating an outbound message against
// every active cap. Returned by WouldDefer for the send loop.
type CapDecision struct {
	// Defer reports whether at least one cap rule's counter has been
	// hit — in which case the send loop should requeue the message
	// with backoff, not drop it.
	Defer bool `json:"defer"`
	// HitCapID identifies which rule was tripped (the first one we
	// find — caps are independent so any single hit defers).
	HitCapID    string `json:"hit_cap_id,omitempty"`
	HitCapLabel string `json:"hit_cap_label,omitempty"`
	// CurrentCount + Window are surfaced for observability so the
	// sendloop log row can carry context.
	CurrentCount int `json:"current_count,omitempty"`
}

// AllowedChannels + AllowedMessageTypes are the validation sets. The
// "*" wildcard is allowed in both columns so an operator can set a
// catch-all cap (e.g. "any channel, any type, max 50/week").
var AllowedChannels = []string{"email", "sms", "push", "webhook", "*"}

var AllowedMessageTypes = []string{
	"transactional",
	"marketing",
	"newsletter",
	"product_update",
	"price_drop",
	"reengagement",
	"*",
}

// ErrNotFound is returned by Repo.Get when the cap doesn't exist.
var ErrNotFound = errors.New("freq_caps: not found")

// Repo wraps the pgx pool. All tenant-scoped queries open a tx via
// db.WithTenant so RLS isolates the read/write.
type Repo struct {
	Pool *db.Pool
}

// List returns every cap for the tenant, ordered by created_at.
func (r *Repo) List(ctx context.Context, tenantID string) ([]Cap, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, label, channel, message_type, max_count,
       window_seconds, applies_to, active, created_at, updated_at
  FROM frequency_caps
 WHERE tenant_id = $1::uuid
 ORDER BY created_at`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Cap{}
	for rows.Next() {
		var c Cap
		if scanErr := rows.Scan(&c.ID, &c.Label, &c.Channel, &c.MessageType,
			&c.MaxCount, &c.WindowSeconds, &c.AppliesTo, &c.Active,
			&c.CreatedAt, &c.UpdatedAt); scanErr == nil {
			out = append(out, c)
		}
	}
	return out, rows.Err()
}

// Get fetches a single cap; returns ErrNotFound when missing.
func (r *Repo) Get(ctx context.Context, tenantID, id string) (*Cap, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var c Cap
	err = tx.QueryRow(ctx, `
SELECT id::text, label, channel, message_type, max_count,
       window_seconds, applies_to, active, created_at, updated_at
  FROM frequency_caps
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id).Scan(
		&c.ID, &c.Label, &c.Channel, &c.MessageType,
		&c.MaxCount, &c.WindowSeconds, &c.AppliesTo, &c.Active,
		&c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// Create inserts a new cap and returns the inserted row.
func (r *Repo) Create(ctx context.Context, tenantID string, in Cap) (*Cap, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out Cap
	err = tx.QueryRow(ctx, `
INSERT INTO frequency_caps
   (tenant_id, label, channel, message_type, max_count, window_seconds, applies_to, active)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
RETURNING id::text, label, channel, message_type, max_count,
          window_seconds, applies_to, active, created_at, updated_at`,
		tenantID, in.Label, in.Channel, in.MessageType, in.MaxCount,
		in.WindowSeconds, in.AppliesTo, in.Active).Scan(
		&out.ID, &out.Label, &out.Channel, &out.MessageType,
		&out.MaxCount, &out.WindowSeconds, &out.AppliesTo, &out.Active,
		&out.CreatedAt, &out.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

// Patch updates a subset of fields on a cap. Caller passes pointers so
// "omitted" and "null" are distinguishable.
type PatchInput struct {
	Label         *string `json:"label,omitempty"`
	Channel       *string `json:"channel,omitempty"`
	MessageType   *string `json:"message_type,omitempty"`
	MaxCount      *int    `json:"max_count,omitempty"`
	WindowSeconds *int    `json:"window_seconds,omitempty"`
	AppliesTo     *string `json:"applies_to,omitempty"`
	Active        *bool   `json:"active,omitempty"`
}

// Patch applies the input to an existing cap. Returns the updated row.
func (r *Repo) Patch(ctx context.Context, tenantID, id string, in PatchInput) (*Cap, error) {
	cur, err := r.Get(ctx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if in.Label != nil {
		cur.Label = strings.TrimSpace(*in.Label)
	}
	if in.Channel != nil {
		cur.Channel = strings.TrimSpace(*in.Channel)
	}
	if in.MessageType != nil {
		cur.MessageType = strings.TrimSpace(*in.MessageType)
	}
	if in.MaxCount != nil {
		cur.MaxCount = *in.MaxCount
	}
	if in.WindowSeconds != nil {
		cur.WindowSeconds = *in.WindowSeconds
	}
	if in.AppliesTo != nil {
		cur.AppliesTo = strings.TrimSpace(*in.AppliesTo)
	}
	if in.Active != nil {
		cur.Active = *in.Active
	}
	if err := ValidateCap(*cur); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out Cap
	err = tx.QueryRow(ctx, `
UPDATE frequency_caps
   SET label          = $2,
       channel        = $3,
       message_type   = $4,
       max_count      = $5,
       window_seconds = $6,
       applies_to     = $7,
       active         = $8,
       updated_at     = now()
 WHERE id = $1::uuid
RETURNING id::text, label, channel, message_type, max_count,
          window_seconds, applies_to, active, created_at, updated_at`,
		id, cur.Label, cur.Channel, cur.MessageType,
		cur.MaxCount, cur.WindowSeconds, cur.AppliesTo, cur.Active).Scan(
		&out.ID, &out.Label, &out.Channel, &out.MessageType,
		&out.MaxCount, &out.WindowSeconds, &out.AppliesTo, &out.Active,
		&out.CreatedAt, &out.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete removes a cap. Returns ErrNotFound when nothing was deleted.
func (r *Repo) Delete(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx,
		`DELETE FROM frequency_caps WHERE id = $1::uuid`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// --- enforcement plumbing -------------------------------------------

// SendContext is the structured projection of an outbound message
// the send loop hands WouldDefer / RecordSent. Keep it small so the
// send loop pays a cheap struct construction, not a payload decode.
type SendContext struct {
	SubscriberEmail string
	Channel         string // "email" | "sms" | "push" | "webhook"
	MessageType     string // see AllowedMessageTypes
	CampaignID      string
}

// WouldDefer reports whether at least one active cap rule for the
// tenant has been hit for this (subscriber, channel, message_type)
// combination. Send loop integration:
//
//	dec, err := freq_caps.WouldDefer(ctx, pool, tenantID, ctxv)
//	if err == nil && dec.Defer { sendloop.Requeue(); continue }
//	defer freq_caps.RecordSent(ctx, pool, tenantID, ctxv)
//
// NOTE: actual sendloop wiring is W2B Agent A's territory; this
// helper is the integration contract.
func WouldDefer(ctx context.Context, pool *db.Pool, tenantID string, sctx SendContext) (CapDecision, error) {
	if pool == nil || strings.TrimSpace(sctx.SubscriberEmail) == "" {
		return CapDecision{}, nil
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return CapDecision{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	caps, err := listActiveMatchingCaps(ctx, tx, sctx)
	if err != nil || len(caps) == 0 {
		return CapDecision{}, err
	}
	for _, c := range caps {
		cutoff := time.Now().UTC().Add(-time.Duration(c.WindowSeconds) * time.Second)
		var count int
		err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM frequency_cap_events
 WHERE tenant_id = $1::uuid
   AND subscriber_email = $2
   AND (channel = $3 OR $3 = '*' OR channel = '*')
   AND (message_type = $4 OR $4 = '*' OR message_type = '*')
   AND sent_at >= $5`,
			tenantID, sctx.SubscriberEmail, c.Channel, c.MessageType, cutoff).Scan(&count)
		if err != nil {
			continue
		}
		if count >= c.MaxCount {
			return CapDecision{
				Defer:        true,
				HitCapID:     c.ID,
				HitCapLabel:  c.Label,
				CurrentCount: count,
			}, nil
		}
	}
	return CapDecision{}, nil
}

// RecordSent appends one event row per successful send. Called by the
// send loop AFTER dispatch so a delivery failure does not consume cap
// budget against the subscriber. Idempotency: best-effort — duplicate
// rows on retry are absorbed in the count (slight over-counting biases
// toward MORE protection for the subscriber, never less).
func RecordSent(ctx context.Context, pool *db.Pool, tenantID string, sctx SendContext) {
	if pool == nil || strings.TrimSpace(sctx.SubscriberEmail) == "" {
		return
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, `
INSERT INTO frequency_cap_events
  (tenant_id, subscriber_email, channel, message_type, campaign_id, sent_at)
VALUES ($1::uuid, $2, $3, $4, NULLIF($5,'')::uuid, now())`,
		tenantID, sctx.SubscriberEmail, sctx.Channel, sctx.MessageType, sctx.CampaignID)
	_ = tx.Commit(ctx)
}

// listActiveMatchingCaps returns only the rules whose channel +
// message_type match the candidate send (with the "*" wildcard
// resolving to any). Pre-filter at the DB so we don't pay for rule
// evaluation that can't match.
func listActiveMatchingCaps(ctx context.Context, tx pgx.Tx, sctx SendContext) ([]Cap, error) {
	rows, err := tx.Query(ctx, `
SELECT id::text, label, channel, message_type, max_count,
       window_seconds, applies_to, active, created_at, updated_at
  FROM frequency_caps
 WHERE active = true
   AND (channel = $1 OR channel = '*' OR $1 = '*')
   AND (message_type = $2 OR message_type = '*' OR $2 = '*')`,
		sctx.Channel, sctx.MessageType)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Cap{}
	for rows.Next() {
		var c Cap
		if scanErr := rows.Scan(&c.ID, &c.Label, &c.Channel, &c.MessageType,
			&c.MaxCount, &c.WindowSeconds, &c.AppliesTo, &c.Active,
			&c.CreatedAt, &c.UpdatedAt); scanErr == nil {
			out = append(out, c)
		}
	}
	return out, rows.Err()
}

// --- validation -----------------------------------------------------

// ValidateCap enforces the structural invariants the schema-level
// CHECK constraints carry; surfaced as a Go error so handlers can
// return a friendly 400 instead of a Postgres CHECK violation message.
func ValidateCap(c Cap) error {
	if !containsString(AllowedChannels, c.Channel) {
		return errors.New("channel must be one of: " + strings.Join(AllowedChannels, ", "))
	}
	if !containsString(AllowedMessageTypes, c.MessageType) {
		return errors.New("message_type must be one of: " + strings.Join(AllowedMessageTypes, ", "))
	}
	if c.MaxCount <= 0 || c.MaxCount > 1000 {
		return errors.New("max_count must be between 1 and 1000")
	}
	// 60s lower bound prevents abuse (you can't realistically cap to
	// "10 per 30 seconds" in a marketing automation product); 30d
	// upper bound matches Iterable's window cap.
	if c.WindowSeconds < 60 || c.WindowSeconds > 2592000 {
		return errors.New("window_seconds must be between 60 and 2592000 (30 days)")
	}
	if strings.TrimSpace(c.AppliesTo) == "" {
		return errors.New("applies_to is required (use 'all' for tenant-wide)")
	}
	return nil
}

func containsString(haystack []string, needle string) bool {
	for _, h := range haystack {
		if h == needle {
			return true
		}
	}
	return false
}
