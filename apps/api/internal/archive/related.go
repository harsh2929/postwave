// SPDX-License-Identifier: AGPL-3.0-only
//
// related.go — "Read next" / related-issue recommendations for the
// public archive issue page. This is the #1 conversion lever
// competitors (HubSpot, Ghost, Substack) invest in: a small carousel
// of relevant sibling issues at the bottom of a published post lifts
// session depth and downstream subscribe-rate measurably.
//
// Three signals layered into a single SQL pass:
//
//   1. Admin override (archive_related_overrides) — if an operator has
//      manually curated the "read next" list for the source issue, we
//      return it verbatim, sorted by rank. Mirrors Substack's
//      drag-to-reorder series UI.
//
//   2. Tag overlap (campaigns.archive_tags && source.archive_tags) —
//      the Jaccard-ish primitive Ghost's related_blog_posts HubL tag
//      uses. Score is `intersection_size`, no normalisation; works
//      well enough at low cardinalities and avoids an extra subquery
//      per row. We multiply by a constant 100 so it dominates the
//      recency/view tiebreakers.
//
//   3. Recency + popularity tiebreakers — a small linear combination
//      of "days since published" (logarithmic decay) + "30d view
//      count" (capped). Operators with no tag taxonomy still get a
//      reasonable read-next ordering by recency alone.
//
// The endpoint is public and unauthenticated; the tenant id comes
// from the public archive slug. Cache for 5 minutes — the carousel
// changes only when an operator publishes/unpublishes or edits tags.

package archive

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// tenantIDFromCtx is a thin wrapper so the related-issues handlers
// don't repeat the middleware extraction + zero-value check at every
// callsite. Returns (id, true) when a tenant is bound; ("", false)
// for unauthenticated traffic — handlers fall back to a 401 in that
// case.
func tenantIDFromCtx(r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		return "", false
	}
	return t.ID, true
}

// RelatedIssue is the projection returned by the related-issues endpoint.
// Strictly a subset of IssueSummary plus a `score` debug-only field —
// scores are exposed so operators can sanity-check the ranking in the
// admin slideover without re-running the SQL by hand.
type RelatedIssue struct {
	Slug        string    `json:"slug"`
	Subject     string    `json:"subject"`
	Excerpt     string    `json:"excerpt,omitempty"`
	PublishedAt time.Time `json:"publishedAt"`
	HeroImage   string    `json:"heroImage,omitempty"`
	// Score is the relevancy score in [0, +inf). Higher is more
	// relevant. Omitted on the public endpoint (callers that want it
	// can hit the admin variant).
	Score float64 `json:"score,omitempty"`
	// Source flags which signal placed the issue in the result:
	//   "override" — admin-curated
	//   "tags"     — tag-overlap scorer
	//   "recency"  — fallback recency-only scorer
	Source string `json:"source,omitempty"`
}

// RelatedList is the wire shape: a list + a small debug summary the
// admin slideover uses to surface "why did these win?" tooltips.
type RelatedList struct {
	Items     []RelatedIssue `json:"items"`
	Algorithm string         `json:"algorithm,omitempty"`
}

// MaxRelatedLimit is the upper bound on the `limit` query param. Five
// is the carousel sweet-spot HubSpot/Ghost/Substack all converge on;
// larger lists hurt page weight without driving meaningful uplift.
const MaxRelatedLimit = 12
const DefaultRelatedLimit = 5

// Related returns up to `limit` issues most relevant to the issue at
// (tenantID, slug). Honors any admin overrides for that source issue
// first; falls through to the tag-overlap + recency scorer when no
// overrides exist.
//
// The function opens a single WithTenant transaction so:
//
//   - The RLS GUC is set (campaigns has a PERMISSIVE policy that
//     returns 0 rows when `app.tenant_id` is unset — same gotcha that
//     bit GetIssue earlier).
//   - The override lookup and the scoring SELECT see a consistent
//     snapshot.
//
// Tests cover the scorer's tiebreaker behaviour against a fixture
// of fake-but-realistic tag overlaps.
func (r *Repo) Related(ctx context.Context, tenantID, slug string, limit int) (*RelatedList, error) {
	if limit <= 0 {
		limit = DefaultRelatedLimit
	}
	if limit > MaxRelatedLimit {
		limit = MaxRelatedLimit
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Resolve source issue's campaign id + tags. archive_tags is the
	// only attribute the scorer reads; published_at gates the recency
	// half of the score but is rederived in the scorer SQL itself.
	var (
		sourceID   string
		sourceTags []string
	)
	err = tx.QueryRow(ctx, `
SELECT id::text, COALESCE(archive_tags, '{}')
  FROM campaigns
 WHERE tenant_id = $1::uuid AND archive_slug = $2 AND archive_public = true
 LIMIT 1`, tenantID, slug).Scan(&sourceID, &sourceTags)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	// 1. Admin override path.
	overrides, err := r.relatedOverrides(ctx, tx, tenantID, sourceID, limit)
	if err != nil {
		return nil, err
	}
	if len(overrides) > 0 {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return &RelatedList{Items: overrides, Algorithm: "override"}, nil
	}

	// 2/3. Auto-scored path. The SQL combines:
	//   tag_score = 100 * cardinality(tags_intersect(source_tags, c.archive_tags))
	//   recency_score = greatest(0, 30 - extract(epoch from (now() - published))/86400)
	//   popularity_score = LEAST(views_30d, 200) / 20  -- capped at 10 pts
	//
	// Ordered by sum DESC, then published_at DESC for deterministic
	// tiebreakers. LIMIT $4 caps the page; we never paginate further
	// (the carousel never shows >12 anyway).
	algo := "tags"
	if len(sourceTags) == 0 {
		algo = "recency"
	}
	rows, err := tx.Query(ctx, `
WITH source_tags AS (
  SELECT $2::text[] AS tags
), candidate AS (
  SELECT
    c.archive_slug,
    c.subject,
    COALESCE(c.archive_excerpt, '') AS excerpt,
    COALESCE(c.finished_at, c.created_at) AS published_at,
    COALESCE(c.archive_hero_image, '') AS hero_image,
    -- tag-overlap: array intersection cardinality.
    COALESCE(cardinality(ARRAY(SELECT UNNEST(c.archive_tags) INTERSECT SELECT UNNEST((SELECT tags FROM source_tags)))), 0) AS overlap,
    -- 30d view count (bot-excluded), LEFT JOIN so issues without
    -- traffic don't drop from the result.
    COALESCE(v.n, 0) AS views_30d
  FROM campaigns c
  LEFT JOIN (
    SELECT campaign_id, COUNT(*) AS n
      FROM archive_views
     WHERE tenant_id = $1::uuid
       AND NOT bot
       AND viewed_at > now() - INTERVAL '30 days'
     GROUP BY campaign_id
  ) v ON v.campaign_id = c.id
 WHERE c.tenant_id = $1::uuid
   AND c.archive_public = true
   AND c.archive_slug IS NOT NULL
   AND c.id::text <> $3
)
SELECT
  archive_slug, subject, excerpt, published_at, hero_image,
  (overlap * 100.0)
    + GREATEST(0.0, 30.0 - EXTRACT(EPOCH FROM (now() - published_at))/86400.0)
    + LEAST(views_30d::float, 200.0) / 20.0 AS score,
  overlap
FROM candidate
ORDER BY score DESC, published_at DESC
LIMIT $4`,
		tenantID,
		sourceTags,
		sourceID,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := &RelatedList{Items: []RelatedIssue{}, Algorithm: algo}
	for rows.Next() {
		var it RelatedIssue
		var overlap int
		if err := rows.Scan(&it.Slug, &it.Subject, &it.Excerpt, &it.PublishedAt, &it.HeroImage, &it.Score, &overlap); err != nil {
			return nil, err
		}
		if overlap > 0 {
			it.Source = "tags"
		} else {
			it.Source = "recency"
		}
		out.Items = append(out.Items, it)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// relatedOverrides reads the admin-curated list. Returns nil/empty
// when no override rows exist for the source.
//
// The query joins archive_related_overrides → campaigns so we filter
// out overrides that point at a since-unpublished or deleted issue
// without a second round-trip.
func (r *Repo) relatedOverrides(ctx context.Context, tx pgx.Tx, tenantID, sourceID string, limit int) ([]RelatedIssue, error) {
	rows, err := tx.Query(ctx, `
SELECT
  c.archive_slug,
  c.subject,
  COALESCE(c.archive_excerpt, ''),
  COALESCE(c.finished_at, c.created_at),
  COALESCE(c.archive_hero_image, '')
FROM archive_related_overrides o
JOIN campaigns c ON c.id = o.related_campaign_id
 AND c.tenant_id = $1::uuid
 AND c.archive_public = true
 AND c.archive_slug IS NOT NULL
WHERE o.tenant_id = $1::uuid AND o.campaign_id::text = $2
ORDER BY o.rank ASC, o.created_at ASC
LIMIT $3`, tenantID, sourceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]RelatedIssue, 0, limit)
	for rows.Next() {
		var it RelatedIssue
		if err := rows.Scan(&it.Slug, &it.Subject, &it.Excerpt, &it.PublishedAt, &it.HeroImage); err != nil {
			return nil, err
		}
		it.Source = "override"
		out = append(out, it)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// SetRelatedOverrides replaces the admin override list for the source
// campaign with the supplied ordered list of related campaign ids.
// An empty list clears the override and falls the surface back to the
// auto scorer.
//
// Transactional: the existing rows are deleted and the new ones
// inserted in a single tx so a partial failure never leaves the
// override surface half-populated.
func (r *Repo) SetRelatedOverrides(ctx context.Context, tenantID, sourceID string, relatedIDs []string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Validate source exists + is published. Returns ErrNotFound for
	// the desktop's 404 path.
	var ok bool
	err = tx.QueryRow(ctx, `
SELECT true FROM campaigns
 WHERE tenant_id = $1::uuid AND id::text = $2 AND archive_public = true
 LIMIT 1`, tenantID, sourceID).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `
DELETE FROM archive_related_overrides
 WHERE tenant_id = $1::uuid AND campaign_id::text = $2`, tenantID, sourceID); err != nil {
		return err
	}

	for i, rid := range relatedIDs {
		if rid == "" || rid == sourceID {
			continue
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO archive_related_overrides (tenant_id, campaign_id, related_campaign_id, rank)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
ON CONFLICT (tenant_id, campaign_id, related_campaign_id) DO UPDATE SET rank = EXCLUDED.rank`,
			tenantID, sourceID, rid, i); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// GetRelatedOverrides reads the admin override list for the supplied
// source campaign id. Returns an empty slice when no overrides exist
// (so the admin slideover can render an empty-state cleanly).
func (r *Repo) GetRelatedOverrides(ctx context.Context, tenantID, sourceID string) ([]RelatedIssue, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := r.relatedOverrides(ctx, tx, tenantID, sourceID, MaxRelatedLimit)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if out == nil {
		out = []RelatedIssue{}
	}
	return out, nil
}

// ---------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------

// PublicRelated handles GET /api/public/archive/{tenant_slug}/{slug}/related.
// Public, unauthenticated. Caches for 5 min so a viral issue doesn't
// re-run the scorer on every render.
func (d *Deps) PublicRelated(w http.ResponseWriter, r *http.Request) {
	tslug := chi.URLParam(r, "tenant_slug")
	slug := chi.URLParam(r, "campaign_slug")
	tid, err := d.Repo.TenantBySlug(r.Context(), tslug)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such archive"))
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	out, err := d.Repo.Related(r.Context(), tid, slug, limit)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such issue"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Strip the score on the public path — operators can see it on
	// the admin override page (debug-only signal).
	for i := range out.Items {
		out.Items[i].Score = 0
	}
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(out)
}

// AdminRelatedPreview handles GET /api/v1/campaigns/{id}/archive/related —
// scores the related list for an admin so they can preview what the
// public carousel will show. Keeps the per-row score so the slideover
// can surface "this matched on tags" tooltips.
func (d *Deps) AdminRelatedPreview(w http.ResponseWriter, r *http.Request) {
	t, ok := tenantIDFromCtx(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	cid := chi.URLParam(r, "id")
	// Look up the issue's slug so we can reuse Related(). Single
	// round-trip, transparent to the caller — the admin desktop only
	// has the campaign id.
	slug, err := d.Repo.slugForCampaign(r.Context(), t, cid)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not in archive"))
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	out, err := d.Repo.Related(r.Context(), t, slug, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// AdminRelatedGetOverrides GET /api/v1/campaigns/{id}/archive/related/overrides
func (d *Deps) AdminRelatedGetOverrides(w http.ResponseWriter, r *http.Request) {
	t, ok := tenantIDFromCtx(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	cid := chi.URLParam(r, "id")
	items, err := d.Repo.GetRelatedOverrides(r.Context(), t, cid)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, RelatedList{Items: items, Algorithm: "override"})
}

// AdminRelatedSetOverrides PUT /api/v1/campaigns/{id}/archive/related/overrides
// Body: {"relatedCampaignIds": ["uuid1","uuid2",...]}
// Empty list clears overrides (falls back to auto-scoring on the public surface).
func (d *Deps) AdminRelatedSetOverrides(w http.ResponseWriter, r *http.Request) {
	t, ok := tenantIDFromCtx(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	cid := chi.URLParam(r, "id")
	var body struct {
		RelatedCampaignIDs []string `json:"relatedCampaignIds"`
	}
	if err := httpbody.DecodeJSON(w, r, archiveJSONMaxBodyBytes, &body); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if err := d.Repo.SetRelatedOverrides(r.Context(), t, cid, body.RelatedCampaignIDs); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not in archive"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "count": len(body.RelatedCampaignIDs)})
}

// slugForCampaign resolves a campaign uuid to its archive slug, scoped
// to the supplied tenant. Returns ErrNotFound for any campaign that
// isn't published.
func (r *Repo) slugForCampaign(ctx context.Context, tenantID, campaignID string) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var slug string
	err = tx.QueryRow(ctx, `
SELECT archive_slug FROM campaigns
 WHERE tenant_id = $1::uuid AND id::text = $2 AND archive_public = true
 LIMIT 1`, tenantID, campaignID).Scan(&slug)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return slug, nil
}
