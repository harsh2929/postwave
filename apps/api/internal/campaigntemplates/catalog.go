// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/listsearch"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	defaultCatalogPageSize = 24
	maxCatalogPageSize     = 100
	// Tags can be high-cardinality (for example, one source-brand tag per
	// imported reference). Keep the catalog response compact by returning the
	// most prevalent values while still accepting any valid tag in search
	// filters and saved searches.
	maxCatalogTagFacets = 100
)

// SearchFilter is the stable catalog contract shared by web, desktop, and MCP.
// Source accepts the existing ownership values (platform/mine/team/all); any
// other value is treated as a provider name for concise MCP calls.
type SearchFilter struct {
	Query         string
	Goal          string
	Category      string
	Source        string
	Provider      string
	Industry      string
	Style         string
	Layout        string
	Kind          string
	Tags          []string
	Featured      *bool
	FavoritedOnly bool
	UserID        string
	// Sort accepts recommended (default), name, or most_used.
	Sort     string
	Cursor   string
	Page     int
	PerPage  int
	Archived string
}

type FacetValue struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

type CatalogFacets struct {
	Goals      []FacetValue `json:"goals"`
	Categories []FacetValue `json:"categories"`
	Providers  []FacetValue `json:"providers"`
	Industries []FacetValue `json:"industries"`
	Styles     []FacetValue `json:"styles"`
	Layouts    []FacetValue `json:"layouts"`
	// Tags are human-authored organization labels (TMPL-041). System tags
	// (any containing ':') are excluded so only user-facing tags surface.
	Tags []FacetValue `json:"tags"`
}

type SearchResponse struct {
	Items      []Template    `json:"items"`
	Page       int           `json:"page"`
	PerPage    int           `json:"per_page"`
	Total      int           `json:"total"`
	NextCursor string        `json:"next_cursor,omitempty"`
	Facets     CatalogFacets `json:"facets"`
}

// Search returns a compact, bounded catalog page. Body HTML/MJML is omitted;
// callers fetch GET /campaign-templates/{id} only after selection.
func (r *Repo) Search(ctx context.Context, tenantID string, f SearchFilter) (*SearchResponse, error) {
	f, err := normalizeCatalogSearchFilter(f)
	if err != nil {
		return nil, err
	}
	if (f.Source == "mine" || f.Source == "team") &&
		strings.TrimSpace(f.UserID) == "" {
		return nil, ErrDiscoveryUserRequired
	}
	cursor, err := decodeCatalogCursor(f.Cursor, f, tenantID)
	if err != nil {
		return nil, err
	}
	if cursor.Page > 0 {
		f.Page = cursor.Page
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, f.UserID); err != nil {
		return nil, err
	}

	args := []any{f.UserID}
	where := []string{"t.review_status <> 'rejected'"}
	switch f.Archived {
	case "active":
		where = append(where, "t.archived_at IS NULL")
	case "archived":
		where = append(where, "t.archived_at IS NOT NULL")
	}
	addText := func(column, value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		args = append(args, value)
		where = append(where, fmt.Sprintf("LOWER(%s) = LOWER($%d)", column, len(args)))
	}

	if q := f.Query; q != "" {
		args = append(args, q)
		n := len(args)
		// The slug is the identifier people and agents quote
		// ("welcome-negative-promise"), so it is searchable like the name.
		where = append(where, fmt.Sprintf(`(
			t.name ILIKE '%%' || $%d || '%%'
			OR t.slug ILIKE '%%' || $%d || '%%'
			OR t.subject ILIKE '%%' || $%d || '%%'
			OR COALESCE(t.description, '') ILIKE '%%' || $%d || '%%'
			OR t.source_brand ILIKE '%%' || $%d || '%%'
			OR array_to_string(t.tags, ' ') ILIKE '%%' || $%d || '%%'
		)`, n, n, n, n, n, n))
	}
	addText("t.goal", f.Goal)
	addText("t.category", f.Category)
	addText("t.industry", f.Industry)
	addText("t.style", f.Style)
	addText("t.layout", f.Layout)
	if f.Kind != "" {
		kind, kindErr := canonicalTemplateKind(f.Kind)
		if kindErr != nil {
			return nil, kindErr
		}
		addText("t.template_kind", kind)
	}

	source := f.Source
	switch source {
	case "platform":
		where = append(where, "t.tenant_id IS NULL")
	case "mine":
		where = append(where, "t.tenant_id IS NOT NULL")
		if f.UserID != "" {
			args = append(args, f.UserID)
			where = append(where, fmt.Sprintf("t.created_by::text = $%d", len(args)))
		}
	case "team":
		where = append(where, "t.tenant_id IS NOT NULL")
		if f.UserID != "" {
			args = append(args, f.UserID)
			where = append(where, fmt.Sprintf("(t.created_by IS NULL OR t.created_by::text <> $%d)", len(args)))
		}
	case "", "all":
		// no ownership filter
	default:
		// normalizeCatalogSearchFilter maps provider aliases before this point.
	}
	addText("t.source_provider", f.Provider)

	if len(f.Tags) > 0 {
		args = append(args, f.Tags)
		where = append(where, fmt.Sprintf("t.tags && $%d::text[]", len(args)))
	}
	if f.Featured != nil {
		args = append(args, *f.Featured)
		where = append(where, fmt.Sprintf("t.is_featured = $%d", len(args)))
	}
	if f.FavoritedOnly {
		where = append(where, "fav.template_id IS NOT NULL")
	}

	baseWhere := strings.Join(where, " AND ")
	var total int
	countQuery := `
SELECT COUNT(*)::int
  FROM campaign_templates t
  LEFT JOIN template_favorites fav
    ON fav.template_id = t.id
   AND fav.user_id::text = NULLIF($1, '')
 WHERE ` + baseWhere
	if err := tx.QueryRow(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, err
	}

	cursorWhere := ""
	if cursor.Page > 0 {
		cursorWhere = catalogCursorWhere(&args, f.Sort, cursor)
	}
	args = append(args, f.PerPage+1)
	limitArg := len(args)
	offsetClause := ""
	if cursor.Page == 0 && f.Page > 1 {
		args = append(args, (f.Page-1)*f.PerPage)
		offsetClause = " OFFSET $" + strconv.Itoa(len(args))
	}
	query := `
SELECT t.id::text, COALESCE(t.tenant_id::text, ''), t.slug, t.name,
       COALESCE(t.description, ''), COALESCE(t.category, ''),
       t.subject, t.preview_text, '' AS body_html, '' AS body_mjml,
       t.variables, t.tags, t.created_at, t.updated_at,
       COALESCE(t.goal, ''), COALESCE(t.is_featured, false),
       COALESCE(t.usage_count, 0), t.last_used_at,
       (fav.template_id IS NOT NULL) AS is_favorited,
       t.template_kind, t.source_provider, COALESCE(t.source_external_id, ''),
       t.source_url, t.source_brand, t.thumbnail_url, t.source_captured_at,
       t.source_license_status, t.source_metadata, t.industry, t.style, t.layout,
	       t.design_metadata, t.review_status, t.quality_score::float8, t.content_hash,
	       t.imported_at, COALESCE(to_jsonb(t.reference_template_ids), '[]'::jsonb),
	       t.generation_metadata,
	       t.reference_adaptation_allowed, t.reference_direct_use_allowed,
	       COALESCE(t.reference_review_decision_id::text, ''),
	       t.reference_reviewed_at,
	       (t.body_html <> '') AS has_source_html,
	       (t.body_mjml <> '') AS has_source_mjml,
	       t.version, t.archived_at
  FROM campaign_templates t
  LEFT JOIN template_favorites fav
    ON fav.template_id = t.id
   AND fav.user_id::text = NULLIF($1, '')
 WHERE ` + baseWhere + cursorWhere + `
 ORDER BY ` + catalogOrderBy(f.Sort) + `
 LIMIT $` + strconv.Itoa(limitArg) + offsetClause

	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	items := make([]Template, 0, f.PerPage+1)
	for rows.Next() {
		var row catalogSearchRow
		if err := row.scan(rows); err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, row.Template)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	hasMore := len(items) > f.PerPage
	if hasMore {
		items = items[:f.PerPage]
	}
	if err := attachHostedPreviewAssets(ctx, tx, items); err != nil {
		return nil, err
	}

	facets, err := loadCatalogFacets(ctx, tx)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	out := &SearchResponse{Items: items, Page: f.Page, PerPage: f.PerPage, Total: total, Facets: facets}
	if hasMore && len(items) > 0 {
		out.NextCursor = encodeCatalogCursor(items[len(items)-1], f, tenantID, f.Page+1)
	}
	return out, nil
}

type catalogSearchRow struct {
	Template
}

func (r *catalogSearchRow) scan(row rowScanner) error {
	var varsRaw, sourceRaw, designRaw, refsRaw, generationRaw []byte
	err := row.Scan(
		&r.ID, &r.TenantID, &r.Slug, &r.Name, &r.Description, &r.Category,
		&r.Subject, &r.PreviewText, &r.BodyHTML, &r.BodyMJML, &varsRaw, &r.Tags,
		&r.CreatedAt, &r.UpdatedAt, &r.Goal, &r.IsFeatured, &r.UsageCount,
		&r.LastUsedAt, &r.IsFavorited, &r.TemplateKind, &r.SourceProvider,
		&r.SourceExternalID, &r.SourceURL, &r.SourceBrand, &r.ThumbnailURL,
		&r.SourceCapturedAt, &r.SourceLicenseStatus, &sourceRaw, &r.Industry,
		&r.Style, &r.Layout, &designRaw, &r.ReviewStatus, &r.QualityScore,
		&r.ContentHash, &r.ImportedAt, &refsRaw, &generationRaw,
		&r.ReferenceAdaptationAllowed, &r.ReferenceDirectUseAllowed,
		&r.ReferenceReviewDecisionID, &r.ReferenceReviewedAt,
		&r.HasSourceHTML, &r.HasSourceMJML, &r.Version, &r.ArchivedAt,
	)
	if err != nil {
		return err
	}
	_ = json.Unmarshal(varsRaw, &r.Variables)
	_ = json.Unmarshal(refsRaw, &r.ReferenceTemplateIDs)
	decodeJSONObject(sourceRaw, &r.SourceMetadata)
	decodeJSONObject(designRaw, &r.DesignMetadata)
	decodeJSONObject(generationRaw, &r.GenerationMetadata)
	if r.Variables == nil {
		r.Variables = []map[string]interface{}{}
	}
	if r.ReferenceTemplateIDs == nil {
		r.ReferenceTemplateIDs = []string{}
	}
	r.PreviewAssets = []TemplatePreviewAsset{}
	projectTemplate(&r.Template, unrestrictedTemplatePresentation)
	return nil
}

func normalizeCatalogSearchFilter(f SearchFilter) (SearchFilter, error) {
	if f.Page < 1 {
		f.Page = 1
	}
	if f.PerPage < 1 {
		f.PerPage = defaultCatalogPageSize
	}
	if f.PerPage > maxCatalogPageSize {
		f.PerPage = maxCatalogPageSize
	}
	var err error
	f.Archived, err = canonicalArchiveFilter(f.Archived)
	if err != nil {
		return SearchFilter{}, err
	}
	f.Goal, err = canonicalGoal(f.Goal)
	if err != nil {
		return SearchFilter{}, err
	}
	if strings.TrimSpace(f.Kind) != "" {
		f.Kind, err = canonicalTemplateKind(f.Kind)
		if err != nil {
			return SearchFilter{}, err
		}
	}
	f.Sort = strings.ToLower(strings.TrimSpace(f.Sort))
	if f.Sort == "" {
		f.Sort = "recommended"
	}
	switch f.Sort {
	case "recommended", "name", "most_used":
	default:
		return SearchFilter{}, ErrInvalidCatalogSort
	}
	f.Query = strings.TrimSpace(f.Query)
	f.Category = strings.ToLower(strings.TrimSpace(f.Category))
	f.Source = strings.ToLower(strings.TrimSpace(f.Source))
	f.Provider = strings.ToLower(strings.TrimSpace(f.Provider))
	f.Industry = strings.ToLower(strings.TrimSpace(f.Industry))
	f.Style = strings.ToLower(strings.TrimSpace(f.Style))
	f.Layout = strings.ToLower(strings.TrimSpace(f.Layout))
	if f.Source != "" && f.Source != "all" && f.Source != "platform" &&
		f.Source != "mine" && f.Source != "team" && f.Provider == "" {
		f.Provider = f.Source
	}
	rawTags := append([]string(nil), f.Tags...)
	tagSet := make(map[string]struct{}, len(rawTags))
	f.Tags = make([]string, 0, len(rawTags))
	for _, tag := range rawTags {
		tag = strings.ToLower(strings.TrimSpace(tag))
		if tag == "" {
			continue
		}
		if _, seen := tagSet[tag]; seen {
			continue
		}
		tagSet[tag] = struct{}{}
		f.Tags = append(f.Tags, tag)
	}
	sort.Strings(f.Tags)
	return f, nil
}

func catalogOrderBy(sortMode string) string {
	switch sortMode {
	case "name":
		return "LOWER(t.name) ASC, t.id ASC"
	case "most_used":
		return "COALESCE(t.usage_count, 0) DESC, t.created_at DESC, t.id ASC"
	default:
		return `COALESCE(t.is_featured, false) DESC,
		        COALESCE(t.quality_score, 0)::float8 DESC,
		        COALESCE(t.usage_count, 0) DESC,
		        t.created_at DESC, t.id ASC`
	}
}

func catalogCursorWhere(args *[]any, sortMode string, cursor catalogCursorPosition) string {
	add := func(value any) int {
		*args = append(*args, value)
		return len(*args)
	}
	switch sortMode {
	case "name":
		nameArg, idArg := add(cursor.Name), add(cursor.ID)
		return fmt.Sprintf(` AND (
			LOWER(t.name) > $%d OR
			(LOWER(t.name) = $%d AND t.id::text > $%d)
		)`, nameArg, nameArg, idArg)
	case "most_used":
		usageArg, createdArg, idArg := add(cursor.Usage), add(cursor.CreatedAt), add(cursor.ID)
		return fmt.Sprintf(` AND (
			COALESCE(t.usage_count, 0) < $%d OR
			(COALESCE(t.usage_count, 0) = $%d AND t.created_at < $%d) OR
			(COALESCE(t.usage_count, 0) = $%d AND t.created_at = $%d AND t.id::text > $%d)
		)`, usageArg, usageArg, createdArg, usageArg, createdArg, idArg)
	default:
		featuredArg := add(cursor.Featured)
		qualityArg := add(cursor.Quality)
		usageArg := add(cursor.Usage)
		createdArg := add(cursor.CreatedAt)
		idArg := add(cursor.ID)
		return fmt.Sprintf(` AND (
			COALESCE(t.is_featured, false) < $%d OR
			(COALESCE(t.is_featured, false) = $%d AND COALESCE(t.quality_score, 0)::float8 < $%d) OR
			(COALESCE(t.is_featured, false) = $%d AND COALESCE(t.quality_score, 0)::float8 = $%d AND COALESCE(t.usage_count, 0) < $%d) OR
			(COALESCE(t.is_featured, false) = $%d AND COALESCE(t.quality_score, 0)::float8 = $%d AND COALESCE(t.usage_count, 0) = $%d AND t.created_at < $%d) OR
			(COALESCE(t.is_featured, false) = $%d AND COALESCE(t.quality_score, 0)::float8 = $%d AND COALESCE(t.usage_count, 0) = $%d AND t.created_at = $%d AND t.id::text > $%d)
		)`,
			featuredArg,
			featuredArg, qualityArg,
			featuredArg, qualityArg, usageArg,
			featuredArg, qualityArg, usageArg, createdArg,
			featuredArg, qualityArg, usageArg, createdArg, idArg,
		)
	}
}

func loadCatalogFacets(ctx context.Context, tx pgx.Tx) (CatalogFacets, error) {
	rows, err := tx.Query(ctx, `
WITH facet_values AS (
    SELECT 'goals' AS dimension, COALESCE(goal, '') AS value, COUNT(*) AS n
      FROM campaign_templates WHERE review_status <> 'rejected' AND archived_at IS NULL GROUP BY goal
    UNION ALL
    SELECT 'categories', COALESCE(category, ''), COUNT(*)
      FROM campaign_templates WHERE review_status <> 'rejected' AND archived_at IS NULL GROUP BY category
    UNION ALL
    SELECT 'providers', source_provider, COUNT(*)
      FROM campaign_templates WHERE review_status <> 'rejected' AND archived_at IS NULL GROUP BY source_provider
    UNION ALL
    SELECT 'industries', industry, COUNT(*)
      FROM campaign_templates WHERE review_status <> 'rejected' AND archived_at IS NULL GROUP BY industry
    UNION ALL
    SELECT 'styles', style, COUNT(*)
      FROM campaign_templates WHERE review_status <> 'rejected' AND archived_at IS NULL GROUP BY style
    UNION ALL
    SELECT 'layouts', layout, COUNT(*)
      FROM campaign_templates WHERE review_status <> 'rejected' AND archived_at IS NULL GROUP BY layout
    UNION ALL
    SELECT 'tags', LOWER(tag), COUNT(*)
      FROM campaign_templates, unnest(tags) AS tag
     WHERE review_status <> 'rejected' AND archived_at IS NULL AND tag NOT LIKE '%:%'
     GROUP BY LOWER(tag)
), ranked_facets AS (
    SELECT dimension, value, n,
           ROW_NUMBER() OVER (
               PARTITION BY dimension
               ORDER BY n DESC, value
           ) AS facet_rank
      FROM facet_values
     WHERE value <> ''
)
SELECT dimension, value, n::int
  FROM ranked_facets
 WHERE dimension <> 'tags' OR facet_rank <= $1
 ORDER BY dimension, n DESC, value`, maxCatalogTagFacets)
	if err != nil {
		return CatalogFacets{}, err
	}
	defer rows.Close()
	out := CatalogFacets{
		Goals: []FacetValue{}, Categories: []FacetValue{}, Providers: []FacetValue{},
		Industries: []FacetValue{}, Styles: []FacetValue{}, Layouts: []FacetValue{},
		Tags: []FacetValue{},
	}
	for rows.Next() {
		var dimension string
		var value FacetValue
		if err := rows.Scan(&dimension, &value.Value, &value.Count); err != nil {
			return CatalogFacets{}, err
		}
		appendCatalogFacet(&out, dimension, value)
	}
	if err := rows.Err(); err != nil {
		return CatalogFacets{}, err
	}
	return out, nil
}

func appendCatalogFacet(out *CatalogFacets, dimension string, value FacetValue) {
	if out == nil {
		return
	}
	switch dimension {
	case "goals":
		out.Goals = append(out.Goals, value)
	case "categories":
		out.Categories = append(out.Categories, value)
	case "providers":
		out.Providers = append(out.Providers, value)
	case "industries":
		out.Industries = append(out.Industries, value)
	case "styles":
		out.Styles = append(out.Styles, value)
	case "layouts":
		out.Layouts = append(out.Layouts, value)
	case "tags":
		// Keep a second in-process guard so a future query rewrite cannot
		// accidentally re-introduce an unbounded response.
		if len(out.Tags) < maxCatalogTagFacets {
			out.Tags = append(out.Tags, value)
		}
	}
}

// Search handles GET /api/v1/campaign-templates/search.
func (d *Deps) Search(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	q := r.URL.Query()
	f := SearchFilter{
		Query:         listsearch.ReadQuery(q),
		Goal:          q.Get("goal"),
		Category:      q.Get("category"),
		Source:        q.Get("source"),
		Provider:      q.Get("provider"),
		Industry:      q.Get("industry"),
		Style:         q.Get("style"),
		Layout:        q.Get("layout"),
		Kind:          q.Get("kind"),
		Tags:          strings.Split(q.Get("tags"), ","),
		FavoritedOnly: q.Get("favorited") == "1" || q.Get("favorited") == "true",
		Sort:          q.Get("sort"),
		Page:          intQuery(q.Get("page"), 1),
		PerPage:       intQuery(q.Get("per_page"), defaultCatalogPageSize),
		Archived:      archiveFilterFromRequest(r),
	}
	if q.Get("page") == "" {
		f.Cursor = q.Get("cursor")
	}
	if raw := strings.TrimSpace(q.Get("featured")); raw != "" {
		v := raw == "1" || strings.EqualFold(raw, "true")
		f.Featured = &v
	}
	if user, ok := middleware.UserFromContext(r.Context()); ok && user != nil {
		f.UserID = user.ID
	}
	if (strings.EqualFold(strings.TrimSpace(f.Source), "mine") ||
		strings.EqualFold(strings.TrimSpace(f.Source), "team")) &&
		strings.TrimSpace(f.UserID) == "" {
		httperror.Write(
			w,
			http.StatusUnauthorized,
			"no_user",
			"source=mine and source=team require an authenticated user",
		)
		return
	}
	out, err := d.Repo.Search(r.Context(), tenant.ID, f)
	if err != nil {
		if errors.Is(err, ErrDiscoveryUserRequired) {
			httperror.Write(
				w,
				http.StatusUnauthorized,
				"no_user",
				"source=mine and source=team require an authenticated user",
			)
			return
		}
		if errors.Is(err, ErrInvalidGoal) || errors.Is(err, ErrInvalidTemplateKind) ||
			errors.Is(err, ErrInvalidArchiveFilter) || errors.Is(err, ErrInvalidCatalogSort) ||
			errors.Is(err, ErrInvalidCatalogCursor) {
			writeTemplateValidationError(w, err)
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	projectTemplatesForRequest(r.Context(), out.Items)
	writeJSON(w, http.StatusOK, out)
}

func intQuery(raw string, fallback int) int {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n < 1 {
		return fallback
	}
	return n
}
