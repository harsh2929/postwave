// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
)

const (
	maxRecentTemplates             = 100
	defaultRecentTemplateLimit     = 24
	maxCollectionTemplates         = 100
	maxDiscoveryCollections        = 100
	maxDiscoverySavedSearches      = 100
	discoveryStateJSONMaxBodyBytes = 64 << 10
)

var (
	ErrDiscoveryUserRequired     = errors.New("campaigntemplates: discovery state requires a user")
	ErrDiscoveryNameConflict     = errors.New("campaigntemplates: discovery state name already exists")
	ErrDiscoveryPrecondition     = errors.New("campaigntemplates: discovery state precondition failed")
	ErrDiscoveryIdempotencyKey   = errors.New("campaigntemplates: discovery state idempotency key invalid")
	ErrDiscoveryIdempotencyReuse = errors.New("campaigntemplates: discovery state idempotency key reused with different input")
	ErrInvalidDiscoveryName      = errors.New("campaigntemplates: invalid discovery state name")
	ErrCollectionNotFound        = errors.New("campaigntemplates: collection not found")
	ErrInvalidCollectionItems    = errors.New("campaigntemplates: invalid collection items")
	ErrSavedSearchNotFound       = errors.New("campaigntemplates: saved search not found")
	ErrInvalidSavedSearch        = errors.New("campaigntemplates: invalid saved search")
	ErrInvalidCompareSelection   = errors.New("campaigntemplates: compare requires two to four unique templates")
	ErrTemplateIdentifierMissing = errors.New("campaigntemplates: template identifier not found")
)

type RecentTemplateView struct {
	Template      Template  `json:"template"`
	ViewCount     int       `json:"view_count"`
	FirstViewedAt time.Time `json:"first_viewed_at"`
	LastViewedAt  time.Time `json:"last_viewed_at"`
}

type CampaignTemplateCollection struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	TemplateIDs []string   `json:"template_ids"`
	Items       []Template `json:"items,omitempty"`
	ItemCount   int        `json:"item_count"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	Version     int64      `json:"version"`
	ETag        string     `json:"etag"`
}

type CreateCampaignTemplateCollectionInput struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	TemplateIDs []string `json:"template_ids,omitempty"`
}

type UpdateCampaignTemplateCollectionInput struct {
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
}

type ReplaceCampaignTemplateCollectionItemsInput struct {
	TemplateIDs []string `json:"template_ids"`
}

// SavedSearchFilters deliberately excludes cursor/page. A saved search is a
// reusable query definition, never a stale location inside a result set.
type SavedSearchFilters struct {
	Query         string   `json:"q,omitempty"`
	Goal          string   `json:"goal,omitempty"`
	Category      string   `json:"category,omitempty"`
	Source        string   `json:"source,omitempty"`
	Provider      string   `json:"provider,omitempty"`
	Industry      string   `json:"industry,omitempty"`
	Style         string   `json:"style,omitempty"`
	Layout        string   `json:"layout,omitempty"`
	Kind          string   `json:"kind,omitempty"`
	Tags          []string `json:"tags,omitempty"`
	Featured      *bool    `json:"featured,omitempty"`
	FavoritedOnly bool     `json:"favorited,omitempty"`
	Archived      string   `json:"archived,omitempty"`
	Sort          string   `json:"sort,omitempty"`
}

type CampaignTemplateSavedSearch struct {
	ID              string                              `json:"id"`
	Name            string                              `json:"name"`
	Filters         SavedSearchFilters                  `json:"filters"`
	ObsoleteFilters []CampaignTemplateSavedSearchFilter `json:"obsolete_filters"`
	CreatedAt       time.Time                           `json:"created_at"`
	UpdatedAt       time.Time                           `json:"updated_at"`
	Version         int64                               `json:"version"`
	ETag            string                              `json:"etag"`
}

// CampaignTemplateSavedSearchFilter identifies one persisted taxonomy value
// that is no longer available in the authoritative visible catalog. Value is
// the exact persisted value so a caller can remove it from Filters and safely
// replace the definition through UpdateSavedSearch using the current ETag.
type CampaignTemplateSavedSearchFilter struct {
	Field string `json:"field"`
	Value string `json:"value"`
}

type CreateCampaignTemplateSavedSearchInput struct {
	Name    string             `json:"name"`
	Filters SavedSearchFilters `json:"filters"`
}

type UpdateCampaignTemplateSavedSearchInput struct {
	Name    *string             `json:"name,omitempty"`
	Filters *SavedSearchFilters `json:"filters,omitempty"`
}

type CompareTemplateItem struct {
	RequestedIdentifier string   `json:"requested_identifier"`
	MatchedBy           string   `json:"matched_by"`
	Template            Template `json:"template"`
}

type CompareTemplatesResponse struct {
	Items                  []CompareTemplateItem `json:"items"`
	UnavailableIdentifiers []string              `json:"unavailable_identifiers"`
}

type templateDiscoveryRepository interface {
	RecordRecentView(context.Context, string, string, string) (*RecentTemplateView, error)
	ListRecentViews(context.Context, string, string, int) ([]RecentTemplateView, error)
	ClearRecentViews(context.Context, string, string, string) (int64, error)
	ListCollections(context.Context, string, string) ([]CampaignTemplateCollection, error)
	GetCollection(context.Context, string, string, string) (*CampaignTemplateCollection, error)
	CreateCollection(context.Context, string, string, CreateCampaignTemplateCollectionInput) (*CampaignTemplateCollection, error)
	UpdateCollection(context.Context, string, string, string, UpdateCampaignTemplateCollectionInput) (*CampaignTemplateCollection, error)
	ReplaceCollectionItems(context.Context, string, string, string, []string) (*CampaignTemplateCollection, error)
	DeleteCollection(context.Context, string, string, string) (bool, error)
	CreateCollectionIdempotent(context.Context, string, string, string, CreateCampaignTemplateCollectionInput) (*CampaignTemplateCollection, error)
	UpdateCollectionIfVersion(context.Context, string, string, string, int64, UpdateCampaignTemplateCollectionInput) (*CampaignTemplateCollection, error)
	ReplaceCollectionItemsIfVersion(context.Context, string, string, string, int64, []string) (*CampaignTemplateCollection, error)
	DeleteCollectionIfVersion(context.Context, string, string, string, int64) (bool, error)
	ListSavedSearches(context.Context, string, string) ([]CampaignTemplateSavedSearch, error)
	GetSavedSearch(context.Context, string, string, string) (*CampaignTemplateSavedSearch, error)
	CreateSavedSearch(context.Context, string, string, CreateCampaignTemplateSavedSearchInput) (*CampaignTemplateSavedSearch, error)
	UpdateSavedSearch(context.Context, string, string, string, UpdateCampaignTemplateSavedSearchInput) (*CampaignTemplateSavedSearch, error)
	DeleteSavedSearch(context.Context, string, string, string) (bool, error)
	CreateSavedSearchIdempotent(context.Context, string, string, string, CreateCampaignTemplateSavedSearchInput) (*CampaignTemplateSavedSearch, error)
	UpdateSavedSearchIfVersion(context.Context, string, string, string, int64, UpdateCampaignTemplateSavedSearchInput) (*CampaignTemplateSavedSearch, error)
	DeleteSavedSearchIfVersion(context.Context, string, string, string, int64) (bool, error)
	CompareTemplates(context.Context, string, string, []string) (*CompareTemplatesResponse, error)
}

func collectionETag(collection *CampaignTemplateCollection) string {
	if collection == nil || collection.ID == "" || collection.Version < 1 {
		return ""
	}
	return httpcache.ETagStrong("campaign-template-collection", collection.ID, collection.Version)
}

func savedSearchETag(saved *CampaignTemplateSavedSearch) string {
	if saved == nil || saved.ID == "" || saved.Version < 1 {
		return ""
	}
	return httpcache.ETagStrong("campaign-template-saved-search", saved.ID, saved.Version)
}

func bindTemplateDiscoveryActor(ctx context.Context, tx pgx.Tx, userID string) error {
	userID = strings.TrimSpace(userID)
	if userID != "" {
		parsed, err := uuid.Parse(userID)
		if err != nil {
			return ErrDiscoveryUserRequired
		}
		userID = parsed.String()
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.user_id', $1, true)`, userID); err != nil {
		return fmt.Errorf("campaigntemplates: bind discovery actor: %w", err)
	}
	return nil
}

func requireDiscoveryUser(userID string) (string, error) {
	parsed, err := uuid.Parse(strings.TrimSpace(userID))
	if err != nil {
		return "", ErrDiscoveryUserRequired
	}
	return parsed.String(), nil
}

const discoveryTemplateSummaryColumns = `
t.id::text, COALESCE(t.tenant_id::text, ''), t.slug, t.name,
COALESCE(t.description, ''), COALESCE(t.category, ''),
t.subject, t.preview_text, '' AS body_html, '' AS body_mjml,
t.variables, t.tags, t.created_at, t.updated_at,
COALESCE(t.goal, ''), COALESCE(t.is_featured, false),
COALESCE(t.usage_count, 0), t.last_used_at,
EXISTS (
    SELECT 1 FROM template_favorites fav
     WHERE fav.template_id = t.id
       AND fav.user_id::text = $2
) AS is_favorited,
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
t.version, t.archived_at`

func getDiscoveryTemplateByIdentifier(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, userID, identifier string,
) (*Template, string, error) {
	row := tx.QueryRow(ctx, `
SELECT `+discoveryTemplateSummaryColumns+`,
       CASE WHEN t.id::text = $3 THEN 'id' ELSE 'slug' END
  FROM campaign_templates t
 WHERE t.review_status <> 'rejected'
   AND t.archived_at IS NULL
   AND (t.id::text = $3 OR LOWER(t.slug) = LOWER($3))
 ORDER BY CASE
            WHEN t.id::text = $3 THEN 0
            WHEN t.tenant_id = $1::uuid THEN 1
            ELSE 2
          END
 LIMIT 1`, tenantID, userID, strings.TrimSpace(identifier))
	var matchedBy string
	template, err := scanWithTrailingString(row, &matchedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", fmt.Errorf("%w: %s", ErrTemplateIdentifierMissing, identifier)
	}
	return template, matchedBy, err
}

// scanWithTrailingString mirrors scan while accepting one query-owned marker.
func scanWithTrailingString(row rowScanner, trailing *string) (*Template, error) {
	var template Template
	var varsRaw, sourceRaw, designRaw, refsRaw, generationRaw []byte
	if err := row.Scan(
		&template.ID, &template.TenantID, &template.Slug, &template.Name,
		&template.Description, &template.Category, &template.Subject,
		&template.PreviewText, &template.BodyHTML, &template.BodyMJML,
		&varsRaw, &template.Tags, &template.CreatedAt, &template.UpdatedAt,
		&template.Goal, &template.IsFeatured, &template.UsageCount,
		&template.LastUsedAt, &template.IsFavorited, &template.TemplateKind,
		&template.SourceProvider, &template.SourceExternalID, &template.SourceURL,
		&template.SourceBrand, &template.ThumbnailURL, &template.SourceCapturedAt,
		&template.SourceLicenseStatus, &sourceRaw, &template.Industry,
		&template.Style, &template.Layout, &designRaw, &template.ReviewStatus,
		&template.QualityScore, &template.ContentHash, &template.ImportedAt,
		&refsRaw, &generationRaw, &template.ReferenceAdaptationAllowed,
		&template.ReferenceDirectUseAllowed, &template.ReferenceReviewDecisionID,
		&template.ReferenceReviewedAt, &template.HasSourceHTML,
		&template.HasSourceMJML, &template.Version, &template.ArchivedAt, trailing,
	); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(varsRaw, &template.Variables)
	_ = json.Unmarshal(refsRaw, &template.ReferenceTemplateIDs)
	decodeJSONObject(sourceRaw, &template.SourceMetadata)
	decodeJSONObject(designRaw, &template.DesignMetadata)
	decodeJSONObject(generationRaw, &template.GenerationMetadata)
	if template.Variables == nil {
		template.Variables = []map[string]interface{}{}
	}
	if template.ReferenceTemplateIDs == nil {
		template.ReferenceTemplateIDs = []string{}
	}
	template.PreviewAssets = []TemplatePreviewAsset{}
	projectTemplate(&template, unrestrictedTemplatePresentation)
	return &template, nil
}

func (r *Repo) RecordRecentView(
	ctx context.Context, tenantID, userID, templateID string,
) (*RecentTemplateView, error) {
	userID, err := requireDiscoveryUser(userID)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, userID); err != nil {
		return nil, err
	}
	var view RecentTemplateView
	var canonicalID string
	err = tx.QueryRow(ctx, `
WITH visible AS MATERIALIZED (
    SELECT id
      FROM campaign_templates
     WHERE id::text = $3
       AND review_status <> 'rejected'
       AND archived_at IS NULL
), changed AS (
    INSERT INTO campaign_template_recent_views
        (tenant_id, user_id, template_id)
    SELECT $1::uuid, $2::uuid, id FROM visible
    ON CONFLICT (tenant_id, user_id, template_id) DO UPDATE
       SET view_count = campaign_template_recent_views.view_count + 1,
           last_viewed_at = now()
    RETURNING template_id::text, view_count, first_viewed_at, last_viewed_at
)
SELECT template_id, view_count, first_viewed_at, last_viewed_at FROM changed`,
		tenantID, userID, templateID,
	).Scan(&canonicalID, &view.ViewCount, &view.FirstViewedAt, &view.LastViewedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
DELETE FROM campaign_template_recent_views
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid
   AND template_id IN (
       SELECT template_id
         FROM campaign_template_recent_views
        WHERE tenant_id = $1::uuid AND user_id = $2::uuid
        ORDER BY last_viewed_at DESC, template_id ASC
        OFFSET $3
   )`, tenantID, userID, maxRecentTemplates); err != nil {
		return nil, err
	}
	template, _, err := getDiscoveryTemplateByIdentifier(ctx, tx, tenantID, userID, canonicalID)
	if err != nil {
		return nil, err
	}
	view.Template = *template
	if err := attachHostedPreviewAsset(ctx, tx, &view.Template); err != nil {
		return nil, err
	}
	return &view, tx.Commit(ctx)
}

func (r *Repo) ListRecentViews(
	ctx context.Context, tenantID, userID string, limit int,
) ([]RecentTemplateView, error) {
	userID, err := requireDiscoveryUser(userID)
	if err != nil {
		return nil, err
	}
	if limit < 1 {
		limit = defaultRecentTemplateLimit
	}
	if limit > maxRecentTemplates {
		limit = maxRecentTemplates
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, userID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT recent.template_id::text, recent.view_count,
       recent.first_viewed_at, recent.last_viewed_at
  FROM campaign_template_recent_views recent
  JOIN campaign_templates template ON template.id = recent.template_id
 WHERE recent.tenant_id = $1::uuid
   AND recent.user_id = $2::uuid
   AND template.review_status <> 'rejected'
   AND template.archived_at IS NULL
 ORDER BY recent.last_viewed_at DESC, recent.template_id ASC
 LIMIT $3`, tenantID, userID, limit)
	if err != nil {
		return nil, err
	}
	type recentRow struct {
		id string
		RecentTemplateView
	}
	raw := make([]recentRow, 0, limit)
	for rows.Next() {
		var item recentRow
		if err := rows.Scan(&item.id, &item.ViewCount, &item.FirstViewedAt, &item.LastViewedAt); err != nil {
			rows.Close()
			return nil, err
		}
		raw = append(raw, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]RecentTemplateView, 0, len(raw))
	for _, row := range raw {
		template, _, err := getDiscoveryTemplateByIdentifier(ctx, tx, tenantID, userID, row.id)
		if err != nil {
			return nil, err
		}
		row.Template = *template
		out = append(out, row.RecentTemplateView)
	}
	templates := make([]Template, len(out))
	for index := range out {
		templates[index] = out[index].Template
	}
	if err := attachHostedPreviewAssets(ctx, tx, templates); err != nil {
		return nil, err
	}
	for index := range out {
		out[index].Template = templates[index]
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ClearRecentViews(
	ctx context.Context, tenantID, userID, templateID string,
) (int64, error) {
	userID, err := requireDiscoveryUser(userID)
	if err != nil {
		return 0, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, userID); err != nil {
		return 0, err
	}
	query := `DELETE FROM campaign_template_recent_views
	           WHERE tenant_id = $1::uuid AND user_id = $2::uuid`
	args := []any{tenantID, userID}
	if strings.TrimSpace(templateID) != "" {
		query += ` AND template_id::text = $3`
		args = append(args, templateID)
	}
	tag, err := tx.Exec(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}

func validateDiscoveryName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 120 {
		return "", ErrInvalidDiscoveryName
	}
	return name, nil
}

func validateCollectionTemplateIDs(ids []string) ([]string, error) {
	if len(ids) > maxCollectionTemplates {
		return nil, ErrInvalidCollectionItems
	}
	out := make([]string, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, raw := range ids {
		id, err := uuid.Parse(strings.TrimSpace(raw))
		if err != nil {
			return nil, ErrInvalidCollectionItems
		}
		canonical := id.String()
		if _, exists := seen[canonical]; exists {
			return nil, ErrInvalidCollectionItems
		}
		seen[canonical] = struct{}{}
		out = append(out, canonical)
	}
	return out, nil
}

func discoveryStateDBError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return ErrDiscoveryNameConflict
	}
	return err
}

func (r *Repo) ListCollections(
	ctx context.Context, tenantID, userID string,
) ([]CampaignTemplateCollection, error) {
	userID, err := requireDiscoveryUser(userID)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, userID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT collection.id::text, collection.name, collection.description,
       collection.created_at, collection.updated_at, collection.version,
       COALESCE(
         array_agg(item.template_id::text ORDER BY item.position)
           FILTER (WHERE item.template_id IS NOT NULL),
         ARRAY[]::text[]
       ),
       COUNT(item.template_id)::int
  FROM campaign_template_collections collection
  LEFT JOIN campaign_template_collection_items item
    ON item.collection_id = collection.id
 WHERE collection.tenant_id = $1::uuid AND collection.user_id = $2::uuid
 GROUP BY collection.id
 ORDER BY collection.updated_at DESC, collection.id ASC
 LIMIT $3`, tenantID, userID, maxDiscoveryCollections)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CampaignTemplateCollection{}
	for rows.Next() {
		var collection CampaignTemplateCollection
		if err := rows.Scan(
			&collection.ID, &collection.Name, &collection.Description,
			&collection.CreatedAt, &collection.UpdatedAt, &collection.Version,
			&collection.TemplateIDs,
			&collection.ItemCount,
		); err != nil {
			return nil, err
		}
		collection.ETag = collectionETag(&collection)
		out = append(out, collection)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func getCollectionTx(
	ctx context.Context, tx pgx.Tx, tenantID, userID, collectionID string,
) (*CampaignTemplateCollection, error) {
	var collection CampaignTemplateCollection
	err := tx.QueryRow(ctx, `
SELECT id::text, name, description, created_at, updated_at, version
  FROM campaign_template_collections
 WHERE id::text = $3 AND tenant_id = $1::uuid AND user_id = $2::uuid`,
		tenantID, userID, collectionID,
	).Scan(&collection.ID, &collection.Name, &collection.Description,
		&collection.CreatedAt, &collection.UpdatedAt, &collection.Version)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrCollectionNotFound
	}
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT template_id::text
  FROM campaign_template_collection_items
 WHERE collection_id = $1::uuid
 ORDER BY position ASC`, collection.ID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		collection.TemplateIDs = append(collection.TemplateIDs, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	collection.Items = make([]Template, 0, len(collection.TemplateIDs))
	for _, id := range collection.TemplateIDs {
		template, _, err := getDiscoveryTemplateByIdentifier(ctx, tx, tenantID, userID, id)
		if errors.Is(err, ErrTemplateIdentifierMissing) {
			// Archived/rejected templates remain in durable membership but do
			// not become executable or previewable through a collection.
			continue
		}
		if err != nil {
			return nil, err
		}
		collection.Items = append(collection.Items, *template)
	}
	collection.ItemCount = len(collection.TemplateIDs)
	if err := attachHostedPreviewAssets(ctx, tx, collection.Items); err != nil {
		return nil, err
	}
	collection.ETag = collectionETag(&collection)
	return &collection, nil
}

func (r *Repo) GetCollection(
	ctx context.Context, tenantID, userID, collectionID string,
) (*CampaignTemplateCollection, error) {
	userID, err := requireDiscoveryUser(userID)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, userID); err != nil {
		return nil, err
	}
	collection, err := getCollectionTx(ctx, tx, tenantID, userID, collectionID)
	if err != nil {
		return nil, err
	}
	return collection, tx.Commit(ctx)
}

func lockCollectionTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, userID, collectionID string,
	expectedVersion int64,
) (int64, error) {
	var version int64
	err := tx.QueryRow(ctx, `
SELECT version
  FROM campaign_template_collections
 WHERE id::text = $3 AND tenant_id = $1::uuid AND user_id = $2::uuid
 FOR UPDATE`, tenantID, userID, collectionID).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrCollectionNotFound
	}
	if err != nil {
		return 0, err
	}
	if expectedVersion > 0 && version != expectedVersion {
		return 0, ErrDiscoveryPrecondition
	}
	return version, nil
}

func replaceCollectionItemsTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, userID, collectionID string,
	ids []string,
	expectedVersion int64,
	bumpVersion bool,
) error {
	if _, err := lockCollectionTx(
		ctx, tx, tenantID, userID, collectionID, expectedVersion,
	); err != nil {
		return err
	}
	currentRows, err := tx.Query(ctx, `
SELECT template_id::text FROM campaign_template_collection_items
 WHERE collection_id::text = $1 ORDER BY position`, collectionID)
	if err != nil {
		return err
	}
	current := []string{}
	for currentRows.Next() {
		var id string
		if err := currentRows.Scan(&id); err != nil {
			currentRows.Close()
			return err
		}
		current = append(current, id)
	}
	currentRows.Close()
	if err := currentRows.Err(); err != nil {
		return err
	}
	if equalStrings(current, ids) {
		return nil
	}
	for _, id := range ids {
		var visible bool
		if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM campaign_templates
     WHERE id::text = $1
       AND review_status <> 'rejected'
       AND archived_at IS NULL
)`, id).Scan(&visible); err != nil {
			return err
		}
		if !visible {
			return fmt.Errorf("%w: %s", ErrTemplateIdentifierMissing, id)
		}
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM campaign_template_collection_items WHERE collection_id::text = $1`,
		collectionID,
	); err != nil {
		return err
	}
	for position, id := range ids {
		if _, err := tx.Exec(ctx, `
INSERT INTO campaign_template_collection_items
    (tenant_id, user_id, collection_id, template_id, position)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)`,
			tenantID, userID, collectionID, id, position,
		); err != nil {
			return err
		}
	}
	if bumpVersion {
		_, err = tx.Exec(ctx, `
UPDATE campaign_template_collections SET updated_at = now()
 WHERE id::text = $1`, collectionID)
	}
	return err
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func normalizeDiscoveryIdempotencyKey(value string) (string, error) {
	if !utf8.ValidString(value) || strings.IndexFunc(value, unicode.IsControl) >= 0 {
		return "", ErrDiscoveryIdempotencyKey
	}
	value = strings.TrimSpace(value)
	if value == "" || len(value) > idempotency.MaxKeyLength {
		return "", ErrDiscoveryIdempotencyKey
	}
	return value, nil
}

func discoveryCreateRequestHash(resource string, input any) (string, error) {
	raw, err := httpcache.CanonicalJSON(input)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(append([]byte(resource+"\x00"), raw...))
	return fmt.Sprintf("%x", sum[:]), nil
}

func (r *Repo) CreateCollection(
	ctx context.Context, tenantID, userID string, in CreateCampaignTemplateCollectionInput,
) (*CampaignTemplateCollection, error) {
	return r.createCollection(ctx, tenantID, userID, "", in)
}

func (r *Repo) CreateCollectionIdempotent(
	ctx context.Context,
	tenantID, userID, idempotencyKey string,
	in CreateCampaignTemplateCollectionInput,
) (*CampaignTemplateCollection, error) {
	key, err := normalizeDiscoveryIdempotencyKey(idempotencyKey)
	if err != nil {
		return nil, err
	}
	return r.createCollection(ctx, tenantID, userID, key, in)
}

func (r *Repo) createCollection(
	ctx context.Context,
	tenantID, userID, idempotencyKey string,
	in CreateCampaignTemplateCollectionInput,
) (*CampaignTemplateCollection, error) {
	userID, err := requireDiscoveryUser(userID)
	if err != nil {
		return nil, err
	}
	in.Name, err = validateDiscoveryName(in.Name)
	if err != nil {
		return nil, err
	}
	if utf8.RuneCountInString(in.Description) > 1000 {
		return nil, ErrInvalidDiscoveryName
	}
	in.TemplateIDs, err = validateCollectionTemplateIDs(in.TemplateIDs)
	if err != nil {
		return nil, err
	}
	requestHash := ""
	if idempotencyKey != "" {
		requestHash, err = discoveryCreateRequestHash("campaign-template-collection", in)
		if err != nil {
			return nil, err
		}
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, userID); err != nil {
		return nil, err
	}
	var id string
	err = tx.QueryRow(ctx, `
INSERT INTO campaign_template_collections
    (tenant_id, user_id, name, description,
     create_idempotency_key, create_request_hash)
VALUES ($1::uuid, $2::uuid, $3, $4, NULLIF($5, ''), NULLIF($6, ''))
ON CONFLICT (tenant_id, user_id, create_idempotency_key)
    WHERE create_idempotency_key IS NOT NULL
DO NOTHING
RETURNING id::text`,
		tenantID, userID, in.Name, in.Description, idempotencyKey, requestHash,
	).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) && idempotencyKey != "" {
		var storedHash string
		err = tx.QueryRow(ctx, `
SELECT id::text, create_request_hash
  FROM campaign_template_collections
 WHERE tenant_id = $1::uuid
   AND user_id = $2::uuid
   AND create_idempotency_key = $3`,
			tenantID, userID, idempotencyKey,
		).Scan(&id, &storedHash)
		if err == nil && storedHash != requestHash {
			return nil, ErrDiscoveryIdempotencyReuse
		}
	}
	if err != nil {
		return nil, discoveryStateDBError(err)
	}
	collection, err := getCollectionTx(ctx, tx, tenantID, userID, id)
	if err != nil {
		return nil, err
	}
	if len(collection.TemplateIDs) == 0 && len(in.TemplateIDs) > 0 {
		if err := replaceCollectionItemsTx(
			ctx, tx, tenantID, userID, id, in.TemplateIDs, 0, false,
		); err != nil {
			return nil, err
		}
		collection, err = getCollectionTx(ctx, tx, tenantID, userID, id)
		if err != nil {
			return nil, err
		}
	} else if !equalStrings(collection.TemplateIDs, in.TemplateIDs) {
		// A durable key can only reach this branch when a historical row is
		// inconsistent with its stored request hash. Fail closed instead of
		// mutating the original create result.
		return nil, ErrDiscoveryIdempotencyReuse
	}
	return collection, tx.Commit(ctx)
}

func (r *Repo) UpdateCollection(
	ctx context.Context, tenantID, userID, collectionID string,
	in UpdateCampaignTemplateCollectionInput,
) (*CampaignTemplateCollection, error) {
	return r.updateCollection(ctx, tenantID, userID, collectionID, 0, in)
}

func (r *Repo) UpdateCollectionIfVersion(
	ctx context.Context,
	tenantID, userID, collectionID string,
	expectedVersion int64,
	in UpdateCampaignTemplateCollectionInput,
) (*CampaignTemplateCollection, error) {
	if expectedVersion < 1 {
		return nil, ErrDiscoveryPrecondition
	}
	return r.updateCollection(
		ctx, tenantID, userID, collectionID, expectedVersion, in,
	)
}

func (r *Repo) updateCollection(
	ctx context.Context,
	tenantID, userID, collectionID string,
	expectedVersion int64,
	in UpdateCampaignTemplateCollectionInput,
) (*CampaignTemplateCollection, error) {
	userID, err := requireDiscoveryUser(userID)
	if err != nil {
		return nil, err
	}
	if in.Name == nil && in.Description == nil {
		return nil, ErrInvalidDiscoveryName
	}
	if in.Name != nil {
		value, err := validateDiscoveryName(*in.Name)
		if err != nil {
			return nil, err
		}
		in.Name = &value
	}
	if in.Description != nil && utf8.RuneCountInString(*in.Description) > 1000 {
		return nil, ErrInvalidDiscoveryName
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, userID); err != nil {
		return nil, err
	}
	if _, err := lockCollectionTx(
		ctx, tx, tenantID, userID, collectionID, expectedVersion,
	); err != nil {
		return nil, err
	}
	var currentName, currentDescription string
	if err := tx.QueryRow(ctx, `
SELECT name, description
  FROM campaign_template_collections
 WHERE id::text = $3 AND tenant_id = $1::uuid AND user_id = $2::uuid`,
		tenantID, userID, collectionID,
	).Scan(&currentName, &currentDescription); err != nil {
		return nil, err
	}
	changed := (in.Name != nil && *in.Name != currentName) ||
		(in.Description != nil && *in.Description != currentDescription)
	if changed {
		_, err = tx.Exec(ctx, `
UPDATE campaign_template_collections
   SET name = COALESCE($4, name),
       description = COALESCE($5, description)
 WHERE id::text = $3 AND tenant_id = $1::uuid AND user_id = $2::uuid`,
			tenantID, userID, collectionID, in.Name, in.Description)
		if err != nil {
			return nil, discoveryStateDBError(err)
		}
	}
	collection, err := getCollectionTx(ctx, tx, tenantID, userID, collectionID)
	if err != nil {
		return nil, err
	}
	return collection, tx.Commit(ctx)
}

func (r *Repo) ReplaceCollectionItems(
	ctx context.Context, tenantID, userID, collectionID string, templateIDs []string,
) (*CampaignTemplateCollection, error) {
	return r.replaceCollectionItems(
		ctx, tenantID, userID, collectionID, 0, templateIDs,
	)
}

func (r *Repo) ReplaceCollectionItemsIfVersion(
	ctx context.Context,
	tenantID, userID, collectionID string,
	expectedVersion int64,
	templateIDs []string,
) (*CampaignTemplateCollection, error) {
	if expectedVersion < 1 {
		return nil, ErrDiscoveryPrecondition
	}
	return r.replaceCollectionItems(
		ctx, tenantID, userID, collectionID, expectedVersion, templateIDs,
	)
}

func (r *Repo) replaceCollectionItems(
	ctx context.Context,
	tenantID, userID, collectionID string,
	expectedVersion int64,
	templateIDs []string,
) (*CampaignTemplateCollection, error) {
	userID, err := requireDiscoveryUser(userID)
	if err != nil {
		return nil, err
	}
	templateIDs, err = validateCollectionTemplateIDs(templateIDs)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, userID); err != nil {
		return nil, err
	}
	if err := replaceCollectionItemsTx(
		ctx, tx, tenantID, userID, collectionID,
		templateIDs, expectedVersion, true,
	); err != nil {
		return nil, err
	}
	collection, err := getCollectionTx(ctx, tx, tenantID, userID, collectionID)
	if err != nil {
		return nil, err
	}
	return collection, tx.Commit(ctx)
}

func (r *Repo) DeleteCollection(
	ctx context.Context, tenantID, userID, collectionID string,
) (bool, error) {
	return r.deleteCollection(ctx, tenantID, userID, collectionID, 0)
}

func (r *Repo) DeleteCollectionIfVersion(
	ctx context.Context,
	tenantID, userID, collectionID string,
	expectedVersion int64,
) (bool, error) {
	if expectedVersion < 1 {
		return false, ErrDiscoveryPrecondition
	}
	return r.deleteCollection(
		ctx, tenantID, userID, collectionID, expectedVersion,
	)
}

func (r *Repo) deleteCollection(
	ctx context.Context,
	tenantID, userID, collectionID string,
	expectedVersion int64,
) (bool, error) {
	userID, err := requireDiscoveryUser(userID)
	if err != nil {
		return false, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, userID); err != nil {
		return false, err
	}
	if _, err := lockCollectionTx(
		ctx, tx, tenantID, userID, collectionID, expectedVersion,
	); err != nil {
		if expectedVersion == 0 && errors.Is(err, ErrCollectionNotFound) {
			return false, tx.Commit(ctx)
		}
		return false, err
	}
	tag, err := tx.Exec(ctx, `
DELETE FROM campaign_template_collections
 WHERE id::text = $3 AND tenant_id = $1::uuid AND user_id = $2::uuid`,
		tenantID, userID, collectionID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, tx.Commit(ctx)
}

func normalizeSavedSearchFilters(filters SavedSearchFilters) (SavedSearchFilters, error) {
	if utf8.RuneCountInString(filters.Query) > 500 ||
		len(filters.Tags) > 20 {
		return SavedSearchFilters{}, ErrInvalidSavedSearch
	}
	for _, value := range []string{
		filters.Category, filters.Source, filters.Provider, filters.Industry,
		filters.Style, filters.Layout, filters.Kind,
	} {
		if utf8.RuneCountInString(value) > 100 {
			return SavedSearchFilters{}, ErrInvalidSavedSearch
		}
	}
	for _, tag := range filters.Tags {
		if utf8.RuneCountInString(tag) > 80 {
			return SavedSearchFilters{}, ErrInvalidSavedSearch
		}
	}
	normalized, err := normalizeCatalogSearchFilter(filters.SearchFilter(""))
	if err != nil {
		return SavedSearchFilters{}, ErrInvalidSavedSearch
	}
	return savedFiltersFromSearchFilter(normalized), nil
}

func (filters SavedSearchFilters) SearchFilter(userID string) SearchFilter {
	return SearchFilter{
		Query: filters.Query, Goal: filters.Goal, Category: filters.Category,
		Source: filters.Source, Provider: filters.Provider, Industry: filters.Industry,
		Style: filters.Style, Layout: filters.Layout, Kind: filters.Kind,
		Tags: append([]string(nil), filters.Tags...), Featured: filters.Featured,
		FavoritedOnly: filters.FavoritedOnly, UserID: userID,
		Archived: filters.Archived, Sort: filters.Sort,
	}
}

func savedFiltersFromSearchFilter(filter SearchFilter) SavedSearchFilters {
	return SavedSearchFilters{
		Query: filter.Query, Goal: filter.Goal, Category: filter.Category,
		Source: filter.Source, Provider: filter.Provider, Industry: filter.Industry,
		Style: filter.Style, Layout: filter.Layout, Kind: filter.Kind,
		Tags: append([]string(nil), filter.Tags...), Featured: filter.Featured,
		FavoritedOnly: filter.FavoritedOnly, Archived: filter.Archived, Sort: filter.Sort,
	}
}

func scanSavedSearch(row rowScanner) (*CampaignTemplateSavedSearch, error) {
	var saved CampaignTemplateSavedSearch
	var raw []byte
	if err := row.Scan(
		&saved.ID, &saved.Name, &raw, &saved.CreatedAt, &saved.UpdatedAt,
		&saved.Version,
	); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &saved.Filters); err != nil {
		return nil, err
	}
	saved.ObsoleteFilters = []CampaignTemplateSavedSearchFilter{}
	saved.ETag = savedSearchETag(&saved)
	return &saved, nil
}

type savedSearchTaxonomyKey struct {
	field string
	value string
}

func savedSearchDynamicTaxonomyKeys(
	filters SavedSearchFilters,
) []savedSearchTaxonomyKey {
	keys := make([]savedSearchTaxonomyKey, 0, 7+len(filters.Tags))
	seen := make(map[savedSearchTaxonomyKey]struct{}, cap(keys))
	appendKey := func(field, value string) {
		value = strings.ToLower(strings.TrimSpace(value))
		key := savedSearchTaxonomyKey{field: field, value: value}
		if value == "" {
			return
		}
		if _, exists := seen[key]; exists {
			return
		}
		seen[key] = struct{}{}
		keys = append(keys, key)
	}
	appendKey("category", filters.Category)
	source := strings.ToLower(strings.TrimSpace(filters.Source))
	switch source {
	case "", "all", "platform", "mine", "team":
	default:
		// Search accepts a provider slug through source for concise clients.
		// Validate that alias against the same authoritative provider column.
		appendKey("source", filters.Source)
	}
	appendKey("provider", filters.Provider)
	appendKey("industry", filters.Industry)
	appendKey("style", filters.Style)
	appendKey("layout", filters.Layout)
	for _, tag := range filters.Tags {
		appendKey("tags", tag)
	}
	return keys
}

func obsoleteSavedSearchFilters(
	filters SavedSearchFilters,
	available map[savedSearchTaxonomyKey]struct{},
) []CampaignTemplateSavedSearchFilter {
	out := make([]CampaignTemplateSavedSearchFilter, 0)
	appendObsolete := func(field, value string) {
		out = append(out, CampaignTemplateSavedSearchFilter{
			Field: field,
			Value: value,
		})
	}
	if value := strings.TrimSpace(filters.Goal); value != "" {
		if _, err := canonicalGoal(value); err != nil {
			appendObsolete("goal", filters.Goal)
		}
	}
	dynamic := savedSearchDynamicTaxonomyKeys(filters)
	for _, candidate := range dynamic {
		if _, ok := available[candidate]; ok {
			continue
		}
		switch candidate.field {
		case "category":
			appendObsolete(candidate.field, filters.Category)
		case "source":
			appendObsolete(candidate.field, filters.Source)
		case "provider":
			appendObsolete(candidate.field, filters.Provider)
		case "industry":
			appendObsolete(candidate.field, filters.Industry)
		case "style":
			appendObsolete(candidate.field, filters.Style)
		case "layout":
			appendObsolete(candidate.field, filters.Layout)
		case "tags":
			// Preserve exact persisted spelling for safe list cleanup.
			for _, tag := range filters.Tags {
				if strings.EqualFold(strings.TrimSpace(tag), candidate.value) {
					appendObsolete(candidate.field, tag)
					break
				}
			}
		}
	}
	if value := strings.TrimSpace(filters.Kind); value != "" {
		if _, err := canonicalTemplateKind(value); err != nil {
			appendObsolete("kind", filters.Kind)
		}
	}
	if value := strings.TrimSpace(filters.Archived); value != "" {
		if _, err := canonicalArchiveFilter(value); err != nil {
			appendObsolete("archived", filters.Archived)
		}
	}
	if value := strings.ToLower(strings.TrimSpace(filters.Sort)); value != "" {
		switch value {
		case "recommended", "name", "most_used":
		default:
			appendObsolete("sort", filters.Sort)
		}
	}
	return out
}

// annotateSavedSearchObsoleteFilters checks only values actually persisted by
// the returned saved searches against the complete visible catalog taxonomy.
// It deliberately does not consume SearchResponse.Facets: tag facets are
// frequency-bounded for payload size and therefore are not authoritative.
func annotateSavedSearchObsoleteFilters(
	ctx context.Context,
	tx pgx.Tx,
	savedSearches ...*CampaignTemplateSavedSearch,
) error {
	requested := make(map[savedSearchTaxonomyKey]struct{})
	for _, saved := range savedSearches {
		if saved == nil {
			continue
		}
		saved.ObsoleteFilters = []CampaignTemplateSavedSearchFilter{}
		for _, key := range savedSearchDynamicTaxonomyKeys(saved.Filters) {
			requested[key] = struct{}{}
		}
	}
	available := make(map[savedSearchTaxonomyKey]struct{}, len(requested))
	if len(requested) > 0 {
		fields := make([]string, 0, len(requested))
		values := make([]string, 0, len(requested))
		for key := range requested {
			fields = append(fields, key.field)
			values = append(values, key.value)
		}
		rows, err := tx.Query(ctx, `
WITH requested(field, value) AS (
    SELECT * FROM unnest($1::text[], $2::text[])
), available(field, value) AS (
    SELECT requested.field, requested.value
      FROM requested
      JOIN campaign_templates
        ON requested.field = 'category'
       AND LOWER(campaign_templates.category) = requested.value
     WHERE campaign_templates.review_status <> 'rejected'
    UNION ALL
    SELECT requested.field, requested.value
      FROM requested
      JOIN campaign_templates
        ON requested.field IN ('source', 'provider')
       AND LOWER(campaign_templates.source_provider) = requested.value
     WHERE campaign_templates.review_status <> 'rejected'
    UNION ALL
    SELECT requested.field, requested.value
      FROM requested
      JOIN campaign_templates
        ON requested.field = 'industry'
       AND LOWER(campaign_templates.industry) = requested.value
     WHERE campaign_templates.review_status <> 'rejected'
    UNION ALL
    SELECT requested.field, requested.value
      FROM requested
      JOIN campaign_templates
        ON requested.field = 'style'
       AND LOWER(campaign_templates.style) = requested.value
     WHERE campaign_templates.review_status <> 'rejected'
    UNION ALL
    SELECT requested.field, requested.value
      FROM requested
      JOIN campaign_templates
        ON requested.field = 'layout'
       AND LOWER(campaign_templates.layout) = requested.value
     WHERE campaign_templates.review_status <> 'rejected'
    UNION ALL
    SELECT requested.field, requested.value
      FROM requested
      JOIN campaign_templates
        ON requested.field = 'tags'
      JOIN LATERAL unnest(campaign_templates.tags) AS tag
        ON LOWER(tag) = requested.value
     WHERE campaign_templates.review_status <> 'rejected'
)
SELECT DISTINCT field, value FROM available`,
			fields,
			values,
		)
		if err != nil {
			return err
		}
		for rows.Next() {
			var key savedSearchTaxonomyKey
			if err := rows.Scan(&key.field, &key.value); err != nil {
				rows.Close()
				return err
			}
			available[key] = struct{}{}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
	}
	for _, saved := range savedSearches {
		if saved != nil {
			saved.ObsoleteFilters = obsoleteSavedSearchFilters(
				saved.Filters,
				available,
			)
		}
	}
	return nil
}

func (r *Repo) ListSavedSearches(
	ctx context.Context, tenantID, userID string,
) ([]CampaignTemplateSavedSearch, error) {
	userID, err := requireDiscoveryUser(userID)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, userID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, name, filters, created_at, updated_at, version
  FROM campaign_template_saved_searches
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid
 ORDER BY updated_at DESC, id ASC
 LIMIT $3`, tenantID, userID, maxDiscoverySavedSearches)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CampaignTemplateSavedSearch{}
	for rows.Next() {
		saved, err := scanSavedSearch(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *saved)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	savedPointers := make([]*CampaignTemplateSavedSearch, len(out))
	for index := range out {
		savedPointers[index] = &out[index]
	}
	if err := annotateSavedSearchObsoleteFilters(
		ctx,
		tx,
		savedPointers...,
	); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) GetSavedSearch(
	ctx context.Context, tenantID, userID, savedSearchID string,
) (*CampaignTemplateSavedSearch, error) {
	userID, err := requireDiscoveryUser(userID)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, userID); err != nil {
		return nil, err
	}
	saved, err := scanSavedSearch(tx.QueryRow(ctx, `
SELECT id::text, name, filters, created_at, updated_at, version
  FROM campaign_template_saved_searches
 WHERE id::text = $3 AND tenant_id = $1::uuid AND user_id = $2::uuid`,
		tenantID, userID, savedSearchID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrSavedSearchNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := annotateSavedSearchObsoleteFilters(ctx, tx, saved); err != nil {
		return nil, err
	}
	return saved, tx.Commit(ctx)
}

func (r *Repo) CreateSavedSearch(
	ctx context.Context, tenantID, userID string, in CreateCampaignTemplateSavedSearchInput,
) (*CampaignTemplateSavedSearch, error) {
	return r.createSavedSearch(ctx, tenantID, userID, "", in)
}

func (r *Repo) CreateSavedSearchIdempotent(
	ctx context.Context,
	tenantID, userID, idempotencyKey string,
	in CreateCampaignTemplateSavedSearchInput,
) (*CampaignTemplateSavedSearch, error) {
	key, err := normalizeDiscoveryIdempotencyKey(idempotencyKey)
	if err != nil {
		return nil, err
	}
	return r.createSavedSearch(ctx, tenantID, userID, key, in)
}

func (r *Repo) createSavedSearch(
	ctx context.Context,
	tenantID, userID, idempotencyKey string,
	in CreateCampaignTemplateSavedSearchInput,
) (*CampaignTemplateSavedSearch, error) {
	userID, err := requireDiscoveryUser(userID)
	if err != nil {
		return nil, err
	}
	in.Name, err = validateDiscoveryName(in.Name)
	if err != nil {
		return nil, err
	}
	in.Filters, err = normalizeSavedSearchFilters(in.Filters)
	if err != nil {
		return nil, err
	}
	raw, _ := json.Marshal(in.Filters)
	requestHash := ""
	if idempotencyKey != "" {
		requestHash, err = discoveryCreateRequestHash("campaign-template-saved-search", in)
		if err != nil {
			return nil, err
		}
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, userID); err != nil {
		return nil, err
	}
	saved, err := scanSavedSearch(tx.QueryRow(ctx, `
INSERT INTO campaign_template_saved_searches
    (tenant_id, user_id, name, filters,
     create_idempotency_key, create_request_hash)
VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, NULLIF($5, ''), NULLIF($6, ''))
ON CONFLICT (tenant_id, user_id, create_idempotency_key)
    WHERE create_idempotency_key IS NOT NULL
DO NOTHING
RETURNING id::text, name, filters, created_at, updated_at, version`,
		tenantID, userID, in.Name, raw, idempotencyKey, requestHash))
	if errors.Is(err, pgx.ErrNoRows) && idempotencyKey != "" {
		var storedHash string
		saved, err = scanSavedSearch(tx.QueryRow(ctx, `
SELECT id::text, name, filters, created_at, updated_at, version
  FROM campaign_template_saved_searches
 WHERE tenant_id = $1::uuid
   AND user_id = $2::uuid
   AND create_idempotency_key = $3`,
			tenantID, userID, idempotencyKey))
		if err == nil {
			err = tx.QueryRow(ctx, `
SELECT create_request_hash
  FROM campaign_template_saved_searches
 WHERE id = $1::uuid`, saved.ID).Scan(&storedHash)
		}
		if err == nil && storedHash != requestHash {
			return nil, ErrDiscoveryIdempotencyReuse
		}
	}
	if err != nil {
		return nil, discoveryStateDBError(err)
	}
	if err := annotateSavedSearchObsoleteFilters(ctx, tx, saved); err != nil {
		return nil, err
	}
	return saved, tx.Commit(ctx)
}

func lockSavedSearchTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, userID, savedSearchID string,
	expectedVersion int64,
) (*CampaignTemplateSavedSearch, error) {
	saved, err := scanSavedSearch(tx.QueryRow(ctx, `
SELECT id::text, name, filters, created_at, updated_at, version
  FROM campaign_template_saved_searches
 WHERE id::text = $3 AND tenant_id = $1::uuid AND user_id = $2::uuid
 FOR UPDATE`, tenantID, userID, savedSearchID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrSavedSearchNotFound
	}
	if err != nil {
		return nil, err
	}
	if expectedVersion > 0 && saved.Version != expectedVersion {
		return nil, ErrDiscoveryPrecondition
	}
	return saved, nil
}

func (r *Repo) UpdateSavedSearch(
	ctx context.Context, tenantID, userID, savedSearchID string,
	in UpdateCampaignTemplateSavedSearchInput,
) (*CampaignTemplateSavedSearch, error) {
	return r.updateSavedSearch(ctx, tenantID, userID, savedSearchID, 0, in)
}

func (r *Repo) UpdateSavedSearchIfVersion(
	ctx context.Context,
	tenantID, userID, savedSearchID string,
	expectedVersion int64,
	in UpdateCampaignTemplateSavedSearchInput,
) (*CampaignTemplateSavedSearch, error) {
	if expectedVersion < 1 {
		return nil, ErrDiscoveryPrecondition
	}
	return r.updateSavedSearch(
		ctx, tenantID, userID, savedSearchID, expectedVersion, in,
	)
}

func (r *Repo) updateSavedSearch(
	ctx context.Context,
	tenantID, userID, savedSearchID string,
	expectedVersion int64,
	in UpdateCampaignTemplateSavedSearchInput,
) (*CampaignTemplateSavedSearch, error) {
	userID, err := requireDiscoveryUser(userID)
	if err != nil {
		return nil, err
	}
	if in.Name == nil && in.Filters == nil {
		return nil, ErrInvalidSavedSearch
	}
	if in.Name != nil {
		value, err := validateDiscoveryName(*in.Name)
		if err != nil {
			return nil, err
		}
		in.Name = &value
	}
	var raw []byte
	if in.Filters != nil {
		value, err := normalizeSavedSearchFilters(*in.Filters)
		if err != nil {
			return nil, err
		}
		in.Filters = &value
		raw, _ = json.Marshal(value)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, userID); err != nil {
		return nil, err
	}
	current, err := lockSavedSearchTx(
		ctx, tx, tenantID, userID, savedSearchID, expectedVersion,
	)
	if err != nil {
		return nil, err
	}
	currentRaw, _ := json.Marshal(current.Filters)
	changed := (in.Name != nil && *in.Name != current.Name) ||
		(in.Filters != nil && string(raw) != string(currentRaw))
	saved := current
	if changed {
		saved, err = scanSavedSearch(tx.QueryRow(ctx, `
UPDATE campaign_template_saved_searches
   SET name = COALESCE($4, name),
       filters = CASE WHEN $5::jsonb IS NULL THEN filters ELSE $5::jsonb END
 WHERE id::text = $3 AND tenant_id = $1::uuid AND user_id = $2::uuid
RETURNING id::text, name, filters, created_at, updated_at, version`,
			tenantID, userID, savedSearchID, in.Name, raw))
		if err != nil {
			return nil, discoveryStateDBError(err)
		}
	}
	if err := annotateSavedSearchObsoleteFilters(ctx, tx, saved); err != nil {
		return nil, err
	}
	return saved, tx.Commit(ctx)
}

func (r *Repo) DeleteSavedSearch(
	ctx context.Context, tenantID, userID, savedSearchID string,
) (bool, error) {
	return r.deleteSavedSearch(ctx, tenantID, userID, savedSearchID, 0)
}

func (r *Repo) DeleteSavedSearchIfVersion(
	ctx context.Context,
	tenantID, userID, savedSearchID string,
	expectedVersion int64,
) (bool, error) {
	if expectedVersion < 1 {
		return false, ErrDiscoveryPrecondition
	}
	return r.deleteSavedSearch(
		ctx, tenantID, userID, savedSearchID, expectedVersion,
	)
}

func (r *Repo) deleteSavedSearch(
	ctx context.Context,
	tenantID, userID, savedSearchID string,
	expectedVersion int64,
) (bool, error) {
	userID, err := requireDiscoveryUser(userID)
	if err != nil {
		return false, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, userID); err != nil {
		return false, err
	}
	if _, err := lockSavedSearchTx(
		ctx, tx, tenantID, userID, savedSearchID, expectedVersion,
	); err != nil {
		if expectedVersion == 0 && errors.Is(err, ErrSavedSearchNotFound) {
			return false, tx.Commit(ctx)
		}
		return false, err
	}
	tag, err := tx.Exec(ctx, `
DELETE FROM campaign_template_saved_searches
 WHERE id::text = $3 AND tenant_id = $1::uuid AND user_id = $2::uuid`,
		tenantID, userID, savedSearchID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, tx.Commit(ctx)
}

func normalizeCompareIdentifiers(identifiers []string) ([]string, error) {
	if len(identifiers) < 2 || len(identifiers) > 4 {
		return nil, ErrInvalidCompareSelection
	}
	out := make([]string, 0, len(identifiers))
	seen := make(map[string]struct{}, len(identifiers))
	for _, identifier := range identifiers {
		identifier = strings.TrimSpace(identifier)
		if identifier == "" || utf8.RuneCountInString(identifier) > 256 {
			return nil, ErrInvalidCompareSelection
		}
		key := strings.ToLower(identifier)
		if _, exists := seen[key]; exists {
			return nil, ErrInvalidCompareSelection
		}
		seen[key] = struct{}{}
		out = append(out, identifier)
	}
	return out, nil
}

func (r *Repo) CompareTemplates(
	ctx context.Context, tenantID, userID string, identifiers []string,
) (*CompareTemplatesResponse, error) {
	identifiers, err := normalizeCompareIdentifiers(identifiers)
	if err != nil {
		return nil, err
	}
	userID = strings.TrimSpace(userID)
	if userID != "" {
		userID, err = requireDiscoveryUser(userID)
		if err != nil {
			return nil, err
		}
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, userID); err != nil {
		return nil, err
	}
	out := &CompareTemplatesResponse{
		Items:                  make([]CompareTemplateItem, 0, len(identifiers)),
		UnavailableIdentifiers: make([]string, 0, len(identifiers)),
	}
	for _, identifier := range identifiers {
		template, matchedBy, err := getDiscoveryTemplateByIdentifier(
			ctx, tx, tenantID, userID, identifier,
		)
		if errors.Is(err, ErrTemplateIdentifierMissing) {
			out.UnavailableIdentifiers = append(
				out.UnavailableIdentifiers,
				identifier,
			)
			continue
		}
		if err != nil {
			return nil, err
		}
		out.Items = append(out.Items, CompareTemplateItem{
			RequestedIdentifier: identifier, MatchedBy: matchedBy, Template: *template,
		})
	}
	templates := make([]Template, len(out.Items))
	for index := range out.Items {
		templates[index] = out.Items[index].Template
	}
	if err := attachHostedPreviewAssets(ctx, tx, templates); err != nil {
		return nil, err
	}
	for index := range out.Items {
		out.Items[index].Template = templates[index]
	}
	return out, tx.Commit(ctx)
}
