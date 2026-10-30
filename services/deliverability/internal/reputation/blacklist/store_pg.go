// SPDX-License-Identifier: AGPL-3.0-only
//
// store_pg.go — Postgres-backed ObservationStore for the blocklist
// monitor. Writes one row to blocklist_observations per check (see
// migration 0112) and answers LatestObservedAt for the monitor's
// skip-if-recent gate.
//
// Why this lives in the blacklist package: the schema is purpose-built
// for the monitor's wire types (Observation), and the store is the
// only consumer of those types' DB representation. Splitting it out
// would force every test that uses an in-memory monitor to import a
// sibling package just for the interface.

package blacklist

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresStore implements ObservationStore against the
// blocklist_observations table.
type PostgresStore struct {
	Pool *pgxpool.Pool
}

// NewPostgresStore wraps a pgx pool. The blocklist monitor runs without
// a tenant context (it sweeps across all tenants' subjects), so the
// store does NOT call db.WithTenant. Tenant scoping is enforced at
// READ time via the API endpoints + RLS on `app.tenant_id`.
func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore {
	if pool == nil {
		return nil
	}
	return &PostgresStore{Pool: pool}
}

// Insert writes one observation. tenant_id is nullable for operator-
// owned (free pool) subjects; we pass NULL when Observation.TenantID
// is empty.
func (s *PostgresStore) Insert(ctx context.Context, o Observation) error {
	if s == nil || s.Pool == nil {
		return errors.New("blacklist postgres store: nil pool")
	}
	if o.SubjectType == "" || o.Subject == "" || o.Zone == "" {
		return errors.New("blacklist insert: subject_type, subject, and zone are required")
	}
	if o.CheckedAt.IsZero() {
		o.CheckedAt = time.Now().UTC()
	}
	tx, err := withWorkerScope(ctx, s.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var tenantArg any
	if strings.TrimSpace(o.TenantID) != "" {
		tenantArg = o.TenantID
	}
	var errArg any
	if o.Error != "" {
		errArg = o.Error
	}

	_, err = tx.Exec(ctx, `
INSERT INTO blocklist_observations
    (subject_type, subject, zone, listed, confidence, error, tenant_id, checked_at)
VALUES ($1, $2, $3, $4, $5, $6, $7::uuid, $8)`,
		o.SubjectType, o.Subject, o.Zone, o.Listed, o.Confidence,
		errArg, tenantArg, o.CheckedAt,
	)
	if err != nil {
		return fmt.Errorf("insert observation: %w", err)
	}
	return tx.Commit(ctx)
}

// LatestObservedAt returns the most recent CheckedAt for the
// (subjectType, subject, zone) tuple, or zero time when no row exists.
// Backs the monitor's skip-if-recent gate.
func (s *PostgresStore) LatestObservedAt(ctx context.Context, subjectType, subject, zone string) (time.Time, error) {
	if s == nil || s.Pool == nil {
		return time.Time{}, errors.New("blacklist postgres store: nil pool")
	}
	tx, err := withWorkerScope(ctx, s.Pool)
	if err != nil {
		return time.Time{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var ts time.Time
	row := tx.QueryRow(ctx, `
SELECT checked_at FROM blocklist_observations
 WHERE subject_type = $1 AND subject = $2 AND zone = $3
 ORDER BY checked_at DESC
 LIMIT 1`, subjectType, subject, zone)
	if err := row.Scan(&ts); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return time.Time{}, nil
		}
		return time.Time{}, err
	}
	return ts, nil
}

// LatestPerZone returns the most recent observation per zone for one
// subject. Used by the dashboard + ShouldAutoSuppress() check. The
// caller filters by recency on the application side (zones not
// observed in the last 24h are conservatively dropped).
func (s *PostgresStore) LatestPerZone(ctx context.Context, subjectType, subject string) ([]Observation, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("blacklist postgres store: nil pool")
	}
	tx, err := withWorkerScope(ctx, s.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT DISTINCT ON (zone)
       subject_type, subject, zone, listed, confidence,
       COALESCE(error,'') AS error, COALESCE(tenant_id::text,'') AS tenant_id, checked_at
  FROM blocklist_observations
 WHERE subject_type = $1 AND subject = $2
 ORDER BY zone, checked_at DESC`, subjectType, subject)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Observation{}
	for rows.Next() {
		var o Observation
		if err := rows.Scan(
			&o.SubjectType, &o.Subject, &o.Zone, &o.Listed, &o.Confidence,
			&o.Error, &o.TenantID, &o.CheckedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// RecentObservations returns every observation for a subject in the
// last `window`. Used by the dashboard "history" view + zone health
// computation.
func (s *PostgresStore) RecentObservations(ctx context.Context, subjectType, subject string, window time.Duration, limit int) ([]Observation, error) {
	if s == nil || s.Pool == nil {
		return nil, errors.New("blacklist postgres store: nil pool")
	}
	if limit <= 0 || limit > 5000 {
		limit = 500
	}
	since := time.Now().UTC().Add(-window)
	tx, err := withWorkerScope(ctx, s.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT subject_type, subject, zone, listed, confidence,
       COALESCE(error,'') AS error, COALESCE(tenant_id::text,'') AS tenant_id, checked_at
  FROM blocklist_observations
 WHERE subject_type = $1 AND subject = $2 AND checked_at >= $3
 ORDER BY checked_at DESC
 LIMIT $4`, subjectType, subject, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Observation{}
	for rows.Next() {
		var o Observation
		if err := rows.Scan(
			&o.SubjectType, &o.Subject, &o.Zone, &o.Listed, &o.Confidence,
			&o.Error, &o.TenantID, &o.CheckedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}
