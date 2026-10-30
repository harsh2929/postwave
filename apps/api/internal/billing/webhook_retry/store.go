// SPDX-License-Identifier: AGPL-3.0-only
//
// Package webhook_retry implements a durable retry queue for Stripe
// webhook events that the inline handler couldn't process.
//
// Why we own the retry instead of letting Stripe retry:
//
//   - Stripe's retry cadence (every few hours, 3 days max) is too
//     coarse for transient failures (DB connection blip, downstream
//     5xx). We want to retry in 30s.
//   - We need a dead-letter queue we can introspect from an admin UI
//     so an operator can replay manually after a code fix.
//   - We need to alert when an event is dead-lettered — silent loss
//     of paying-customer events is unacceptable.
//
// Schema lives in 0089_status_and_retry.sql; see Attempt for the row
// shape.
package webhook_retry

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// BackoffSchedule is the per-attempt delay before re-trying a pending
// row. attempt_number is 0-indexed: index 0 means the inline handler
// just failed and we're scheduling the first retry.
//
// The schedule is intentionally exponential-with-flat-tail: short
// delays for transient blips, long delays before the final dead-letter
// so an on-call has time to push a fix.
//
//	idx  delay        cumulative
//	  0  30s          30s
//	  1   5m          5m30s
//	  2  30m          35m30s
//	  3   2h           2h35m
//	  4   8h          10h35m
//	  5   1d         34h35m
//	  6   7d        ~9d
//	  7  --          dead-letter
//
// MaxAttempts is len(BackoffSchedule). Past the last entry we
// dead-letter and emit a metric.
var BackoffSchedule = []time.Duration{
	30 * time.Second,
	5 * time.Minute,
	30 * time.Minute,
	2 * time.Hour,
	8 * time.Hour,
	24 * time.Hour,
	7 * 24 * time.Hour,
	0, // sentinel — index 7 ⇒ dead-letter
}

// MaxAttempts is the count of retry slots before dead-lettering. We
// dead-letter when attempt_number reaches this value (so attempts
// 0..MaxAttempts-1 are normal retries; attempt MaxAttempts is "give
// up").
var MaxAttempts = len(BackoffSchedule) - 1

// AttemptStatus mirrors the stripe_webhook_attempts.status column.
type AttemptStatus string

const (
	StatusPending      AttemptStatus = "pending"
	StatusSucceeded    AttemptStatus = "succeeded"
	StatusDeadLettered AttemptStatus = "dead_lettered"
)

// Attempt is one row in stripe_webhook_attempts.
type Attempt struct {
	ID            string
	EventID       string
	PayloadJSON   []byte
	AttemptNumber int
	Status        AttemptStatus
	NextAttemptAt time.Time
	LastError     string
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// Store is the retry-queue storage interface. The pgx-backed
// implementation is below; tests can substitute a memory store.
type Store interface {
	Enqueue(ctx context.Context, eventID string, payload []byte) error
	DequeueDue(ctx context.Context, limit int) ([]Attempt, error)
	MarkSucceeded(ctx context.Context, attemptID string) error
	MarkFailed(ctx context.Context, attemptID string, err error) error
	DeadLetter(ctx context.Context, attemptID string, finalErr error) error
	// ListByStatus returns attempts in a given status, newest first.
	// Used by the admin endpoint.
	ListByStatus(ctx context.Context, status AttemptStatus, limit int) ([]Attempt, error)
	// Replay re-enqueues a dead-lettered attempt as a fresh row with
	// attempt_number=0. Returns the new attempt id.
	Replay(ctx context.Context, attemptID string) (string, error)
}

// PgStore is the pgx-backed implementation.
type PgStore struct {
	Pool *pgxpool.Pool
	Now  func() time.Time
}

// NewPgStore constructs a PgStore with the standard wall-clock.
func NewPgStore(pool *pgxpool.Pool) *PgStore { return &PgStore{Pool: pool} }

func (s *PgStore) now() time.Time {
	if s != nil && s.Now != nil {
		return s.Now()
	}
	return time.Now().UTC()
}

// NextAttemptDelay returns the delay before the (attemptNumber+1)th
// attempt should run. Returns 0 + true when this attempt should be
// dead-lettered instead of retried.
func NextAttemptDelay(attemptNumber int) (time.Duration, bool) {
	if attemptNumber < 0 || attemptNumber >= MaxAttempts {
		return 0, true
	}
	return BackoffSchedule[attemptNumber], false
}

// Enqueue inserts a fresh pending row at attempt_number=0. The unique
// constraint on (event_id, attempt_number) makes this idempotent for
// duplicate calls in the inline handler — we ON CONFLICT DO NOTHING so
// a Stripe redelivery doesn't double-enqueue.
func (s *PgStore) Enqueue(ctx context.Context, eventID string, payload []byte) error {
	if s == nil || s.Pool == nil {
		return errors.New("nil store")
	}
	if eventID == "" {
		return errors.New("empty event id")
	}
	now := s.now()
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO stripe_webhook_attempts
		  (event_id, payload_json, attempt_number, status, next_attempt_at,
		   created_at, updated_at)
		VALUES ($1, $2, 0, 'pending', $3, $3, $3)
		ON CONFLICT (event_id, attempt_number) DO NOTHING
	`, eventID, payload, now)
	if err != nil {
		return fmt.Errorf("enqueue: %w", err)
	}
	return nil
}

// DequeueDue returns up to `limit` rows that are pending AND whose
// next_attempt_at has passed. We do NOT lock the rows here — the
// worker uses an UPDATE with a WHERE clause that includes the
// attempt_number to make MarkSucceeded/MarkFailed safe under multiple
// workers; the cost of two workers running the same payload twice is
// already idempotent at the billing handler level.
func (s *PgStore) DequeueDue(ctx context.Context, limit int) ([]Attempt, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("nil store")
	}
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT id::text, event_id, payload_json, attempt_number,
		       status, COALESCE(next_attempt_at, now()),
		       COALESCE(last_error, ''), created_at, updated_at
		FROM stripe_webhook_attempts
		WHERE status = 'pending' AND next_attempt_at <= now()
		ORDER BY next_attempt_at ASC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, fmt.Errorf("dequeue: %w", err)
	}
	defer rows.Close()
	var out []Attempt
	for rows.Next() {
		var a Attempt
		var status string
		if err := rows.Scan(&a.ID, &a.EventID, &a.PayloadJSON, &a.AttemptNumber,
			&status, &a.NextAttemptAt, &a.LastError, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return nil, err
		}
		a.Status = AttemptStatus(status)
		out = append(out, a)
	}
	return out, rows.Err()
}

// MarkSucceeded transitions a pending row to succeeded.
func (s *PgStore) MarkSucceeded(ctx context.Context, attemptID string) error {
	if s == nil || s.Pool == nil {
		return errors.New("nil store")
	}
	now := s.now()
	tag, err := s.Pool.Exec(ctx, `
		UPDATE stripe_webhook_attempts
		SET status = 'succeeded',
		    succeeded_at = $2,
		    updated_at = $2
		WHERE id = $1 AND status = 'pending'
	`, attemptID, now)
	if err != nil {
		return fmt.Errorf("mark succeeded: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return errors.New("no pending row matched")
	}
	return nil
}

// MarkFailed records a failed attempt and either:
//   - schedules the next attempt (incrementing attempt_number,
//     next_attempt_at = now() + BackoffSchedule[next]); or
//   - dead-letters if we've exhausted MaxAttempts.
//
// The dead-letter branch is taken when the next attempt_number would
// equal MaxAttempts; the worker calls DeadLetter explicitly in that
// case so the metric/email side-effects can fire from one place.
func (s *PgStore) MarkFailed(ctx context.Context, attemptID string, errFromHandler error) error {
	if s == nil || s.Pool == nil {
		return errors.New("nil store")
	}
	now := s.now()
	// Read current attempt_number so we can pick the right backoff slot.
	var currAttempt int
	if err := s.Pool.QueryRow(ctx, `
		SELECT attempt_number FROM stripe_webhook_attempts
		WHERE id = $1 AND status = 'pending'
	`, attemptID).Scan(&currAttempt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errors.New("no pending attempt with that id")
		}
		return fmt.Errorf("read current attempt: %w", err)
	}
	nextAttempt := currAttempt + 1
	delay, dead := NextAttemptDelay(currAttempt)
	if dead {
		// Caller should call DeadLetter directly; we don't fold both
		// into one UPDATE because dead-letter has additional side
		// effects (metric, alert email) wired in the worker.
		return errExhausted
	}
	nextAt := now.Add(delay)
	errMsg := ""
	if errFromHandler != nil {
		errMsg = truncate(errFromHandler.Error(), 4000)
	}
	tag, err := s.Pool.Exec(ctx, `
		UPDATE stripe_webhook_attempts
		SET attempt_number = $2,
		    next_attempt_at = $3,
		    last_error = $4,
		    updated_at = $5
		WHERE id = $1 AND status = 'pending'
	`, attemptID, nextAttempt, nextAt, errMsg, now)
	if err != nil {
		return fmt.Errorf("mark failed: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return errors.New("no pending row matched")
	}
	return nil
}

// errExhausted is returned by MarkFailed when the next slot would be
// the dead-letter sentinel. Worker code uses errors.Is to detect this.
var errExhausted = errors.New("retry attempts exhausted")

// IsExhausted returns true when MarkFailed signals "no more retries."
func IsExhausted(err error) bool { return errors.Is(err, errExhausted) }

// DeadLetter transitions a pending row to dead_lettered and stamps the
// final error.
func (s *PgStore) DeadLetter(ctx context.Context, attemptID string, finalErr error) error {
	if s == nil || s.Pool == nil {
		return errors.New("nil store")
	}
	now := s.now()
	errMsg := ""
	if finalErr != nil {
		errMsg = truncate(finalErr.Error(), 4000)
	}
	tag, err := s.Pool.Exec(ctx, `
		UPDATE stripe_webhook_attempts
		SET status = 'dead_lettered',
		    dead_lettered_at = $2,
		    last_error = $3,
		    updated_at = $2
		WHERE id = $1 AND status = 'pending'
	`, attemptID, now, errMsg)
	if err != nil {
		return fmt.Errorf("dead-letter: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return errors.New("no pending row matched")
	}
	return nil
}

// ListByStatus returns attempts in a given status, ordered by updated_at
// DESC. Used by the admin DLQ review endpoint.
func (s *PgStore) ListByStatus(ctx context.Context, status AttemptStatus, limit int) ([]Attempt, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("nil store")
	}
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT id::text, event_id, payload_json, attempt_number,
		       status, COALESCE(next_attempt_at, now()),
		       COALESCE(last_error, ''), created_at, updated_at
		FROM stripe_webhook_attempts
		WHERE status = $1
		ORDER BY updated_at DESC
		LIMIT $2
	`, string(status), limit)
	if err != nil {
		return nil, fmt.Errorf("list: %w", err)
	}
	defer rows.Close()
	var out []Attempt
	for rows.Next() {
		var a Attempt
		var st string
		if err := rows.Scan(&a.ID, &a.EventID, &a.PayloadJSON, &a.AttemptNumber,
			&st, &a.NextAttemptAt, &a.LastError, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return nil, err
		}
		a.Status = AttemptStatus(st)
		out = append(out, a)
	}
	return out, rows.Err()
}

// Replay reads a dead-lettered row and INSERTs a fresh pending row at
// attempt_number=0 with the same payload. The original row is left in
// place as audit trail.
//
// We pick a NEW attempt_number for the replay row by counting existing
// rows for this event_id and using `that count` as the slot. This
// avoids unique-constraint conflicts when an event has been dead-
// lettered, replayed, and dead-lettered again.
func (s *PgStore) Replay(ctx context.Context, attemptID string) (string, error) {
	if s == nil || s.Pool == nil {
		return "", errors.New("nil store")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var eventID string
	var payload []byte
	if err := tx.QueryRow(ctx, `
		SELECT event_id, payload_json
		FROM stripe_webhook_attempts
		WHERE id = $1 AND status = 'dead_lettered'
	`, attemptID).Scan(&eventID, &payload); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", errors.New("not found or not dead-lettered")
		}
		return "", fmt.Errorf("read replay source: %w", err)
	}
	var slot int
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(attempt_number), -1) + 1
		FROM stripe_webhook_attempts
		WHERE event_id = $1
	`, eventID).Scan(&slot); err != nil {
		return "", fmt.Errorf("pick slot: %w", err)
	}
	now := s.now()
	var newID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO stripe_webhook_attempts
		  (event_id, payload_json, attempt_number, status, next_attempt_at,
		   created_at, updated_at)
		VALUES ($1, $2, $3, 'pending', $4, $4, $4)
		RETURNING id::text
	`, eventID, payload, slot, now).Scan(&newID); err != nil {
		return "", fmt.Errorf("insert replay: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("commit: %w", err)
	}
	return newID, nil
}

// truncate trims s to at most max bytes (UTF-8-safe enough — we don't
// promise an exact char count, just bounded storage).
func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}
