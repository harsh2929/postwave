// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// ListSubscriberAddedEvent is one authoritative list-membership revision.
// AddedAt must be the value persisted on list_subscribers, not a caller clock:
// it is part of the source identity that separates a later remove/re-add from
// a retry of the original mutation.
type ListSubscriberAddedEvent struct {
	SubscriberID string
	Email        string
	ListID       string
	Source       string
	AddedAt      time.Time
}

type preparedListSubscriberAddedEvent struct {
	SourceEventID string          `json:"source_event_id"`
	OccurredAt    time.Time       `json:"occurred_at"`
	PayloadSHA256 string          `json:"payload_sha256"`
	Envelope      json.RawMessage `json:"envelope"`
	ListID        string          `json:"list_id"`
}

// FireListSubscriberAddedBatch persists receipts and delivery intents for an
// arbitrary membership batch without issuing one subscription query per
// member. It performs exactly one set-based receipt INSERT, one collision
// validation query, and one set-based delivery INSERT in the producer's tx.
func (*TransactionalFanout) FireListSubscriberAddedBatch(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	events []ListSubscriberAddedEvent,
) (int, error) {
	if tx == nil {
		return 0, errors.New("outbound_webhooks: transactional list fanout requires a transaction")
	}
	tenantID = strings.TrimSpace(tenantID)
	if tenantID == "" {
		return 0, errors.New("outbound_webhooks: transactional list fanout requires a tenant")
	}
	if len(events) == 0 {
		return 0, nil
	}

	prepared := make([]preparedListSubscriberAddedEvent, 0, len(events))
	for index, event := range events {
		record, err := prepareListSubscriberAddedEvent(tenantID, event)
		if err != nil {
			return 0, fmt.Errorf(
				"outbound_webhooks: prepare list subscriber added event %d: %w",
				index, err,
			)
		}
		prepared = append(prepared, record)
	}
	batchJSON, err := json.Marshal(prepared)
	if err != nil {
		return 0, fmt.Errorf("outbound_webhooks: marshal list event batch: %w", err)
	}

	if _, err := tx.Exec(ctx, `
WITH incoming AS (
    SELECT source_event_id::uuid,
           occurred_at,
           decode(payload_sha256, 'hex') AS payload_sha256
      FROM jsonb_to_recordset($2::jsonb) AS event(
          source_event_id text,
          occurred_at timestamptz,
          payload_sha256 text
      )
)
INSERT INTO outbound_webhook_event_receipts (
    tenant_id, source_event_id, event_type, occurred_at, payload_sha256
)
SELECT $1::uuid, source_event_id, 'list.subscriber.added',
       occurred_at, payload_sha256
  FROM incoming
ON CONFLICT (tenant_id, source_event_id) DO NOTHING`,
		tenantID, string(batchJSON)); err != nil {
		return 0, fmt.Errorf(
			"outbound_webhooks: persist list event receipts: %w", err,
		)
	}

	var collision bool
	if err := tx.QueryRow(ctx, `
WITH incoming AS (
    SELECT source_event_id::uuid,
           decode(payload_sha256, 'hex') AS payload_sha256
      FROM jsonb_to_recordset($2::jsonb) AS event(
          source_event_id text,
          payload_sha256 text
      )
)
SELECT EXISTS (
    SELECT 1
      FROM incoming i
      LEFT JOIN outbound_webhook_event_receipts r
        ON r.tenant_id = $1::uuid
       AND r.source_event_id = i.source_event_id
     WHERE r.source_event_id IS NULL
        OR r.event_type <> 'list.subscriber.added'
        OR r.payload_sha256 <> i.payload_sha256
)`,
		tenantID, string(batchJSON)).Scan(&collision); err != nil {
		return 0, fmt.Errorf(
			"outbound_webhooks: validate list event receipts: %w", err,
		)
	}
	if collision {
		return 0, errors.New(
			"outbound_webhooks: source event id collision in list subscriber added batch",
		)
	}

	var count int
	if err := tx.QueryRow(ctx, `
WITH incoming AS (
    SELECT source_event_id::uuid,
           occurred_at,
           envelope,
           list_id
      FROM jsonb_to_recordset($2::jsonb) AS event(
          source_event_id text,
          occurred_at timestamptz,
          envelope jsonb,
          list_id text
      )
),
inserted AS (
    INSERT INTO outbound_webhook_deliveries (
        tenant_id, webhook_id, event_type, source_event_id, payload,
        next_attempt_at, status
    )
    SELECT w.tenant_id, w.id, 'list.subscriber.added',
           i.source_event_id, i.envelope, now(), 'pending'
      FROM incoming i
      JOIN outbound_webhooks w
        ON w.tenant_id = $1::uuid
       AND w.deleted_at IS NULL
       AND w.active = true
       AND w.auth_config_state = 'ready'
       AND w.url_state = 'ready'
       AND 'list.subscriber.added' = ANY(w.events)
       AND w.created_at <= i.occurred_at
       AND (w.list_id IS NULL OR w.list_id::text = i.list_id)
    ON CONFLICT (tenant_id, webhook_id, source_event_id)
        WHERE source_event_id IS NOT NULL AND parent_delivery_id IS NULL
    DO NOTHING
    RETURNING 1
)
SELECT count(*)::int FROM inserted`,
		tenantID, string(batchJSON)).Scan(&count); err != nil {
		return 0, fmt.Errorf(
			"outbound_webhooks: persist list delivery intents: %w", err,
		)
	}
	return count, nil
}

func prepareListSubscriberAddedEvent(
	tenantID string,
	event ListSubscriberAddedEvent,
) (preparedListSubscriberAddedEvent, error) {
	event.SubscriberID = strings.TrimSpace(event.SubscriberID)
	event.Email = strings.TrimSpace(event.Email)
	event.ListID = strings.TrimSpace(event.ListID)
	event.Source = strings.TrimSpace(event.Source)
	if event.SubscriberID == "" {
		return preparedListSubscriberAddedEvent{}, errors.New("subscriber id required")
	}
	if event.Email == "" {
		return preparedListSubscriberAddedEvent{}, errors.New("email required")
	}
	if event.ListID == "" {
		return preparedListSubscriberAddedEvent{}, errors.New("list id required")
	}
	if event.Source == "" {
		return preparedListSubscriberAddedEvent{}, errors.New("source required")
	}
	if event.AddedAt.IsZero() {
		return preparedListSubscriberAddedEvent{}, errors.New("persisted added_at required")
	}
	event.AddedAt = event.AddedAt.UTC()

	bodyJSON, err := transactionalBodyJSON(map[string]any{
		"subscriber_id": event.SubscriberID,
		"email":         event.Email,
		"list_id":       event.ListID,
		"source":        event.Source,
	})
	if err != nil {
		return preparedListSubscriberAddedEvent{}, err
	}
	sourceKey := strings.Join([]string{
		"list-membership-added",
		event.ListID,
		event.SubscriberID,
		event.AddedAt.Format(time.RFC3339Nano),
	}, "\x00")
	sourceEventID := transactionalSourceEventID(tenantID, sourceKey)
	body := json.RawMessage(bodyJSON)
	envelopeJSON, err := json.Marshal(map[string]any{
		"event": map[string]any{
			"id":          sourceEventID,
			"type":        EventListSubscriberAdded,
			"occurred_at": event.AddedAt.Format(time.RFC3339Nano),
			"data":        body,
		},
	})
	if err != nil {
		return preparedListSubscriberAddedEvent{}, err
	}
	payloadDigest := sha256.Sum256(bodyJSON)
	return preparedListSubscriberAddedEvent{
		SourceEventID: sourceEventID,
		OccurredAt:    event.AddedAt,
		PayloadSHA256: hex.EncodeToString(payloadDigest[:]),
		Envelope:      append(json.RawMessage(nil), envelopeJSON...),
		ListID:        event.ListID,
	}, nil
}
