// SPDX-License-Identifier: AGPL-3.0-only
//
// progress.go — GET /api/v1/goals/progress.
//
// Computes, per goal, the live "current" value from the EXISTING
// aggregates (no new denormalised tables):
//
//	subscribers    — COUNT(*) of status='enabled' rows in subscribers.
//	                 Same base relation segments.Repo.Count uses; this
//	                 is the point-in-time audience size, so the period
//	                 window doesn't apply.
//	open_rate      — unique opens ÷ sends over the CURRENT period
//	                 window, ×100. Sourced from campaign_report_events
//	                 (event_type 'opened' / 'sent') — the same ledger
//	                 analytics' tenant-wide dashboard rollups read
//	                 (analytics.go DashboardSummary). Mirrors
//	                 analytics' OpenRate math: unique opens over
//	                 delivered, falling back to sent when no
//	                 'delivered' rows exist (legacy paths only emit
//	                 'sent').
//	revenue_cents  — SUM(amount_cents) from the conversions ledger
//	                 (conversions table, conversions package) with
//	                 occurred_at inside the current period window.
//	list_growth    — COUNT(*) of subscriber rows created inside the
//	                 current period window (created_at), i.e. new
//	                 signups this period.
//
// Pacing: the goal's current period window is the
// [starts_at + n·period, starts_at + (n+1)·period) interval that
// contains now(). pct = current/target. pace compares pct against the
// elapsed fraction of the window with a ±5pp tolerance band:
// ahead ≥ elapsed+0.05, behind < elapsed−0.05, else on_track.
// Point-in-time metrics (subscribers) are paced the same way against
// the absolute target — by end of the window the count should reach
// target, and progress is assumed roughly linear.

package goals

import (
	"context"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// paceTolerance is the ± band (in progress fraction) around the
// elapsed-time expectation inside which a goal counts as on_track.
const paceTolerance = 0.05

// GoalProgress is one element of the /goals/progress response.
type GoalProgress struct {
	Goal        Goal      `json:"goal"`
	Current     float64   `json:"current"`
	Target      float64   `json:"target"`
	Pct         float64   `json:"pct"`
	Pace        string    `json:"pace"` // "ahead" | "on_track" | "behind"
	PeriodStart time.Time `json:"period_start"`
	PeriodEnd   time.Time `json:"period_end"`
	AsOf        time.Time `json:"as_of"`
}

// Progress GET /api/v1/goals/progress.
func (d *Deps) Progress(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	goals, err := d.listGoals(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	now := time.Now().UTC()
	out := make([]GoalProgress, 0, len(goals))
	for _, g := range goals {
		start, end := CurrentPeriodWindow(g.StartsAt, g.Period, now)
		current, err := d.currentValue(r.Context(), t.ID, g.Metric, start, end)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		pct, pace := ComputePace(current, g.Target, start, end, now)
		out = append(out, GoalProgress{
			Goal:        g,
			Current:     current,
			Target:      g.Target,
			Pct:         pct,
			Pace:        pace,
			PeriodStart: start,
			PeriodEnd:   end,
			AsOf:        now,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"progress": out, "as_of": now})
}

// CurrentPeriodWindow returns the [start, end) window of the period
// containing `now`, anchored at startsAt and advancing by calendar
// months (1 for monthly, 3 for quarterly). When now precedes
// startsAt the first window is returned. Exported for tests.
func CurrentPeriodWindow(startsAt time.Time, period string, now time.Time) (time.Time, time.Time) {
	months := 1
	if period == "quarterly" {
		months = 3
	}
	start := startsAt.UTC()
	end := start.AddDate(0, months, 0)
	for !now.Before(end) {
		start = end
		end = start.AddDate(0, months, 0)
	}
	return start, end
}

// ComputePace returns (pct, pace). pct is current/target (clamped at
// 0). pace compares the progress fraction against the elapsed
// fraction of the window with the ±paceTolerance band. Exported for
// tests.
func ComputePace(current, target float64, start, end, now time.Time) (float64, string) {
	pct := 0.0
	if target > 0 {
		pct = current / target
	}
	if pct < 0 {
		pct = 0
	}
	elapsed := 0.0
	if window := end.Sub(start); window > 0 {
		elapsed = float64(now.Sub(start)) / float64(window)
	}
	if elapsed < 0 {
		elapsed = 0
	}
	if elapsed > 1 {
		elapsed = 1
	}
	switch {
	case pct >= elapsed+paceTolerance:
		return pct, "ahead"
	case pct < elapsed-paceTolerance:
		return pct, "behind"
	default:
		return pct, "on_track"
	}
}

// currentValue runs the per-metric source query. All four queries run
// inside one tenant-scoped tx per goal — goal counts are small (≤100)
// and each query is a single indexed aggregate.
func (d *Deps) currentValue(ctx context.Context, tenantID, metric string, start, end time.Time) (float64, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	v, err := currentValueInTx(ctx, tx, tenantID, metric, start, end)
	if err != nil {
		return 0, err
	}
	return v, tx.Commit(ctx)
}

func currentValueInTx(ctx context.Context, tx pgx.Tx, tenantID, metric string, start, end time.Time) (float64, error) {
	switch metric {
	case "subscribers":
		// Source: subscribers table — live enabled-audience size
		// (same relation the segment preview counts run against).
		var n int64
		err := tx.QueryRow(ctx, `
SELECT COUNT(*) FROM subscribers
 WHERE tenant_id = $1::uuid AND status = 'enabled'`, tenantID).Scan(&n)
		return float64(n), err

	case "open_rate":
		// Source: campaign_report_events — unique opens over
		// delivered (fallback: sent) inside the period window.
		// Mirrors analytics.Repo's OpenRate math, which divides
		// unique_opens by delivered and falls back to 'sent' for
		// legacy paths that never emit 'delivered'.
		var opens, delivered, sent int64
		err := tx.QueryRow(ctx, `
SELECT COUNT(DISTINCT subscriber_email) FILTER (WHERE event_type = 'opened'),
       COUNT(*) FILTER (WHERE event_type = 'delivered'),
       COUNT(*) FILTER (WHERE event_type = 'sent')
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
   AND at >= $2::timestamptz AND at < $3::timestamptz
   AND event_type IN ('opened','delivered','sent')`,
			tenantID, start, end).Scan(&opens, &delivered, &sent)
		if err != nil {
			return 0, err
		}
		denom := delivered
		if denom == 0 {
			denom = sent
		}
		if denom == 0 {
			return 0, nil
		}
		return float64(opens) / float64(denom) * 100, nil

	case "revenue_cents":
		// Source: conversions ledger (internal/conversions) —
		// attributed revenue inside the period window.
		//
		// Mixed-currency safety: the conversions package contract is
		// "never sum amount_cents across currencies" (cents are not
		// comparable between USD and EUR). We resolve the window's
		// dominant currency first — the one with the most revenue, ties
		// broken by row count then alphabetically for determinism,
		// mirroring conversions.dominantCurrency — and SUM only that
		// currency's rows. A USD+EUR tenant reports its dominant
		// currency's progress, never a meaningless cross-currency total.
		var cents int64
		err := tx.QueryRow(ctx, `
WITH dominant AS (
  SELECT currency
    FROM conversions
   WHERE tenant_id = $1::uuid
     AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz
     AND amount_cents IS NOT NULL
   GROUP BY currency
   ORDER BY SUM(amount_cents) DESC, COUNT(*) DESC, currency
   LIMIT 1
)
SELECT COALESCE(SUM(c.amount_cents) FILTER (
         WHERE c.currency IS NOT DISTINCT FROM (SELECT currency FROM dominant)
       ), 0)
  FROM conversions c
 WHERE c.tenant_id = $1::uuid
   AND c.occurred_at >= $2::timestamptz AND c.occurred_at < $3::timestamptz
   AND c.amount_cents IS NOT NULL`,
			tenantID, start, end).Scan(&cents)
		return float64(cents), err

	case "list_growth":
		// Source: subscribers.created_at — net new subscriber rows
		// created inside the period window.
		var n int64
		err := tx.QueryRow(ctx, `
SELECT COUNT(*) FROM subscribers
 WHERE tenant_id = $1::uuid
   AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`,
			tenantID, start, end).Scan(&n)
		return float64(n), err
	}
	return 0, ErrInvalidMetric
}
