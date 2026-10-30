// SPDX-License-Identifier: AGPL-3.0-only
//
// dow_pattern.go — per-day-of-week + per-hour open-pattern aggregation.
//
// The existing best-send-hour pipeline (send_time_opt.go) picks the
// MODAL hour-of-week for each subscriber and uses that to schedule
// the next send. That's a strong signal at the per-subscriber level
// but the segment-level surface (GetSegmentBest) collapses to
// hour-of-day — throwing away the day-of-week dimension.
//
// This file adds:
//
//   * OpenPattern: 7x24 normalised heatmap (DOW × hour-of-day).
//   * Repo.LoadOpenPattern: builds the heatmap for a single subscriber.
//   * Repo.LoadSegmentPattern: averages many subscribers' heatmaps for
//     the segment surface.
//   * GET /api/v1/subscribers/{id}/open-pattern — single-subscriber
//     heatmap (debug + the desktop's per-recipient picker).
//   * GET /api/v1/send-time-opt/heatmap?segment_id=... — segment
//     heatmap for the campaign-builder's "best DOW + hour" surface.
//
// The 7x24 grid is more informative than mode-of-hour-of-week because
// it lets the UI:
//
//   * Show a heatmap (Mon 9am brightest → "your audience opens
//     strongest Monday at 9am UTC").
//   * Identify a "second-best window" for follow-up sends.
//   * Detect bimodal audiences (commuters + lunch readers, say).
//
// Pattern normalisation: each cell holds the FRACTION of opens that
// landed in that cell (so the matrix sums to 1.0). Easier for the UI
// to colour-scale and easier to combine across subscribers without
// being skewed by power-users with thousands of opens.

package send_time_opt

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

// OpenPattern is a 7x24 normalised heatmap of opens. Rows: day-of-week
// 0..6 (Sunday=0). Cols: hour-of-day 0..23. Sum across all cells = 1.0
// when SampleSize > 0; 0.0 for cold subscribers.
type OpenPattern struct {
	Email         string         `json:"email,omitempty"`
	SampleSize    int            `json:"sample_size"`
	Grid          [7][24]float64 `json:"grid"`
	BestDOW       int            `json:"best_dow"`  // 0..6, Sunday=0
	BestHour      int            `json:"best_hour"` // 0..23 UTC
	SecondaryDOW  int            `json:"secondary_dow,omitempty"`
	SecondaryHour int            `json:"secondary_hour,omitempty"`
	Bimodal       bool           `json:"bimodal"` // true when 2nd peak >= 0.6 * 1st
	ComputedAt    time.Time      `json:"computed_at"`
}

// buildPattern populates an OpenPattern from a slice of open
// timestamps. We re-use HourOfWeek to derive DOW + HoD without
// re-implementing the conversion. Back-compat wrapper around
// buildWeightedPattern with implicit weights=1 — kept so callers that
// don't carry per-event weights (the legacy opens-only paths) don't
// have to materialise a weights slice.
func buildPattern(opens []time.Time) OpenPattern {
	if len(opens) == 0 {
		return OpenPattern{}
	}
	weights := make([]int, len(opens))
	for i := range weights {
		weights[i] = 1
	}
	return buildWeightedPattern(opens, weights)
}

// buildWeightedPattern is the weighted variant of buildPattern. Each
// (time, weight) pair contributes `weight` units to the grid cell so
// stronger intent signals (clicks/replies) shift the modal pick the
// same way the multiplicity approach in `weightFor` does at the
// per-subscriber Mode() level. Zero-weight entries are skipped
// entirely — they neither bump SampleSize nor populate a cell.
//
// `weights` and `events` MUST be the same length; a length mismatch
// is tolerated by treating the shorter slice as authoritative (we'd
// rather under-count than panic on a drifted caller). The function
// stays leaf-pure so it can be exercised by table tests without any
// DB or weights-reader dependency.
func buildWeightedPattern(events []time.Time, weights []int) OpenPattern {
	var p OpenPattern
	n := len(events)
	if n == 0 || len(weights) == 0 {
		return p
	}
	if len(weights) < n {
		n = len(weights)
	}
	total := 0
	for i := 0; i < n; i++ {
		wt := weights[i]
		if wt <= 0 {
			continue
		}
		hw := HourOfWeek(events[i])
		dow := hw / 24
		hod := hw % 24
		if dow < 0 || dow > 6 || hod < 0 || hod > 23 {
			continue
		}
		p.Grid[dow][hod] += float64(wt)
		total += wt
	}
	p.SampleSize = total
	if total == 0 {
		return p
	}
	// Normalise to fractions + find the peak + check bimodality.
	totalF := float64(p.SampleSize)
	first, second := 0.0, 0.0
	for d := 0; d < 7; d++ {
		for h := 0; h < 24; h++ {
			v := p.Grid[d][h] / totalF
			p.Grid[d][h] = v
			if v > first {
				// Old best becomes the new secondary.
				second = first
				p.SecondaryDOW = p.BestDOW
				p.SecondaryHour = p.BestHour
				first = v
				p.BestDOW = d
				p.BestHour = h
			} else if v > second && !(d == p.BestDOW && h == p.BestHour) {
				second = v
				p.SecondaryDOW = d
				p.SecondaryHour = h
			}
		}
	}
	// Bimodal if the second peak is at least 60% of the first.
	if first > 0 && second/first >= 0.6 {
		p.Bimodal = true
	}
	p.ComputedAt = time.Now().UTC()
	return p
}

// LoadOpenPattern reads recent opens for a subscriber and returns
// their 7x24 OpenPattern. We pull 2000 opens (twice the existing
// Compute() window) because the heatmap is more informative when
// it has more data — the modal-hour computation only needs ~5 opens
// to commit, but a useful heatmap needs >= 20 to look anything
// other than noisy.
func (r *Repo) LoadOpenPattern(ctx context.Context, tenantID, email string) (*OpenPattern, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	weights := resolveWeights(ctx, r.Weights, tenantID)
	rows, err := tx.Query(ctx, `
SELECT at, event_type FROM subscriber_events
WHERE tenant_id = $1::uuid
  AND subscriber_email = $2
  AND event_type IN ('opened', 'clicked', 'replied')
  AND at >= now() - interval '180 days'
ORDER BY at DESC
LIMIT 2000`, tenantID, strings.ToLower(strings.TrimSpace(email)))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := make([]time.Time, 0, 256)
	eventWeights := make([]int, 0, 256)
	for rows.Next() {
		var (
			t         time.Time
			eventType string
		)
		if err := rows.Scan(&t, &eventType); err != nil {
			return nil, err
		}
		events = append(events, t)
		eventWeights = append(eventWeights, weightFor(eventType, weights))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	p := buildWeightedPattern(events, eventWeights)
	p.Email = email
	if cerr := tx.Commit(ctx); cerr != nil {
		return nil, cerr
	}
	return &p, nil
}

// SegmentPattern is the aggregated 7x24 heatmap for a segment. Each
// subscriber's normalised grid is averaged in — power users with
// thousands of opens do NOT dominate the segment view.
type SegmentPattern struct {
	SegmentID     string         `json:"segment_id"`
	Subscribers   int            `json:"subscribers_with_data"`
	Grid          [7][24]float64 `json:"grid"`
	BestDOW       int            `json:"best_dow"`
	BestHour      int            `json:"best_hour"`
	SecondaryDOW  int            `json:"secondary_dow,omitempty"`
	SecondaryHour int            `json:"secondary_hour,omitempty"`
	HasSecondary  bool           `json:"has_secondary_window"`
	ComputedAt    time.Time      `json:"computed_at"`
}

// LoadSegmentPattern aggregates per-subscriber open patterns for a
// segment. We use a row-bounded query for safety; very large segments
// (> SegmentPatternSubscriberLimit) sample the most-recently-active
// subscribers.
func (r *Repo) LoadSegmentPattern(ctx context.Context, tenantID, segmentID string) (*SegmentPattern, error) {
	membership, err := r.resolveSegmentMembership(
		ctx, tenantID, segmentID, 1, 1, segments.DefinitionPopulation(false),
	)
	if err != nil {
		return nil, err
	}
	if membership.IsFallback {
		stoSegmentFallbackEngagedTotal.WithLabelValues(membership.Reason, "heatmap").Inc()
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Resolve subscriber emails through the canonical segment-membership
	// resolver. Cache misses compile the exact AST; they never broaden to the
	// whole tenant.
	subs := make([]string, 0, 2048)
	{
		args := append([]any{tenantID}, membership.Args...)
		args = append(args, SegmentPatternSubscriberLimit)
		rows, err := tx.Query(ctx, `
SELECT email::text FROM subscribers
WHERE tenant_id = $1::uuid
  AND status = 'enabled'
	AND id IN (`+membership.Subquery+`)
LIMIT $`+strconv.Itoa(len(args)), args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var e string
			if err := rows.Scan(&e); err != nil {
				rows.Close()
				return nil, err
			}
			subs = append(subs, e)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	// For each subscriber, fetch their opens (capped at 200/sub to
	// keep the segment query bounded — 2000 subs * 200 opens = 400k
	// rows worst-case, which is fine for a tenant on modern Postgres
	// but caps the per-segment endpoint at a predictable cost).
	var sp SegmentPattern
	sp.SegmentID = segmentID

	// We aggregate by reusing buildPattern per subscriber and
	// averaging the normalised grids. This is O(subs * 7 * 24) plus
	// the open-fetch query per subscriber. We batch the fetch into a
	// single query with ANY($1).
	if len(subs) == 0 {
		return &sp, nil
	}
	weights := resolveWeights(ctx, r.Weights, tenantID)
	rows, err := tx.Query(ctx, `
SELECT subscriber_email, at, event_type
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND event_type IN ('opened', 'clicked', 'replied')
   AND subscriber_email = ANY($2)
   AND at >= now() - INTERVAL '180 days'
 ORDER BY subscriber_email, at DESC`, tenantID, subs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// Bucket weighted engagement events per email.
	perEmail := make(map[string][]time.Time, len(subs))
	perEmailWeights := make(map[string][]int, len(subs))
	for rows.Next() {
		var email string
		var at time.Time
		var eventType string
		if err := rows.Scan(&email, &at, &eventType); err != nil {
			return nil, err
		}
		// Cap per-subscriber sample at 200 to prevent a power-user's
		// open history from skewing the segment average.
		if len(perEmail[email]) < 200 {
			perEmail[email] = append(perEmail[email], at)
			perEmailWeights[email] = append(perEmailWeights[email], weightFor(eventType, weights))
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Average normalised grids.
	var sum [7][24]float64
	withData := 0
	for email, ts := range perEmail {
		p := buildWeightedPattern(ts, perEmailWeights[email])
		if p.SampleSize < MinOpens {
			continue
		}
		for d := 0; d < 7; d++ {
			for h := 0; h < 24; h++ {
				sum[d][h] += p.Grid[d][h]
			}
		}
		withData++
	}
	sp.Subscribers = withData
	if withData == 0 {
		return &sp, nil
	}
	first, second := 0.0, 0.0
	for d := 0; d < 7; d++ {
		for h := 0; h < 24; h++ {
			v := sum[d][h] / float64(withData)
			sp.Grid[d][h] = v
			if v > first {
				second = first
				sp.SecondaryDOW = sp.BestDOW
				sp.SecondaryHour = sp.BestHour
				first = v
				sp.BestDOW = d
				sp.BestHour = h
			} else if v > second && !(d == sp.BestDOW && h == sp.BestHour) {
				second = v
				sp.SecondaryDOW = d
				sp.SecondaryHour = h
			}
		}
	}
	if first > 0 && second/first >= 0.6 {
		sp.HasSecondary = true
	}
	sp.ComputedAt = time.Now().UTC()
	if cerr := tx.Commit(ctx); cerr != nil {
		return nil, cerr
	}
	return &sp, nil
}

// SegmentPatternSubscriberLimit bounds the per-segment heatmap query.
// 2000 is enough to give a stable average for any reasonable segment
// and keeps the worst-case row count bounded.
const SegmentPatternSubscriberLimit = 2000

// GetOpenPattern GET /api/v1/subscribers/{id}/open-pattern.
func (d *Deps) GetOpenPattern(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	// Resolve subscriber email from id first (the inner query uses
	// subscriber_email — the canonical join key on subscriber_events).
	var email string
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	row := tx.QueryRow(r.Context(),
		`SELECT email::text FROM subscribers
		  WHERE tenant_id = $1::uuid AND id::text = $2`, t.ID, id)
	if err := row.Scan(&email); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	_ = tx.Commit(r.Context())
	p, err := d.Repo.LoadOpenPattern(r.Context(), t.ID, email)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// GetSegmentHeatmap GET /api/v1/send-time-opt/heatmap?segment_id= OR campaign_id=.
//
// 404 with {"error":"insufficient_data", ...} when fewer than
// MinSegmentSamples subscribers in the segment have computed best
// hours.
func (d *Deps) GetSegmentHeatmap(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	segmentID := strings.TrimSpace(r.URL.Query().Get("segment_id"))
	campaignID := strings.TrimSpace(r.URL.Query().Get("campaign_id"))
	if segmentID == "" && campaignID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_params",
			"either segment_id or campaign_id is required"))
		return
	}
	if segmentID == "" {
		seg, err := d.Repo.resolveCampaignSegment(r.Context(), t.ID, campaignID)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				writeJSON(w, http.StatusNotFound, errEnv("campaign_not_found", ""))
				return
			}
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		segmentID = seg
	}
	sp, err := d.Repo.LoadSegmentPattern(r.Context(), t.ID, segmentID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if sp.Subscribers < MinSegmentSamples {
		writeJSON(w, http.StatusNotFound, map[string]any{
			"error":   "insufficient_data",
			"message": "need >= 30 subscribers with open history; have " + itoa(sp.Subscribers),
		})
		return
	}
	writeJSON(w, http.StatusOK, sp)
}

// MountPatternRoutes registers the new pattern endpoints on the same
// chi.Router used by MountRoutes. Kept as a separate Mount* so it can
// be wired independently if the surface needs to be split out.
func (d *Deps) MountPatternRoutes(r chi.Router) {
	// admin-rbac-require-scope (P0): pattern endpoints are reports.
	read := r.With(apikeys.RequireScope(
		apikeys.ScopeReadReports,
		apikeys.ScopeAdmin,
	))
	read.Get("/api/v1/subscribers/{id}/open-pattern", observability.RecordSurfaceFunc("send_time_opt", "open_pattern", d.GetOpenPattern))
	read.Get("/api/v1/send-time-opt/heatmap", observability.RecordSurfaceFunc("send_time_opt", "segment_heatmap", d.GetSegmentHeatmap))
}

// keep json import referenced if the file is built in isolation.
var _ = json.Marshal
var _ context.Context = nil
