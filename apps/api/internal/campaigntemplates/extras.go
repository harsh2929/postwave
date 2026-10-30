// SPDX-License-Identifier: AGPL-3.0-only
//
// extras.go — Templates v2 product surface. Layers the discovery,
// favorites, usage tracking, and clone affordances on top of the
// 0048 / 0187 schema.
//
// Five Repo operations + their handlers:
//
//   * Clone(src, newSlug, newName) — duplicates any template (own or
//     platform) into a tenant-owned row. Solves the "I want to
//     customize a Moosewave gallery template" path that the original
//     Update handler explicitly punts on.
//   * RecordUse(templateID) — atomically bumps usage_count +
//     last_used_at. Called by the desktop the moment a template is
//     handed off to a new campaign draft (so the "popular" sort
//     reflects real product behaviour, not just CRUD activity).
//   * SetFavorite(userID, templateID, favorited) — toggles a row in
//     template_favorites for the calling user.
//   * Stats() — headline tiles (totals, used 30d, top template, last
//     used at). One transaction so the snapshot is consistent.
//   * GoalCounts() — taxonomy + per-goal counts (drives the goal
//     filter rail).
//
// All five are tenant-scoped via db.WithTenant; the favorites table
// is RLS-isolated per 0187.

package campaigntemplates

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ---------------------------------------------------------------------
// Stats + taxonomy
// ---------------------------------------------------------------------

// Stats is the headline rollup returned by GET /api/v1/campaign-templates/stats.
type Stats struct {
	Total           int        `json:"total"`
	Mine            int        `json:"mine"`
	Featured        int        `json:"featured"`
	Favorites       int        `json:"favorites"`
	UsedLast30d     int        `json:"used_last_30d"`
	TopTemplateID   string     `json:"top_template_id,omitempty"`
	TopTemplateName string     `json:"top_template_name,omitempty"`
	TopUsageCount   int        `json:"top_usage_count,omitempty"`
	LastUsedAt      *time.Time `json:"last_used_at,omitempty"`
}

// GoalCount is one row in GET /api/v1/campaign-templates/goals.
type GoalCount struct {
	Goal  string `json:"goal"`
	Count int    `json:"count"`
}

// GetStats computes the tiles for the dashboard. Uses a single tx so
// the snapshot is consistent across the constituent subqueries.
func (r *Repo) GetStats(ctx context.Context, tenantID, userID string) (*Stats, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, userID); err != nil {
		return nil, err
	}
	out := &Stats{}

	if err := tx.QueryRow(ctx, `
SELECT COUNT(*)                                       AS total,
       COUNT(*) FILTER (WHERE tenant_id IS NOT NULL)  AS mine,
       COUNT(*) FILTER (WHERE COALESCE(is_featured, false))                                AS featured,
       COUNT(*) FILTER (WHERE last_used_at > now() - INTERVAL '30 days')                   AS used_30d
  FROM campaign_templates
 WHERE review_status <> 'rejected'
   AND archived_at IS NULL`).Scan(
		&out.Total, &out.Mine, &out.Featured, &out.UsedLast30d,
	); err != nil {
		return nil, err
	}

	// Favorites count for the calling user — best-effort: when no
	// user context, returns 0 cheaply.
	if userID != "" {
		if err := tx.QueryRow(ctx, `
SELECT COUNT(*)
  FROM template_favorites fav
  JOIN campaign_templates tpl ON tpl.id = fav.template_id
 WHERE fav.user_id::text = $1
   AND fav.tenant_id = $2::uuid
   AND tpl.review_status <> 'rejected'
   AND tpl.archived_at IS NULL`, userID, tenantID).
			Scan(&out.Favorites); err != nil {
			return nil, err
		}
	}

	// Top template across the visible set, with name pulled in via a
	// single JOIN. NullString guards against zero-template tenants.
	var (
		topID   sql.NullString
		topName sql.NullString
		topN    sql.NullInt64
		lastAt  sql.NullTime
	)
	if err := tx.QueryRow(ctx, `
SELECT id::text, name, COALESCE(usage_count, 0), last_used_at
  FROM campaign_templates
 WHERE COALESCE(usage_count, 0) > 0
   AND review_status <> 'rejected'
   AND archived_at IS NULL
 ORDER BY usage_count DESC, last_used_at DESC NULLS LAST
 LIMIT 1`).Scan(&topID, &topName, &topN, &lastAt); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if topID.Valid {
		out.TopTemplateID = topID.String
		out.TopTemplateName = topName.String
		out.TopUsageCount = int(topN.Int64)
	}
	if lastAt.Valid {
		t := lastAt.Time
		out.LastUsedAt = &t
	}
	return out, tx.Commit(ctx)
}

// GoalCounts returns the taxonomy + per-goal counts, restricted to
// templates visible to the tenant (RLS).
func (r *Repo) GoalCounts(ctx context.Context, tenantID string) ([]GoalCount, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT COALESCE(goal, '') AS g, COUNT(*) AS n
  FROM campaign_templates
 WHERE review_status <> 'rejected'
   AND archived_at IS NULL
 GROUP BY g
 ORDER BY n DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []GoalCount{}
	for rows.Next() {
		var gc GoalCount
		if err := rows.Scan(&gc.Goal, &gc.Count); err != nil {
			return nil, err
		}
		out = append(out, gc)
	}
	return out, tx.Commit(ctx)
}

// ---------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------

// CloneInput is the body of POST /api/v1/campaign-templates/{id}/clone.
// All fields optional — when blank, the handler derives a sane default
// from the source row (name + " (copy)", slug suffixed "-copy-NNNN").
type CloneInput struct {
	Name string `json:"name,omitempty"`
	Slug string `json:"slug,omitempty"`
}

// Clone reads the source template (own or platform) and inserts a new
// tenant-owned row carrying the same body / SEO knobs. The clone
// always starts with usage_count=0 + is_featured=false + no favorite,
// regardless of the source.
//
// Idempotency: slug collision returns ErrSlugConflict so the caller
// can prompt for a new slug rather than silently overwriting.
func (r *Repo) Clone(ctx context.Context, tenantID, srcID string, in CloneInput) (*Template, error) {
	src, err := r.Get(ctx, tenantID, srcID)
	if err != nil {
		return nil, err
	}
	create, err := cloneCreateInput(src, in)
	if err != nil {
		return nil, err
	}
	return r.Create(ctx, tenantID, create)
}

func cloneCreateInput(src *Template, in CloneInput) (CreateInput, error) {
	if strings.EqualFold(strings.TrimSpace(src.TemplateKind), templateKindReference) {
		return CreateInput{}, ErrReferenceCloneBlocked
	}
	if err := ValidateTemplateEligibility(src); err != nil {
		return CreateInput{}, err
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = cloneCopyName(src.Name)
	}
	slug := strings.TrimSpace(in.Slug)
	if slug == "" {
		// Keep the source slug for traceability but reserve enough bytes for
		// the collision-resistant suffix. Source slugs are ASCII, so byte
		// truncation cannot split a rune.
		suffix := "-copy-" + randSlugSuffix()
		base := src.Slug
		if maxBase := MaxSlugLength - len(suffix); len(base) > maxBase {
			base = base[:maxBase]
		}
		base = strings.TrimRight(base, "-")
		slug = base + suffix
	}
	if err := validateSlug(slug); err != nil {
		return CreateInput{}, err
	}
	// A clone points directly at its immediate source. Transitive ancestry
	// stays on the source row and is copied into metadata for audit, without
	// violating the public maximum of three direct references.
	lineage := []string{src.ID}
	create := CreateInput{
		Slug:        slug,
		Name:        name,
		Description: src.Description,
		Category:    src.Category,
		Subject:     src.Subject,
		PreviewText: src.PreviewText,
		BodyHTML:    src.BodyHTML,
		BodyMJML:    src.BodyMJML,
		Variables:   src.Variables,
		// Tags carry over but we drop the "featured" marker; tenant
		// clones aren't featured-eligible (that's a platform-only
		// distinction).
		Tags:                 filterTags(src.Tags, "featured"),
		Goal:                 src.Goal,
		ReferenceTemplateIDs: lineage,
		GenerationMetadata: map[string]any{
			"operation":                       "clone",
			"source_template_id":              src.ID,
			"reference_template_ids":          lineage,
			"ancestor_reference_template_ids": uniqueIDs(src.ReferenceTemplateIDs),
		},
	}
	if err := validateTemplateContent(create.Name, create.Subject, create.PreviewText,
		create.BodyHTML, create.BodyMJML, create.Variables, create.Tags); err != nil {
		return CreateInput{}, err
	}
	return create, nil
}

func cloneCopyName(sourceName string) string {
	const suffix = " (copy)"
	base := strings.TrimSpace(sourceName)
	limit := MaxNameLength - len(suffix)
	if len(base) > limit {
		base = base[:limit]
		for !utf8.ValidString(base) {
			_, size := utf8.DecodeLastRuneInString(base)
			if size <= 0 || size > len(base) {
				base = ""
				break
			}
			base = base[:len(base)-size]
		}
		base = strings.TrimSpace(base)
	}
	if base == "" {
		base = "Template"
	}
	return base + suffix
}

// filterTags returns a copy of `tags` with every occurrence of `drop`
// removed (case-insensitive). The source slice is left untouched.
func filterTags(tags []string, drop string) []string {
	out := make([]string, 0, len(tags))
	for _, t := range tags {
		if strings.EqualFold(t, drop) {
			continue
		}
		out = append(out, t)
	}
	return out
}

// randSlugSuffix produces 8 hex chars suitable for a slug suffix. The
// regex constraint in validateSlug forbids most characters; hex is
// always safe.
func randSlugSuffix() string {
	// Cheap; not cryptographic. Nanosecond mod-32-bit + hex format
	// gives enough uniqueness for a UI-driven slug suffix.
	n := time.Now().UnixNano()
	return fmt.Sprintf("%08x", uint32(n))
}

// ---------------------------------------------------------------------
// RecordUse
// ---------------------------------------------------------------------

// RecordUse atomically increments usage_count + sets last_used_at on an
// eligible tenant-owned template. Platform counters are shared global state;
// a tenant-facing request must never mutate them.
//
// Returns ErrNotFound when the id is unknown or invisible. The
// dashboard handler calls this immediately on "Use in campaign"
// click; failures are non-fatal for the handoff but surface in the
// HTTP response so the caller can log.
func (r *Repo) RecordUse(ctx context.Context, tenantID, templateID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE campaign_templates
	   SET usage_count  = COALESCE(usage_count, 0) + 1,
	       last_used_at = now()
	 WHERE tenant_id = $1::uuid
	   AND id::text = $2
	   AND review_status = 'approved'
	   AND source_license_status = 'owned'
	   AND archived_at IS NULL
	   AND (
	       template_kind <> 'reference'
	       OR reference_direct_use_allowed = true
	   )`, tenantID, templateID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// ---------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------

// SetFavorite toggles the (user, template) row in template_favorites.
// Idempotent — favoriting an already-favorited row returns OK with no
// row change (ON CONFLICT DO NOTHING); unfavoriting a non-favorited
// row also returns OK.
//
// Any tenant-visible template that has not been rejected can be bookmarked,
// including pending references awaiting review. Favoriting does not execute
// template content; clone/adapt/campaign creation retain their stricter
// approved-and-owned eligibility gate. Removal stays possible after a later
// rejection. Requires a non-empty userID; without one the calling user can't
// be distinguished from teammates, so we refuse rather than silently
// favoriting on someone else's behalf.
func (r *Repo) SetFavorite(ctx context.Context, tenantID, userID, templateID string, favorited bool) error {
	if userID == "" {
		return errors.New("campaigntemplates: cannot favorite without a user context")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, userID); err != nil {
		return err
	}
	var visible bool
	if favorited {
		err = tx.QueryRow(ctx, `
WITH bookmarkable AS MATERIALIZED (
    SELECT id
      FROM campaign_templates
     WHERE id::text = $3
       AND (tenant_id = $1::uuid OR tenant_id IS NULL)
       AND review_status <> 'rejected'
       AND archived_at IS NULL
), changed AS (
    INSERT INTO template_favorites (tenant_id, user_id, template_id)
    SELECT $1::uuid, $2::uuid, id FROM bookmarkable
    ON CONFLICT DO NOTHING
    RETURNING 1
)
SELECT EXISTS (SELECT 1 FROM bookmarkable)`, tenantID, userID, templateID).Scan(&visible)
	} else {
		// Removal remains possible if a formerly-favorited template is later
		// rejected. It still proves tenant visibility before touching the row.
		err = tx.QueryRow(ctx, `
WITH visible_template AS MATERIALIZED (
    SELECT id
      FROM campaign_templates
     WHERE id::text = $3
       AND (tenant_id = $1::uuid OR tenant_id IS NULL)
), changed AS (
    DELETE FROM template_favorites fav
     USING visible_template visible
     WHERE fav.tenant_id = $1::uuid
       AND fav.user_id = $2::uuid
       AND fav.template_id = visible.id
    RETURNING 1
)
SELECT EXISTS (SELECT 1 FROM visible_template)`, tenantID, userID, templateID).Scan(&visible)
	}
	if err != nil {
		return err
	}
	if !visible {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// ---------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------

// MountExtraRoutes registers the v2 additions. Caller is responsible
// for wiring the same auth + tenant middleware as the base CRUD
// routes — these are not separate; they extend the same surface.
func (d *Deps) MountExtraRoutes(r chi.Router) {
	r.Get("/api/v1/campaign-templates/stats", d.Stats)
	r.Get("/api/v1/campaign-templates/goals", d.Goals)
	r.Post("/api/v1/campaign-templates/{id}/clone", d.Clone)
	r.Post("/api/v1/campaign-templates/{id}/use", d.RecordUse)
	r.Post("/api/v1/campaign-templates/{id}/favorite", d.Favorite)
	r.Post("/api/v1/campaign-templates/{id}/unfavorite", d.Unfavorite)
}

func (d *Deps) Stats(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	uid := ""
	if u, ok := middleware.UserFromContext(r.Context()); ok {
		uid = u.ID
	}
	out, err := d.Repo.GetStats(r.Context(), t.ID, uid)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) Goals(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	out, err := d.Repo.GoalCounts(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) Clone(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	var in CloneInput
	// Body is optional — a bare POST clones with derived name + slug.
	if err := httpbody.DecodeJSONWith(w, r, campaignTemplateJSONMaxBodyBytes, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
		writeWorkflowBodyError(w, err)
		return
	}
	tpl, err := d.Repo.Clone(r.Context(), t.ID, id, in)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			httperror.Write(w, http.StatusNotFound, "not_found", "")
		case errors.Is(err, ErrSlugConflict):
			httperror.Write(w, http.StatusConflict, "slug_conflict",
				"Slug already exists. Pass a unique `slug` in the request body.")
		case errors.Is(err, ErrInvalidSlug):
			httperror.WriteValidation(w, "invalid_slug", err.Error())
		case errors.Is(err, ErrInvalidTemplateContent):
			writeTemplateValidationError(w, err)
		case errors.Is(err, ErrTemplateIneligible):
			httperror.Write(w, http.StatusUnprocessableEntity, "template_ineligible", "Template must be approved and owned before it can be cloned.")
		case errors.Is(err, ErrReferenceCloneBlocked):
			httperror.Write(w, http.StatusUnprocessableEntity, "reference_clone_blocked", "Reference templates must be adapted through the governed generation flow.")
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	projectTemplateForRequest(r.Context(), tpl)
	writeJSON(w, http.StatusCreated, tpl)
}

func (d *Deps) RecordUse(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.RecordUse(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (d *Deps) Favorite(w http.ResponseWriter, r *http.Request)   { d.toggleFavorite(w, r, true) }
func (d *Deps) Unfavorite(w http.ResponseWriter, r *http.Request) { d.toggleFavorite(w, r, false) }

func (d *Deps) toggleFavorite(w http.ResponseWriter, r *http.Request, favorited bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	u, ok := middleware.UserFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_user",
			"favorites require an authenticated user context")
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.SetFavorite(r.Context(), t.ID, u.ID, id, favorited); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "favorited": favorited})
}
