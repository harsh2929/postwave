// SPDX-License-Identifier: AGPL-3.0-only
//
// Package campaigntemplates exposes the per-tenant + platform-shared
// campaign template library (migration 0048). Distinct from voice
// templates — voice owns AI-sequence definitions; campaign templates
// are concrete HTML/MJML snippets a tenant copies into a fresh draft.
package campaigntemplates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/listsearch"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Template is one row from campaign_templates.
//
// v2 (migration 0187) added Goal / IsFeatured / UsageCount /
// LastUsedAt / IsFavorited. Goal + IsFeatured are persisted columns;
// IsFavorited is a per-request flag joined in from template_favorites
// for the calling user. All five carry `omitempty` so legacy clients
// reading the JSON still see the original shape.
type Template struct {
	ID          string                   `json:"id"`
	TenantID    string                   `json:"tenant_id,omitempty"` // empty = platform template
	Slug        string                   `json:"slug"`
	Name        string                   `json:"name"`
	Description string                   `json:"description,omitempty"`
	Category    string                   `json:"category,omitempty"`
	Subject     string                   `json:"subject"`
	PreviewText string                   `json:"preview_text,omitempty"`
	BodyHTML    string                   `json:"body_html,omitempty"`
	BodyMJML    string                   `json:"body_mjml,omitempty"`
	Variables   []map[string]interface{} `json:"variables"`
	Tags        []string                 `json:"tags"`
	CreatedAt   time.Time                `json:"created_at"`
	UpdatedAt   time.Time                `json:"updated_at"`

	// v2 fields.
	Goal        string     `json:"goal,omitempty"`
	IsFeatured  bool       `json:"is_featured,omitempty"`
	UsageCount  int        `json:"usage_count,omitempty"`
	LastUsedAt  *time.Time `json:"last_used_at,omitempty"`
	IsFavorited bool       `json:"is_favorited,omitempty"`

	// Reference-library fields (migration 1748). A reference record carries
	// provenance and visual taxonomy but may intentionally have no reusable
	// HTML/MJML. Editable records are safe to hand directly to the composer.
	TemplateKind         string         `json:"template_kind,omitempty"`
	SourceProvider       string         `json:"source_provider,omitempty"`
	SourceExternalID     string         `json:"source_external_id,omitempty"`
	SourceURL            string         `json:"source_url,omitempty"`
	SourceBrand          string         `json:"source_brand,omitempty"`
	ThumbnailURL         string         `json:"thumbnail_url,omitempty"`
	SourceCapturedAt     *time.Time     `json:"source_captured_at,omitempty"`
	SourceLicenseStatus  string         `json:"source_license_status,omitempty"`
	SourceMetadata       map[string]any `json:"source_metadata,omitempty"`
	Industry             string         `json:"industry,omitempty"`
	Style                string         `json:"style,omitempty"`
	Layout               string         `json:"layout,omitempty"`
	DesignMetadata       map[string]any `json:"design_metadata,omitempty"`
	ReviewStatus         string         `json:"review_status,omitempty"`
	QualityScore         float64        `json:"quality_score"`
	ContentHash          string         `json:"content_hash,omitempty"`
	ImportedAt           *time.Time     `json:"imported_at,omitempty"`
	ReferenceTemplateIDs []string       `json:"reference_template_ids,omitempty"`
	GenerationMetadata   map[string]any `json:"generation_metadata,omitempty"`

	// Reference review state is maintained only by the append-only review
	// decision service. The raw grants are internal; clients consume the
	// request-aware Capabilities projection below.
	ReferenceAdaptationAllowed bool       `json:"-"`
	ReferenceDirectUseAllowed  bool       `json:"-"`
	ReferenceReviewDecisionID  string     `json:"reference_review_decision_id,omitempty"`
	ReferenceReviewedAt        *time.Time `json:"reference_reviewed_at,omitempty"`
	HasSourceHTML              bool       `json:"-"`
	HasSourceMJML              bool       `json:"-"`

	Version    int64      `json:"version"`
	ETag       string     `json:"etag"`
	ArchivedAt *time.Time `json:"archived_at,omitempty"`

	PreviewAssets     []TemplatePreviewAsset `json:"preview_assets"`
	Capabilities      TemplateCapabilities   `json:"capabilities"`
	RecommendedAction string                 `json:"recommended_action"`
	Warnings          []TemplateWarning      `json:"warnings"`
	// VariableRoles names every merge tag in the template that is not
	// ordinary content, with who fills it: "subscriber" (per recipient),
	// "workspace" (from workspace settings when a draft is created), or
	// "send_time" (the unsubscribe and archive links the send loop renders).
	// Tags that are absent are content the author or caller fills. Search
	// results carry no bodies, so there it reflects the variables, name,
	// subject, and preview text only.
	VariableRoles map[string]string `json:"variable_roles"`
}

// CreateInput is the trusted repository input shared by authoring, import, and
// generation workflows. The public POST uses the narrower authoringCreateInput
// contract below so callers cannot supply governance or lineage fields.
type CreateInput struct {
	Slug        string                   `json:"slug"`
	Name        string                   `json:"name"`
	Description string                   `json:"description,omitempty"`
	Category    string                   `json:"category,omitempty"`
	Subject     string                   `json:"subject"`
	PreviewText string                   `json:"preview_text,omitempty"`
	BodyHTML    string                   `json:"body_html,omitempty"`
	BodyMJML    string                   `json:"body_mjml,omitempty"`
	Variables   []map[string]interface{} `json:"variables,omitempty"`
	Tags        []string                 `json:"tags,omitempty"`
	// v2: goal taxonomy (welcome / newsletter / announcement /
	// promotional / re_engagement / transactional / automation).
	// Empty string accepted (NULLs out the column).
	Goal string `json:"goal,omitempty"`

	TemplateKind         string         `json:"template_kind,omitempty"`
	SourceProvider       string         `json:"source_provider,omitempty"`
	SourceExternalID     string         `json:"source_external_id,omitempty"`
	SourceURL            string         `json:"source_url,omitempty"`
	SourceBrand          string         `json:"source_brand,omitempty"`
	ThumbnailURL         string         `json:"thumbnail_url,omitempty"`
	SourceCapturedAt     *time.Time     `json:"source_captured_at,omitempty"`
	SourceLicenseStatus  string         `json:"source_license_status,omitempty"`
	SourceMetadata       map[string]any `json:"source_metadata,omitempty"`
	Industry             string         `json:"industry,omitempty"`
	Style                string         `json:"style,omitempty"`
	Layout               string         `json:"layout,omitempty"`
	DesignMetadata       map[string]any `json:"design_metadata,omitempty"`
	ReviewStatus         string         `json:"review_status,omitempty"`
	QualityScore         float64        `json:"quality_score,omitempty"`
	ContentHash          string         `json:"content_hash,omitempty"`
	ImportedAt           *time.Time     `json:"imported_at,omitempty"`
	ReferenceTemplateIDs []string       `json:"reference_template_ids,omitempty"`
	GenerationMetadata   map[string]any `json:"generation_metadata,omitempty"`
}

// authoringCreateInput is the public POST /campaign-templates contract.
//
// CreateInput is also used by trusted in-process import and generation paths,
// which need provenance and lineage fields. Decoding the public request into
// that wider struct allowed a normal editor to claim an external source was
// owned/reviewed or to forge generation lineage. Keep those fields visible
// here only so the strict decoder can return a deliberate validation error
// (and so older desktop clients that send empty lineage containers continue
// to work); they are never copied into the persisted authoring input.
type authoringCreateInput struct {
	Slug           string                   `json:"slug"`
	Name           string                   `json:"name"`
	Description    string                   `json:"description,omitempty"`
	Category       string                   `json:"category,omitempty"`
	Subject        string                   `json:"subject"`
	PreviewText    string                   `json:"preview_text,omitempty"`
	BodyHTML       string                   `json:"body_html,omitempty"`
	BodyMJML       string                   `json:"body_mjml,omitempty"`
	Variables      []map[string]interface{} `json:"variables,omitempty"`
	Tags           []string                 `json:"tags,omitempty"`
	Goal           string                   `json:"goal,omitempty"`
	Industry       string                   `json:"industry,omitempty"`
	Style          string                   `json:"style,omitempty"`
	Layout         string                   `json:"layout,omitempty"`
	ThumbnailURL   string                   `json:"thumbnail_url,omitempty"`
	DesignMetadata map[string]any           `json:"design_metadata,omitempty"`

	TemplateKind         string         `json:"template_kind,omitempty"`
	SourceProvider       string         `json:"source_provider,omitempty"`
	SourceExternalID     string         `json:"source_external_id,omitempty"`
	SourceURL            string         `json:"source_url,omitempty"`
	SourceBrand          string         `json:"source_brand,omitempty"`
	SourceCapturedAt     *time.Time     `json:"source_captured_at,omitempty"`
	SourceLicenseStatus  string         `json:"source_license_status,omitempty"`
	SourceMetadata       map[string]any `json:"source_metadata,omitempty"`
	ReviewStatus         string         `json:"review_status,omitempty"`
	QualityScore         *float64       `json:"quality_score,omitempty"`
	ContentHash          string         `json:"content_hash,omitempty"`
	ImportedAt           *time.Time     `json:"imported_at,omitempty"`
	ReferenceTemplateIDs []string       `json:"reference_template_ids,omitempty"`
	GenerationMetadata   map[string]any `json:"generation_metadata,omitempty"`
}

// UpdateInput is the body of PATCH /api/v1/campaign-templates/{id}.
type UpdateInput struct {
	Name           *string                   `json:"name,omitempty"`
	Description    *string                   `json:"description,omitempty"`
	Category       *string                   `json:"category,omitempty"`
	Subject        *string                   `json:"subject,omitempty"`
	PreviewText    *string                   `json:"preview_text,omitempty"`
	BodyHTML       *string                   `json:"body_html,omitempty"`
	BodyMJML       *string                   `json:"body_mjml,omitempty"`
	Variables      *[]map[string]interface{} `json:"variables,omitempty"`
	Tags           *[]string                 `json:"tags,omitempty"`
	Goal           *string                   `json:"goal,omitempty"`
	Industry       *string                   `json:"industry,omitempty"`
	Style          *string                   `json:"style,omitempty"`
	Layout         *string                   `json:"layout,omitempty"`
	ThumbnailURL   *string                   `json:"thumbnail_url,omitempty"`
	DesignMetadata *map[string]any           `json:"design_metadata,omitempty"`
	IfMatch        string                    `json:"-"`
	// ActorUserID is set server-side (from the session). Repo.Update publishes
	// it to the app.actor_user_id GUC so the revision-append trigger records
	// who made the edit (TMPL-040). Empty → NULL changed_by.
	ActorUserID string `json:"-"`
}

// ListFilter narrows the templates returned by List + the response
// enrichment surface. Empty fields mean "no filter".
type ListFilter struct {
	// Free-text — name, slug, OR subject ILIKE.
	Query string
	// Goal taxonomy. Must be one of the valid CHECK values (or "" for
	// "no filter"); unknown values are rejected rather than broadening a query.
	Goal string
	// Source — "platform" / "mine" / "team" / "all" (default). The
	// distinction between "mine" and "team" is by created_by relative
	// to UserID. When UserID is empty, "mine" and "team" both collapse
	// to "any tenant template".
	Source string
	// FavoritedOnly — when true, restrict results to those favorited
	// by UserID.
	FavoritedOnly bool
	// UserID — the calling user, used to compute IsFavorited and to
	// distinguish Source=mine vs Source=team.
	UserID string
	// Page / PerPage bound the deprecated array response. The legacy route
	// remains reachable for search pickers, but no longer returns the entire
	// catalog (or its HTML bodies) in one response.
	Page    int
	PerPage int
	// Archived accepts active (default), archived, or all.
	Archived string
}

// Errors.
var (
	ErrNotFound                  = errors.New("campaigntemplates: not found")
	ErrSlugConflict              = errors.New("campaigntemplates: slug already in use")
	ErrSourceConflict            = errors.New("campaigntemplates: source item already ingested")
	ErrInvalidSlug               = errors.New("campaigntemplates: slug must be lowercase alphanumeric or dashes")
	ErrInvalidGoal               = errors.New("campaigntemplates: invalid goal")
	ErrInvalidTemplateKind       = errors.New("campaigntemplates: invalid template kind")
	ErrInvalidReviewStatus       = errors.New("campaigntemplates: invalid review status")
	ErrRestrictedCreateFields    = errors.New("campaigntemplates: provenance, review, licensing, quality, import, and lineage fields are server controlled")
	ErrTemplateIneligible        = errors.New("campaigntemplates: template is not approved and owned")
	ErrReferenceCloneBlocked     = errors.New("campaigntemplates: reference templates must be adapted, not cloned")
	ErrReferenceMutationBlocked  = errors.New("campaigntemplates: reference templates must be adapted, not edited")
	ErrReferenceDeleteBlocked    = errors.New("campaigntemplates: reference templates are immutable and cannot be deleted")
	ErrTemplateArchived          = errors.New("campaigntemplates: archived templates must be restored before editing")
	ErrTemplatePrecondition      = errors.New("campaigntemplates: template precondition failed")
	ErrInvalidArchiveFilter      = errors.New("campaigntemplates: invalid archived filter")
	ErrReferenceReviewTarget     = errors.New("campaigntemplates: review target must be a tenant-owned reference")
	ErrInvalidReviewDecision     = errors.New("campaigntemplates: invalid reference review decision")
	ErrDirectUseLicenseRequired  = errors.New("campaigntemplates: direct use requires an owned source license")
	ErrReviewActorRequired       = errors.New("campaigntemplates: an auditable review actor is required")
	ErrInvalidReviewedDesign     = errors.New("campaigntemplates: invalid reviewed design")
	ErrTemplateReferenced        = errors.New("campaigntemplates: template is referenced by campaign or template lineage")
	ErrInvalidTemplateContent    = errors.New("campaigntemplates: template content is invalid or too large")
	ErrImportContentHashMismatch = errors.New("campaigntemplates: imported content hash does not match body html")
	ErrInvalidCatalogCursor      = errors.New("campaigntemplates: invalid catalog cursor")
	ErrInvalidCatalogSort        = errors.New("campaigntemplates: invalid catalog sort")
)

const (
	templateKindEditable      = "editable"
	templateKindReference     = "reference"
	reviewStatusPending       = "pending"
	reviewStatusApproved      = "approved"
	reviewStatusRejected      = "rejected"
	licenseStatusOwned        = "owned"
	licenseStatusUnreviewed   = "personal-use-unreviewed"
	defaultAuthorQualityScore = 0.5
)

const MaxSlugLength = 80
const MaxNameLength = 200
const campaignTemplateJSONMaxBodyBytes int64 = 2 << 20 // 2 MiB

const (
	maxTemplateSubjectRunes       = 998
	maxTemplatePreviewRunes       = 500
	maxTemplateBodyBytes          = 1 << 20
	maxTemplateCombinedBodyBytes  = 1536 << 10
	maxTemplateVariables          = 100
	maxTemplateVariablesJSONBytes = 64 << 10
	maxTemplateVariableKeys       = 32
	maxTemplateVariableKeyRunes   = 64
	maxTemplateTags               = 50
	maxTemplateTagRunes           = 120
	maxTemplateTagsJSONBytes      = 16 << 10
)

const (
	defaultLegacyListPageSize = 50
	maxLegacyListPageSize     = 100
	legacyListBodyProjection  = "''::text AS body_html, ''::text AS body_mjml"
)

var slugRE = regexp.MustCompile(`^[a-z][a-z0-9-]{0,79}$`)

func validateSlug(s string) error {
	if !slugRE.MatchString(s) {
		return ErrInvalidSlug
	}
	return nil
}

func validateTemplateVariables(variables []map[string]interface{}) error {
	if len(variables) > maxTemplateVariables {
		return fmt.Errorf("%w: at most %d variables are supported", ErrInvalidTemplateContent, maxTemplateVariables)
	}
	for _, variable := range variables {
		if len(variable) > maxTemplateVariableKeys {
			return fmt.Errorf("%w: variable definitions contain too many fields", ErrInvalidTemplateContent)
		}
		for key := range variable {
			if strings.TrimSpace(key) == "" || utf8.RuneCountInString(key) > maxTemplateVariableKeyRunes {
				return fmt.Errorf("%w: variable field name is invalid", ErrInvalidTemplateContent)
			}
		}
	}
	raw, err := json.Marshal(variables)
	if err != nil || len(raw) > maxTemplateVariablesJSONBytes {
		return fmt.Errorf("%w: variable definitions exceed %d bytes", ErrInvalidTemplateContent, maxTemplateVariablesJSONBytes)
	}
	return nil
}

func validateTemplateTags(tags []string) error {
	if len(tags) > maxTemplateTags {
		return fmt.Errorf("%w: at most %d tags are supported", ErrInvalidTemplateContent, maxTemplateTags)
	}
	for _, tag := range tags {
		if strings.TrimSpace(tag) == "" || utf8.RuneCountInString(tag) > maxTemplateTagRunes {
			return fmt.Errorf("%w: tags must be non-empty and at most %d characters", ErrInvalidTemplateContent, maxTemplateTagRunes)
		}
	}
	raw, err := json.Marshal(tags)
	if err != nil || len(raw) > maxTemplateTagsJSONBytes {
		return fmt.Errorf("%w: tags exceed %d bytes", ErrInvalidTemplateContent, maxTemplateTagsJSONBytes)
	}
	return nil
}

func validateTemplateContent(name, subject, preview, bodyHTML, bodyMJML string, variables []map[string]interface{}, tags []string) error {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > MaxNameLength {
		return fmt.Errorf("%w: name is required and must be at most %d bytes", ErrInvalidTemplateContent, MaxNameLength)
	}
	if utf8.RuneCountInString(subject) > maxTemplateSubjectRunes {
		return fmt.Errorf("%w: subject must be at most %d characters", ErrInvalidTemplateContent, maxTemplateSubjectRunes)
	}
	if utf8.RuneCountInString(preview) > maxTemplatePreviewRunes {
		return fmt.Errorf("%w: preview text must be at most %d characters", ErrInvalidTemplateContent, maxTemplatePreviewRunes)
	}
	if len(bodyHTML) > maxTemplateBodyBytes || len(bodyMJML) > maxTemplateBodyBytes ||
		len(bodyHTML)+len(bodyMJML) > maxTemplateCombinedBodyBytes {
		return fmt.Errorf("%w: template bodies exceed the permitted size", ErrInvalidTemplateContent)
	}
	if err := validateTemplateVariables(variables); err != nil {
		return err
	}
	return validateTemplateTags(tags)
}

func validateUpdateInput(in UpdateInput) error {
	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if name == "" || len(name) > MaxNameLength {
			return fmt.Errorf("%w: name is required and must be at most %d bytes", ErrInvalidTemplateContent, MaxNameLength)
		}
	}
	if in.Subject != nil && utf8.RuneCountInString(*in.Subject) > maxTemplateSubjectRunes {
		return fmt.Errorf("%w: subject must be at most %d characters", ErrInvalidTemplateContent, maxTemplateSubjectRunes)
	}
	if in.PreviewText != nil && utf8.RuneCountInString(*in.PreviewText) > maxTemplatePreviewRunes {
		return fmt.Errorf("%w: preview text must be at most %d characters", ErrInvalidTemplateContent, maxTemplatePreviewRunes)
	}
	if in.BodyHTML != nil && len(*in.BodyHTML) > maxTemplateBodyBytes {
		return fmt.Errorf("%w: HTML body exceeds the permitted size", ErrInvalidTemplateContent)
	}
	if in.BodyMJML != nil && len(*in.BodyMJML) > maxTemplateBodyBytes {
		return fmt.Errorf("%w: MJML body exceeds the permitted size", ErrInvalidTemplateContent)
	}
	if in.BodyHTML != nil && in.BodyMJML != nil && len(*in.BodyHTML)+len(*in.BodyMJML) > maxTemplateCombinedBodyBytes {
		return fmt.Errorf("%w: combined template bodies exceed the permitted size", ErrInvalidTemplateContent)
	}
	if in.Variables != nil {
		if err := validateTemplateVariables(*in.Variables); err != nil {
			return err
		}
	}
	if in.Tags != nil {
		if err := validateTemplateTags(*in.Tags); err != nil {
			return err
		}
	}
	return nil
}

func canonicalReferenceIDs(ids []string) ([]string, error) {
	out := make([]string, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, raw := range ids {
		parsed, err := uuid.Parse(strings.TrimSpace(raw))
		if err != nil {
			return nil, fmt.Errorf("%w: reference_template_ids must contain UUIDs", ErrInvalidTemplateContent)
		}
		id := parsed.String()
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out, nil
}

// lockTemplateReferences re-resolves every visible lineage row and holds a
// key-share lock until the derivative insert commits. It serializes with
// Delete's FOR UPDATE lock: either the derivative becomes visible before the
// delete dependency check, or deletion wins and creation fails ErrNotFound.
func lockTemplateReferences(ctx context.Context, tx pgx.Tx, tenantID string, referenceIDs []string) error {
	if len(referenceIDs) == 0 {
		return nil
	}
	rows, err := tx.Query(ctx, `
SELECT id::text
  FROM campaign_templates
 WHERE (tenant_id = $1::uuid OR tenant_id IS NULL)
   AND id = ANY($2::uuid[])
 ORDER BY id
 FOR KEY SHARE`, tenantID, referenceIDs)
	if err != nil {
		return err
	}
	defer rows.Close()
	found := 0
	for rows.Next() {
		found++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if found != len(referenceIDs) {
		return ErrNotFound
	}
	return nil
}

func legacyListBounds(page, perPage int) (int, int) {
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = defaultLegacyListPageSize
	}
	if perPage > maxLegacyListPageSize {
		perPage = maxLegacyListPageSize
	}
	return page, perPage
}

// Repo wraps the pgx pool.
type Repo struct {
	Pool *db.Pool
}

// templateRepository keeps the HTTP/workflow layer testable without weakening
// the production repository boundary. Tests embed this interface and override
// only the operations exercised by an adversarial case.
type templateRepository interface {
	List(context.Context, string, ListFilter) ([]Template, error)
	Search(context.Context, string, SearchFilter) (*SearchResponse, error)
	Get(context.Context, string, string) (*Template, error)
	GetByIDOrSlug(context.Context, string, string) (*Template, error)
	WorkspaceIdentity(context.Context, string) (WorkspaceIdentity, error)
	Create(context.Context, string, CreateInput) (*Template, error)
	Update(context.Context, string, string, UpdateInput) (*Template, error)
	Archive(context.Context, string, string, string) (*Template, error)
	Restore(context.Context, string, string, string) (*Template, error)
	Delete(context.Context, string, string, string) (*Template, error)
	ListRevisions(context.Context, string, string, int, int) (*TemplateRevisionPage, error)
	GetRevision(context.Context, string, string, int64) (*TemplateRevision, error)
	RestoreRevision(context.Context, string, string, int64, string) (*Template, error)
	GetStats(context.Context, string, string) (*Stats, error)
	GoalCounts(context.Context, string) ([]GoalCount, error)
	Clone(context.Context, string, string, CloneInput) (*Template, error)
	RecordUse(context.Context, string, string) error
	SetFavorite(context.Context, string, string, string, bool) error
	UpsertImported(context.Context, string, CreateInput) (*Template, bool, error)
	ReviewReference(context.Context, string, string, ReferenceReviewDecisionInput, ReferenceReviewActor) (*ReferenceReviewResult, error)
	// FlowUsage lists the flows whose current graph references this template
	// (FLOW-029 reverse "used by flows").
	FlowUsage(context.Context, string, string) ([]FlowUsageRef, error)
}

// List returns a compact, bounded page from the union of platform templates
// (tenant_id NULL) and the tenant's own templates, filtered + enriched per the
// supplied ListFilter. HTML/MJML bodies are intentionally omitted; callers
// fetch one full record with Get after selection. Featured platform rows
// surface first, then non-featured platform, then tenant rows by usage_count +
// created_at.
//
// Each row is enriched with `is_favorited` via a LEFT JOIN against
// template_favorites scoped to (tenant_id, UserID). When UserID is
// empty the join produces FALSE for every row (still cheap — empty
// uuid filter on the right side never matches).
//
// Backwards compatibility: the legacy `func List(ctx, tenantID, q string)`
// call shape has been replaced. Callers needing the old signature can
// pass ListFilter{Query: q}.
func (r *Repo) List(ctx context.Context, tenantID string, f ListFilter) ([]Template, error) {
	goal, err := canonicalGoal(f.Goal)
	if err != nil {
		return nil, err
	}
	f.Goal = goal
	archiveFilter, err := canonicalArchiveFilter(f.Archived)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, f.UserID); err != nil {
		return nil, err
	}

	// Build WHERE clauses incrementally. $1 is always the search
	// query (may be empty), $2 the user id for the favorites join
	// (may be empty UUID). Extra filters append after.
	args := []any{f.Query, f.UserID}
	where := []string{
		`t.review_status <> 'rejected'`,
		`($1 = '' OR (t.name ILIKE '%' || $1 || '%' OR t.slug ILIKE '%' || $1 || '%' OR t.subject ILIKE '%' || $1 || '%'))`,
	}
	switch archiveFilter {
	case "active":
		where = append(where, "t.archived_at IS NULL")
	case "archived":
		where = append(where, "t.archived_at IS NOT NULL")
	}
	if g := f.Goal; g != "" {
		args = append(args, g)
		where = append(where, fmt.Sprintf("t.goal = $%d", len(args)))
	}
	switch f.Source {
	case "platform":
		where = append(where, "t.tenant_id IS NULL")
	case "mine":
		if f.UserID != "" {
			args = append(args, f.UserID)
			where = append(where,
				fmt.Sprintf("t.tenant_id IS NOT NULL AND t.created_by::text = $%d", len(args)))
		} else {
			where = append(where, "t.tenant_id IS NOT NULL")
		}
	case "team":
		if f.UserID != "" {
			args = append(args, f.UserID)
			where = append(where,
				fmt.Sprintf("t.tenant_id IS NOT NULL AND (t.created_by IS NULL OR t.created_by::text <> $%d)", len(args)))
		} else {
			where = append(where, "t.tenant_id IS NOT NULL")
		}
	}
	if f.FavoritedOnly {
		where = append(where, "fav.template_id IS NOT NULL")
	}
	page, perPage := legacyListBounds(f.Page, f.PerPage)
	args = append(args, perPage, (page-1)*perPage)
	limitArg, offsetArg := len(args)-1, len(args)

	sqlQ := `
SELECT t.id::text, COALESCE(t.tenant_id::text, ''), t.slug, t.name,
       COALESCE(t.description, ''), COALESCE(t.category, ''),
       t.subject, t.preview_text, ` + legacyListBodyProjection + `,
       t.variables, t.tags, t.created_at, t.updated_at,
       COALESCE(t.goal, ''),
       COALESCE(t.is_featured, false),
       COALESCE(t.usage_count, 0),
       t.last_used_at,
       (fav.template_id IS NOT NULL) AS is_favorited,
       t.template_kind, t.source_provider,
       COALESCE(t.source_external_id, ''), t.source_url, t.source_brand,
       t.thumbnail_url, t.source_captured_at, t.source_license_status,
       t.source_metadata, t.industry, t.style, t.layout,
       t.design_metadata, t.review_status, t.quality_score::float8,
	       t.content_hash, t.imported_at,
	       COALESCE(to_jsonb(t.reference_template_ids), '[]'::jsonb),
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
   AND fav.user_id::text = NULLIF($2, '')
 WHERE ` + strings.Join(where, " AND ") + `
 ORDER BY (t.tenant_id IS NULL) DESC,
          COALESCE(t.is_featured, false) DESC,
          COALESCE(t.usage_count, 0) DESC,
		  t.created_at DESC, t.id
	LIMIT $` + fmt.Sprint(limitArg) + ` OFFSET $` + fmt.Sprint(offsetArg)

	rows, err := tx.Query(ctx, sqlQ, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Template{}
	for rows.Next() {
		t, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := attachHostedPreviewAssets(ctx, tx, out); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// userIDFromContext is a thin wrapper around middleware.UserFromContext
// that returns "" when there's no acting user. The Create path uses it
// to stamp created_by; absent user context produces a NULL.
func userIDFromContext(ctx context.Context) string {
	if u, ok := middleware.UserFromContext(ctx); ok {
		return u.ID
	}
	return ""
}

// validGoal mirrors the CHECK constraint added in migration 0187. Callers use
// canonicalGoal so an unknown value is rejected instead of broadening a read
// filter or relying on a database constraint to reject a write.
func validGoal(g string) bool {
	switch g {
	case "welcome", "newsletter", "announcement", "promotional",
		"re_engagement", "transactional", "automation":
		return true
	}
	return false
}

func canonicalGoal(goal string) (string, error) {
	goal = strings.ToLower(strings.TrimSpace(goal))
	if goal == "" {
		return "", nil
	}
	if !validGoal(goal) {
		return "", ErrInvalidGoal
	}
	return goal, nil
}

func canonicalArchiveFilter(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	switch value {
	case "", "active":
		return "active", nil
	case "archived", "all":
		return value, nil
	default:
		return "", ErrInvalidArchiveFilter
	}
}

func archiveFilterFromRequest(r *http.Request) string {
	value := strings.TrimSpace(r.URL.Query().Get("archived"))
	if value == "" {
		raw := strings.TrimSpace(r.URL.Query().Get("include_archived"))
		switch {
		case raw == "":
			return ""
		case raw == "1" || strings.EqualFold(raw, "true"):
			return "all"
		case raw == "0" || strings.EqualFold(raw, "false"):
			return "active"
		default:
			return "invalid"
		}
	}
	return value
}

func (in authoringCreateInput) trustedInput() (CreateInput, error) {
	goal, err := canonicalGoal(in.Goal)
	if err != nil {
		return CreateInput{}, err
	}
	if in.TemplateKind != "" {
		if _, err := canonicalTemplateKind(in.TemplateKind); err != nil {
			return CreateInput{}, err
		}
		return CreateInput{}, ErrRestrictedCreateFields
	}
	if in.ReviewStatus != "" {
		if _, err := canonicalReviewStatus(in.ReviewStatus); err != nil {
			return CreateInput{}, err
		}
		return CreateInput{}, ErrRestrictedCreateFields
	}
	if strings.TrimSpace(in.SourceProvider) != "" ||
		strings.TrimSpace(in.SourceExternalID) != "" ||
		strings.TrimSpace(in.SourceURL) != "" ||
		strings.TrimSpace(in.SourceBrand) != "" ||
		in.SourceCapturedAt != nil ||
		strings.TrimSpace(in.SourceLicenseStatus) != "" ||
		len(in.SourceMetadata) > 0 ||
		in.QualityScore != nil ||
		strings.TrimSpace(in.ContentHash) != "" ||
		in.ImportedAt != nil ||
		len(in.ReferenceTemplateIDs) > 0 ||
		len(in.GenerationMetadata) > 0 {
		return CreateInput{}, ErrRestrictedCreateFields
	}

	trusted := CreateInput{
		Slug: in.Slug, Name: in.Name, Description: in.Description,
		Category: in.Category, Subject: in.Subject, PreviewText: in.PreviewText,
		BodyHTML: in.BodyHTML, BodyMJML: in.BodyMJML, Variables: in.Variables,
		Tags: in.Tags, Goal: goal, Industry: in.Industry, Style: in.Style,
		Layout: in.Layout, ThumbnailURL: in.ThumbnailURL, DesignMetadata: in.DesignMetadata,
		TemplateKind: templateKindEditable, SourceProvider: "postwave",
		SourceLicenseStatus: licenseStatusOwned, ReviewStatus: reviewStatusApproved,
		QualityScore: defaultAuthorQualityScore, ReferenceTemplateIDs: []string{},
		GenerationMetadata: map[string]any{},
	}
	// Hand-authored templates have one source of truth. Keeping caller-supplied
	// HTML beside MJML lets an older HTML edit appear saved while campaign draft
	// creation recompiles the unchanged MJML over it.
	if strings.TrimSpace(trusted.BodyMJML) != "" {
		trusted.BodyHTML = ""
	}
	if err := validateTemplateContent(trusted.Name, trusted.Subject, trusted.PreviewText,
		trusted.BodyHTML, trusted.BodyMJML, trusted.Variables, trusted.Tags); err != nil {
		return CreateInput{}, err
	}
	return trusted, nil
}

// Get returns one template (platform OR tenant-owned). RLS lets
// tenant requests see their own + platform rows but never another
// tenant's templates.
func (r *Repo) Get(ctx context.Context, tenantID, id string) (*Template, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindTemplateDiscoveryActor(ctx, tx, userIDFromContext(ctx)); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT t.id::text, COALESCE(t.tenant_id::text, ''), t.slug, t.name,
       COALESCE(t.description, ''), COALESCE(t.category, ''),
       t.subject, t.preview_text, t.body_html, t.body_mjml,
       t.variables, t.tags, t.created_at, t.updated_at,
       COALESCE(t.goal, ''), COALESCE(t.is_featured, false),
       COALESCE(t.usage_count, 0), t.last_used_at,
       EXISTS (
           SELECT 1
             FROM template_favorites fav
            WHERE fav.tenant_id = $2::uuid
              AND fav.user_id::text = NULLIF($3, '')
              AND fav.template_id = t.id
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
	       t.version, t.archived_at
  FROM campaign_templates t
 WHERE t.id::text = $1`, id, tenantID, userIDFromContext(ctx))
	t, err := scan(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := attachHostedPreviewAsset(ctx, tx, t); err != nil {
		return nil, err
	}
	return t, tx.Commit(ctx)
}

// Create inserts a tenant-owned template. Platform templates are
// seeded by migration only — there's no public path to create one.
func (r *Repo) Create(ctx context.Context, tenantID string, in CreateInput) (*Template, error) {
	in.Slug = strings.TrimSpace(in.Slug)
	in.Name = strings.TrimSpace(in.Name)
	if err := validateSlug(in.Slug); err != nil {
		return nil, err
	}
	if err := validateTemplateContent(in.Name, in.Subject, in.PreviewText,
		in.BodyHTML, in.BodyMJML, in.Variables, in.Tags); err != nil {
		return nil, err
	}
	goal, err := canonicalGoal(in.Goal)
	if err != nil {
		return nil, err
	}
	// created_by is set when the request carries a user context.
	// Threaded from the handler via ctx-bound middleware.UserFromContext.
	userID := userIDFromContext(ctx)
	kind, err := canonicalTemplateKind(in.TemplateKind)
	if err != nil {
		return nil, err
	}
	provider := strings.ToLower(strings.TrimSpace(in.SourceProvider))
	if provider == "" {
		provider = "postwave"
	}
	licenseStatus := strings.TrimSpace(in.SourceLicenseStatus)
	if licenseStatus == "" {
		if provider == "postwave" {
			licenseStatus = "owned"
		} else {
			licenseStatus = "personal-use-unreviewed"
		}
	}
	reviewStatus, err := canonicalReviewStatus(in.ReviewStatus)
	if err != nil {
		return nil, err
	}
	qualityScore := in.QualityScore
	if qualityScore <= 0 {
		qualityScore = 0.5
	} else if qualityScore > 1 {
		qualityScore = 1
	}
	importedAt := in.ImportedAt
	if provider != "postwave" && importedAt == nil {
		now := time.Now().UTC()
		importedAt = &now
	}
	referenceIDs, err := canonicalReferenceIDs(in.ReferenceTemplateIDs)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockTemplateReferences(ctx, tx, tenantID, referenceIDs); err != nil {
		return nil, err
	}
	varsJSON, _ := json.Marshal(nilSlice(in.Variables))
	sourceMetadataJSON, _ := json.Marshal(nonNilObject(in.SourceMetadata))
	designMetadataJSON, _ := json.Marshal(nonNilObject(in.DesignMetadata))
	generationMetadataJSON, _ := json.Marshal(nonNilObject(in.GenerationMetadata))
	// tags column is NOT NULL DEFAULT '{}', so a nil Go slice must
	// be coerced to an empty array before the driver serializes it.
	tags := in.Tags
	if tags == nil {
		tags = []string{}
	}
	row := tx.QueryRow(ctx, `
INSERT INTO campaign_templates
    (tenant_id, slug, name, description, category, subject, preview_text,
     body_html, body_mjml, variables, tags, goal, created_by,
     template_kind, source_provider, source_external_id, source_url,
     source_brand, thumbnail_url, source_captured_at, source_license_status,
     source_metadata, industry, style, layout, design_metadata, review_status,
     quality_score, content_hash, imported_at, reference_template_ids,
     generation_metadata)
VALUES
    ($1::uuid, $2, $3, NULLIF($4, ''), NULLIF($5, ''),
     $6, $7, $8, $9, $10::jsonb, $11, NULLIF($12, ''),
     NULLIF($13, '')::uuid,
     $14, $15, NULLIF($16, ''), $17, $18, $19, $20, $21,
     $22::jsonb, $23, $24, $25, $26::jsonb, $27,
     $28, $29, $30, $31::uuid[], $32::jsonb)
RETURNING id::text, COALESCE(tenant_id::text, ''), slug, name,
          COALESCE(description, ''), COALESCE(category, ''),
          subject, preview_text, body_html, body_mjml,
          variables, tags, created_at, updated_at,
          COALESCE(goal, ''), COALESCE(is_featured, false),
          COALESCE(usage_count, 0), last_used_at,
          false AS is_favorited,
          template_kind, source_provider, COALESCE(source_external_id, ''),
          source_url, source_brand, thumbnail_url, source_captured_at,
	          source_license_status, source_metadata, industry, style, layout,
	          design_metadata, review_status, quality_score::float8, content_hash,
	          imported_at, COALESCE(to_jsonb(reference_template_ids), '[]'::jsonb),
	          generation_metadata,
	          reference_adaptation_allowed, reference_direct_use_allowed,
	          COALESCE(reference_review_decision_id::text, ''),
	          reference_reviewed_at,
	          (body_html <> '') AS has_source_html,
	          (body_mjml <> '') AS has_source_mjml,
	          version, archived_at`,
		tenantID, in.Slug, in.Name, in.Description, in.Category,
		in.Subject, in.PreviewText, in.BodyHTML, in.BodyMJML,
		string(varsJSON), tags, goal, userID,
		kind, provider, strings.TrimSpace(in.SourceExternalID), strings.TrimSpace(in.SourceURL),
		strings.TrimSpace(in.SourceBrand), strings.TrimSpace(in.ThumbnailURL), in.SourceCapturedAt,
		licenseStatus, string(sourceMetadataJSON), strings.TrimSpace(in.Industry),
		strings.TrimSpace(in.Style), strings.TrimSpace(in.Layout), string(designMetadataJSON),
		reviewStatus, qualityScore, strings.TrimSpace(in.ContentHash), importedAt,
		referenceIDs, string(generationMetadataJSON))
	t, err := scan(row)
	if err != nil {
		if isUniqueViolation(err) {
			if in.SourceExternalID != "" && strings.Contains(strings.ToLower(err.Error()), "source_external") {
				return nil, ErrSourceConflict
			}
			return nil, ErrSlugConflict
		}
		return nil, err
	}
	return t, tx.Commit(ctx)
}

// Source updates replace the previous format. MJML wins when both fields are
// supplied by an older client; an HTML-only patch retires stale MJML.
// Metadata-only patches preserve the source unchanged.
func applyAuthoringSourcePatch(template *Template, in UpdateInput) {
	if in.BodyHTML != nil {
		template.BodyHTML = *in.BodyHTML
	}
	if in.BodyMJML != nil {
		template.BodyMJML = *in.BodyMJML
	}
	if in.BodyMJML != nil && strings.TrimSpace(*in.BodyMJML) != "" {
		template.BodyHTML = ""
	} else if in.BodyHTML != nil {
		template.BodyMJML = ""
	} else if in.BodyMJML != nil {
		template.BodyHTML = ""
	}
}

// Update applies a partial patch. Tenants can only patch their own
// templates — RLS rejects writes to platform rows.
func (r *Repo) Update(ctx context.Context, tenantID, id string, in UpdateInput) (*Template, error) {
	if err := validateUpdateInput(in); err != nil {
		return nil, err
	}
	cur, err := r.Get(ctx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if cur.TenantID == "" {
		// Platform templates are shared and immutable to tenant callers. Keep
		// the response nondisclosing and consistent with Delete rather than
		// turning the authorization boundary into a 500 or UUID oracle.
		return nil, ErrNotFound
	}
	if cur.TemplateKind == templateKindReference {
		return nil, ErrReferenceMutationBlocked
	}
	if cur.ArchivedAt != nil {
		return nil, ErrTemplateArchived
	}
	if in.IfMatch == "" || in.IfMatch != templateETag(cur) {
		return nil, ErrTemplatePrecondition
	}
	if in.Name != nil {
		cur.Name = strings.TrimSpace(*in.Name)
	}
	if in.Description != nil {
		cur.Description = strings.TrimSpace(*in.Description)
	}
	if in.Category != nil {
		cur.Category = strings.TrimSpace(*in.Category)
	}
	if in.Subject != nil {
		cur.Subject = *in.Subject
	}
	if in.PreviewText != nil {
		cur.PreviewText = *in.PreviewText
	}
	applyAuthoringSourcePatch(cur, in)
	if in.Variables != nil {
		cur.Variables = *in.Variables
	}
	if in.Tags != nil {
		cur.Tags = *in.Tags
	}
	if in.Goal != nil {
		goal, goalErr := canonicalGoal(*in.Goal)
		if goalErr != nil {
			return nil, goalErr
		}
		cur.Goal = goal
	}
	if in.Industry != nil {
		cur.Industry = strings.TrimSpace(*in.Industry)
	}
	if in.Style != nil {
		cur.Style = strings.TrimSpace(*in.Style)
	}
	if in.Layout != nil {
		cur.Layout = strings.TrimSpace(*in.Layout)
	}
	if in.ThumbnailURL != nil {
		cur.ThumbnailURL = strings.TrimSpace(*in.ThumbnailURL)
	}
	if in.DesignMetadata != nil {
		cur.DesignMetadata = nonNilObject(*in.DesignMetadata)
	}
	if err := validateTemplateContent(cur.Name, cur.Subject, cur.PreviewText,
		cur.BodyHTML, cur.BodyMJML, cur.Variables, cur.Tags); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Publish the actor to a tx-local GUC so the revision-append trigger can
	// record who made this edit (TMPL-040). SET LOCAL scopes it to this tx.
	if in.ActorUserID != "" {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.actor_user_id', $1, true)`, in.ActorUserID); err != nil {
			return nil, err
		}
	}
	varsJSON, _ := json.Marshal(nilSlice(cur.Variables))
	designMetadataJSON, _ := json.Marshal(nonNilObject(cur.DesignMetadata))
	row := tx.QueryRow(ctx, `
UPDATE campaign_templates SET
    name = $3,
    description = NULLIF($4, ''),
    category = NULLIF($5, ''),
    subject = $6,
    preview_text = $7,
    body_html = $8,
    body_mjml = $9,
    variables = $10::jsonb,
    tags = $11,
    goal = NULLIF($12, ''),
    industry = $13,
    style = $14,
    layout = $15,
    thumbnail_url = $16,
    design_metadata = $17::jsonb,
    updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2 AND version = $18
RETURNING id::text, COALESCE(tenant_id::text, ''), slug, name,
          COALESCE(description, ''), COALESCE(category, ''),
          subject, preview_text, body_html, body_mjml,
          variables, tags, created_at, updated_at,
          COALESCE(goal, ''), COALESCE(is_featured, false),
          COALESCE(usage_count, 0), last_used_at,
          false AS is_favorited,
          template_kind, source_provider, COALESCE(source_external_id, ''),
          source_url, source_brand, thumbnail_url, source_captured_at,
	          source_license_status, source_metadata, industry, style, layout,
	          design_metadata, review_status, quality_score::float8, content_hash,
	          imported_at, COALESCE(to_jsonb(reference_template_ids), '[]'::jsonb),
	          generation_metadata,
	          reference_adaptation_allowed, reference_direct_use_allowed,
	          COALESCE(reference_review_decision_id::text, ''),
	          reference_reviewed_at,
	          (body_html <> '') AS has_source_html,
	          (body_mjml <> '') AS has_source_mjml,
	          version, archived_at`,
		tenantID, cur.ID, cur.Name, cur.Description, cur.Category,
		cur.Subject, cur.PreviewText, cur.BodyHTML, cur.BodyMJML,
		string(varsJSON), cur.Tags, cur.Goal, cur.Industry, cur.Style,
		cur.Layout, cur.ThumbnailURL, string(designMetadataJSON), cur.Version)
	t, err := scan(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTemplatePrecondition
		}
		return nil, err
	}
	return t, tx.Commit(ctx)
}

// Delete is a compatibility alias for safe archive. It never removes the row,
// so campaign attribution, template lineage, and revision history remain
// intact even when older clients still use DELETE.
func (r *Repo) Delete(ctx context.Context, tenantID, id, ifMatch string) (*Template, error) {
	return r.Archive(ctx, tenantID, id, ifMatch)
}

// rowScanner narrows pgx.Row + pgx.Rows so scan() works on both.
type rowScanner interface {
	Scan(dest ...any) error
}

// scan dispatches between the legacy 14-col Scan (Get / Create /
// Update RETURNING) and the v2 19-col Scan (List with favorites
// join). The wide form lives in scanWide; this helper keeps the
// older code paths working without a sweeping rewrite.
func scan(r rowScanner) (*Template, error) {
	// All existing call sites that hit this path SELECT 14 columns
	// in the original order. List rebinds to scanWide before calling.
	var t Template
	var varsRaw, sourceMetadataRaw, designMetadataRaw, referenceIDsRaw, generationMetadataRaw []byte
	if err := r.Scan(
		&t.ID, &t.TenantID, &t.Slug, &t.Name,
		&t.Description, &t.Category,
		&t.Subject, &t.PreviewText, &t.BodyHTML, &t.BodyMJML,
		&varsRaw, &t.Tags,
		&t.CreatedAt, &t.UpdatedAt,
		&t.Goal, &t.IsFeatured, &t.UsageCount, &t.LastUsedAt, &t.IsFavorited,
		&t.TemplateKind, &t.SourceProvider, &t.SourceExternalID,
		&t.SourceURL, &t.SourceBrand, &t.ThumbnailURL, &t.SourceCapturedAt,
		&t.SourceLicenseStatus, &sourceMetadataRaw, &t.Industry, &t.Style,
		&t.Layout, &designMetadataRaw, &t.ReviewStatus, &t.QualityScore,
		&t.ContentHash, &t.ImportedAt, &referenceIDsRaw, &generationMetadataRaw,
		&t.ReferenceAdaptationAllowed, &t.ReferenceDirectUseAllowed,
		&t.ReferenceReviewDecisionID, &t.ReferenceReviewedAt,
		&t.HasSourceHTML, &t.HasSourceMJML,
		&t.Version, &t.ArchivedAt,
	); err != nil {
		return nil, err
	}
	if len(varsRaw) > 0 {
		_ = json.Unmarshal(varsRaw, &t.Variables)
	}
	if t.Variables == nil {
		t.Variables = []map[string]interface{}{}
	}
	decodeJSONObject(sourceMetadataRaw, &t.SourceMetadata)
	decodeJSONObject(designMetadataRaw, &t.DesignMetadata)
	decodeJSONObject(generationMetadataRaw, &t.GenerationMetadata)
	if len(referenceIDsRaw) > 0 {
		_ = json.Unmarshal(referenceIDsRaw, &t.ReferenceTemplateIDs)
	}
	if t.ReferenceTemplateIDs == nil {
		t.ReferenceTemplateIDs = []string{}
	}
	t.PreviewAssets = []TemplatePreviewAsset{}
	projectTemplate(&t, unrestrictedTemplatePresentation)
	return &t, nil
}

func nilSlice(s []map[string]interface{}) []map[string]interface{} {
	if s == nil {
		return []map[string]interface{}{}
	}
	return s
}

func nonNilObject(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

func decodeJSONObject(raw []byte, out *map[string]any) {
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, out)
	}
	if *out == nil {
		*out = map[string]any{}
	}
}

func canonicalTemplateKind(kind string) (string, error) {
	kind = strings.ToLower(strings.TrimSpace(kind))
	switch kind {
	case "", templateKindEditable:
		return templateKindEditable, nil
	case templateKindReference:
		return templateKindReference, nil
	default:
		return "", ErrInvalidTemplateKind
	}
}

func canonicalReviewStatus(status string) (string, error) {
	status = strings.ToLower(strings.TrimSpace(status))
	switch status {
	case "", reviewStatusApproved:
		return reviewStatusApproved, nil
	case reviewStatusPending, reviewStatusRejected:
		return status, nil
	default:
		return "", ErrInvalidReviewStatus
	}
}

// ValidateTemplateEligibility is the direct-execution gate. Exact owned +
// approved governance remains mandatory. References additionally require an
// explicit audited direct-use grant; an adaptation-only decision can never
// make captured third-party content executable.
func ValidateTemplateEligibility(template *Template) error {
	if template == nil {
		return ErrNotFound
	}
	if template.ArchivedAt != nil {
		return ErrTemplateIneligible
	}
	kind, err := canonicalTemplateKind(template.TemplateKind)
	if err != nil {
		return ErrTemplateIneligible
	}
	if template.ReviewStatus != reviewStatusApproved || template.SourceLicenseStatus != licenseStatusOwned {
		return ErrTemplateIneligible
	}
	if kind == templateKindReference && !template.ReferenceDirectUseAllowed {
		return ErrTemplateIneligible
	}
	return nil
}

// ValidateTemplateAdaptationEligibility is the generation-inspiration gate.
// Editable templates retain the strict direct-use gate. References may instead
// pass with an audited adaptation grant, without changing or claiming
// ownership of the captured source.
func ValidateTemplateAdaptationEligibility(template *Template) error {
	if template == nil {
		return ErrNotFound
	}
	if template.ArchivedAt != nil {
		return ErrTemplateIneligible
	}
	kind, err := canonicalTemplateKind(template.TemplateKind)
	if err != nil {
		return ErrTemplateIneligible
	}
	if kind == templateKindEditable {
		return ValidateTemplateEligibility(template)
	}
	if template.ReviewStatus != reviewStatusApproved || !template.ReferenceAdaptationAllowed {
		return ErrTemplateIneligible
	}
	return nil
}

// isUniqueViolation matches the pg error code for a unique-index
// collision (slug conflict).
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "23505") ||
		strings.Contains(err.Error(), "duplicate key")
}

// ----------------------------------------------------------------------
// HTTP handlers
// ----------------------------------------------------------------------

type Deps struct {
	Repo       templateRepository
	ReviewPool *db.Pool
	Designs    DesignDraftStore
	Previews   PreviewAssetEnqueuer
	Campaigns  CampaignCreator
	Generator  TemplateGenerator
	// Logger is used by httperror.WriteInternal to record server-side
	// error detail without echoing it to callers. Optional; nil is
	// tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	// Accept ?query= (desktop UI canonical) and ?q= (legacy clients).
	f := ListFilter{
		Query:         listsearch.ReadQuery(r.URL.Query()),
		Goal:          strings.TrimSpace(r.URL.Query().Get("goal")),
		Source:        strings.TrimSpace(r.URL.Query().Get("source")),
		FavoritedOnly: r.URL.Query().Get("favorited") == "1" || r.URL.Query().Get("favorited") == "true",
		Page:          intQuery(r.URL.Query().Get("page"), 1),
		PerPage:       intQuery(r.URL.Query().Get("per_page"), defaultLegacyListPageSize),
		Archived:      archiveFilterFromRequest(r),
	}
	f.Page, f.PerPage = legacyListBounds(f.Page, f.PerPage)
	if u, ok := middleware.UserFromContext(r.Context()); ok {
		f.UserID = u.ID
	}
	out, err := d.Repo.List(r.Context(), t.ID, f)
	if err != nil {
		if errors.Is(err, ErrInvalidGoal) || errors.Is(err, ErrInvalidArchiveFilter) {
			writeTemplateValidationError(w, err)
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.Header().Set("X-Page", fmt.Sprint(f.Page))
	w.Header().Set("X-Per-Page", fmt.Sprint(f.PerPage))
	if len(out) == f.PerPage {
		w.Header().Set("X-Next-Page", fmt.Sprint(f.Page+1))
	}
	w.Header().Set("Link", `</api/v1/campaign-templates/search>; rel="successor-version"`)
	projectTemplatesForRequest(r.Context(), out)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	// {id} accepts the template's UUID or its slug, so a quoted name such as
	// "welcome-negative-promise" resolves instead of 404ing.
	id := chi.URLParam(r, "id")
	tpl, err := d.Repo.GetByIDOrSlug(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	projectTemplateForRequest(r.Context(), tpl)
	w.Header().Set("ETag", tpl.ETag)
	writeJSON(w, http.StatusOK, tpl)
}

func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var publicIn authoringCreateInput
	if err := httpbody.DecodeJSON(w, r, campaignTemplateJSONMaxBodyBytes, &publicIn); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in, err := publicIn.trustedInput()
	if err != nil {
		writeTemplateValidationError(w, err)
		return
	}
	tpl, err := d.Repo.Create(r.Context(), t.ID, in)
	if err != nil {
		switch {
		case errors.Is(err, ErrSlugConflict):
			httperror.Write(w, http.StatusConflict, "slug_conflict",
				fmt.Sprintf("a template with slug %q already exists", in.Slug))
		case errors.Is(err, ErrSourceConflict):
			httperror.Write(w, http.StatusConflict, "source_conflict",
				"this source item has already been ingested")
		case errors.Is(err, ErrInvalidSlug):
			httperror.WriteValidation(w, "invalid_slug", err.Error())
		case errors.Is(err, ErrInvalidGoal), errors.Is(err, ErrInvalidTemplateKind),
			errors.Is(err, ErrInvalidReviewStatus), errors.Is(err, ErrRestrictedCreateFields),
			errors.Is(err, ErrInvalidTemplateContent):
			writeTemplateValidationError(w, err)
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	projectTemplateForRequest(r.Context(), tpl)
	w.Header().Set("ETag", tpl.ETag)
	writeJSON(w, http.StatusCreated, tpl)
}

func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, campaignTemplateJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := validateUpdateInput(in); err != nil {
		writeTemplateValidationError(w, err)
		return
	}
	ifMatch, ok := requireTemplateIfMatch(w, r)
	if !ok {
		return
	}
	in.IfMatch = ifMatch
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		in.ActorUserID = u.ID
	}
	tpl, err := d.Repo.Update(r.Context(), t.ID, id, in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "")
			return
		}
		if errors.Is(err, ErrInvalidGoal) || errors.Is(err, ErrInvalidTemplateContent) {
			writeTemplateValidationError(w, err)
			return
		}
		if errors.Is(err, ErrReferenceMutationBlocked) {
			httperror.Write(w, http.StatusUnprocessableEntity, "adaptation_required",
				"Reference templates are read-only. Use Make it mine to create an editable copy.")
			return
		}
		if errors.Is(err, ErrTemplatePrecondition) {
			httpcache.WritePreconditionFailed(w)
			return
		}
		if errors.Is(err, ErrTemplateArchived) {
			httperror.Write(w, http.StatusConflict, "template_archived",
				"Restore the template before editing it.")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	projectTemplateForRequest(r.Context(), tpl)
	w.Header().Set("ETag", tpl.ETag)
	writeJSON(w, http.StatusOK, tpl)
}

func writeTemplateValidationError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalidGoal):
		httperror.WriteValidation(w, "invalid_goal", "goal is not supported")
	case errors.Is(err, ErrInvalidTemplateKind):
		httperror.WriteValidation(w, "invalid_template_kind", "template_kind is not supported")
	case errors.Is(err, ErrInvalidReviewStatus):
		httperror.WriteValidation(w, "invalid_review_status", "review_status is not supported")
	case errors.Is(err, ErrInvalidArchiveFilter):
		httperror.WriteValidation(w, "invalid_archived_filter", "archived must be active, archived, or all")
	case errors.Is(err, ErrInvalidCatalogCursor):
		httperror.WriteValidation(w, "invalid_cursor", "cursor is invalid or does not match the current catalog filters")
	case errors.Is(err, ErrInvalidCatalogSort):
		httperror.WriteValidation(w, "invalid_sort", "sort must be recommended, name, or most_used")
	case errors.Is(err, ErrRestrictedCreateFields):
		httperror.WriteValidation(w, "server_controlled_fields", "provenance, review, licensing, quality, import, and lineage fields are server controlled")
	case errors.Is(err, ErrInvalidTemplateContent):
		httperror.WriteValidation(w, "invalid_template_content", "template content is missing, invalid, or exceeds an authoring limit")
	default:
		httperror.WriteValidation(w, "invalid_template", "template input is invalid")
	}
}

func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	ifMatch, ok := requireTemplateIfMatch(w, r)
	if !ok {
		return
	}
	tpl, err := d.Repo.Delete(r.Context(), t.ID, id, ifMatch)
	if err != nil {
		writeTemplateLifecycleError(w, r, d, err)
		return
	}
	projectTemplateForRequest(r.Context(), tpl)
	w.Header().Set("ETag", tpl.ETag)
	w.Header().Set("Deprecation", "true")
	w.Header().Set("Link", `</api/v1/campaign-templates/`+id+`/archive>; rel="successor-version"`)
	writeJSON(w, http.StatusOK, tpl)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// errEnv is retained for the package's extras.go handlers that have
// not yet been migrated to httperror. The base CRUD handlers in this
// file now route 5xx paths through httperror.WriteInternal so raw
// pgx error text is no longer echoed to clients.
func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}
