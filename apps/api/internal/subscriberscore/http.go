// SPDX-License-Identifier: AGPL-3.0-only
//
// http.go — read-only HTTP surface over the persisted per-subscriber
// engagement score.
//
// Where the score lives: subscribers.engagement_score (+ the
// engagement_score_at stamp), added in migrations 0061 + 0137 and
// recomputed by the internal/scoring worker every 15 minutes from
// the last 90 days of subscriber_events × scoring_rules weights.
// (This package's own background Scorer writes the *separate*
// subscribers.churn_score column — see subscriberscore.go.)
//
// This file only ever reads what the worker stored — no on-read
// recompute, no derived smoothing. Three endpoints:
//
//   GET /api/v1/subscribers/{id}/engagement-score
//       → {score, computed_at?} — verbatim column values. {id}
//         accepts a subscriber UUID or the email itself (same
//         convention as the subscriber timeline endpoint).
//
//   GET /api/v1/engagement-scores/distribution
//       → {buckets: [{range, min, max, count}]} — decile buckets
//         (NTILE(10) over scored subscribers). Unscored subscribers
//         (engagement_score IS NULL — never touched by the worker)
//         are excluded so the deciles describe real scores only.
//
//   GET /api/v1/engagement-scores/subscribers?min=&max=&page=&per_page=
//       → paged {id, email, score} list ordered score DESC, so the
//         UI can build score-banded audiences. Served off the
//         (tenant_id, engagement_score DESC) index from 0166.
//
// All endpoints require the read:subscribers scope and resolve the
// tenant via the standard middleware + db.WithTenant (RLS) path.

package subscriberscore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
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
)

// HTTPDeps wires the engagement-score read endpoints.
type HTTPDeps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// Page-size bounds for the score-banded subscriber list.
const (
	defaultScorePageSize = 50
	maxScorePageSize     = 200
)

// MountRoutes registers the engagement-score read surface. Caller
// must mount inside the tenant-authenticated router group.
func MountRoutes(r chi.Router, d *HTTPDeps) {
	if d == nil || d.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadSubscribers)
	r.With(read).Get("/api/v1/subscribers/{id}/engagement-score", d.GetEngagementScore)
	r.With(read).Get("/api/v1/engagement-scores/distribution", d.Distribution)
	r.With(read).Get("/api/v1/engagement-scores/subscribers", d.ListByScore)
}

// EngagementScore is the verbatim stored score for one subscriber.
// Score is a pointer because subscribers the worker has never scored
// carry a NULL engagement_score (0061 added the column nullable).
type EngagementScore struct {
	Score      *int    `json:"score"`
	ComputedAt *string `json:"computed_at,omitempty"`
}

// ScoreBucket is one decile of the tenant's scored subscribers.
type ScoreBucket struct {
	Range string `json:"range"`
	Min   int    `json:"min"`
	Max   int    `json:"max"`
	Count int    `json:"count"`
}

// ScoredSubscriber is one row of the score-banded audience list.
type ScoredSubscriber struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Score int    `json:"score"`
}

// errSubscriberNotFound is a typed sentinel so the handler can 404
// without echoing raw db error text.
var errSubscriberNotFound = errors.New("subscriberscore: subscriber not found")

// scoreRangeLabel renders the human bucket label ("12..40"). Pure —
// unit-tested without a database.
func scoreRangeLabel(lo, hi int) string {
	return fmt.Sprintf("%d..%d", lo, hi)
}

// clampPerPage normalizes the per_page parameter into [1, max].
// Zero/negative fall back to the default. Pure — unit-tested.
func clampPerPage(perPage int) int {
	if perPage <= 0 {
		return defaultScorePageSize
	}
	if perPage > maxScorePageSize {
		return maxScorePageSize
	}
	return perPage
}

// clampPage normalizes 1-based page numbers. Pure — unit-tested.
func clampPage(page int) int {
	if page < 1 {
		return 1
	}
	return page
}

// FetchScore reads the stored engagement score for one subscriber.
// idOrEmail accepts the subscriber UUID or the email address.
func FetchScore(ctx context.Context, pool *db.Pool, tenantID, idOrEmail string) (*EngagementScore, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var score *int
	var at *time.Time
	err = tx.QueryRow(ctx, `
SELECT engagement_score, engagement_score_at
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2))`,
		tenantID, idOrEmail).Scan(&score, &at)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errSubscriberNotFound
	}
	if err != nil {
		return nil, err
	}
	out := &EngagementScore{Score: score}
	if at != nil {
		s := at.UTC().Format(time.RFC3339)
		out.ComputedAt = &s
	}
	return out, nil
}

// ScoreDistribution buckets the tenant's scored subscribers into
// deciles. NTILE(10) over engagement_score ascending; each returned
// bucket carries its observed [min, max] score plus the row count.
// Tenants with fewer than 10 scored subscribers get fewer buckets —
// that's NTILE semantics and we surface it verbatim.
func ScoreDistribution(ctx context.Context, pool *db.Pool, tenantID string) ([]ScoreBucket, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
WITH scored AS (
  SELECT engagement_score::int AS score,
         NTILE(10) OVER (ORDER BY engagement_score) AS decile
    FROM subscribers
   WHERE tenant_id = $1::uuid
     AND engagement_score IS NOT NULL
)
SELECT MIN(score)::int, MAX(score)::int, COUNT(*)::int
  FROM scored
 GROUP BY decile
 ORDER BY decile`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ScoreBucket{}
	for rows.Next() {
		var lo, hi, n int
		if err := rows.Scan(&lo, &hi, &n); err != nil {
			return nil, err
		}
		out = append(out, ScoreBucket{
			Range: scoreRangeLabel(lo, hi),
			Min:   lo, Max: hi, Count: n,
		})
	}
	return out, rows.Err()
}

// SubscribersByScore lists scored subscribers inside [min, max]
// (either bound optional — nil means unbounded), ordered score DESC
// then id for a stable sort. Returns the page slice plus the total
// matching count for the paging envelope.
func SubscribersByScore(ctx context.Context, pool *db.Pool, tenantID string, min, max *int, page, perPage int) ([]ScoredSubscriber, int, error) {
	page = clampPage(page)
	perPage = clampPerPage(perPage)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var total int
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*)::int
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND engagement_score IS NOT NULL
   AND ($2::int IS NULL OR engagement_score >= $2::int)
   AND ($3::int IS NULL OR engagement_score <= $3::int)`,
		tenantID, min, max).Scan(&total); err != nil {
		return nil, 0, err
	}

	rows, err := tx.Query(ctx, `
SELECT id::text, email::text, engagement_score::int
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND engagement_score IS NOT NULL
   AND ($2::int IS NULL OR engagement_score >= $2::int)
   AND ($3::int IS NULL OR engagement_score <= $3::int)
 ORDER BY engagement_score DESC, id
 LIMIT $4::int OFFSET $5::int`,
		tenantID, min, max, perPage, (page-1)*perPage)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	out := []ScoredSubscriber{}
	for rows.Next() {
		var s ScoredSubscriber
		if err := rows.Scan(&s.ID, &s.Email, &s.Score); err != nil {
			return nil, 0, err
		}
		out = append(out, s)
	}
	return out, total, rows.Err()
}

// GetEngagementScore GET /api/v1/subscribers/{id}/engagement-score.
func (d *HTTPDeps) GetEngagementScore(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := FetchScore(r.Context(), d.Pool, t.ID, chi.URLParam(r, "id"))
	if errors.Is(err, errSubscriberNotFound) {
		httperror.Write(w, http.StatusNotFound, "not_found", "subscriber not found")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Distribution GET /api/v1/engagement-scores/distribution.
func (d *HTTPDeps) Distribution(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	buckets, err := ScoreDistribution(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"buckets": buckets})
}

// ListByScore GET /api/v1/engagement-scores/subscribers?min=&max=&page=&per_page=.
func (d *HTTPDeps) ListByScore(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	q := r.URL.Query()
	min, err := optionalInt(q.Get("min"))
	if err != nil {
		httperror.WriteValidation(w, "bad_min", "min must be an integer")
		return
	}
	max, err := optionalInt(q.Get("max"))
	if err != nil {
		httperror.WriteValidation(w, "bad_max", "max must be an integer")
		return
	}
	if min != nil && max != nil && *min > *max {
		httperror.WriteValidation(w, "bad_range", "min must be <= max")
		return
	}
	page, err := optionalInt(q.Get("page"))
	if err != nil {
		httperror.WriteValidation(w, "bad_page", "page must be an integer")
		return
	}
	perPage, err := optionalInt(q.Get("per_page"))
	if err != nil {
		httperror.WriteValidation(w, "bad_per_page", "per_page must be an integer")
		return
	}
	p, pp := 1, 0
	if page != nil {
		p = *page
	}
	if perPage != nil {
		pp = *perPage
	}
	subs, total, err := SubscribersByScore(r.Context(), d.Pool, t.ID, min, max, p, pp)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":    subs,
		"page":     clampPage(p),
		"per_page": clampPerPage(pp),
		"total":    total,
	})
}

// optionalInt parses an optional query parameter. Empty → nil.
// Pure — unit-tested.
func optionalInt(raw string) (*int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return nil, err
	}
	return &n, nil
}

// writeJSON mirrors the helper in package scoring — small enough to
// duplicate rather than export from a shared spot.
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
