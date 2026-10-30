package storage

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/voice/internal/handlers"
)

// EnrollmentStore is the Postgres-backed handlers.SequenceEnrollmentStore.
//
// Source of truth: sequence_enrollments (migration 0399) — one row per
// (tenant, sequence, subscriber). enrolled_at is set on first sight;
// completed_goal_at / completed_goal_kind are filled when an open/click
// goal is observed (by apps/api's listmonk-events writer once sends carry
// sequence attribution) or stamped by the external dispatcher for
// conversion goals. This store is a plain aggregate read over that table.
//
// Tenant scoping mirrors ActivityStore: a short tx with app.tenant_id
// bound via set_config so the table's RLS policies gate the read.
type EnrollmentStore struct {
	Pool *pgxpool.Pool
}

// NewEnrollmentStore constructs an EnrollmentStore.
func NewEnrollmentStore(pool *pgxpool.Pool) *EnrollmentStore {
	return &EnrollmentStore{Pool: pool}
}

// EnrollmentStats implements handlers.SequenceEnrollmentStore: total
// enrolled, total goal-completed, and a per-kind completion breakdown for
// one sequence.
func (s *EnrollmentStore) EnrollmentStats(ctx context.Context, tenantID, sequenceID string) (handlers.SequenceEnrollmentStats, error) {
	out := handlers.SequenceEnrollmentStats{CompletedByKind: map[string]int{}}
	if tenantID == "" {
		return out, errors.New("tenant id required")
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return out, err
	}

	// Totals in one pass.
	if err := tx.QueryRow(ctx, `
SELECT count(*)::int                                              AS enrolled,
       count(*) FILTER (WHERE completed_goal_at IS NOT NULL)::int AS completed
  FROM sequence_enrollments
 WHERE tenant_id = $1::uuid AND sequence_id = $2::uuid`,
		tenantID, sequenceID).Scan(&out.Enrolled, &out.CompletedGoal); err != nil {
		return out, fmt.Errorf("storage: enrollment totals: %w", err)
	}

	// Per-kind breakdown of completions.
	rows, err := tx.Query(ctx, `
SELECT completed_goal_kind, count(*)::int
  FROM sequence_enrollments
 WHERE tenant_id = $1::uuid AND sequence_id = $2::uuid
   AND completed_goal_at IS NOT NULL
   AND completed_goal_kind IS NOT NULL
 GROUP BY completed_goal_kind`, tenantID, sequenceID)
	if err != nil {
		return out, fmt.Errorf("storage: enrollment by-kind: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var kind string
		var n int
		if err := rows.Scan(&kind, &n); err != nil {
			return out, err
		}
		out.CompletedByKind[kind] = n
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	if err := tx.Commit(ctx); err != nil {
		return out, err
	}
	return out, nil
}
