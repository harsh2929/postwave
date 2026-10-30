// SPDX-License-Identifier: AGPL-3.0-only
//
// leaderboard.go — GET /api/v1/referrals/leaderboard
// (feat/full-surface-wiring task 5).
//
//	GET /api/v1/referrals/leaderboard?window=90d&limit=20
//	→ {
//	    "window_days": 90,
//	    "items": [
//	      {"referrer_email_masked": "a***@example.com",
//	       "conversions": 12, "milestone": 10, "rank": 1},
//	      ...
//	    ]
//	  }
//
// Conversions are counted inside the rolling window with the same
// fraud + credit-status filters the stats funnel applies; the
// milestone column is recalculated from the current stored program and the
// referrer's ALL-TIME credited count. It is a directional historical view,
// not an immutable reward grant. Emails are masked
// (a***@domain) because the leaderboard is an operator overview, not
// a PII drill-down — the unmasked drill-down stays on
// /subscribers/{id}/referral.

package referrals

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// LeaderboardItem is one ranked row.
type LeaderboardItem struct {
	ReferrerEmailMasked string `json:"referrer_email_masked"`
	Conversions         int    `json:"conversions"`
	// Milestone is the highest unlocked program milestone count
	// (0 = none unlocked or no program configured).
	Milestone int `json:"milestone"`
	Rank      int `json:"rank"`
}

// LeaderboardResponse is the wire shape.
type LeaderboardResponse struct {
	WindowDays int               `json:"window_days"`
	Items      []LeaderboardItem `json:"items"`
}

// maskEmail masks a referrer address as "a***@domain". Inputs that
// don't look like an email collapse to "***" so a malformed stored
// value can never leak through unmasked. Pure — unit-tested directly.
func maskEmail(email string) string {
	email = strings.TrimSpace(email)
	at := strings.LastIndex(email, "@")
	if at <= 0 || at == len(email)-1 {
		return "***"
	}
	return email[:1] + "***@" + email[at+1:]
}

// parseLeaderboardWindowDays accepts "90", "90d", "12w"; defaults to
// 90 and clamps to [1, 365].
func parseLeaderboardWindowDays(s string) int {
	s = strings.TrimSpace(strings.ToLower(s))
	if s == "" {
		return 90
	}
	mult := 1
	switch {
	case strings.HasSuffix(s, "d"):
		s = strings.TrimSuffix(s, "d")
	case strings.HasSuffix(s, "w"):
		mult = 7
		s = strings.TrimSuffix(s, "w")
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return 90
	}
	n *= mult
	if n > 365 {
		return 365
	}
	return n
}

// highestUnlockedMilestone returns the largest milestone count <=
// totalConversions (0 when none). Pure — unit-tested directly.
func highestUnlockedMilestone(milestones []Milestone, totalConversions int) int {
	best := 0
	for _, m := range milestones {
		if m.Count <= totalConversions && m.Count > best {
			best = m.Count
		}
	}
	return best
}

// Leaderboard GET /api/v1/referrals/leaderboard?window=90d&limit=20.
func (d *Deps) Leaderboard(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "repo_unavailable", "repository unavailable")
		return
	}
	windowDays := parseLeaderboardWindowDays(r.URL.Query().Get("window"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	rows, err := d.Repo.leaderboardRows(r.Context(), t.ID, windowDays, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// Milestone tiers come from the active program; absence of a
	// program (ErrNotFound) just zeroes the milestone column.
	var milestones []Milestone
	if prog, perr := d.Repo.GetActiveProgram(r.Context(), t.ID); perr == nil && prog != nil {
		milestones = prog.Milestones
	}
	items := make([]LeaderboardItem, 0, len(rows))
	for i, row := range rows {
		items = append(items, LeaderboardItem{
			ReferrerEmailMasked: maskEmail(row.email),
			Conversions:         row.windowCount,
			Milestone:           highestUnlockedMilestone(milestones, row.totalCount),
			Rank:                i + 1,
		})
	}
	writeJSON(w, http.StatusOK, LeaderboardResponse{
		WindowDays: windowDays,
		Items:      items,
	})
}

type leaderboardRow struct {
	email       string
	windowCount int
	totalCount  int
	lastAt      time.Time
}

// leaderboardRows aggregates credited, non-fraud conversions per
// referrer: windowed count (ranking) + all-time count (milestone
// tier) in one grouped pass, joined to subscribers for the email.
// Referrers whose subscriber row was deleted still rank — their email
// masks to "***".
func (r *Repo) leaderboardRows(ctx context.Context, tenantID string, windowDays, limit int) ([]leaderboardRow, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT COALESCE(s.email::text, ''),
       COUNT(*) FILTER (WHERE c.created_at >= now() - ($2::int * interval '1 day'))::int AS n_window,
       COUNT(*)::int AS n_total,
       MAX(c.created_at) AS last_at
  FROM referral_conversions c
  LEFT JOIN subscribers s
    ON s.tenant_id = c.tenant_id AND s.id::text = c.referrer_subscriber_id
 WHERE c.tenant_id = $1::uuid
   AND COALESCE(c.fraud_score, 0) < $3
   AND COALESCE(c.credit_status, 'credited') = 'credited'
 GROUP BY c.referrer_subscriber_id, s.email
HAVING COUNT(*) FILTER (WHERE c.created_at >= now() - ($2::int * interval '1 day')) > 0
 ORDER BY n_window DESC, last_at DESC
 LIMIT $4`, tenantID, windowDays, referralFraudThreshold, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []leaderboardRow{}
	for rows.Next() {
		var lr leaderboardRow
		if err := rows.Scan(&lr.email, &lr.windowCount, &lr.totalCount, &lr.lastAt); err != nil {
			return nil, err
		}
		out = append(out, lr)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}
