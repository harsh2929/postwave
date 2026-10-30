package storage

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/voice/internal/handlers"
)

// ParticipantStore is the Postgres-backed handlers.SequenceParticipantStore.
//
// Source of truth: sequence_funnel_events (infra/migrations/0052) — one
// row per (tenant, sequence, subscriber_email, email position) written
// by the automation runtime / sequence dispatcher when an email fires,
// updated with opened_at / clicked_at by the events handler. It is the
// ONLY per-subscriber sequence-progress table the platform stores, so
// the participant view is a derivation, not a literal enrollment read:
//
//   - entered_at    = min(sent_at)             (first email received)
//   - last_event_at = greatest of max(sent_at), max(opened_at),
//     max(clicked_at)  (GREATEST ignores NULLs)
//   - current_step  = max(position) + 1        (positions are 0-indexed
//     in the table; the wire contract is 1-based)
//   - status:
//     "exited"    — the subscriber row is gone, or its lifecycle status
//     is disabled/blocklisted (they can't progress further).
//     Explicit exit-node exits are NOT recorded anywhere,
//     so those participants surface as active until their
//     subscriber record changes. Documented deviation.
//     "completed_goal" — the sequence has an evaluable goal (open /
//     click) and this subscriber's funnel rows show it was met.
//     Outranks "completed". Conversion goals are never evaluable
//     in-repo (no event source), so they never produce this label.
//     "completed" — current_step has reached the sequence's email-step
//     count (they received the final email).
//     "active"    — everything else. The legacy drawer's "stuck" state
//     has no backing data and is not emitted.
//
// The subscribers join targets the tenant-scoped Moosewave mirror (same
// database; RLS applies through the transaction's app.tenant_id GUC).
type ParticipantStore struct {
	Pool *pgxpool.Pool
}

// NewParticipantStore constructs a ParticipantStore.
func NewParticipantStore(pool *pgxpool.Pool) *ParticipantStore {
	return &ParticipantStore{Pool: pool}
}

// participantOrderBy maps the handler's whitelisted sort keys to ORDER
// BY fragments. Email is appended as a tiebreaker at the call site so
// pagination stays stable across requests.
var participantOrderBy = map[string]string{
	"entered_at_desc":    "entered_at DESC",
	"entered_at_asc":     "entered_at ASC",
	"last_event_at_desc": "last_event_at DESC",
	"last_event_at_asc":  "last_event_at ASC",
	"current_step_desc":  "current_step DESC",
	"current_step_asc":   "current_step ASC",
}

// ListParticipants implements handlers.SequenceParticipantStore. See the
// type doc for the derivation rules.
func (s *ParticipantStore) ListParticipants(ctx context.Context, tenantID, sequenceID string, q handlers.SequenceParticipantQuery) ([]handlers.SequenceParticipant, int, error) {
	if tenantID == "" {
		return nil, 0, errors.New("tenant id required")
	}
	orderBy, ok := participantOrderBy[q.Sort]
	if !ok {
		// The handler whitelists sorts; an unknown key here is a
		// programming error, not user input — fail loudly.
		return nil, 0, fmt.Errorf("storage: unknown participant sort %q", q.Sort)
	}
	page := q.Page
	if page < 1 {
		page = 1
	}
	perPage := q.PerPage
	if perPage < 1 {
		perPage = 50
	}

	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return nil, 0, err
	}

	// orderBy comes from the fixed map above — never from user input —
	// so the Sprintf is injection-safe.
	//
	// $7 is the sequence's evaluable goal kind ('open' / 'click'; ''
	// when no goal or a conversion goal — see handlers.goalKindOf).
	// Goal-met participants label as 'completed_goal', which outranks
	// 'completed': meeting the goal is the more specific success and is
	// what exit_on_goal keys off.
	query := fmt.Sprintf(`
		WITH agg AS (
			SELECT subscriber_email,
			       min(sent_at)                                            AS entered_at,
			       GREATEST(max(sent_at), max(opened_at), max(clicked_at)) AS last_event_at,
			       max(position) + 1                                       AS current_step,
			       bool_or(opened_at  IS NOT NULL)                         AS any_open,
			       bool_or(clicked_at IS NOT NULL)                         AS any_click
			  FROM sequence_funnel_events
			 WHERE tenant_id = $1::uuid AND sequence_id = $2::uuid
			 GROUP BY subscriber_email
		), labeled AS (
			SELECT a.subscriber_email::text  AS email,
			       COALESCE(s.id::text, '')  AS subscriber_id,
			       a.current_step,
			       a.entered_at,
			       a.last_event_at,
			       CASE
			           WHEN s.id IS NULL OR s.status IN ('disabled','blocklisted') THEN 'exited'
			           WHEN ($7 = 'open' AND a.any_open) OR ($7 = 'click' AND a.any_click)
			                                                                       THEN 'completed_goal'
			           WHEN $3::int > 0 AND a.current_step >= $3::int             THEN 'completed'
			           ELSE 'active'
			       END AS status
			  FROM agg a
			  LEFT JOIN subscribers s
			    ON s.tenant_id = $1::uuid AND s.email = a.subscriber_email
		)
		SELECT email, subscriber_id, current_step, entered_at, last_event_at, status,
		       count(*) OVER() AS total
		  FROM labeled
		 WHERE ($4 = '' OR status = $4)
		 ORDER BY %s, email ASC
		 LIMIT $5 OFFSET $6`, orderBy)

	rows, err := tx.Query(ctx, query,
		tenantID, sequenceID, q.EmailStepCount, q.Status, perPage, (page-1)*perPage, q.GoalKind)
	if err != nil {
		return nil, 0, fmt.Errorf("storage: list participants: %w", err)
	}
	defer rows.Close()

	out := make([]handlers.SequenceParticipant, 0, perPage)
	total := 0
	for rows.Next() {
		var p handlers.SequenceParticipant
		if err := rows.Scan(&p.Email, &p.SubscriberID, &p.CurrentStep,
			&p.EnteredAt, &p.LastEventAt, &p.Status, &total); err != nil {
			return nil, 0, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, err
	}
	// Pages past the end return zero rows, which leaves the windowed
	// total at 0 — acceptable: the client treats it as an empty page.
	return out, total, nil
}
