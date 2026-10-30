// SPDX-License-Identifier: AGPL-3.0-only
//
// INBOX-031 — persist tenant reputation over time so the dashboard can show a
// trend. One row is recorded per reputation fetch (capture-on-fetch); the
// series accrues as the dashboard is used. All statements set app.tenant_id so
// RLS scopes the table (migration 1836).
package reputation

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// senderScoreSourceName is the aggregator source name (senderscore.Client.Name)
// whose success means the SenderScore field is a real measurement rather than
// the zero default.
const senderScoreSourceName = "senderscore"

// SnapshotStore is the Postgres-backed writer/reader for reputation history.
type SnapshotStore struct {
	Pool *pgxpool.Pool
}

// NewSnapshotStore constructs a SnapshotStore, failing loudly on a nil pool.
func NewSnapshotStore(p *pgxpool.Pool) (*SnapshotStore, error) {
	if p == nil {
		return nil, errors.New("reputation snapshot store: nil pgx pool")
	}
	return &SnapshotStore{Pool: p}, nil
}

// ReputationSnapshot is one point on the reputation trend.
type ReputationSnapshot struct {
	SenderScore       int       `json:"sender_score"`
	GoogleScore       string    `json:"google_score"`
	MicrosoftScore    string    `json:"microsoft_score"`
	BlacklistHitCount int       `json:"blacklist_hit_count"`
	DataAvailable     bool      `json:"data_available"`
	CheckedAt         time.Time `json:"checked_at"`
}

func (s *SnapshotStore) beginTenant(ctx context.Context, tenantID string) (pgx.Tx, error) {
	if tenantID == "" {
		return nil, errors.New("reputation snapshot store: tenant id required")
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// Record persists one reputation reading. Best-effort — the caller must not
// fail the reputation response if this errors.
func (s *SnapshotStore) Record(ctx context.Context, tenantID string, rep domain.Reputation) error {
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// -1 sentinel keys off whether the SenderScore SOURCE actually measured
	// this fetch, not the aggregate DataAvailable flag: an always-registered
	// source (e.g. blacklist) can set DataAvailable=true while SenderScore was
	// never measured and stays at its zero default. Persisting that 0 would
	// chart as a genuine SenderScore of 0. Only store the value when the
	// senderscore source succeeded.
	senderScore := rep.SenderScore
	if !slices.Contains(rep.SourcesSucceeded, senderScoreSourceName) {
		senderScore = -1
	}
	checkedAt := rep.CheckedAt
	if checkedAt.IsZero() {
		checkedAt = time.Now().UTC()
	}
	// ON CONFLICT collapses repeat dashboard views inside the aggregator's 24h
	// cache window (which re-present the same frozen checked_at) into a single
	// row, so the table stays bounded by real measurements (migration 1836).
	if _, err := tx.Exec(ctx, `
INSERT INTO reputation_snapshots
    (tenant_id, domain, ip, sender_score, google_score, microsoft_score,
     blacklist_hit_count, data_available, checked_at)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (tenant_id, checked_at) DO NOTHING`,
		tenantID, rep.Domain, rep.IP, senderScore, string(rep.GoogleScore),
		string(rep.MicrosoftScore), len(rep.BlacklistHits), rep.DataAvailable, checkedAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// History returns snapshots at or after `since`, oldest-first (so a client
// draws a left-to-right trend), capped at limit.
func (s *SnapshotStore) History(ctx context.Context, tenantID string, since time.Time, limit int) ([]ReputationSnapshot, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Select the most-recent N in the window (ORDER BY DESC LIMIT), then
	// re-order ascending so the client draws left-to-right. A plain
	// `ORDER BY ASC LIMIT` would return the OLDEST N and silently drop the
	// newest points once the window holds more rows than the limit — the
	// trend would freeze on ancient data.
	rows, err := tx.Query(ctx, `
SELECT sender_score, google_score, microsoft_score, blacklist_hit_count,
       data_available, checked_at
  FROM (
    SELECT sender_score, google_score, microsoft_score, blacklist_hit_count,
           data_available, checked_at
      FROM reputation_snapshots
     WHERE tenant_id = $1::uuid AND checked_at >= $2
     ORDER BY checked_at DESC
     LIMIT $3
  ) recent
 ORDER BY checked_at ASC`, tenantID, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReputationSnapshot{}
	for rows.Next() {
		var snap ReputationSnapshot
		if err := rows.Scan(&snap.SenderScore, &snap.GoogleScore, &snap.MicrosoftScore,
			&snap.BlacklistHitCount, &snap.DataAvailable, &snap.CheckedAt); err != nil {
			return nil, err
		}
		out = append(out, snap)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}
