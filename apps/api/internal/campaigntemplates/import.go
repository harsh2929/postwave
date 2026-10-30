// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	campaignTemplateImportMaxBodyBytes int64 = 8 << 20
	maxTemplatesPerImport                    = 100
)

func importBodyHTMLHash(bodyHTML string) string {
	digest := sha256.Sum256([]byte(bodyHTML))
	return fmt.Sprintf("sha256:%x", digest)
}

func validateImportedContentHash(in CreateInput) error {
	if strings.TrimSpace(in.ContentHash) != importBodyHTMLHash(in.BodyHTML) {
		return ErrImportContentHashMismatch
	}
	return nil
}

type ImportRequest struct {
	// Items is the compact API envelope. Templates accepts the checked-in
	// scraper catalog directly; AllowUnknownFields intentionally ignores the
	// catalog-only provenance/previews that are already projected into the
	// declared CreateInput metadata fields.
	Items     []CreateInput `json:"items,omitempty"`
	Templates []CreateInput `json:"templates,omitempty"`
}

type ImportItemError struct {
	Index            int    `json:"index"`
	Slug             string `json:"slug,omitempty"`
	SourceExternalID string `json:"source_external_id,omitempty"`
	Code             string `json:"code"`
}

type ImportResponse struct {
	Items   []Template        `json:"items"`
	Created int               `json:"created"`
	Updated int               `json:"updated"`
	Failed  int               `json:"failed"`
	Errors  []ImportItemError `json:"errors"`
}

func (r *Repo) findTenantTemplateBySource(ctx context.Context, tenantID, provider, externalID string) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	err = tx.QueryRow(ctx, `
SELECT id::text
  FROM campaign_templates
 WHERE tenant_id = $1::uuid
   AND source_provider = $2
   AND source_external_id = $3`, tenantID, provider, externalID).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	return id, tx.Commit(ctx)
}

// UpsertImported makes a bounded external ingest safely retryable. The source
// provider/external-id pair is the idempotency key inside a tenant.
func (r *Repo) UpsertImported(ctx context.Context, tenantID string, in CreateInput) (*Template, bool, error) {
	if err := validateImportedContentHash(in); err != nil {
		return nil, false, err
	}
	in = stampImportedInput(in, time.Now().UTC())
	in.SourceProvider = strings.ToLower(strings.TrimSpace(in.SourceProvider))
	in.SourceExternalID = strings.TrimSpace(in.SourceExternalID)
	if in.SourceProvider == "" || in.SourceProvider == "postwave" || in.SourceExternalID == "" {
		return nil, false, errors.New("external source_provider and source_external_id are required")
	}
	id, err := r.findTenantTemplateBySource(ctx, tenantID, in.SourceProvider, in.SourceExternalID)
	if errors.Is(err, ErrNotFound) {
		created, createErr := r.Create(ctx, tenantID, in)
		if createErr == nil {
			return created, true, nil
		}
		if !errors.Is(createErr, ErrSourceConflict) {
			return nil, false, createErr
		}
		// Concurrent importer won the unique-key race; continue as update.
		id, err = r.findTenantTemplateBySource(ctx, tenantID, in.SourceProvider, in.SourceExternalID)
	}
	if err != nil {
		return nil, false, err
	}

	prepared, err := prepareImportedReferenceRefresh(in)
	if err != nil {
		// A rejected external refresh must not leave an earlier rights decision
		// executable. Demotion is deliberately narrower than refresh: it never
		// changes source content, provenance, or the content hash.
		if demoteErr := r.demoteImportedReferenceGovernance(
			ctx, tenantID, id, in.SourceProvider, in.SourceExternalID,
		); demoteErr != nil {
			return nil, false, errors.Join(err,
				fmt.Errorf("demote rejected imported reference: %w", demoteErr))
		}
		return nil, false, err
	}
	// Content, provenance, governance, and content_hash are one database
	// mutation. Concurrent importers may replace one another, but cannot leave
	// one import's identity beside another import's body.
	if err := r.refreshImportedReferenceAtomic(ctx, tenantID, id, prepared); err != nil {
		return nil, false, err
	}
	out, err := r.Get(ctx, tenantID, id)
	return out, false, err
}

func prepareImportedReferenceRefresh(in CreateInput) (CreateInput, error) {
	in.Name = strings.TrimSpace(in.Name)
	in.Description = strings.TrimSpace(in.Description)
	in.Category = strings.TrimSpace(in.Category)
	goal, err := canonicalGoal(in.Goal)
	if err != nil {
		return CreateInput{}, err
	}
	if err := validateTemplateContent(in.Name, in.Subject, in.PreviewText,
		in.BodyHTML, in.BodyMJML, in.Variables, in.Tags); err != nil {
		return CreateInput{}, err
	}
	in.Goal = goal
	return in, nil
}

func (r *Repo) refreshImportedReferenceAtomic(ctx context.Context, tenantID, id string, in CreateInput) error {
	varsRaw, _ := json.Marshal(nilSlice(in.Variables))
	sourceRaw, _ := json.Marshal(nonNilObject(in.SourceMetadata))
	designRaw, _ := json.Marshal(nonNilObject(in.DesignMetadata))
	tags := in.Tags
	if tags == nil {
		tags = []string{}
	}
	quality := in.QualityScore
	if quality <= 0 {
		quality = 0.5
	} else if quality > 1 {
		quality = 1
	}
	importedAt := in.ImportedAt
	if importedAt == nil {
		now := time.Now().UTC()
		importedAt = &now
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var updated bool
	err = tx.QueryRow(ctx, `
SELECT campaign_template_refresh_reference_atomic(
    $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb,
    $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18,
    $19, $20, $21, $22, $23::jsonb, $24, $25, $26
)`,
		tenantID, id, in.SourceProvider, in.SourceExternalID,
		strings.TrimSpace(in.SourceURL), strings.TrimSpace(in.SourceBrand),
		strings.TrimSpace(in.ThumbnailURL), in.SourceCapturedAt, string(sourceRaw),
		in.Name, in.Description, in.Category, in.Subject, in.PreviewText,
		in.BodyHTML, in.BodyMJML, string(varsRaw), tags, in.Goal,
		strings.TrimSpace(in.Industry),
		strings.TrimSpace(in.Style), strings.TrimSpace(in.Layout),
		string(designRaw), quality, strings.TrimSpace(in.ContentHash), importedAt,
	).Scan(&updated)
	if err != nil {
		return err
	}
	if !updated {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func (r *Repo) demoteImportedReferenceGovernance(
	ctx context.Context,
	tenantID, id, sourceProvider, sourceExternalID string,
) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var updated bool
	err = tx.QueryRow(ctx, `
SELECT campaign_template_demote_reference_governance(
    $1::uuid, $2::uuid, $3, $4
)`,
		tenantID, id, sourceProvider, sourceExternalID,
	).Scan(&updated)
	if err != nil {
		return err
	}
	if !updated {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// stampImportedInput is deliberately unconditional. Import credentials grant
// ingestion, not rights review: client claims such as `approved`, `editable`,
// or `owned` cannot promote captured material into executable content. Import
// records also cannot claim derivative lineage; that is minted only after an
// eligible adaptation/generation succeeds.
func stampImportedInput(in CreateInput, importedAt time.Time) CreateInput {
	in.TemplateKind = templateKindReference
	in.ReviewStatus = reviewStatusPending
	in.SourceLicenseStatus = licenseStatusUnreviewed
	in.ImportedAt = &importedAt
	in.ReferenceTemplateIDs = []string{}
	in.GenerationMetadata = map[string]any{}
	return in
}

// Import handles POST /api/v1/campaign-templates/import. It is tenant-owned by
// design; promotion into the platform-wide gallery remains an explicit admin
// review step rather than a side effect of scraping.
func (d *Deps) Import(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in ImportRequest
	if err := httpbody.DecodeJSONWith(w, r, campaignTemplateImportMaxBodyBytes, &in, httpbody.Options{AllowUnknownFields: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	items := in.Items
	if len(items) == 0 {
		items = in.Templates
	}
	if len(items) == 0 || len(items) > maxTemplatesPerImport {
		httperror.WriteValidation(w, "invalid_import_size", "import must contain between 1 and 100 templates")
		return
	}
	response := ImportResponse{Items: []Template{}, Errors: []ImportItemError{}}
	for index, item := range items {
		if err := validateImportedContentHash(item); err != nil {
			response.Failed++
			response.Errors = append(response.Errors, ImportItemError{
				Index: index, Slug: item.Slug, SourceExternalID: item.SourceExternalID,
				Code: importErrorCode(err),
			})
			continue
		}
		// Stamp at the HTTP boundary and again in UpsertImported so neither an
		// alternate repository nor an in-process caller can trust client claims.
		item = stampImportedInput(item, time.Now().UTC())
		if item.Category == "" {
			item.Category = "newsletter"
		}
		if item.Goal == "" {
			item.Goal = "newsletter"
		}
		out, created, err := d.Repo.UpsertImported(r.Context(), tenant.ID, item)
		if err != nil {
			response.Failed++
			response.Errors = append(response.Errors, ImportItemError{
				Index: index, Slug: item.Slug, SourceExternalID: item.SourceExternalID,
				Code: importErrorCode(err),
			})
			continue
		}
		if err := d.enqueueImportedPreviews(r.Context(), out.ID, item); err != nil {
			if d.Logger != nil {
				d.Logger.Error(
					"campaign template preview enqueue failed",
					"template_id", out.ID,
					"source_provider", item.SourceProvider,
					"source_external_id", item.SourceExternalID,
					"error", err,
				)
			}
			response.Failed++
			response.Errors = append(response.Errors, ImportItemError{
				Index: index, Slug: item.Slug, SourceExternalID: item.SourceExternalID,
				Code: "preview_enqueue_failed",
			})
			continue
		}
		if created {
			response.Created++
		} else {
			response.Updated++
		}
		// The request may carry several MiB of source HTML. Echoing every body
		// would make a successful bounded import exceed client/proxy response
		// limits, so return provenance-rich summaries and let callers GET a
		// selected item when they need its full source.
		projectTemplateForRequest(r.Context(), out)
		response.Items = append(response.Items, compactImportedTemplate(*out))
	}
	status := http.StatusOK
	if response.Failed > 0 {
		status = http.StatusMultiStatus
	} else if response.Updated == 0 {
		status = http.StatusCreated
	}
	writeJSON(w, status, response)
}

func compactImportedTemplate(template Template) Template {
	template.BodyHTML = ""
	template.BodyMJML = ""
	if template.PreviewAssets == nil {
		template.PreviewAssets = []TemplatePreviewAsset{}
	}
	return template
}

func importErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrInvalidSlug):
		return "invalid_slug"
	case errors.Is(err, ErrSlugConflict):
		return "slug_conflict"
	case errors.Is(err, ErrSourceConflict):
		return "source_conflict"
	case errors.Is(err, ErrInvalidGoal):
		return "invalid_goal"
	case errors.Is(err, ErrInvalidTemplateKind):
		return "invalid_template_kind"
	case errors.Is(err, ErrInvalidReviewStatus):
		return "invalid_review_status"
	case errors.Is(err, ErrInvalidTemplateContent):
		return "invalid_template_content"
	case errors.Is(err, ErrImportContentHashMismatch):
		return "content_hash_mismatch"
	default:
		return "import_failed"
	}
}
