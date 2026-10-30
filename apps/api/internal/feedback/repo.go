// SPDX-License-Identifier: AGPL-3.0-only
package feedback

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// SoftBounceWindow is how far back we look when deciding whether a soft
// bounce burst should escalate into an automatic suppression.
const SoftBounceWindow = 7 * 24 * time.Hour

// SoftBounceThreshold is the count of soft bounces in SoftBounceWindow
// that triggers a suppression. Three soft bounces in a week is the
// industry-standard "give up; assume the mailbox is gone" line.
const SoftBounceThreshold = 3

// Repo is the pgx-backed persistence surface for feedback events.
type Repo struct{ Pool *db.Pool }

// RecordBounce persists ev to bounce_events under the tenant's RLS scope
// and, when the bounce is severe enough, mirrors it into the existing
// email_suppressions table with reason='hard_bounce' so the send pipeline
// drops the address on the next dispatch.
//
// Severity rules:
//   - bounce_type='hard'  → always suppress
//   - bounce_type='soft'  → suppress only if there are ≥SoftBounceThreshold
//     soft bounces in the trailing SoftBounceWindow
//     (counting the row we just inserted)
//   - bounce_type='transient' → never suppress; it's the ESP itself
//     temporarily failing
func (r *Repo) RecordBounce(ctx context.Context, tenantID string, ev BounceEvent) error {
	if tenantID == "" {
		return fmt.Errorf("feedback: tenantID required")
	}
	if strings.TrimSpace(ev.SubscriberEmail) == "" {
		return fmt.Errorf("feedback: subscriber_email required")
	}
	switch ev.BounceType {
	case "hard", "soft", "transient":
	default:
		return fmt.Errorf("feedback: bounce_type %q not in (hard, soft, transient)", ev.BounceType)
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	raw := normalizeRaw(ev.Raw)
	receivedAt := ev.ReceivedAt
	if receivedAt.IsZero() {
		receivedAt = time.Now().UTC()
	}

	// Idempotent insert via the partial unique index from migration
	// 0162 (tenant_id, esp, esp_message_id) WHERE esp_message_id IS
	// NOT NULL. Provider redeliveries (legitimate retry of an event
	// whose ack got lost) now no-op rather than writing duplicate
	// rows that double-count the soft-bounce threshold or inflate
	// per-tenant complaint rates.
	if _, err := tx.Exec(ctx, `
INSERT INTO bounce_events (
    tenant_id, subscriber_email, bounce_type, esp, esp_message_id, raw, received_at)
VALUES ($1::uuid, $2, $3, $4, NULLIF($5, ''), $6::jsonb, $7)
ON CONFLICT (tenant_id, esp, esp_message_id) WHERE esp_message_id IS NOT NULL DO NOTHING`,
		tenantID, strings.TrimSpace(ev.SubscriberEmail), ev.BounceType, ev.ESP,
		ev.ESPMessageID, string(raw), receivedAt,
	); err != nil {
		return fmt.Errorf("feedback: insert bounce_events: %w", err)
	}

	suppress := false
	switch ev.BounceType {
	case "hard":
		suppress = true
	case "soft":
		var count int
		if err := tx.QueryRow(ctx, `
SELECT count(*) FROM bounce_events
 WHERE tenant_id = $1::uuid
   AND subscriber_email = $2
   AND bounce_type = 'soft'
   AND received_at >= $3`,
			tenantID, strings.TrimSpace(ev.SubscriberEmail), receivedAt.Add(-SoftBounceWindow),
		).Scan(&count); err != nil {
			return fmt.Errorf("feedback: count soft bounces: %w", err)
		}
		if count >= SoftBounceThreshold {
			suppress = true
		}
	}

	if suppress {
		if err := upsertSuppression(ctx, tx, tenantID, ev.SubscriberEmail, "hard_bounce", "fbl-auto", ev.ESPMessageID, raw, receivedAt); err != nil {
			return err
		}
	}

	// Project onto the transactional message this event was about, if it was
	// about one. Suppression answers "never mail this address again"; this
	// answers "what became of the receipt for order #4131", and only the second
	// is a question a transactional sender can act on.
	//
	// Unconditional on `suppress`: a single soft bounce does not suppress
	// anything, and it is still the reason a specific message did not arrive.
	if err := r.projectAndAnnounce(ctx, tx, tenantID, ev.ESPMessageID, ev.SubscriberEmail,
		outcomeForBounce(ev.BounceType), bounceReason(raw), ev.ESP, receivedAt); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

// outcomeForBounce maps our bounce vocabulary onto the recipient-outcome one.
//
// A soft bounce is `deferred`, not `bounced`: the mailbox is full or the server
// is throttling, and reporting that as a permanent failure would have senders
// purging addresses that work. The escalation to suppression after
// SoftBounceThreshold is a separate judgement and stays where it is.
func outcomeForBounce(bounceType string) string {
	if bounceType == "hard" {
		return "bounced"
	}
	return "deferred"
}

// bounceReason pulls a human-readable diagnostic out of the provider payload.
//
// Best-effort by design: every ESP names this field differently, and an empty
// reason is a worse answer than a wrong one is dangerous. The raw payload is
// already stored on the bounce row for anyone who needs the truth.
func bounceReason(raw []byte) string {
	var probe map[string]any
	if err := json.Unmarshal(raw, &probe); err != nil {
		return ""
	}
	for _, key := range []string{"diagnostic_code", "description", "reason", "details"} {
		if v, ok := probe[key].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// RecordComplaint persists ev to complaint_events and ALWAYS adds a
// reason='complaint' suppression. Complaints are unambiguous user intent
// — there is no soft-vs-hard distinction.
func (r *Repo) RecordComplaint(ctx context.Context, tenantID string, ev ComplaintEvent) error {
	if tenantID == "" {
		return fmt.Errorf("feedback: tenantID required")
	}
	if strings.TrimSpace(ev.SubscriberEmail) == "" {
		return fmt.Errorf("feedback: subscriber_email required")
	}
	if ev.ComplaintType != "" {
		switch ev.ComplaintType {
		case "abuse", "fbl", "spam":
		default:
			return fmt.Errorf("feedback: complaint_type %q not in (abuse, fbl, spam)", ev.ComplaintType)
		}
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	raw := normalizeRaw(ev.Raw)
	receivedAt := ev.ReceivedAt
	if receivedAt.IsZero() {
		receivedAt = time.Now().UTC()
	}

	// Idempotent insert — see RecordBounce for the rationale.
	if _, err := tx.Exec(ctx, `
INSERT INTO complaint_events (
    tenant_id, subscriber_email, complaint_type, esp, esp_message_id, raw, received_at)
VALUES ($1::uuid, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), $6::jsonb, $7)
ON CONFLICT (tenant_id, esp, esp_message_id) WHERE esp_message_id IS NOT NULL DO NOTHING`,
		tenantID, strings.TrimSpace(ev.SubscriberEmail), ev.ComplaintType, ev.ESP,
		ev.ESPMessageID, string(raw), receivedAt,
	); err != nil {
		return fmt.Errorf("feedback: insert complaint_events: %w", err)
	}

	if err := upsertSuppression(ctx, tx, tenantID, ev.SubscriberEmail, "complaint", "fbl-auto", ev.ESPMessageID, raw, receivedAt); err != nil {
		return err
	}

	if err := r.projectAndAnnounce(ctx, tx, tenantID, ev.ESPMessageID, ev.SubscriberEmail,
		"complained", ev.ComplaintType, ev.ESP, receivedAt); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

// ListByEmail returns the bounce + complaint history for an email address.
// Used by the support-side investigation endpoint. Capped at 200 rows per
// table; if a tenant has more than that for one email we have other
// problems.
func (r *Repo) ListByEmail(ctx context.Context, tenantID, email string) ([]BounceEvent, []ComplaintEvent, error) {
	if tenantID == "" {
		return nil, nil, fmt.Errorf("feedback: tenantID required")
	}
	email = strings.TrimSpace(email)
	if email == "" {
		return nil, nil, fmt.Errorf("feedback: email required")
	}

	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return nil, nil, fmt.Errorf("feedback: set tenant scope: %w", err)
	}

	bounces := []BounceEvent{}
	rows, err := tx.Query(ctx, `
SELECT id, tenant_id::text, subscriber_email, bounce_type, esp,
       COALESCE(esp_message_id, ''), raw, received_at
  FROM bounce_events
 WHERE tenant_id = $1::uuid AND subscriber_email = $2
 ORDER BY received_at DESC
 LIMIT 200`, tenantID, email)
	if err != nil {
		return nil, nil, fmt.Errorf("feedback: query bounces: %w", err)
	}
	for rows.Next() {
		var b BounceEvent
		var raw []byte
		if err := rows.Scan(&b.ID, &b.TenantID, &b.SubscriberEmail, &b.BounceType,
			&b.ESP, &b.ESPMessageID, &raw, &b.ReceivedAt); err != nil {
			rows.Close()
			return nil, nil, err
		}
		b.Raw = append(json.RawMessage(nil), raw...)
		bounces = append(bounces, b)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	complaints := []ComplaintEvent{}
	rows, err = tx.Query(ctx, `
SELECT id, tenant_id::text, subscriber_email, COALESCE(complaint_type, ''),
       COALESCE(esp, ''), COALESCE(esp_message_id, ''), raw, received_at
  FROM complaint_events
 WHERE tenant_id = $1::uuid AND subscriber_email = $2
 ORDER BY received_at DESC
 LIMIT 200`, tenantID, email)
	if err != nil {
		return nil, nil, fmt.Errorf("feedback: query complaints: %w", err)
	}
	for rows.Next() {
		var c ComplaintEvent
		var raw []byte
		if err := rows.Scan(&c.ID, &c.TenantID, &c.SubscriberEmail, &c.ComplaintType,
			&c.ESP, &c.ESPMessageID, &raw, &c.ReceivedAt); err != nil {
			rows.Close()
			return nil, nil, err
		}
		c.Raw = append(json.RawMessage(nil), raw...)
		complaints = append(complaints, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	return bounces, complaints, nil
}

// LookupTenantsByEmail returns the tenant ids that have a subscriber
// row for the given email address. Used as the last-resort tenant
// resolver in the SES bounce/complaint handler when neither the
// esp_message_id nor the X-Postwave-Tenant header is present — e.g.
// when Listmonk's shared-SMTP relay didn't tag outgoing messages.
//
// Returns ([], nil) when no subscriber matches. Multiple matches mean
// the same email is subscribed across multiple tenants; the caller
// can apply suppression to all of them, or pick one as a routing hint.
// Read uses the outbox-worker bypass GUC so it can scan across
// tenants in a single query.
func (r *Repo) LookupTenantsByEmail(ctx context.Context, email string) ([]string, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	if email == "" {
		return nil, nil
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.deliverability_resolver', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT DISTINCT tenant_id::text FROM subscribers
 WHERE lower(email) = $1`, email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// LookupTenantByESPMessageID searches both campaign outbox evidence and the
// public transactional send ledger for a provider message ID. It returns a
// tenant only when all matches resolve to exactly one distinct owner; missing
// or cross-tenant ambiguous evidence fails closed as an empty result.
//
// Best-effort: returns ("", nil) when no matching outbox row is found
// (callers fall back to a tenant header). The lookup runs under the
// outbox worker GUC so it can read across tenants the same way the
// outbox claim path does.
func (r *Repo) LookupTenantByESPMessageID(ctx context.Context, espMessageID string) (string, error) {
	espMessageID = strings.TrimSpace(espMessageID)
	if espMessageID == "" {
		return "", nil
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return "", err
	}
	var tenantID string
	err = tx.QueryRow(ctx, lookupTenantByESPMessageIDSQL, espMessageID).Scan(&tenantID)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return tenantID, nil
}

const lookupTenantByESPMessageIDSQL = `
WITH matches AS (
  SELECT tenant_id
    FROM outbox_events
   WHERE payload->>'esp_message_id' = $1
  UNION
  SELECT tenant_id
    FROM transactional_emails
   WHERE provider_message_id = $1
)
SELECT COALESCE(
  CASE WHEN count(*) = 1 THEN min(tenant_id::text) END,
  ''
)
FROM matches`

// upsertSuppression mirrors a feedback row into email_suppressions so the
// send pipeline (which already consults that table) drops the address
// on the next dispatch. Reason values must match the CHECK constraint in
// 0030_mailchimp_productization.sql ('hard_bounce' | 'complaint' |
// 'unsubscribe' | 'manual' | 'imported'); we use 'hard_bounce' for both
// hard and soft-burst escalations.
func upsertSuppression(ctx context.Context, tx pgx.Tx, tenantID, email, reason, source, providerEventID string, raw []byte, suppressedAt time.Time) error {
	meta, err := json.Marshal(map[string]any{
		"source":     source,
		"raw_sample": json.RawMessage(raw),
	})
	if err != nil {
		return fmt.Errorf("feedback: marshal suppression metadata: %w", err)
	}
	_, err = tx.Exec(ctx, `
INSERT INTO email_suppressions (
    tenant_id, email, reason, source, provider_event_id, metadata, suppressed_at)
VALUES ($1::uuid, $2, $3, $4, NULLIF($5, ''), $6::jsonb, $7)
ON CONFLICT (tenant_id, email, reason) DO UPDATE SET
    source            = EXCLUDED.source,
    provider_event_id = COALESCE(EXCLUDED.provider_event_id, email_suppressions.provider_event_id),
    metadata          = email_suppressions.metadata || EXCLUDED.metadata,
    suppressed_at     = GREATEST(email_suppressions.suppressed_at, EXCLUDED.suppressed_at),
    expires_at        = NULL`,
		tenantID, strings.TrimSpace(email), reason, source, providerEventID, string(meta), suppressedAt,
	)
	if err != nil {
		return fmt.Errorf("feedback: upsert suppression: %w", err)
	}
	return nil
}

func normalizeRaw(in json.RawMessage) []byte {
	if len(in) == 0 {
		return []byte("{}")
	}
	return in
}
