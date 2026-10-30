// SPDX-License-Identifier: AGPL-3.0-only
//
// SaveHistorySnapshot writes a Score result into list_health_history
// (migration 0251) so the per-list grade can be trended over time.
//
// The table has a daily-unique constraint on (tenant_id, list_id,
// sampled_at::date, window_days) — repeated runs on the same day for
// the same list+window collapse into one row via ON CONFLICT DO UPDATE.
// This keeps the worker idempotent under retries.
//
// Per GAP-LS-119 the writer surface lives here; the daily-tick worker
// that calls it lands in a separate package. The Get handler does NOT
// auto-snapshot — point-in-time reads stay free of write-side state.

package list_health

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// SaveHistorySnapshot upserts one row into list_health_history for the
// given (tenant, list, today, window_days) bucket. listID must be the
// uuid of a native list row (post GAP-LS-044/045).
//
// Opens its own tenant-scoped tx — the worker pattern is "one snapshot,
// one tx" so a single bad list doesn't poison the whole batch.
func SaveHistorySnapshot(ctx context.Context, pool *db.Pool, tenantID, listID string, s Score) error {
	if pool == nil {
		return fmt.Errorf("list_health: nil pool")
	}
	if tenantID == "" {
		return fmt.Errorf("list_health: tenant id required")
	}
	if listID == "" {
		return fmt.Errorf("list_health: list id required")
	}
	if s.Grade == "" {
		return fmt.Errorf("list_health: grade required")
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Rates are stored as numeric(6,4) — clamp to the column's domain so
	// a degenerate compute can never blow the CHECK constraint.
	bounce := clampRate(s.BounceRate)
	complaint := clampRate(s.ComplaintRate)
	unsub := clampRate(s.UnsubscribeRate)
	engage := clampRate(s.EngagementRate)

	const q = `
INSERT INTO list_health_history (
    tenant_id, list_id, window_days, score, grade,
    bounce_rate, complaint_rate, unsubscribe_rate, engagement_rate,
    active_subscribers, total_subscribers, blocklisted_count
) VALUES (
    $1::uuid, $2::uuid, $3, $4, $5,
    $6, $7, $8, $9,
    $10, $11, $12
)
ON CONFLICT (tenant_id, list_id, ((sampled_at)::date), window_days)
DO UPDATE SET
    score              = EXCLUDED.score,
    grade              = EXCLUDED.grade,
    bounce_rate        = EXCLUDED.bounce_rate,
    complaint_rate     = EXCLUDED.complaint_rate,
    unsubscribe_rate   = EXCLUDED.unsubscribe_rate,
    engagement_rate    = EXCLUDED.engagement_rate,
    active_subscribers = EXCLUDED.active_subscribers,
    total_subscribers  = EXCLUDED.total_subscribers,
    blocklisted_count  = EXCLUDED.blocklisted_count,
    sampled_at         = now()
`
	if _, err := tx.Exec(ctx, q,
		tenantID, listID, s.WindowDays, s.Score, s.Grade,
		bounce, complaint, unsub, engage,
		s.ActiveSubscribers, s.TotalSubscribers, s.BlocklistedCount,
	); err != nil {
		return fmt.Errorf("list_health: insert history: %w", err)
	}
	return tx.Commit(ctx)
}

// clampRate keeps a ratio inside [0, 9.9999] so it fits numeric(6,4)
// even if the upstream divisor went pathological.
func clampRate(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 9.9999 {
		return 9.9999
	}
	return v
}
