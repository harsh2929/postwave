// SPDX-License-Identifier: AGPL-3.0-only
//
// engagement_churn_repo.go — the DB side of the commerce-free churn
// signal (see engagement_churn.go for the model).
//
// Reads recency of the last open/click per subscriber from
// campaign_report_events and projects it through the banded
// EngagementChurnRisk model. Used by the retention win-back worker as
// the fallback churn source for tenants that have no commerce data.

package predictive

import (
	"context"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// EngagementChurnRow is one subscriber scored by engagement recency.
type EngagementChurnRow struct {
	Email             string
	DaysSinceActivity int     // -1 when the subscriber has no recorded open/click
	ChurnRisk         float64 // banded EngagementChurnRisk(DaysSinceActivity)
}

// HasCommerceChurn reports whether the tenant has any commerce-derived
// churn scores (profile_predictions rows). The win-back worker calls
// this to decide between the commerce churn source and the engagement
// fallback, so non-commerce tenants still get win-backs.
//
// Runs under db.WithTenant — RLS clamps the count to the caller's
// tenant. A tenant with zero rows (predictive never ran, or ran with no
// commerce signal) returns false, steering the worker to engagement.
func (r *Repo) HasCommerceChurn(ctx context.Context, tenantID string) (bool, error) {
	if r == nil || r.Pool == nil {
		return false, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM profile_predictions WHERE tenant_id = $1::uuid AND churn_risk > 0`,
		tenantID).Scan(&n); err != nil {
		return false, err
	}
	return n > 0, tx.Commit(ctx)
}

// EngagementChurnCrossers returns up to `limit` enabled subscribers
// whose engagement-recency churn risk is at/above `threshold`, ordered
// most-at-risk first.
//
// Recency is the days since each subscriber's most recent 'opened' or
// 'clicked' campaign_report_event. Subscribers with NO recorded
// open/click are included with DaysSinceActivity = -1 (never engaged →
// max risk) — they're prime win-back targets. We require the address to
// resolve to an enabled subscribers row so we never target a disabled /
// deleted contact.
//
// Runs under db.WithTenant: campaign_report_events and subscribers are
// both FORCE-RLS, so binding app.tenant_id is what makes this query
// return rows at all (a bare pool query would silently see zero — the
// dead-worker class this branch fixes). The worker calls this with the
// tenant bound per-iteration.
func (r *Repo) EngagementChurnCrossers(ctx context.Context, tenantID string, threshold float64, limit int) ([]EngagementChurnRow, error) {
	if r == nil || r.Pool == nil {
		return nil, nil
	}
	if limit <= 0 || limit > 5000 {
		limit = 1000
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// last_activity: most recent open/click per enabled subscriber.
	// LEFT JOIN so subscribers with no engagement event still surface
	// (days = NULL → -1 sentinel → max risk band).
	rows, err := tx.Query(ctx, `
WITH last_activity AS (
  SELECT lower(subscriber_email::text) AS email,
         max(at) AS last_at
    FROM campaign_report_events
   WHERE tenant_id = $1::uuid
     AND event_type IN ('opened', 'clicked')
     AND subscriber_email IS NOT NULL
   GROUP BY lower(subscriber_email::text)
)
SELECT lower(s.email::text) AS email,
       CASE
         WHEN la.last_at IS NULL THEN -1
         ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - la.last_at)) / 86400)::int
       END AS days_since
  FROM subscribers s
  LEFT JOIN last_activity la
    ON la.email = lower(s.email::text)
 WHERE s.tenant_id = $1::uuid
   AND s.status = 'enabled'
 -- Most-at-risk first (never-engaged = NULL last_at, then oldest activity)
 -- so the 50k cap captures the highest churn risk on large lists rather
 -- than an arbitrary heap slice.
 ORDER BY la.last_at ASC NULLS FIRST
 LIMIT 50000`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []EngagementChurnRow{}
	for rows.Next() {
		var email string
		var days int
		if err := rows.Scan(&email, &days); err != nil {
			return nil, err
		}
		risk := EngagementChurnRisk(days)
		if risk < threshold {
			continue
		}
		out = append(out, EngagementChurnRow{
			Email:             strings.TrimSpace(strings.ToLower(email)),
			DaysSinceActivity: days,
			ChurnRisk:         risk,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	// Most-at-risk first, then cap. Done in Go because the banded risk
	// is computed in Go (the SQL only returns days); the result set is
	// already bounded by the LIMIT above.
	sortEngagementByRiskDesc(out)
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// sortEngagementByRiskDesc orders most-at-risk first (higher risk, then
// older activity). Insertion sort is fine — call sites are bounded and
// the slice is small relative to the 50k scan cap.
func sortEngagementByRiskDesc(rows []EngagementChurnRow) {
	for i := 1; i < len(rows); i++ {
		j := i
		for j > 0 && engagementLess(rows[j-1], rows[j]) {
			rows[j-1], rows[j] = rows[j], rows[j-1]
			j--
		}
	}
}

// engagementLess reports whether a ranks BELOW b (so the sort pushes b
// ahead). Higher risk ranks first; ties break on older recency (a -1
// "never engaged" sentinel is treated as the oldest).
func engagementLess(a, b EngagementChurnRow) bool {
	if a.ChurnRisk != b.ChurnRisk {
		return a.ChurnRisk < b.ChurnRisk
	}
	return recencyRank(a.DaysSinceActivity) < recencyRank(b.DaysSinceActivity)
}

// recencyRank turns days-since into a "staleness" rank where -1 (never
// engaged) is the stalest. Larger = more stale = ranks first.
func recencyRank(days int) int {
	if days < 0 {
		return 1 << 30
	}
	return days
}

// EngagementChurnAsOf is the testable core of the recency→risk mapping
// for a single subscriber given an explicit clock — used by tests that
// don't have a live DB. Returns the banded risk.
func EngagementChurnAsOf(lastActivity *time.Time, now time.Time) float64 {
	if lastActivity == nil {
		return EngagementChurnRisk(-1)
	}
	days := int(now.Sub(*lastActivity).Hours() / 24)
	if days < 0 {
		days = 0
	}
	return EngagementChurnRisk(days)
}
