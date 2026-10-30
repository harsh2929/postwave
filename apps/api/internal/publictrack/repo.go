// SPDX-License-Identifier: AGPL-3.0-only
package publictrack

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// AnonymousRepo is the default anonymousEventRecorder, backed by
// subscriber_anonymous_events (migration 1744). It never touches
// subscribers/subscriber_events — that table is intentionally isolated from
// the identified timeline until a stitch producer
// (subscribers.Repo.AttributeAnonymousEvents) copies rows across post-identify.
type AnonymousRepo struct {
	Pool *db.Pool
}

// RecordAnonymousEvent inserts one row into subscriber_anonymous_events,
// tenant-scoped via db.WithTenant (the app.tenant_id NULLIF RLS idiom).
//
// Idempotency mirrors subscribers.Repo.RecordSubscriberEvent's contract but
// via a plain UNIQUE constraint (tenant_id, anonymous_id, source_event_id)
// rather than the separate subscriber_event_dedup_keys table: this surface
// has no subscriber row to race against and a much simpler dedup shape, so
// INSERT ... ON CONFLICT DO NOTHING is sufficient and avoids a second
// round trip on the common (non-duplicate) path. source_event_id is
// optional; when absent every call inserts a new row (NULLs never collide
// under the UNIQUE constraint, matching subscriber_event_dedup_keys'
// convention elsewhere in this codebase).
func (r *AnonymousRepo) RecordAnonymousEvent(ctx context.Context, tenantID string, in AnonymousEventInput) (*AnonymousEvent, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("publictrack: AnonymousRepo requires a pool")
	}
	if tenantID == "" {
		return nil, errors.New("publictrack: tenant id is required")
	}
	normalizeAnonymousEventInput(&in)

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	at := time.Now().UTC()
	if in.OccurredAt != nil {
		at = in.OccurredAt.UTC()
	}
	props := in.Properties
	if props == nil {
		props = map[string]any{}
	}
	propsRaw, err := json.Marshal(props)
	if err != nil {
		return nil, fmt.Errorf("marshal anonymous event properties: %w", err)
	}

	out := AnonymousEvent{
		AnonymousID:   in.AnonymousID,
		EventName:     in.EventName,
		EventType:     in.EventType,
		Properties:    props,
		SourceEventID: in.SourceEventID,
	}

	err = tx.QueryRow(ctx, `
INSERT INTO subscriber_anonymous_events
    (tenant_id, anonymous_id, event_name, event_type, properties, source_event_id, occurred_at)
VALUES ($1::uuid, $2, NULLIF($3, ''), $4, $5::jsonb, NULLIF($6, ''), $7)
ON CONFLICT (tenant_id, anonymous_id, source_event_id) DO NOTHING
RETURNING id, occurred_at`,
		tenantID, in.AnonymousID, in.EventName, in.EventType, string(propsRaw), in.SourceEventID, at).
		Scan(&out.ID, &out.OccurredAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// ON CONFLICT DO NOTHING fired: a prior call already claimed this
		// (tenant_id, anonymous_id, source_event_id) triple. Only reachable
		// when source_event_id is non-empty (NULLs never conflict), so this
		// lookup is exact.
		out.Deduped = true
		if err := tx.QueryRow(ctx, `
SELECT id, event_name, event_type, properties, occurred_at
  FROM subscriber_anonymous_events
 WHERE tenant_id = $1::uuid AND anonymous_id = $2 AND source_event_id = $3
 LIMIT 1`, tenantID, in.AnonymousID, in.SourceEventID).
			Scan(&out.ID, &out.EventName, &out.EventType, &propsRaw, &out.OccurredAt); err != nil {
			return nil, fmt.Errorf("load existing anonymous event: %w", err)
		}
		_ = json.Unmarshal(propsRaw, &out.Properties)
	} else if err != nil {
		return nil, fmt.Errorf("insert subscriber_anonymous_event: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

func normalizeAnonymousEventInput(in *AnonymousEventInput) {
	in.AnonymousID = strings.TrimSpace(in.AnonymousID)
	in.EventName = strings.TrimSpace(in.EventName)
	in.EventType = strings.ToLower(strings.TrimSpace(in.EventType))
	if in.EventType == "" {
		in.EventType = "custom"
	}
	in.SourceEventID = strings.TrimSpace(in.SourceEventID)
}
