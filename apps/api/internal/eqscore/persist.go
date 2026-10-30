// SPDX-License-Identifier: AGPL-3.0-only
//
// persist.go — durable storage for the EQ-Score history.
//
// The eqscore package is otherwise pure-functional (Score() takes an
// Input and a Reputation impl and returns a Result). This file is the
// only one that touches the database, kept separate so the core
// grading logic stays trivially unit-testable.
//
// The handler calls RecordScore synchronously after Score() — a
// single bounded INSERT under a tenant-scoped transaction. Even at
// 1k rps the cost is negligible compared to the spam-scan that
// happens upstream.
//
// AvgScoreLast30d is the read side. The placement predictor's
// enrichment middleware (predictenrich.Handler) calls it once per
// /api/v1/predict request to populate the AvgEQScoreLast30d field on
// the engagement-risk payload.

package eqscore

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// HistoryRecord is the persisted shape of a grade event. Mirrors the
// columns on eq_score_history. Fields are pointers/strings rather
// than nested types to keep the INSERT one round-trip.
type HistoryRecord struct {
	TenantID     string
	CampaignID   string // optional; empty = NULL
	DraftLabel   string // optional; empty = NULL
	Score        int    // 0..100
	Grade        string // "A+" .. "F"
	ContentScore int    // 0..100; pass -1 to store NULL
	AuthScore    int    // 0..100; pass -1 to store NULL
	ReputationSc int    // 0..100; pass -1 to store NULL (also when sub-score skipped)
	FromAddress  string // optional; empty = NULL
}

// RecordScore writes one row to eq_score_history. The caller has
// already grade the input — this just persists the outcome.
//
// We accept a *db.Pool rather than a transaction because every call
// is its own short transaction; folding it into the caller's tx
// risks holding a tenant-scoped lock for an unbounded length of
// time when the caller is a long-running request.
func RecordScore(ctx context.Context, pool *db.Pool, rec HistoryRecord) error {
	if pool == nil || rec.TenantID == "" {
		return nil
	}
	tx, err := db.WithTenant(ctx, pool, rec.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
INSERT INTO eq_score_history
  (tenant_id, campaign_id, draft_label, score, grade,
   content_score, auth_score, reputation_score, from_address)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)`,
		rec.TenantID,
		nullableUUID(rec.CampaignID),
		nullableText(rec.DraftLabel),
		rec.Score,
		rec.Grade,
		nullableInt(rec.ContentScore),
		nullableInt(rec.AuthScore),
		nullableInt(rec.ReputationSc),
		nullableText(rec.FromAddress),
	)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// AvgScoreLast30d returns the mean score over the last 30 days for a
// tenant, and a "has data" flag. When no rows are present the
// returned avg is 0 and has=false — the placement predictor uses 0
// as the "neutral / no history" sentinel.
//
// We round to int because the consumer (predictor.HistoricalEngagement)
// stores int. 89.4 → 89, 89.6 → 90 (Postgres ROUND() to integer
// implements banker's rounding by default, but the predictor's bands
// are coarse enough — 5-point bins — that ±1 has no behavioural
// effect).
func AvgScoreLast30d(ctx context.Context, pool *db.Pool, tenantID string) (int, bool, error) {
	if pool == nil || tenantID == "" {
		return 0, false, nil
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var avg *float64
	var cnt int64
	row := tx.QueryRow(ctx, `
SELECT AVG(score)::float8, COUNT(*)
  FROM eq_score_history
 WHERE tenant_id = $1::uuid
   AND at >= now() - INTERVAL '30 days'`, tenantID)
	if err := row.Scan(&avg, &cnt); err != nil {
		return 0, false, err
	}
	if cnt == 0 || avg == nil {
		return 0, false, nil
	}
	v := int(*avg + 0.5) // round-half-up for stability across stats engines.
	if v < 0 {
		v = 0
	}
	if v > 100 {
		v = 100
	}
	return v, true, nil
}

// helpers — pgx accepts a typed nil pointer as SQL NULL. A bare
// "" string would round-trip as the empty string, which is wrong
// for uuid/numeric columns.
func nullableText(s string) *string {
	t := strings.TrimSpace(s)
	if t == "" {
		return nil
	}
	return &t
}

func nullableUUID(s string) *string {
	t := strings.TrimSpace(s)
	if t == "" {
		return nil
	}
	return &t
}

func nullableInt(n int) *int {
	if n < 0 {
		return nil
	}
	return &n
}

// keep pgxpool referenced if we later split the file to take a
// pgxpool.Conn directly (currently we only use db.WithTenant).
var _ *pgxpool.Pool = nil
