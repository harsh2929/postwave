package contact_ratings

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Repo wraps the pgx pool for subscribers.rating updates and
// contact_history_events reads/writes.
type Repo struct {
	Pool *db.Pool
}

// SetRating writes subscribers.rating. A value of 0 clears the rating
// (sets NULL). Returns the new value (nil = cleared).
//
// Side effect: appends a row to contact_history_events with kind
// "rating.changed" so the timeline reflects the manual rating.
func (r *Repo) SetRating(ctx context.Context, tenantID, subscriberID string, rating int) (*RatingResponse, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var stored *int
	if rating == 0 {
		_, err = tx.Exec(ctx, `
UPDATE subscribers SET rating = NULL, updated_at = now()
 WHERE id = $1::uuid`, subscriberID)
	} else {
		v := rating
		_, err = tx.Exec(ctx, `
UPDATE subscribers SET rating = $2::smallint, updated_at = now()
 WHERE id = $1::uuid`, subscriberID, rating)
		stored = &v
	}
	if err != nil {
		return nil, err
	}

	// Audit row.
	payload, _ := json.Marshal(map[string]any{"rating": rating})
	if _, err := tx.Exec(ctx, `
INSERT INTO contact_history_events (tenant_id, subscriber_id, kind, at, payload)
VALUES ($1::uuid, $2::uuid, 'rating.changed', now(), $3::jsonb)`,
		tenantID, subscriberID, string(payload)); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &RatingResponse{SubscriberID: subscriberID, Rating: stored}, nil
}

// ListHistory returns contact-history rows newest-first. A cursor carries both
// the timestamp and UUID tie-breaker; a nil UUID preserves the legacy strict
// timestamp boundary.
func (r *Repo) ListHistory(ctx context.Context, tenantID, subscriberID string, beforeAt *time.Time, beforeID *uuid.UUID, limit int) ([]HistoryEvent, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, subscriber_id::text, kind,
       at,
       CASE
         WHEN kind = 'rating.changed'
              AND jsonb_typeof(payload->'rating') = 'number'
           THEN jsonb_build_object('rating', payload->'rating')
         ELSE '{}'::jsonb
       END AS safe_payload
  FROM contact_history_events
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2::uuid
   AND (
     $3::timestamptz IS NULL
     OR at < $3::timestamptz
     OR ($4::uuid IS NOT NULL AND at = $3::timestamptz AND id < $4::uuid)
   )
 ORDER BY at DESC, id DESC
 LIMIT $5`, tenantID, subscriberID, beforeAt, beforeID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []HistoryEvent{}
	for rows.Next() {
		var e HistoryEvent
		var raw []byte
		var at time.Time
		if err := rows.Scan(&e.ID, &e.TenantID, &e.SubscriberID, &e.Kind,
			&at, &raw); err != nil {
			return nil, err
		}
		e.At = at.UTC().Format(time.RFC3339Nano)
		e.Payload = decodeJSON(raw)
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// AppendEvent inserts a contact_history_events row. Other packages
// (subscribers, campaigns) can call this when they observe a relevant
// signal — kept thin so the surface stays simple.
func (r *Repo) AppendEvent(ctx context.Context, tenantID, subscriberID, kind string, payload map[string]any) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	body, _ := json.Marshal(payload)
	if _, err := tx.Exec(ctx, `
INSERT INTO contact_history_events (tenant_id, subscriber_id, kind, at, payload)
VALUES ($1::uuid, $2::uuid, $3, now(), $4::jsonb)`,
		tenantID, subscriberID, kind, string(body)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func decodeJSON(raw []byte) map[string]any {
	if len(raw) == 0 {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil || out == nil {
		return map[string]any{}
	}
	return out
}

// silence unused pgx import — kept because future ListHistory
// extensions may need pgx-specific error helpers.
var _ = pgx.ErrNoRows
var _ error = errors.New("")
