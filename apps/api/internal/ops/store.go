// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrSnoozeReasonRequired: a snooze with no reason is a mute button, and mute
// buttons are how boards die. The HTTP layer maps this to 422.
var ErrSnoozeReasonRequired = errors.New("ops: snooze requires a non-empty reason")

type Store struct{ pool *pgxpool.Pool }

func NewStore(p *pgxpool.Pool) *Store { return &Store{pool: p} }

// LoadAll returns the last OBSERVED result per check. A check with no row is
// absent from the map; its zero Result then derives to stale, which is
// correct: a check that has never reported is not a check that is fine.
func (s *Store) LoadAll(ctx context.Context) (map[string]Result, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT check_id, status, detail, last_reported_at,
		       last_ok_at, first_red_at, acked_until, coalesce(ack_reason, '')
		  FROM ops_check_results`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]Result{}
	for rows.Next() {
		var r Result
		if err := rows.Scan(&r.CheckID, &r.Status, &r.Detail, &r.LastReportedAt,
			&r.LastOKAt, &r.FirstRedAt, &r.AckedUntil, &r.AckReason); err != nil {
			return nil, err
		}
		out[r.CheckID] = r
	}
	return out, rows.Err()
}

// Upsert records an OBSERVED status and appends a history row on a transition.
//
// It will never write 'stale' or 'due' — those are read-time derivations, and
// the CHECK constraint on ops_check_results.status would reject them anyway.
func (s *Store) Upsert(ctx context.Context, checkID string, prev Result, st Status, detail string, now time.Time) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var lastOK, firstRed *time.Time
	if st == StatusOK {
		lastOK = &now
	} else {
		lastOK = prev.LastOKAt
	}
	switch {
	case st == StatusOK:
		firstRed = nil
	case prev.FirstRedAt != nil:
		firstRed = prev.FirstRedAt // preserve, so the board can say "red 19h"
	default:
		firstRed = &now
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO ops_check_results
		       (check_id, status, detail, last_reported_at, last_ok_at, first_red_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $4)
		ON CONFLICT (check_id) DO UPDATE SET
		    status           = EXCLUDED.status,
		    detail           = EXCLUDED.detail,
		    last_reported_at = EXCLUDED.last_reported_at,
		    last_ok_at       = EXCLUDED.last_ok_at,
		    first_red_at     = EXCLUDED.first_red_at,
		    updated_at       = EXCLUDED.updated_at`,
		checkID, string(st), detail, now, lastOK, firstRed); err != nil {
		return err
	}

	if prev.Status != st {
		from := string(prev.Status)
		if from == "" {
			from = "unknown"
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO ops_check_history (check_id, from_status, to_status, detail, at)
			VALUES ($1, $2, $3, $4, $5)`,
			checkID, from, string(st), detail, now); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

// Beat records a heartbeat: a worker reporting that an iteration of its loop
// completed. It writes status ok and, crucially, last_reported_at -- the field
// Result.Effective reads to derive staleness. A worker that stops beating goes
// stale and then red with nothing else involved.
//
// It goes through Upsert so a heartbeat transition lands in ops_check_history
// exactly like an evaluated result: a worker that stops and restarts leaves a
// trail rather than just a current value.
func (s *Store) Beat(ctx context.Context, checkID string, at time.Time) error {
	prev, err := s.Load(ctx, checkID)
	if err != nil {
		return err
	}
	return s.Upsert(ctx, checkID, prev, StatusOK, "beating", at)
}

// Load returns one check's last observed result. A check with no row yields the
// zero Result, which derives to stale -- correct, since a check that has never
// reported is not a check that is fine.
func (s *Store) Load(ctx context.Context, checkID string) (Result, error) {
	var r Result
	err := s.pool.QueryRow(ctx, `
		SELECT check_id, status, detail, last_reported_at,
		       last_ok_at, first_red_at, acked_until, coalesce(ack_reason, '')
		  FROM ops_check_results WHERE check_id = $1`, checkID).
		Scan(&r.CheckID, &r.Status, &r.Detail, &r.LastReportedAt,
			&r.LastOKAt, &r.FirstRedAt, &r.AckedUntil, &r.AckReason)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{CheckID: checkID}, nil
	}
	return r, err
}

// ErrTickNoteRequired: a tick with no note is a click. The note is the whole
// evidentiary value of a manual chore -- "the access review was done" is worth
// far less than "reviewed 4 operators, removed 1" -- so an empty one is
// refused exactly the way an empty snooze reason is. The HTTP layer maps this
// to 422.
var ErrTickNoteRequired = errors.New("ops: a manual tick requires a note describing what was done")

// Tick records a manual chore as done.
//
// Two writes in one transaction, because they answer different questions and
// losing either makes the other misleading:
//
//   - ops_check_results.last_reported_at re-arms the clock. Effective() reads
//     it against the check's Cadence, so the chore leaves DUE now and returns
//     to DUE when the cadence elapses. It is never "satisfied forever".
//   - ops_manual_log appends who ticked it, when, and what they said. This is
//     the evidence trail an auditor asks for, and it is append-only because
//     "when was this last done" and "has this ever been skipped" are different
//     questions -- only a log answers the second.
//
// This is the first and only write path for ops_manual_log, which has carried
// grants and an index since migration 1700 with no code behind it: the same
// shape as dsar_policies, the dead table this package's registry comment cites
// as the reason the check registry is compiled rather than configured.
func (s *Store) Tick(ctx context.Context, checkID, operatorID, note string, at time.Time) error {
	note = strings.TrimSpace(note)
	if note == "" {
		return ErrTickNoteRequired
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
		INSERT INTO ops_check_results
		       (check_id, status, detail, last_reported_at, last_ok_at, first_red_at, updated_at)
		VALUES ($1, 'ok', $2, $3, $3, NULL, $3)
		ON CONFLICT (check_id) DO UPDATE SET
		    status           = 'ok',
		    detail           = EXCLUDED.detail,
		    last_reported_at = EXCLUDED.last_reported_at,
		    last_ok_at       = EXCLUDED.last_ok_at,
		    first_red_at     = NULL,
		    updated_at       = EXCLUDED.updated_at`,
		checkID, "ticked: "+note, at); err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO ops_manual_log (check_id, operator_id, note, ticked_at)
		VALUES ($1, $2, $3, $4)`, checkID, operatorID, note, at); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

// ManualLogEntry is one recorded tick of a manual chore.
type ManualLogEntry struct {
	CheckID  string    `json:"check_id"`
	Operator string    `json:"operator"`
	Note     string    `json:"note"`
	TickedAt time.Time `json:"ticked_at"`
}

// RecentTicks returns a chore's tick history, newest first. It is what makes
// the log readable rather than merely written: a table nobody reads decays
// into a table nobody writes.
func (s *Store) RecentTicks(ctx context.Context, checkID string, limit int) ([]ManualLogEntry, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		SELECT l.check_id, coalesce(o.email::text, '(deleted operator)'), l.note, l.ticked_at
		  FROM ops_manual_log l
		  LEFT JOIN platform_operators o ON o.id = l.operator_id
		 WHERE l.check_id = $1
		 ORDER BY l.ticked_at DESC, l.id DESC
		 LIMIT $2`, checkID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ManualLogEntry{}
	for rows.Next() {
		var e ManualLogEntry
		if err := rows.Scan(&e.CheckID, &e.Operator, &e.Note, &e.TickedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// Snooze sets acked_until + ack_reason for a check. The reconciler's Upsert
// never touches the ack columns, so a snooze survives subsequent reconciles
// and expires purely by the clock (BuildBoard compares AckedUntil to now).
//
// A check that has never reported has no row to update. We insert a stub
// whose last_reported_at is the epoch: Effective() derives that to stale/due
// exactly as the absent row did, so the stub fabricates NO observation — the
// status column of a stub row is never rendered, only the derived one.
func (s *Store) Snooze(ctx context.Context, checkID string, until time.Time, reason string) error {
	if strings.TrimSpace(reason) == "" {
		return ErrSnoozeReasonRequired
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO ops_check_results
		       (check_id, status, detail, last_reported_at, acked_until, ack_reason, updated_at)
		VALUES ($1, 'red', '', 'epoch'::timestamptz, $2, $3, now())
		ON CONFLICT (check_id) DO UPDATE SET
		    acked_until = EXCLUDED.acked_until,
		    ack_reason  = EXCLUDED.ack_reason,
		    updated_at  = now()`,
		checkID, until, reason)
	return err
}
