// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const designDraftInputMapMaxBytes = 128 << 10

func (d *Deps) CreateDesignDraft(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if d.Designs == nil || d.Repo == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "design_workflow_unavailable", "")
		return
	}
	idempotencyKey, err := requiredDesignIdempotencyKey(r)
	if err != nil {
		writeDesignDraftError(w, r, d, err)
		return
	}
	var input CreateDesignDraftInput
	if err := httpbody.DecodeJSON(w, r, campaignTemplateJSONMaxBodyBytes, &input); err != nil {
		writeWorkflowBodyError(w, err)
		return
	}
	actor, err := referenceReviewActorFromContext(r.Context())
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "design_actor_required",
			"An authenticated user or API key is required to create an auditable design.")
		return
	}
	if client, ok := d.Generator.(*HTTPTemplateGenerator); ok && !generatorConfigured(client) {
		httperror.WriteUnavailable(w, "template_generation_not_enabled",
			"AI design is not enabled in this deployment yet.", false)
		return
	}
	draft, replayed, err := d.StartDesignDraft(
		r.Context(), tenant.ID, actor, idempotencyKey, input,
	)
	if err != nil {
		writeDesignDraftError(w, r, d, err)
		return
	}
	w.Header().Set("Location", "/api/v1/campaign-template-designs/"+draft.ID)
	w.Header().Set("Retry-After", strconv.Itoa(max(draft.RetryAfterSeconds, 2)))
	if replayed {
		w.Header().Set(idempotency.ReplayedHeaderName, "true")
	}
	writeJSON(w, http.StatusAccepted, draft)
}

func (d *Deps) ListDesignDrafts(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if d.Designs == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "design_workflow_unavailable", "")
		return
	}
	actor, err := referenceReviewActorFromContext(r.Context())
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "design_actor_required",
			"An authenticated user or API key is required to recover design drafts.")
		return
	}
	filter, err := designDraftListFilterFromRequest(r)
	if err != nil {
		writeDesignDraftError(w, r, d, err)
		return
	}
	page, err := d.ListRecoverableDesignDrafts(
		r.Context(),
		tenant.ID,
		actor,
		filter,
	)
	if err != nil {
		writeDesignDraftError(w, r, d, err)
		return
	}
	page.GenerationAvailable = d.Repo != nil && generatorConfigured(d.Generator)
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, http.StatusOK, page)
}

func (d *Deps) GetDesignDraft(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if d.Designs == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "design_workflow_unavailable", "")
		return
	}
	actor, ok := authenticatedDesignDraftActor(w, r)
	if !ok {
		return
	}
	draft, err := d.FetchDesignDraft(
		r.Context(), tenant.ID, actor, chi.URLParam(r, "id"),
	)
	if err != nil {
		writeDesignDraftError(w, r, d, err)
		return
	}
	if draft.Revision != nil {
		w.Header().Set("ETag", designRevisionETag(draft.ID, *draft.Revision))
	}
	if draft.RetryAfterSeconds > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(draft.RetryAfterSeconds))
	}
	writeJSON(w, http.StatusOK, draft)
}

func (d *Deps) ListDesignDraftRevisions(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if d.Designs == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "design_workflow_unavailable", "")
		return
	}
	actor, ok := authenticatedDesignDraftActor(w, r)
	if !ok {
		return
	}
	revisions, err := d.FetchDesignDraftRevisions(
		r.Context(), tenant.ID, actor, chi.URLParam(r, "id"),
	)
	if err != nil {
		writeDesignDraftError(w, r, d, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": revisions})
}

func (d *Deps) RefineDesignDraft(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if d.Designs == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "design_workflow_unavailable", "")
		return
	}
	actor, ok := authenticatedDesignDraftActor(w, r)
	if !ok {
		return
	}
	idempotencyKey, err := requiredDesignIdempotencyKey(r)
	if err != nil {
		writeDesignDraftError(w, r, d, err)
		return
	}
	var input RefineDesignDraftInput
	if err := httpbody.DecodeJSON(w, r, campaignTemplateJSONMaxBodyBytes, &input); err != nil {
		writeWorkflowBodyError(w, err)
		return
	}
	draftID := chi.URLParam(r, "id")
	draft, replayed, err := d.QueueDesignDraftRefinementWithKey(
		r.Context(), tenant.ID, actor, draftID, idempotencyKey, input,
	)
	if err != nil {
		writeDesignDraftError(w, r, d, err)
		return
	}
	if replayed {
		w.Header().Set(idempotency.ReplayedHeaderName, "true")
	}
	w.Header().Set("Location", "/api/v1/campaign-template-designs/"+draft.ID)
	w.Header().Set("Retry-After", "2")
	writeJSON(w, http.StatusAccepted, draft)
}

func (d *Deps) RetryDesignDraft(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if d.Designs == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "design_workflow_unavailable", "")
		return
	}
	actor, ok := authenticatedDesignDraftActor(w, r)
	if !ok {
		return
	}
	idempotencyKey, err := requiredDesignIdempotencyKey(r)
	if err != nil {
		writeDesignDraftError(w, r, d, err)
		return
	}
	draftID := chi.URLParam(r, "id")
	draft, replayed, err := d.RetryDesignDraftJobWithKey(
		r.Context(), tenant.ID, actor, draftID, idempotencyKey,
	)
	if err != nil {
		writeDesignDraftError(w, r, d, err)
		return
	}
	if replayed {
		w.Header().Set(idempotency.ReplayedHeaderName, "true")
	}
	w.Header().Set("Retry-After", "2")
	writeJSON(w, http.StatusAccepted, draft)
}

func (d *Deps) ArchiveDesignDraft(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if d.Designs == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "design_workflow_unavailable", "")
		return
	}
	actor, ok := authenticatedDesignDraftActor(w, r)
	if !ok {
		return
	}
	idempotencyKey, err := requiredDesignIdempotencyKey(r)
	if err != nil {
		writeDesignDraftError(w, r, d, err)
		return
	}
	draftID := chi.URLParam(r, "id")
	draft, replayed, err := d.ArchiveDesignDraftJobWithKey(
		r.Context(), tenant.ID, actor, draftID, idempotencyKey,
	)
	if err != nil {
		writeDesignDraftError(w, r, d, err)
		return
	}
	if replayed {
		w.Header().Set(idempotency.ReplayedHeaderName, "true")
	}
	writeJSON(w, http.StatusOK, draft)
}

func (d *Deps) SaveDesignDraft(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if d.Designs == nil || d.Repo == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "design_workflow_unavailable", "")
		return
	}
	actor, ok := authenticatedDesignDraftActor(w, r)
	if !ok {
		return
	}
	idempotencyKey, err := requiredDesignIdempotencyKey(r)
	if err != nil {
		writeDesignDraftError(w, r, d, err)
		return
	}
	var input SaveDesignDraftInput
	if err := httpbody.DecodeJSON(w, r, campaignTemplateJSONMaxBodyBytes, &input); err != nil {
		writeWorkflowBodyError(w, err)
		return
	}
	draftID := chi.URLParam(r, "id")
	template, replayed, err := d.SaveDesignDraftRevisionWithKey(
		r.Context(), tenant.ID, actor, draftID, idempotencyKey, input,
	)
	if err != nil {
		writeDesignDraftError(w, r, d, err)
		return
	}
	if replayed {
		w.Header().Set(idempotency.ReplayedHeaderName, "true")
	}
	w.Header().Set("Location", "/api/v1/campaign-templates/"+template.ID)
	writeJSON(w, http.StatusCreated, template)
}

func (d *Deps) CreateCampaignFromDesignDraft(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if d.Designs == nil || d.Campaigns == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "design_workflow_unavailable", "")
		return
	}
	actor, ok := authenticatedDesignDraftActor(w, r)
	if !ok {
		return
	}
	idempotencyKey, err := requiredDesignIdempotencyKey(r)
	if err != nil {
		writeDesignDraftError(w, r, d, err)
		return
	}
	var input CreateCampaignFromDesignDraftInput
	if err := httpbody.DecodeJSON(w, r, campaignTemplateJSONMaxBodyBytes, &input); err != nil {
		writeWorkflowBodyError(w, err)
		return
	}
	draftID := chi.URLParam(r, "id")
	campaign, replayed, err := d.CreateCampaignFromDesignRevisionWithKey(
		r.Context(), tenant.ID, actor, draftID, idempotencyKey, input,
	)
	if err != nil {
		writeDesignDraftError(w, r, d, err)
		return
	}
	if replayed {
		w.Header().Set(idempotency.ReplayedHeaderName, "true")
	}
	w.Header().Set("Location", "/api/v1/campaigns/"+campaign.ID)
	writeJSON(w, http.StatusCreated, campaign)
}

func authenticatedDesignDraftActor(
	w http.ResponseWriter,
	r *http.Request,
) (ReferenceReviewActor, bool) {
	actor, err := referenceReviewActorFromContext(r.Context())
	if err != nil {
		httperror.Write(
			w,
			http.StatusUnauthorized,
			"design_actor_required",
			"An authenticated user or API key is required to access design drafts.",
		)
		return ReferenceReviewActor{}, false
	}
	return actor, true
}

func (d *Deps) verifiedDesignCommit(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id string,
	commit CommitDesignDraftInput,
) (*DesignDraft, *DesignRevision, error) {
	if commit.Revision < 1 {
		return nil, nil, ErrDesignDraftInvalid
	}
	hash := strings.ToLower(strings.TrimSpace(commit.OutputHash))
	if len(hash) != 64 {
		return nil, nil, ErrDesignDraftOutputHashMismatch
	}
	if _, err := hex.DecodeString(hash); err != nil {
		return nil, nil, ErrDesignDraftOutputHashMismatch
	}
	draft, err := d.Designs.Get(ctx, tenantID, actor, id)
	if err != nil {
		return nil, nil, err
	}
	if draft.CurrentRevision != commit.Revision || draft.Revision == nil ||
		draft.Revision.Revision != commit.Revision {
		return draft, nil, ErrDesignDraftRevisionConflict
	}
	if subtle.ConstantTimeCompare(
		[]byte(hash), []byte(strings.ToLower(draft.Revision.OutputHash)),
	) != 1 {
		return draft, nil, ErrDesignDraftOutputHashMismatch
	}
	if draft.Status != designDraftStatusReady &&
		draft.Status != designDraftStatusSaved &&
		draft.Status != designDraftStatusCampaignCreated {
		return draft, nil, ErrDesignDraftNotReady
	}
	return draft, draft.Revision, nil
}

func normalizeCreateDesignDraftInput(
	input CreateDesignDraftInput,
) (CreateDesignDraftInput, []string, error) {
	input.Mode = strings.ToLower(strings.TrimSpace(input.Mode))
	if input.Mode != designDraftModeAdapt && input.Mode != designDraftModeGenerate {
		return CreateDesignDraftInput{}, nil, ErrDesignDraftInvalid
	}
	for target, limit := range map[*string]int{
		&input.Brief: 8000, &input.Instructions: 4000, &input.Tone: 500,
		&input.Name: MaxNameLength, &input.Subject: reviewedDesignMaxSubjectRunes,
		&input.PreviewText: reviewedDesignMaxPreviewRunes,
		&input.Category:    reviewedDesignMaxTaxonomyRunes,
		&input.Audience:    1500, &input.Industry: reviewedDesignMaxTaxonomyRunes,
		&input.Style:  reviewedDesignMaxTaxonomyRunes,
		&input.Layout: reviewedDesignMaxTaxonomyRunes, &input.CTA: 1500,
	} {
		*target = strings.TrimSpace(*target)
		if utf8.RuneCountInString(*target) > limit {
			return CreateDesignDraftInput{}, nil, ErrDesignDraftInvalid
		}
	}
	input.Kind = strings.ToLower(strings.TrimSpace(input.Kind))
	input.Goal = strings.ToLower(strings.TrimSpace(input.Goal))
	if _, err := canonicalGoal(input.Goal); err != nil {
		return CreateDesignDraftInput{}, nil, err
	}
	input.Fidelity = strings.ToLower(strings.TrimSpace(input.Fidelity))
	if input.Fidelity == "" {
		input.Fidelity = "balanced"
	}
	if input.Fidelity != "close" && input.Fidelity != "balanced" && input.Fidelity != "inspired" {
		return CreateDesignDraftInput{}, nil, ErrDesignDraftInvalid
	}
	if len(input.Sections) > 12 {
		return CreateDesignDraftInput{}, nil, ErrDesignDraftInvalid
	}
	sections := make([]string, 0, len(input.Sections))
	for _, section := range input.Sections {
		section = strings.TrimSpace(section)
		if section == "" || utf8.RuneCountInString(section) > 120 {
			return CreateDesignDraftInput{}, nil, ErrDesignDraftInvalid
		}
		sections = append(sections, section)
	}
	input.Sections = sections
	for _, value := range []map[string]any{input.Brand, input.Content, input.Variables} {
		raw, err := json.Marshal(value)
		if err != nil || len(raw) > designDraftInputMapMaxBytes {
			return CreateDesignDraftInput{}, nil, ErrDesignDraftInvalid
		}
	}
	if !validApprovedGroundingContent(input.Content) {
		return CreateDesignDraftInput{}, nil, ErrDesignDraftInvalid
	}
	if input.Mode == designDraftModeGenerate && input.Brief == "" {
		return CreateDesignDraftInput{}, nil, ErrDesignDraftInvalid
	}
	if input.Mode == designDraftModeAdapt {
		sourceID, err := canonicalDesignUUID(input.SourceTemplateID)
		if err != nil {
			return CreateDesignDraftInput{}, nil, ErrDesignDraftInvalid
		}
		input.SourceTemplateID = sourceID
	} else if strings.TrimSpace(input.SourceTemplateID) != "" {
		return CreateDesignDraftInput{}, nil, ErrDesignDraftInvalid
	}
	references := make([]string, 0, maxReferenceTemplates)
	if input.Mode == designDraftModeAdapt {
		references = append(references, input.SourceTemplateID)
	}
	for _, rawID := range input.ReferenceTemplateIDs {
		id, err := canonicalDesignUUID(rawID)
		if err != nil {
			return CreateDesignDraftInput{}, nil, ErrDesignDraftInvalid
		}
		references = append(references, id)
	}
	references = uniqueIDs(references)
	if len(references) > maxReferenceTemplates {
		return CreateDesignDraftInput{}, nil, ErrDesignDraftInvalid
	}
	if input.Mode == designDraftModeAdapt && len(references) > maxReferenceTemplates {
		return CreateDesignDraftInput{}, nil, ErrDesignDraftInvalid
	}
	input.ReferenceTemplateIDs = append([]string(nil), references...)
	if input.Mode == designDraftModeAdapt {
		input.ReferenceTemplateIDs = append([]string(nil), references[1:]...)
	}
	return input, references, nil
}

func validApprovedGroundingContent(content map[string]any) bool {
	if content == nil {
		return true
	}
	for _, field := range []string{"approved_facts", "approved_urls"} {
		value, exists := content[field]
		if !exists {
			continue
		}
		var entries []string
		switch typed := value.(type) {
		case []string:
			entries = typed
		case []any:
			for _, entry := range typed {
				text, ok := entry.(string)
				if !ok {
					return false
				}
				entries = append(entries, text)
			}
		default:
			return false
		}
		if len(entries) > 20 {
			return false
		}
		for _, entry := range entries {
			if strings.TrimSpace(entry) != entry || entry == "" {
				return false
			}
			if field == "approved_facts" {
				if utf8.RuneCountInString(entry) > 500 || strings.ContainsAny(entry, "\r\n\x00") {
					return false
				}
				continue
			}
			if len(entry) > 2048 {
				return false
			}
			if !validApprovedURL(entry) {
				return false
			}
		}
	}
	if raw, exists := content["approved_assets"]; exists {
		assets, ok := raw.([]any)
		if !ok || len(assets) > 10 {
			return false
		}
		for _, rawAsset := range assets {
			asset, ok := rawAsset.(map[string]any)
			if !ok || len(asset) != 2 {
				return false
			}
			assetURL, hasURL := asset["url"].(string)
			alt, hasAlt := asset["alt"].(string)
			if !hasURL || !hasAlt || len(assetURL) > 2048 || !validApprovedURL(assetURL) ||
				strings.TrimSpace(alt) == "" || utf8.RuneCountInString(alt) > 500 || strings.ContainsAny(alt, "\r\n\x00") {
				return false
			}
		}
	}
	return true
}

func validApprovedURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && parsed.Hostname() != "" && parsed.User == nil
}

func canonicalDesignUUID(value string) (string, error) {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil || parsed == uuid.Nil {
		return "", ErrDesignDraftInvalid
	}
	return parsed.String(), nil
}

func requiredDesignIdempotencyKey(r *http.Request) (string, error) {
	values := r.Header.Values("Idempotency-Key")
	if len(values) != 1 {
		return "", fmt.Errorf("%w: idempotency_key_required", ErrDesignDraftInvalid)
	}
	value := strings.TrimSpace(values[0])
	if value == "" || len(value) > 255 || !utf8.ValidString(value) {
		return "", fmt.Errorf("%w: invalid_idempotency_key", ErrDesignDraftInvalid)
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return "", fmt.Errorf("%w: invalid_idempotency_key", ErrDesignDraftInvalid)
		}
	}
	return value, nil
}

func designDraftListFilterFromRequest(
	r *http.Request,
) (DesignDraftListFilter, error) {
	filter := DesignDraftListFilter{Limit: defaultDesignDraftListLimit}
	query := r.URL.Query()
	if values, ok := query["limit"]; ok {
		if len(values) != 1 || values[0] != strings.TrimSpace(values[0]) {
			return DesignDraftListFilter{}, ErrInvalidDesignDraftLimit
		}
		limit, err := strconv.Atoi(values[0])
		if err != nil {
			return DesignDraftListFilter{}, ErrInvalidDesignDraftLimit
		}
		filter.Limit = limit
	}
	if values, ok := query["cursor"]; ok {
		if len(values) != 1 || values[0] != strings.TrimSpace(values[0]) {
			return DesignDraftListFilter{}, ErrInvalidDesignDraftCursor
		}
		filter.Cursor = values[0]
	}
	return normalizeDesignDraftListFilter(filter)
}

func designRevisionETag(draftID string, revision DesignRevision) string {
	return fmt.Sprintf(`"campaign-template-design:%s:v%d:%s"`,
		draftID, revision.Revision, revision.OutputHash)
}

func writeDesignDraftError(w http.ResponseWriter, r *http.Request, d *Deps, err error) {
	switch {
	case errors.Is(err, ErrInvalidDesignDraftCursor):
		httperror.Write(w, http.StatusBadRequest, "invalid_design_draft_cursor",
			"The cursor is malformed or belongs to another tenant or actor.")
	case errors.Is(err, ErrInvalidDesignDraftLimit):
		httperror.Write(w, http.StatusBadRequest, "invalid_design_draft_limit",
			"limit must be an integer from 1 through 50.")
	case errors.Is(err, ErrDesignDraftNotFound):
		httperror.Write(w, http.StatusNotFound, "design_draft_not_found", "")
	case errors.Is(err, ErrDesignDraftIdempotencyConflict):
		httperror.Write(w, http.StatusUnprocessableEntity, "idempotency_key_request_mismatch",
			"Use a fresh Idempotency-Key when changing the design request.")
	case errors.Is(err, ErrDesignDraftOutcomeConflict):
		httperror.Write(w, http.StatusConflict, "design_commit_conflict",
			"A different save or campaign outcome already exists for this design. Refresh before continuing.")
	case errors.Is(err, ErrDesignDraftReplayAmbiguous):
		httperror.Write(w, http.StatusConflict, "design_mutation_replay_ambiguous",
			"This older mutation cannot be proven safe to replay. Refresh its state and use a fresh key only for a new action.")
	case errors.Is(err, ErrDesignDraftBusy):
		w.Header().Set("Retry-After", "2")
		httperror.Write(w, http.StatusConflict, "design_draft_in_progress",
			"Wait for the current generation attempt before refining or archiving.")
	case errors.Is(err, ErrDesignDraftRevisionConflict):
		httperror.Write(w, http.StatusConflict, "design_revision_conflict",
			"Refresh the design and retry with its current revision and output hash.")
	case errors.Is(err, ErrDesignDraftOutputHashMismatch):
		httperror.Write(w, http.StatusPreconditionFailed, "design_output_hash_mismatch",
			"Refresh the design; the reviewed output hash does not match.")
	case errors.Is(err, ErrDesignDraftNotReady):
		w.Header().Set("Retry-After", "2")
		httperror.Write(w, http.StatusConflict, "design_draft_not_ready",
			"Wait for a ready design before saving or creating a campaign.")
	case errors.Is(err, ErrDesignDraftRetryUnavailable):
		httperror.Write(w, http.StatusConflict, "design_retry_unavailable",
			"Only failed design jobs can be retried.")
	case errors.Is(err, ErrDesignAudienceConflict):
		httperror.WriteValidation(w, "audience_conflict", "pass segment_id or list_id, not both")
	case errors.Is(err, ErrDesignInvalidListID):
		httperror.WriteValidation(w, "invalid_list_id", "list_id must be a positive integer")
	case errors.Is(err, ErrDesignCampaignAlreadyCreated):
		httperror.Write(w, http.StatusConflict, "design_campaign_already_created",
			"A campaign draft was already created from this reviewed design revision.")
	case errors.Is(err, ErrDesignMJMLNotRendered):
		httperror.Write(w, http.StatusUnprocessableEntity, "mjml_not_rendered",
			"The reviewed design's MJML could not be rendered.")
	case errors.Is(err, ErrDesignDraftInvalid):
		message := "The design request is invalid or exceeds supported limits."
		if strings.Contains(err.Error(), "idempotency_key_required") {
			httperror.Write(w, http.StatusBadRequest, "idempotency_key_required",
				"Provide one Idempotency-Key so retries cannot create duplicate work.")
			return
		}
		if strings.Contains(err.Error(), "invalid_idempotency_key") {
			httperror.Write(w, http.StatusBadRequest, "invalid_idempotency_key",
				"Idempotency-Key must be one printable value of at most 255 bytes.")
			return
		}
		httperror.WriteValidation(w, "invalid_design_request", message)
	case errors.Is(err, ErrInvalidReviewedDesign), errors.Is(err, ErrInvalidSlug):
		writeReviewedDesignError(w, r, d, err)
	default:
		writeWorkflowError(w, r, d, err)
	}
}
