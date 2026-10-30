// SPDX-License-Identifier: AGPL-3.0-only
package storage

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/voice/internal/handlers"
)

// PerformanceStore is the Postgres-backed handlers.SequencePerformanceStore.
//
// Source of truth: sequence_funnel_events (migration 0052) — one row per
// (tenant, sequence, subscriber_email, email position), written by the
// sequence dispatcher when an email fires and updated with opened_at /
// clicked_at by the events handler. This aggregates those rows into per-email
// reached/opened/clicked plus a DISTINCT-subscriber sequence rollup (SEQ-009).
type PerformanceStore struct {
	Pool *pgxpool.Pool
}

// NewPerformanceStore constructs a PerformanceStore.
func NewPerformanceStore(pool *pgxpool.Pool) *PerformanceStore {
	return &PerformanceStore{Pool: pool}
}

// Performance implements handlers.SequencePerformanceStore. It runs the
// per-position and sequence-rollup aggregates in one tenant-scoped tx so both
// see the same snapshot. Positions are stored 0-indexed; the wire contract is
// 1-based (mirroring the participants contract).
func (s *PerformanceStore) Performance(ctx context.Context, tenantID, sequenceID string) (handlers.SequencePerformance, error) {
	var out handlers.SequencePerformance
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

	// Sequence-level rollup: DISTINCT subscribers, so a subscriber who opened
	// several emails counts once.
	if err := tx.QueryRow(ctx, `
SELECT count(DISTINCT subscriber_email),
       count(DISTINCT subscriber_email) FILTER (WHERE opened_at  IS NOT NULL),
       count(DISTINCT subscriber_email) FILTER (WHERE clicked_at IS NOT NULL)
  FROM sequence_funnel_events
 WHERE tenant_id = $1::uuid AND sequence_id = $2::uuid`,
		tenantID, sequenceID).Scan(&out.Reached, &out.Opened, &out.Clicked); err != nil {
		return out, err
	}

	// Per-position funnel rows.
	rows, err := tx.Query(ctx, `
SELECT position,
       count(*)                                       AS reached,
       count(*) FILTER (WHERE opened_at  IS NOT NULL) AS opened,
       count(*) FILTER (WHERE clicked_at IS NOT NULL) AS clicked
  FROM sequence_funnel_events
 WHERE tenant_id = $1::uuid AND sequence_id = $2::uuid
 GROUP BY position
 ORDER BY position ASC`, tenantID, sequenceID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	positions := []handlers.SequencePerformancePosition{}
	for rows.Next() {
		var pos, reached, opened, clicked int
		if err := rows.Scan(&pos, &reached, &opened, &clicked); err != nil {
			return out, err
		}
		positions = append(positions, handlers.SequencePerformancePosition{
			Position: pos + 1, // 0-indexed storage -> 1-based wire.
			Reached:  reached,
			Opened:   opened,
			Clicked:  clicked,
		})
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return out, err
	}
	out.Positions = positions
	return out, nil
}
