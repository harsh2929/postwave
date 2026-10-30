// SPDX-License-Identifier: AGPL-3.0-only

// Push state persistence. Three jobs:
//
//   - carry the damping state machine across process restarts, so a deploy
//     mid-incident neither re-alerts nor swallows the alert;
//   - heartbeat the reserved '__push_loop__' row every tick, so the push
//     canary can tell a quiet pipeline from a dead one;
//   - arbitrate replicas with a Postgres advisory lock, so two API instances
//     never run the same damping pass concurrently.

package ops

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// pushLoopCheckID is the reserved heartbeat row in ops_push_state. It is not
// a check: LoadAll must never hand it to the state machine.
const pushLoopCheckID = "__push_loop__"

// PushState is one check's position in the damping state machine.
//
// LastNotifiedClass is what the operator last heard ("ok" or "red"); the
// zero value "" behaves as "ok" — silence means nothing was ever wrong.
// CandidateClass/CandidateStreak track a pending transition that has not yet
// survived the damping window.
type PushState struct {
	CheckID              string
	LastNotifiedClass    string
	CandidateClass       string
	CandidateStreak      int
	LastAlertAt          *time.Time
	LastCriticalRepushAt *time.Time
	UpdatedAt            time.Time
}

type PushStateStore struct{ pool *pgxpool.Pool }

func NewPushStateStore(p *pgxpool.Pool) *PushStateStore { return &PushStateStore{pool: p} }

// LoadAll returns the persisted state per check, skipping the reserved
// '__push_loop__' heartbeat row — that row is plumbing, not a check.
func (s *PushStateStore) LoadAll(ctx context.Context) (map[string]PushState, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT check_id, last_notified_class, candidate_class, candidate_streak,
		       last_alert_at, last_critical_repush_at, updated_at
		  FROM ops_push_state
		 WHERE check_id <> $1`, pushLoopCheckID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]PushState{}
	for rows.Next() {
		var st PushState
		if err := rows.Scan(&st.CheckID, &st.LastNotifiedClass, &st.CandidateClass,
			&st.CandidateStreak, &st.LastAlertAt, &st.LastCriticalRepushAt,
			&st.UpdatedAt); err != nil {
			return nil, err
		}
		out[st.CheckID] = st
	}
	return out, rows.Err()
}

func (s *PushStateStore) Upsert(ctx context.Context, st PushState) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO ops_push_state
		       (check_id, last_notified_class, candidate_class, candidate_streak,
		        last_alert_at, last_critical_repush_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (check_id) DO UPDATE SET
		    last_notified_class     = EXCLUDED.last_notified_class,
		    candidate_class         = EXCLUDED.candidate_class,
		    candidate_streak        = EXCLUDED.candidate_streak,
		    last_alert_at           = EXCLUDED.last_alert_at,
		    last_critical_repush_at = EXCLUDED.last_critical_repush_at,
		    updated_at              = EXCLUDED.updated_at`,
		st.CheckID, st.LastNotifiedClass, st.CandidateClass, st.CandidateStreak,
		st.LastAlertAt, st.LastCriticalRepushAt, st.UpdatedAt)
	return err
}

// HeartbeatLoop stamps the reserved '__push_loop__' row with now. The
// push-canary check reads this timestamp: a push loop that stops ticking
// must show up as a stale heartbeat, not as a suspiciously quiet channel.
func (s *PushStateStore) HeartbeatLoop(ctx context.Context, now time.Time) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO ops_push_state (check_id, updated_at)
		VALUES ($1, $2)
		ON CONFLICT (check_id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
		pushLoopCheckID, now)
	return err
}

// LoopHeartbeatAge reports how long ago the '__push_loop__' row was last
// stamped by HeartbeatLoop. present is false when the row does not exist yet
// (a pusher that has never ticked) — the push-canary check treats "absent"
// the same as "too old": a loop that has never reported is not a loop that
// is fine.
func (s *PushStateStore) LoopHeartbeatAge(ctx context.Context) (age time.Duration, present bool, err error) {
	var updatedAt time.Time
	err = s.pool.QueryRow(ctx,
		`SELECT updated_at FROM ops_push_state WHERE check_id = $1`, pushLoopCheckID).
		Scan(&updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return time.Since(updatedAt), true, nil
}

// TryTickLock takes the cluster-wide push-tick advisory lock. Session-level
// advisory locks belong to a CONNECTION, so the lock and its unlock must run
// on the same dedicated conn — which is why this acquires one from the pool
// and holds it until release is called. The returned release is always safe
// to call, exactly once effective, and never nil.
func (s *PushStateStore) TryTickLock(ctx context.Context) (bool, func(), error) {
	noop := func() {}

	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return false, noop, err
	}

	var got bool
	if err := conn.QueryRow(ctx,
		`SELECT pg_try_advisory_lock(hashtext('ops_push_tick'))`).Scan(&got); err != nil {
		conn.Release()
		return false, noop, err
	}
	if !got {
		conn.Release()
		return false, noop, nil
	}

	var once sync.Once
	release := func() {
		once.Do(func() {
			// Background context: the tick's ctx may already be canceled,
			// and an unreleased advisory lock would wedge every replica
			// until this conn dies.
			_, _ = conn.Exec(context.Background(),
				`SELECT pg_advisory_unlock(hashtext('ops_push_tick'))`)
			conn.Release()
		})
	}
	return true, release, nil
}
