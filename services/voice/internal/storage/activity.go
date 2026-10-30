package storage

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/voice/internal/handlers"
)

// ActivityStore is the Postgres-backed handlers.SequenceActivityStore.
//
// Same source of truth as ParticipantStore (sequence_funnel_events +
// the tenant-scoped subscribers mirror) but a flatter projection: one
// raw aggregate row per subscriber, no paging, no status labeling. The
// pure evaluators in handlers (GoalMet / EvaluateStuck) consume these
// rows for both the GET /sequences/{id}/stuck endpoint and the stuck
// scanner worker, keeping the threshold/goal/completion logic in one
// unit-testable place while this stays a plain aggregation.
type ActivityStore struct {
	Pool *pgxpool.Pool
}

// NewActivityStore constructs an ActivityStore.
func NewActivityStore(pool *pgxpool.Pool) *ActivityStore {
	return &ActivityStore{Pool: pool}
}

// ListActivity implements handlers.SequenceActivityStore.
func (s *ActivityStore) ListActivity(ctx context.Context, tenantID, sequenceID string) ([]handlers.ParticipantActivity, error) {
	if tenantID == "" {
		return nil, errors.New("tenant id required")
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return nil, err
	}

	rows, err := tx.Query(ctx, `
		WITH agg AS (
			SELECT subscriber_email,
			       GREATEST(max(sent_at), max(opened_at), max(clicked_at)) AS last_event_at,
			       max(position) + 1                                       AS current_step,
			       bool_or(opened_at  IS NOT NULL)                         AS any_open,
			       bool_or(clicked_at IS NOT NULL)                         AS any_click
			  FROM sequence_funnel_events
			 WHERE tenant_id = $1::uuid AND sequence_id = $2::uuid
			 GROUP BY subscriber_email
		)
		SELECT a.subscriber_email::text,
		       COALESCE(s.id::text, ''),
		       a.current_step,
		       a.last_event_at,
		       a.any_open,
		       a.any_click,
		       (s.id IS NOT NULL AND s.status NOT IN ('disabled','blocklisted')) AS subscriber_active
		  FROM agg a
		  LEFT JOIN subscribers s
		    ON s.tenant_id = $1::uuid AND s.email = a.subscriber_email
		 ORDER BY a.subscriber_email`,
		tenantID, sequenceID)
	if err != nil {
		return nil, fmt.Errorf("storage: list sequence activity: %w", err)
	}
	defer rows.Close()

	out := make([]handlers.ParticipantActivity, 0)
	for rows.Next() {
		var a handlers.ParticipantActivity
		if err := rows.Scan(&a.Email, &a.SubscriberID, &a.CurrentStep,
			&a.LastEventAt, &a.AnyOpen, &a.AnyClick, &a.SubscriberActive); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}
