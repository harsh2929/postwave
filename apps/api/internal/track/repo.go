// SPDX-License-Identifier: AGPL-3.0-only
package track

import (
	"context"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/flowbuilder"
)

// ErrNotFound is returned when a subscriber lookup misses.
var ErrNotFound = errors.New("track: subscriber not found")

// Repo wraps pgx.
type Repo struct {
	Pool *db.Pool
	// FlowRuns, when set, fans every event recorded via Insert out to matching
	// product_event automations (Klaviyo-style metric-triggered flows). The HTTP
	// /track handler does its own fanout, so leave this nil there; set it on the
	// repo the integration ingest sinks use, so commerce/support/loyalty/CRM/etc.
	// events also trigger flows. Optional.
	FlowRuns flowbuilder.RunEnqueuer
}

// Event is one row of product_events.
type Event struct {
	ID           int64                  `json:"id"`
	TenantID     string                 `json:"tenantId"`
	SubscriberID string                 `json:"subscriberId"`
	EventName    string                 `json:"eventName"`
	Properties   map[string]interface{} `json:"properties"`
	OccurredAt   time.Time              `json:"occurredAt"`
	ReceivedAt   time.Time              `json:"receivedAt"`
}

// SubscriberIdentity is the canonical subscriber handle used for product-event
// persistence and automation fan-out.
type SubscriberIdentity struct {
	ID    string
	Email string
}

// ResolveSubscriber finds a subscriber by id or email; returns the id.
func (r *Repo) ResolveSubscriber(ctx context.Context, tenantID, id, email string) (string, error) {
	found, err := r.ResolveSubscriberIdentity(ctx, tenantID, id, email)
	if err != nil {
		return "", err
	}
	return found.ID, nil
}

// ResolveSubscriberIdentity finds a subscriber by id or email and returns both
// the stable id and canonical email. The automation runtime requires an email
// on event fan-out; id-only tracking calls still need to resolve it here.
func (r *Repo) ResolveSubscriberIdentity(ctx context.Context, tenantID, id, email string) (SubscriberIdentity, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return SubscriberIdentity{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var found SubscriberIdentity
	if id != "" {
		row := tx.QueryRow(ctx,
			`SELECT id::text, email::text FROM subscribers WHERE id::text = $1 LIMIT 1`, id)
		if err := row.Scan(&found.ID, &found.Email); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return SubscriberIdentity{}, ErrNotFound
			}
			return SubscriberIdentity{}, err
		}
	} else if email != "" {
		row := tx.QueryRow(ctx,
			`SELECT id::text, email::text FROM subscribers WHERE email = $1::citext LIMIT 1`, email)
		if err := row.Scan(&found.ID, &found.Email); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return SubscriberIdentity{}, ErrNotFound
			}
			return SubscriberIdentity{}, err
		}
	} else {
		return SubscriberIdentity{}, ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return SubscriberIdentity{}, err
	}
	return found, nil
}

// ResolveSubscriberIdentityByPhone finds a subscriber by the canonical E.164
// phone trait written by the identify path.
func (r *Repo) ResolveSubscriberIdentityByPhone(ctx context.Context, tenantID, phone string) (SubscriberIdentity, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return SubscriberIdentity{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var found SubscriberIdentity
	row := tx.QueryRow(ctx, `
SELECT id::text, email::text
  FROM subscribers
 WHERE custom_fields ->> 'phone' = $1
 ORDER BY updated_at DESC
 LIMIT 1`, phone)
	if err := row.Scan(&found.ID, &found.Email); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return SubscriberIdentity{}, ErrNotFound
		}
		return SubscriberIdentity{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SubscriberIdentity{}, err
	}
	return found, nil
}

// Insert writes a new product_events row.
// Insert records one product event.
//
// eventID is an OPTIONAL client-supplied idempotency key. When present, a
// retry of the same event returns the original row instead of creating a
// second one — client SDKs retry on timeout, and a timeout is exactly the case
// where the write may already have succeeded. Without it a double-counted
// `purchase` enrols someone in an abandoned-cart flow twice, because
// `fanoutEvent` fires per row.
func (r *Repo) Insert(ctx context.Context, tenantID, subscriberID, eventName string, propsJSON []byte, occurredAt time.Time, eventID string) (int64, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if occurredAt.IsZero() {
		occurredAt = time.Now().UTC()
	}
	var id int64
	// DO NOTHING plus a follow-up read, NOT DO UPDATE.
	//
	// `DO UPDATE` would need UPDATE on product_events, and `postwave_app` is
	// granted only SELECT and INSERT (migration 0065) — deliberately, because
	// this is an append-only event log. Widening that grant so a dedupe could
	// "touch" a row would let the application mutate historical events, which is
	// a far worse trade than one extra query on the rare retry path.
	//
	// The cost is that a conflict returns no row, so the existing id is read
	// back. That read is inside the same transaction, so it cannot observe a
	// row some other writer is still committing.
	inserted := true
	row := tx.QueryRow(ctx, `
INSERT INTO product_events (tenant_id, subscriber_id, event_name, properties, occurred_at, event_id)
VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, NULLIF($6, ''))
ON CONFLICT DO NOTHING
RETURNING id`, tenantID, subscriberID, eventName, string(propsJSON), occurredAt, eventID)
	if err := row.Scan(&id); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) || strings.TrimSpace(eventID) == "" {
			return 0, err
		}
		// A conflict on the idempotency key: the event is already recorded.
		inserted = false
		if err := tx.QueryRow(ctx, `
SELECT id FROM product_events
 WHERE tenant_id = $1::uuid AND event_id = $2`, tenantID, eventID).Scan(&id); err != nil {
			return 0, err
		}
	}
	// Record the event's SHAPE, in this same transaction.
	//
	// Only on a genuine insert: a retried event is the same event, and counting
	// its properties again would inflate the drift figure with duplicates of one
	// observation. Same transaction so the summary cannot silently diverge from
	// the log it summarises — see RecordPropertyTypes.
	if inserted {
		types, err := PropertyTypes(propsJSON)
		if err != nil {
			return 0, err
		}
		if err := RecordPropertyTypes(ctx, tx, tenantID, eventName, types); err != nil {
			return 0, err
		}
		// And check it against what somebody DECLARED the event should look
		// like. Same transaction as the insert, so a counted violation always
		// corresponds to a stored event.
		if err := CheckDeclared(ctx, tx, tenantID, eventName, types); err != nil {
			return 0, err
		}
		// And make the event reportable. Same tx, so a metric that appears in
		// the registry always has at least one stored event behind it.
		if err := RecordMetricDiscovery(ctx, tx, tenantID, eventName); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	// Fan out only on a genuine insert. Re-firing flow triggers for a retried
	// event is the duplicate-enrolment this key exists to prevent, and it would
	// happen on every retry rather than once.
	if r.FlowRuns != nil && inserted {
		if !startTrackFanout(
			func() { r.fanoutEvent(tenantID, subscriberID, id, eventName, occurredAt) },
			func(recovered any, stack []byte) {
				log.Printf("track: repository fanout panic tenant=%s event=%s recover=%v\n%s", tenantID, eventName, recovered, stack)
			},
		) {
			log.Printf("track: repository fanout saturated tenant=%s event=%s", tenantID, eventName)
		}
	}
	return id, nil
}

// fanoutEvent enrolls the subscriber into every active flow whose product_event
// trigger matches eventName. Panic-safe + best-effort (a recorded event must not
// fail because a flow lookup did); mirrors track.Deps.fanoutFlowRuns minus the
// optional send-time-optimized delay (a refinement the HTTP path adds).
func (r *Repo) fanoutEvent(tenantID, subscriberID string, eventID int64, eventName string, at time.Time) {
	defer func() { _ = recover() }()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	matches, err := r.FlowRuns.MatchFlowsForEvent(ctx, tenantID, eventName)
	if err != nil {
		// Recording the product event is independent of the deliberately
		// unavailable automation runtime. Ignore only its typed containment
		// result; all future errors remain visible to this best-effort seam.
		if errors.Is(err, flowbuilder.ErrFlowRuntimeUnavailable) {
			return
		}
		return
	}
	for _, m := range matches {
		ev := eventID
		_, _ = r.FlowRuns.EnqueueRun(ctx, tenantID, flowbuilder.RunEnqueueRequest{
			FlowID:           m.FlowID,
			SubscriberID:     subscriberID,
			TriggerEventID:   &ev,
			TriggerEventName: eventName,
			ScheduledAt:      at,
		})
	}
}

// ListBySubscriber returns recent product events for a subscriber.
func (r *Repo) ListBySubscriber(ctx context.Context, tenantID, subscriberID string, limit int) ([]Event, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id, tenant_id::text, subscriber_id::text, event_name, properties,
       occurred_at, received_at
FROM product_events
WHERE subscriber_id::text = $1
ORDER BY occurred_at DESC
LIMIT $2`, subscriberID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var ev Event
		var props map[string]interface{}
		if err := rows.Scan(&ev.ID, &ev.TenantID, &ev.SubscriberID, &ev.EventName,
			&props, &ev.OccurredAt, &ev.ReceivedAt); err != nil {
			return nil, err
		}
		ev.Properties = props
		out = append(out, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ListRecent returns recent product events for the tenant, optionally before a
// cursor timestamp. This powers the operator-facing event feed without forcing
// a subscriber lookup first.
func (r *Repo) ListRecent(ctx context.Context, tenantID string, limit int, before *time.Time) ([]Event, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	args := []any{tenantID, limit}
	query := `
SELECT id, tenant_id::text, subscriber_id::text, event_name, properties,
       occurred_at, received_at
FROM product_events
WHERE tenant_id = $1::uuid`
	if before != nil && !before.IsZero() {
		query += ` AND occurred_at < $3`
		args = append(args, before.UTC())
	}
	query += `
ORDER BY occurred_at DESC
LIMIT $2`
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var ev Event
		var props map[string]interface{}
		if err := rows.Scan(&ev.ID, &ev.TenantID, &ev.SubscriberID, &ev.EventName,
			&props, &ev.OccurredAt, &ev.ReceivedAt); err != nil {
			return nil, err
		}
		ev.Properties = props
		out = append(out, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}
