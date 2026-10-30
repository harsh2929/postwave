// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// TransactionalEvent is a domain event whose delivery intent must commit in
// the same tenant transaction as the business mutation that produced it.
type TransactionalEvent struct {
	TenantID      string
	EventType     string
	SourceEventID string
	Body          any
	OccurredAt    time.Time
}

// TransactionalFanout inserts canonical delivery rows directly inside the
// producer's transaction. It is deliberately stateless: RLS and the supplied
// pgx transaction remain the authority, and the normal delivery worker owns
// all network I/O after commit.
type TransactionalFanout struct{}

const maxTransactionalEventDataBytes = 256 * 1024

// Fire resolves compatible legacy topic aliases, finds matching canonical
// subscriptions, and inserts one idempotent pending row per destination.
func (*TransactionalFanout) Fire(ctx context.Context, tx pgx.Tx, in TransactionalEvent) (int, error) {
	if tx == nil {
		return 0, errors.New("outbound_webhooks: transactional fanout requires a transaction")
	}
	in.TenantID = strings.TrimSpace(in.TenantID)
	if in.TenantID == "" {
		return 0, errors.New("outbound_webhooks: transactional fanout requires a tenant")
	}
	eventType, ok := canonicalTransactionalEventType(in.EventType)
	if !ok {
		return 0, fmt.Errorf(
			"outbound_webhooks: unsupported transactional event type %q",
			strings.TrimSpace(in.EventType),
		)
	}
	if strings.TrimSpace(in.SourceEventID) == "" {
		return 0, errors.New("outbound_webhooks: transactional fanout requires a stable source event id")
	}
	occurredAt := in.OccurredAt
	if occurredAt.IsZero() {
		occurredAt = time.Now().UTC()
	}
	sourceEventID := transactionalSourceEventID(in.TenantID, in.SourceEventID)
	bodyJSON, err := transactionalBodyJSON(in.Body)
	if err != nil {
		return 0, err
	}
	payloadDigest := sha256.Sum256(bodyJSON)
	if _, err := tx.Exec(ctx, `
INSERT INTO outbound_webhook_event_receipts (
    tenant_id, source_event_id, event_type, occurred_at, payload_sha256
)
VALUES ($1::uuid, $2::uuid, $3, $4, $5)
ON CONFLICT (tenant_id, source_event_id) DO NOTHING`,
		in.TenantID, sourceEventID, eventType, occurredAt.UTC(), payloadDigest[:]); err != nil {
		return 0, fmt.Errorf("outbound_webhooks: persist event receipt: %w", err)
	}
	var (
		storedEventType string
		storedDigest    []byte
		storedOccurred  time.Time
	)
	if err := tx.QueryRow(ctx, `
SELECT event_type, payload_sha256, occurred_at
  FROM outbound_webhook_event_receipts
 WHERE tenant_id = $1::uuid
   AND source_event_id = $2::uuid`,
		in.TenantID, sourceEventID).Scan(
		&storedEventType,
		&storedDigest,
		&storedOccurred,
	); err != nil {
		return 0, fmt.Errorf("outbound_webhooks: load event receipt: %w", err)
	}
	if storedEventType != eventType || !bytes.Equal(storedDigest, payloadDigest[:]) {
		return 0, fmt.Errorf(
			"outbound_webhooks: source event id collision for %s", sourceEventID,
		)
	}
	// A retry must keep the authoritative event's first occurrence time.
	// Otherwise a destination created between attempts could receive an old
	// event and the wire envelope would claim it happened during the retry.
	// The receipt insert above wins exactly once; every later observation uses
	// that stored value for both subscription eligibility and the envelope.
	occurredAt = storedOccurred.UTC()
	body := json.RawMessage(bodyJSON)
	envelopeJSON, err := json.Marshal(map[string]any{
		"event": map[string]any{
			"id":          sourceEventID,
			"type":        eventType,
			"occurred_at": occurredAt.Format(time.RFC3339Nano),
			"data":        body,
		},
	})
	if err != nil {
		return 0, err
	}
	listID := transactionalListID(bodyJSON)
	rows, err := tx.Query(ctx, `
INSERT INTO outbound_webhook_deliveries (
    tenant_id, webhook_id, event_type, source_event_id, payload,
    next_attempt_at, status
)
SELECT w.tenant_id, w.id, $2, $3, $4::jsonb, now(), 'pending'
  FROM outbound_webhooks w
 WHERE w.tenant_id = $1::uuid
       AND w.deleted_at IS NULL
       AND w.active = true
       AND w.auth_config_state = 'ready'
       AND w.url_state = 'ready'
   AND $2 = ANY(w.events)
   AND w.created_at <= $6
   AND (w.list_id IS NULL OR ($5 <> '' AND w.list_id::text = $5))
ON CONFLICT (tenant_id, webhook_id, source_event_id)
    WHERE source_event_id IS NOT NULL AND parent_delivery_id IS NULL
DO NOTHING
RETURNING id::text`,
		in.TenantID, eventType, sourceEventID, string(envelopeJSON), listID, occurredAt.UTC())
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return 0, err
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	return count, nil
}

func canonicalTransactionalEventType(eventType string) (string, bool) {
	eventType = strings.TrimSpace(eventType)
	switch eventType {
	case "subscriber.created":
		eventType = "subscriber.added"
	case "subscriber.deleted":
		eventType = "subscriber.removed"
	case "subscriber.bounced":
		eventType = "bounce.received"
	}
	return eventType, IsAllowedEvent(eventType)
}

// IsTransactionalEventType reports whether a producer topic can be mapped to
// the canonical customer-webhook catalog. Compatibility dispatchers use this
// to skip canonical fanout for legacy-only topics; direct transactional
// callers still fail closed when they accidentally pass an unsupported name.
func IsTransactionalEventType(eventType string) bool {
	_, ok := canonicalTransactionalEventType(eventType)
	return ok
}

func transactionalSourceEventID(tenantID, supplied string) string {
	supplied = strings.TrimSpace(supplied)
	if parsed, err := uuid.Parse(supplied); err == nil {
		return parsed.String()
	}
	sum := sha256.Sum256([]byte(tenantID + "\x00" + supplied))
	raw := sum[:16]
	raw[6] = (raw[6] & 0x0f) | 0x50
	raw[8] = (raw[8] & 0x3f) | 0x80
	id, err := uuid.FromBytes(raw)
	if err != nil {
		// sha256 always supplies exactly 16 bytes above. Keep the defensive
		// fallback UUID-shaped so storage never widens to caller-controlled
		// arbitrary text.
		return uuid.NewString()
	}
	return id.String()
}

func transactionalBodyJSON(body any) ([]byte, error) {
	if body == nil {
		return []byte("{}"), nil
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("outbound_webhooks: marshal event data: %w", err)
	}
	if len(raw) > maxTransactionalEventDataBytes {
		return nil, fmt.Errorf(
			"outbound_webhooks: event data exceeds %d bytes",
			maxTransactionalEventDataBytes,
		)
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, errors.New("outbound_webhooks: event data must be a JSON object")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &object); err != nil || object == nil {
		return nil, errors.New("outbound_webhooks: event data must be a JSON object")
	}
	return trimmed, nil
}

func transactionalListID(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var record map[string]json.RawMessage
	if json.Unmarshal(raw, &record) != nil {
		return ""
	}
	var value string
	if json.Unmarshal(record["list_id"], &value) != nil {
		return ""
	}
	return strings.TrimSpace(value)
}
