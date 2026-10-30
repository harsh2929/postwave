// SPDX-License-Identifier: AGPL-3.0-only
//
// engagement.go — SUB-036 Audience performance dashboard backend.
//
// The P&L comparison surface (pnl.go / pnl_repo.go) already returns the
// economic side of segment comparison (revenue, RPR, cost). What it does
// NOT return is the engagement side an audience-focused dashboard needs:
// open rate, click rate, and unsubscribe rate per segment member. This
// file adds a lightweight read that aggregates those rates from
// subscriber_events scoped to a segment's membership.
//
//   GET /api/v1/segments/{id}/engagement-summary?days=90
//
// No new tables: this reuses the segment membership predicate (CompileAST
// + the memberCTE helper from pnl_repo.go) and the subscriber_events
// table. The rate maths are pure (computeEngagementRates) so they are
// table-tested without a database.

package segments

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// SegmentEngagementSummaryResponse is the wire shape: raw event counts
// over the window plus the derived rates and the denominator they were
// computed against.
type SegmentEngagementSummaryResponse struct {
	SegmentID   string `json:"segment_id"`
	WindowDays  int    `json:"window_days"`
	MemberCount int64  `json:"member_count"`

	// Raw event counts (subscriber_events, member-scoped, in window).
	Sends      int64 `json:"sends"`
	Opens      int64 `json:"opens"`
	Clicks     int64 `json:"clicks"`
	Unsubs     int64 `json:"unsubs"`
	Bounces    int64 `json:"bounces"`
	Complaints int64 `json:"complaints"`

	// Derived rates in [0,1]. "Sends" here is the count of engagement
	// events the log carries for members in the window (opened / clicked
	// / bounced / complained / unsubscribed) — the same denominator the
	// per-subscriber engagement score uses, disclosed via RateBasis.
	OpenRate  float64 `json:"open_rate"`
	ClickRate float64 `json:"click_rate"`
	UnsubRate float64 `json:"unsub_rate"`
	RateBasis string  `json:"rate_basis"`

	GeneratedAt time.Time `json:"generated_at"`
}

// engagementRawCounts is the raw aggregate read from subscriber_events
// before the pure rate maths is applied.
type engagementRawCounts struct {
	Sends      int64
	Opens      int64
	Clicks     int64
	Unsubs     int64
	Bounces    int64
	Complaints int64
}

// computeEngagementRates derives open/click/unsub rates from the raw
// counts. Pure — no DB. The denominator is Sends (the count of delivery-
// outcome events for members in the window); when Sends is 0 every rate
// is 0 (an honest "no signal" rather than a divide-by-zero NaN).
func computeEngagementRates(c engagementRawCounts) (openRate, clickRate, unsubRate float64) {
	if c.Sends <= 0 {
		return 0, 0, 0
	}
	den := float64(c.Sends)
	return float64(c.Opens) / den, float64(c.Clicks) / den, float64(c.Unsubs) / den
}

// SegmentEngagementSummary loads the member-scoped engagement aggregate
// for one segment over the window. Opens its own tenant-scoped tx so RLS
// fires; the segment lookup validates ownership and yields the QueryAST.
func (r *Repo) SegmentEngagementSummary(ctx context.Context, tenantID, segmentID string, windowDays int) (*SegmentEngagementSummaryResponse, error) {
	seg, err := r.Get(ctx, tenantID, segmentID)
	if err != nil {
		return nil, err
	}
	predicate, err := CompilePopulation(ctx, seg.QueryAST, tenantID, r, DefinitionPopulation(false))
	if err != nil {
		return nil, fmt.Errorf("segments: compile ast for engagement: %w", err)
	}
	frag, args := predicate.SQL, predicate.Args

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	cte := memberCTE(frag)
	var memberCount int64
	if err := tx.QueryRow(ctx, cte+"\nSELECT count(*)::bigint FROM members", args...).
		Scan(&memberCount); err != nil {
		return nil, fmt.Errorf("segments: engagement member count: %w", err)
	}

	windowIdx := len(args) + 1
	windowArgs := append(append([]any{}, args...), windowDays)
	var raw engagementRawCounts
	if err := tx.QueryRow(ctx, cte+fmt.Sprintf(`
SELECT
  count(*) FILTER (WHERE e.event_type IN ('opened','clicked','bounced','complained','unsubscribed'))::bigint,
  count(*) FILTER (WHERE e.event_type = 'opened')::bigint,
  count(*) FILTER (WHERE e.event_type = 'clicked')::bigint,
  count(*) FILTER (WHERE e.event_type = 'unsubscribed')::bigint,
  count(*) FILTER (WHERE e.event_type = 'bounced')::bigint,
  count(*) FILTER (WHERE e.event_type = 'complained')::bigint
  FROM subscriber_events e
 WHERE e.tenant_id = current_setting('app.tenant_id', true)::uuid
   AND e.at >= now() - make_interval(days => $%d)
   AND lower(e.subscriber_email::text) IN (SELECT email FROM members)`, windowIdx), windowArgs...).
		Scan(&raw.Sends, &raw.Opens, &raw.Clicks, &raw.Unsubs, &raw.Bounces, &raw.Complaints); err != nil {
		return nil, fmt.Errorf("segments: engagement event counts: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	openRate, clickRate, unsubRate := computeEngagementRates(raw)
	return &SegmentEngagementSummaryResponse{
		SegmentID:   segmentID,
		WindowDays:  windowDays,
		MemberCount: memberCount,
		Sends:       raw.Sends,
		Opens:       raw.Opens,
		Clicks:      raw.Clicks,
		Unsubs:      raw.Unsubs,
		Bounces:     raw.Bounces,
		Complaints:  raw.Complaints,
		OpenRate:    openRate,
		ClickRate:   clickRate,
		UnsubRate:   unsubRate,
		RateBasis:   "delivery_outcome_events",
		GeneratedAt: time.Now().UTC(),
	}, nil
}

// SegmentEngagementSummary GET /api/v1/segments/{id}/engagement-summary?days=90.
func (d *Deps) SegmentEngagementSummary(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		httperror.WriteValidation(w, "missing_id", "segment id required")
		return
	}
	days, ok := parsePnLDays(r.URL.Query().Get("days"))
	if !ok {
		httperror.Write(w, http.StatusBadRequest, "bad_days", "days must be an integer in [1,365]")
		return
	}
	out, err := d.Repo.SegmentEngagementSummary(r.Context(), t.ID, id, days)
	if err != nil {
		if err == ErrNotFound {
			httperror.Write(w, http.StatusNotFound, "not_found", "no such segment")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}
