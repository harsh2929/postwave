// SPDX-License-Identifier: AGPL-3.0-only
//
// Package contact_rating owns the *automatic* 1..5-star contact rating
// heuristic that complements the manual-set rating in
// internal/contact_ratings/.
//
// GAP-LS-067 (recompute leg). The manual SetRating endpoint already
// exists in contact_ratings; this package adds the bulk-recompute
// endpoint that derives stars from the last-90d engagement signal:
//
//	stars = ceil(engagement_score * 5)            ; engagement_score 0..1
//	stars = clamp( ceil(score / 20.0), 1..5 )     ; engagement_score 0..100
//
// We pick which scale to use by checking the schema-default max
// (today's subscribers.engagement_score is bounded 0..100 via the
// lead-scoring rules in migration 0137). Subscribers with a NULL
// engagement_score keep their existing rating untouched (the heuristic
// has no signal to overwrite a manual rating with).
//
// Per-subscriber GET returns the current heuristic-derived stars +
// the underlying signal so the dashboard can show "Why this rating".
package contact_rating

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Sentinel errors.
var (
	ErrNotFound     = errors.New("contact_rating: not found")
	ErrInvalidInput = errors.New("contact_rating: invalid input")
)

// RecomputeResult is the response envelope of POST /contact-ratings/recompute.
type RecomputeResult struct {
	Updated    int       `json:"updated"`
	Scanned    int       `json:"scanned"`
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at"`
	WindowDays int       `json:"window_days"`
}

// SubscriberRating is the per-subscriber GET response.
type SubscriberRating struct {
	SubscriberID    string     `json:"subscriber_id"`
	Stars           *int       `json:"stars,omitempty"`
	EngagementScore *int       `json:"engagement_score,omitempty"`
	EngagementAt    *time.Time `json:"engagement_score_at,omitempty"`
	Source          string     `json:"source"` // "manual" or "heuristic"
}

// Repo wraps the pgx pool for the recompute query path.
type Repo struct {
	Pool *db.Pool
}

// Get returns the current rating + engagement signal for a subscriber.
func (r *Repo) Get(ctx context.Context, tenantID, subscriberID string) (*SubscriberRating, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out SubscriberRating
	var stars *int
	var engScore *int
	var engAt *time.Time
	err = tx.QueryRow(ctx, `
SELECT id::text, rating, engagement_score, engagement_score_at
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, subscriberID).Scan(&out.SubscriberID, &stars, &engScore, &engAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	out.Stars = stars
	out.EngagementScore = engScore
	out.EngagementAt = engAt
	out.Source = "manual"
	if stars == nil && engScore != nil {
		s := scoreToStars(*engScore)
		out.Stars = &s
		out.Source = "heuristic"
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

// Recompute sweeps subscribers in the tenant whose engagement_score has
// changed in the last windowDays and writes derived stars into
// subscribers.rating WHERE rating IS NULL (never overwrites manual
// ratings). Returns the number of rows updated + scanned.
//
// The WHERE rating IS NULL guard is the contract: operators who
// manually set a rating retain that value until they explicitly clear
// it (PATCH /subscribers/{id}/rating with {rating:0}).
func (r *Repo) Recompute(ctx context.Context, tenantID string, windowDays int) (*RecomputeResult, error) {
	if windowDays <= 0 || windowDays > 365 {
		windowDays = 90
	}
	res := &RecomputeResult{StartedAt: time.Now().UTC(), WindowDays: windowDays}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Scanned count is the candidate pool for transparency in the
	// dashboard's "Last recompute" tile.
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*)::int
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND engagement_score IS NOT NULL
   AND (engagement_score_at IS NULL OR engagement_score_at > now() - ($2::int * INTERVAL '1 day'))`,
		tenantID, windowDays).Scan(&res.Scanned); err != nil {
		return nil, err
	}

	tag, err := tx.Exec(ctx, `
UPDATE subscribers
   SET rating = LEAST(5, GREATEST(1, CEIL(engagement_score::numeric / 20.0)::int))::smallint,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND engagement_score IS NOT NULL
   AND rating IS NULL
   AND (engagement_score_at IS NULL OR engagement_score_at > now() - ($2::int * INTERVAL '1 day'))`,
		tenantID, windowDays)
	if err != nil {
		return nil, err
	}
	res.Updated = int(tag.RowsAffected())
	res.FinishedAt = time.Now().UTC()
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return res, nil
}

// scoreToStars maps a 0..100 engagement_score onto a 1..5 star bucket.
// score == 0 → 1 star (the contact exists but is unengaged); score==100
// → 5 stars.
func scoreToStars(score int) int {
	if score <= 0 {
		return 1
	}
	s := (score + 19) / 20 // ceil(score/20)
	if s < 1 {
		s = 1
	}
	if s > 5 {
		s = 5
	}
	return s
}

// keep json imported for callers that marshal SubscriberRating.
var _ = json.Marshal
