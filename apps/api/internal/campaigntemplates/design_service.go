// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/emailpreview"
)

// StartDesignDraft is the canonical application boundary used by HTTP and
// native MCP. It normalizes one request, resolves all references through the
// rights gate, and persists an idempotent queued job.
func (d *Deps) StartDesignDraft(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	idempotencyKey string,
	input CreateDesignDraftInput,
) (*DesignDraft, bool, error) {
	if d == nil || d.Designs == nil || d.Repo == nil {
		return nil, false, errors.New("campaign template design workflow unavailable")
	}
	// Fail before persisting a job when the configured HTTP provider is absent.
	// A queued job cannot become ready without that service.
	if client, ok := d.Generator.(*HTTPTemplateGenerator); ok && !generatorConfigured(client) {
		return nil, false, ErrGeneratorUnavailable
	}
	var (
		err          error
		referenceIDs []string
	)
	input, referenceIDs, err = normalizeCreateDesignDraftInput(input)
	if err != nil {
		return nil, false, err
	}
	actor, err = normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, false, err
	}
	if _, err := d.resolveReferences(ctx, tenantID, referenceIDs); err != nil {
		return nil, false, err
	}
	requestRaw, _ := json.Marshal(input)
	requestHash := sha256.Sum256(requestRaw)
	keyHash := sha256.Sum256([]byte(idempotencyKey))
	return d.Designs.Create(ctx, designDraftCreateRecord{
		TenantID: tenantID, Actor: actor, Input: input,
		RequestHash: requestHash[:], IdempotencyHash: keyHash[:],
		ReferenceIDs: referenceIDs, SourceTemplateID: input.SourceTemplateID,
	})
}

func (d *Deps) FetchDesignDraft(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id string,
) (*DesignDraft, error) {
	if d == nil || d.Designs == nil {
		return nil, errors.New("campaign template design workflow unavailable")
	}
	actor, err := normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, err
	}
	return d.Designs.Get(ctx, tenantID, actor, id)
}

// ListRecoverableDesignDrafts is the actor-private recovery boundary used when
// a client lost the acknowledged job id. It returns compact summaries only;
// the existing single-draft endpoint fetches the selected full revision.
func (d *Deps) ListRecoverableDesignDrafts(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	filter DesignDraftListFilter,
) (*DesignDraftPage, error) {
	if d == nil || d.Designs == nil {
		return nil, errors.New("campaign template design workflow unavailable")
	}
	actor, err := normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, err
	}
	filter, err = normalizeDesignDraftListFilter(filter)
	if err != nil {
		return nil, err
	}
	cursor, err := decodeDesignDraftCursor(
		filter.Cursor,
		tenantID,
		actor,
	)
	if err != nil {
		return nil, err
	}
	items, err := d.Designs.ListRecoverable(
		ctx,
		tenantID,
		actor,
		filter.Limit+1,
		cursor,
	)
	if err != nil {
		return nil, err
	}
	page := &DesignDraftPage{Items: items}
	if page.Items == nil {
		page.Items = []DesignDraftSummary{}
	}
	if len(page.Items) > filter.Limit {
		page.Items = page.Items[:filter.Limit]
		page.NextCursor = encodeDesignDraftCursor(
			page.Items[len(page.Items)-1],
			tenantID,
			actor,
		)
	}
	return page, nil
}

func (d *Deps) FetchDesignDraftRevisions(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id string,
) ([]DesignRevision, error) {
	if d == nil || d.Designs == nil {
		return nil, errors.New("campaign template design workflow unavailable")
	}
	actor, err := normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, err
	}
	return d.Designs.ListRevisions(ctx, tenantID, actor, id)
}

func (d *Deps) QueueDesignDraftRefinement(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id string,
	input RefineDesignDraftInput,
) (*DesignDraft, error) {
	if d == nil || d.Designs == nil {
		return nil, errors.New("campaign template design workflow unavailable")
	}
	input.Instructions = strings.TrimSpace(input.Instructions)
	if input.BaseRevision < 1 || input.Instructions == "" ||
		len([]rune(input.Instructions)) > 4000 {
		return nil, ErrDesignDraftInvalid
	}
	actor, err := normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, err
	}
	return d.Designs.QueueRefinement(ctx, tenantID, actor, id, input)
}

func (d *Deps) QueueDesignDraftRefinementWithKey(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id, idempotencyKey string,
	input RefineDesignDraftInput,
) (*DesignDraft, bool, error) {
	var err error
	actor, err = normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, false, err
	}
	registration, err := d.registerDesignMutation(
		ctx, tenantID, actor, id, "refine", idempotencyKey, input,
	)
	if err != nil {
		return nil, false, err
	}
	draft, err := d.QueueDesignDraftRefinement(
		ctx, tenantID, actor, id, input,
	)
	if err != nil && registration.Replayed {
		if current, satisfied := d.replayedDesignMutationDraft(
			ctx, tenantID, actor, id, "refine", input,
		); satisfied {
			return current, true, nil
		}
	}
	return draft, registration.Replayed, err
}

func (d *Deps) RetryDesignDraftJob(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id string,
) (*DesignDraft, error) {
	if d == nil || d.Designs == nil {
		return nil, errors.New("campaign template design workflow unavailable")
	}
	actor, err := normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, err
	}
	return d.Designs.Retry(ctx, tenantID, actor, id)
}

func (d *Deps) RetryDesignDraftJobWithKey(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id, idempotencyKey string,
) (*DesignDraft, bool, error) {
	var err error
	actor, err = normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, false, err
	}
	if idempotencyKey == "" {
		return nil, false, fmt.Errorf(
			"%w: idempotency_key_required",
			ErrDesignDraftInvalid,
		)
	}
	registrar, ok := d.Designs.(designRetryMutationRegistrar)
	if !ok {
		return nil, false, errors.New(
			"campaign template design retry-safe store unavailable",
		)
	}
	keyHash, requestHash, err := designMutationIdentityHashes(
		id,
		"retry",
		idempotencyKey,
		map[string]any{},
	)
	if err != nil {
		return nil, false, err
	}
	draft, registration, err := registrar.RetryDesignDraftWithMutation(
		ctx,
		tenantID,
		actor,
		id,
		keyHash,
		requestHash,
	)
	return draft, registration.Replayed, err
}

func (d *Deps) ArchiveDesignDraftJob(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id string,
) (*DesignDraft, error) {
	if d == nil || d.Designs == nil {
		return nil, errors.New("campaign template design workflow unavailable")
	}
	actor, err := normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, err
	}
	return d.Designs.Archive(ctx, tenantID, actor, id)
}

func (d *Deps) ArchiveDesignDraftJobWithKey(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id, idempotencyKey string,
) (*DesignDraft, bool, error) {
	var err error
	actor, err = normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, false, err
	}
	registration, err := d.registerDesignMutation(
		ctx, tenantID, actor, id, "archive", idempotencyKey,
		map[string]any{},
	)
	if err != nil {
		return nil, false, err
	}
	draft, err := d.ArchiveDesignDraftJob(ctx, tenantID, actor, id)
	if err != nil {
		if current, satisfied := d.replayedDesignMutationDraft(
			ctx, tenantID, actor, id, "archive", nil,
		); satisfied {
			return current, registration.Replayed, nil
		}
	}
	return draft, registration.Replayed, err
}

func (d *Deps) SaveDesignDraftRevision(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id string,
	input SaveDesignDraftInput,
) (*Template, error) {
	if d == nil || d.Designs == nil || d.Repo == nil {
		return nil, errors.New("campaign template design workflow unavailable")
	}
	input.Slug = strings.TrimSpace(input.Slug)
	if err := validateSlug(input.Slug); err != nil {
		return nil, err
	}
	draft, revision, err := d.verifiedDesignCommit(
		ctx, tenantID, actor, id, input.CommitDesignDraftInput,
	)
	if err != nil {
		return nil, err
	}
	if _, err := d.resolveReferences(ctx, tenantID, draft.ReferenceTemplateIDs); err != nil {
		return nil, err
	}
	output := revision.Output
	if strings.TrimSpace(input.Name) != "" {
		output.Name = strings.TrimSpace(input.Name)
	}
	if strings.TrimSpace(input.Subject) != "" {
		output.Subject = strings.TrimSpace(input.Subject)
	}
	if strings.TrimSpace(input.PreviewText) != "" {
		output.PreviewText = strings.TrimSpace(input.PreviewText)
	}
	create, err := PrepareReviewedDesign(SaveGeneratedDesignInput{
		Slug: input.Slug, Name: output.Name, Subject: output.Subject,
		PreviewText: output.PreviewText, BodyHTML: output.BodyHTML,
		BodyMJML: output.BodyMJML, Category: draft.RequestPayload.Category,
		Goal: draft.RequestPayload.Goal, Industry: draft.RequestPayload.Industry,
		Style: draft.RequestPayload.Style, Layout: draft.RequestPayload.Layout,
		Variables:            output.Variables,
		ReferenceTemplateIDs: draft.ReferenceTemplateIDs,
	}, draft.ReferenceTemplateIDs)
	if err != nil {
		return nil, err
	}
	create.GenerationMetadata = map[string]any{
		"operation":                "save_design_draft",
		"design_draft_id":          draft.ID,
		"design_draft_revision":    revision.Revision,
		"design_draft_output_hash": revision.OutputHash,
		"reference_template_ids":   draft.ReferenceTemplateIDs,
	}
	if draft.SavedTemplateID != "" && draft.SavedRevision != nil &&
		*draft.SavedRevision == revision.Revision {
		existing, getErr := d.Repo.Get(
			ctx, tenantID, draft.SavedTemplateID,
		)
		if getErr != nil {
			return nil, getErr
		}
		if !savedTemplateMatchesDesignCommit(
			existing, create, draft, revision,
		) {
			return nil, ErrDesignDraftOutcomeConflict
		}
		return existing, nil
	}
	if existing, recoveryErr := d.recoverSavedTemplate(
		ctx, tenantID, actor, draft, revision, create,
	); recoveryErr != nil {
		return nil, recoveryErr
	} else if existing != nil {
		return existing, nil
	}
	template, err := d.Repo.Create(ctx, tenantID, create)
	if err != nil {
		// A first request may have committed the unique draft-bound template
		// but crashed before updating the draft marker. Recover by its unique
		// lineage and never ask the generator to rerun.
		if existing, recoveryErr := d.recoverSavedTemplate(
			ctx, tenantID, actor, draft, revision, create,
		); recoveryErr != nil {
			return nil, recoveryErr
		} else if existing != nil {
			return existing, nil
		}
		return nil, err
	}
	if _, markErr := d.Designs.MarkSaved(
		ctx, tenantID, actor, draft.ID, revision.Revision, template.ID,
	); markErr != nil && d.Logger != nil {
		d.Logger.Error("mark campaign template design saved",
			"draft_id", draft.ID, "template_id", template.ID, "error", markErr)
	}
	return template, nil
}

func (d *Deps) SaveDesignDraftRevisionWithKey(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id, idempotencyKey string,
	input SaveDesignDraftInput,
) (*Template, bool, error) {
	var err error
	actor, err = normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, false, err
	}
	registration, err := d.registerDesignMutation(
		ctx, tenantID, actor, id, "save", idempotencyKey, input,
	)
	if err != nil {
		return nil, false, err
	}
	template, err := d.SaveDesignDraftRevision(
		ctx, tenantID, actor, id, input,
	)
	return template, registration.Replayed, err
}

func (d *Deps) CreateCampaignFromDesignRevision(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id string,
	input CreateCampaignFromDesignDraftInput,
) (*campaigns.Campaign, error) {
	if d == nil || d.Designs == nil || d.Campaigns == nil {
		return nil, errors.New("campaign template design workflow unavailable")
	}
	input.SegmentID = strings.TrimSpace(input.SegmentID)
	input.ListID = AudienceListID(strings.TrimSpace(string(input.ListID)))
	if input.SegmentID != "" && input.ListID != "" {
		return nil, ErrDesignAudienceConflict
	}
	if input.ListID != "" {
		listID, parseErr := strconv.ParseInt(string(input.ListID), 10, 64)
		if parseErr != nil || listID <= 0 {
			return nil, ErrDesignInvalidListID
		}
	}
	draft, revision, err := d.verifiedDesignCommit(
		ctx, tenantID, actor, id, input.CommitDesignDraftInput,
	)
	if err != nil {
		return nil, err
	}
	if _, err := d.resolveReferences(ctx, tenantID, draft.ReferenceTemplateIDs); err != nil {
		return nil, err
	}
	output := revision.Output
	identity, err := d.Repo.WorkspaceIdentity(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	// A reviewed design's own values and the caller's overrides win over the
	// workspace identity, which only fills brand_name, sender_name and
	// reply_to_email tags nobody gave a value.
	values := mergeValueMaps(identity.values(), output.Variables, input.Variables)
	name := substitute(output.Name, values, false)
	if strings.TrimSpace(input.Name) != "" {
		name = strings.TrimSpace(input.Name)
	}
	subject := substitute(output.Subject, values, false)
	if strings.TrimSpace(input.Subject) != "" {
		subject = strings.TrimSpace(input.Subject)
	}
	preview := substitute(output.PreviewText, values, false)
	if strings.TrimSpace(input.PreviewText) != "" {
		preview = strings.TrimSpace(input.PreviewText)
	}
	bodyHTML := substitute(output.BodyHTML, values, true)
	bodyMJML := substitute(output.BodyMJML, values, true)
	editorMode := "html"
	if strings.TrimSpace(bodyMJML) != "" {
		editorMode = "mjml"
		rendered, _, renderErr := emailpreview.RenderMJML(ctx, bodyMJML, nil)
		if renderErr != nil && strings.TrimSpace(bodyHTML) == "" {
			return nil, ErrDesignMJMLNotRendered
		}
		if renderErr == nil {
			bodyHTML = rendered
		}
	}
	create := campaigns.CreateInput{
		Name: name, Subject: subject, PreviewText: preview,
		BodyHTML: bodyHTML, BodyMJML: bodyMJML,
		CampaignType: "regular", EditorMode: editorMode,
		SegmentID: input.SegmentID, ListID: string(input.ListID),
		ReferenceTemplateIDs:           draft.ReferenceTemplateIDs,
		TemplateVariables:              values,
		SourceTemplateDesignDraftID:    draft.ID,
		SourceTemplateDesignRevision:   revision.Revision,
		SourceTemplateDesignOutputHash: revision.OutputHash,
	}
	if draft.CreatedCampaignID != "" && draft.CampaignRevision != nil &&
		*draft.CampaignRevision == revision.Revision {
		existing, recoveryErr := d.recoverCreatedCampaign(
			ctx, tenantID, actor, draft, revision, create,
		)
		if recoveryErr != nil {
			return nil, recoveryErr
		}
		if existing == nil {
			return nil, ErrDesignCampaignAlreadyCreated
		}
		return existing, nil
	}
	if existing, recoveryErr := d.recoverCreatedCampaign(
		ctx, tenantID, actor, draft, revision, create,
	); recoveryErr != nil {
		return nil, recoveryErr
	} else if existing != nil {
		return existing, nil
	}
	campaign, err := d.Campaigns.Create(ctx, tenantID, create)
	if err != nil {
		if existing, recoveryErr := d.recoverCreatedCampaign(
			ctx, tenantID, actor, draft, revision, create,
		); recoveryErr != nil {
			return nil, recoveryErr
		} else if existing != nil {
			return existing, nil
		}
		return nil, err
	}
	if _, markErr := d.Designs.MarkCampaignCreated(
		ctx, tenantID, actor, draft.ID, revision.Revision, campaign.ID,
	); markErr != nil && d.Logger != nil {
		d.Logger.Error("mark campaign template design campaign created",
			"draft_id", draft.ID, "campaign_id", campaign.ID, "error", markErr)
	}
	return campaign, nil
}

func (d *Deps) CreateCampaignFromDesignRevisionWithKey(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	id, idempotencyKey string,
	input CreateCampaignFromDesignDraftInput,
) (*campaigns.Campaign, bool, error) {
	var err error
	actor, err = normalizeReferenceReviewActor(actor)
	if err != nil {
		return nil, false, err
	}
	registration, err := d.registerDesignMutation(
		ctx, tenantID, actor, id, "create_campaign", idempotencyKey, input,
	)
	if err != nil {
		return nil, false, err
	}
	campaign, err := d.CreateCampaignFromDesignRevision(
		ctx, tenantID, actor, id, input,
	)
	return campaign, registration.Replayed, err
}

func (d *Deps) recoverSavedTemplate(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	draft *DesignDraft,
	revision *DesignRevision,
	expected CreateInput,
) (*Template, error) {
	recovery, ok := d.Repo.(interface {
		GetByDesignDraft(context.Context, string, string) (*Template, error)
	})
	if !ok {
		return nil, nil
	}
	existing, err := recovery.GetByDesignDraft(ctx, tenantID, draft.ID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	if !savedTemplateMatchesDesignCommit(existing, expected, draft, revision) {
		// The unique draft-bound output belongs to another commit request.
		// Never acknowledge it merely because its immutable lineage matches.
		return nil, ErrDesignDraftOutcomeConflict
	}
	if _, markErr := d.Designs.MarkSaved(
		ctx, tenantID, actor, draft.ID, revision.Revision, existing.ID,
	); markErr != nil && d.Logger != nil {
		d.Logger.Error("recover campaign template design saved marker",
			"draft_id", draft.ID, "template_id", existing.ID, "error", markErr)
	}
	return existing, nil
}

func (d *Deps) recoverCreatedCampaign(
	ctx context.Context,
	tenantID string,
	actor ReferenceReviewActor,
	draft *DesignDraft,
	revision *DesignRevision,
	expected campaigns.CreateInput,
) (*campaigns.Campaign, error) {
	recovery, ok := d.Campaigns.(interface {
		GetByTemplateDesignDraft(
			context.Context, string, string,
		) (*campaigns.Campaign, error)
	})
	if !ok {
		return nil, nil
	}
	existing, err := recovery.GetByTemplateDesignDraft(ctx, tenantID, draft.ID)
	if err != nil {
		if errors.Is(err, campaigns.ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	if !createdCampaignMatchesDesignCommit(existing, expected, draft, revision) {
		return nil, ErrDesignDraftOutcomeConflict
	}
	if _, markErr := d.Designs.MarkCampaignCreated(
		ctx, tenantID, actor, draft.ID, revision.Revision, existing.ID,
	); markErr != nil && d.Logger != nil {
		d.Logger.Error("recover campaign template design campaign marker",
			"draft_id", draft.ID, "campaign_id", existing.ID, "error", markErr)
	}
	return existing, nil
}

func savedTemplateMatchesDesignCommit(
	existing *Template,
	expected CreateInput,
	draft *DesignDraft,
	revision *DesignRevision,
) bool {
	if existing == nil || draft == nil || revision == nil {
		return false
	}
	committedRevision, revisionOK := designMetadataInt(
		existing.GenerationMetadata, "design_draft_revision",
	)
	committedHash, hashOK := existing.GenerationMetadata["design_draft_output_hash"].(string)
	committedDraftID, draftIDOK := existing.GenerationMetadata["design_draft_id"].(string)
	return revisionOK &&
		committedRevision == revision.Revision &&
		hashOK &&
		strings.EqualFold(
			strings.TrimSpace(committedHash),
			revision.OutputHash,
		) &&
		draftIDOK &&
		strings.TrimSpace(committedDraftID) == draft.ID &&
		existing.Slug == expected.Slug &&
		existing.Name == expected.Name &&
		existing.Subject == expected.Subject &&
		existing.PreviewText == expected.PreviewText &&
		existing.BodyHTML == expected.BodyHTML &&
		existing.BodyMJML == expected.BodyMJML &&
		existing.Category == expected.Category &&
		existing.Goal == expected.Goal &&
		existing.Industry == expected.Industry &&
		existing.Style == expected.Style &&
		existing.Layout == expected.Layout &&
		existing.TemplateKind == expected.TemplateKind &&
		existing.SourceProvider == expected.SourceProvider &&
		existing.SourceLicenseStatus == expected.SourceLicenseStatus &&
		existing.ReviewStatus == expected.ReviewStatus &&
		existing.QualityScore == expected.QualityScore &&
		jsonSemanticallyEqual(existing.Variables, expected.Variables) &&
		stringSlicesEqual(
			existing.ReferenceTemplateIDs,
			expected.ReferenceTemplateIDs,
		)
}

func createdCampaignMatchesDesignCommit(
	existing *campaigns.Campaign,
	expected campaigns.CreateInput,
	draft *DesignDraft,
	revision *DesignRevision,
) bool {
	if existing == nil || draft == nil || revision == nil {
		return false
	}
	return existing.SourceTemplateDesignDraftID == draft.ID &&
		existing.SourceTemplateDesignRevision == revision.Revision &&
		strings.EqualFold(
			strings.TrimSpace(existing.SourceTemplateDesignOutputHash),
			revision.OutputHash,
		) &&
		existing.Name == expected.Name &&
		existing.Subject == expected.Subject &&
		existing.PreviewText == expected.PreviewText &&
		existing.BodyHTML == expected.BodyHTML &&
		existing.BodyMJML == expected.BodyMJML &&
		existing.CampaignType == expected.CampaignType &&
		existing.EditorMode == expected.EditorMode &&
		existing.SegmentID == expected.SegmentID &&
		existing.ListID == expected.ListID &&
		stringSlicesEqual(
			existing.ReferenceTemplateIDs,
			expected.ReferenceTemplateIDs,
		) &&
		jsonSemanticallyEqual(
			existing.TemplateVariables,
			expected.TemplateVariables,
		)
}

func jsonSemanticallyEqual(left, right any) bool {
	leftRaw, leftErr := json.Marshal(left)
	rightRaw, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftRaw, rightRaw)
}

func stringSlicesEqual(left, right []string) bool {
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

func designMetadataInt(metadata map[string]any, key string) (int, bool) {
	if metadata == nil {
		return 0, false
	}
	switch value := metadata[key].(type) {
	case int:
		return value, value >= 1
	case int32:
		return int(value), value >= 1
	case int64:
		return int(value), value >= 1
	case float64:
		integer := int(value)
		return integer, value == float64(integer) && integer >= 1
	case json.Number:
		integer, err := strconv.Atoi(string(value))
		return integer, err == nil && integer >= 1
	case string:
		integer, err := strconv.Atoi(strings.TrimSpace(value))
		return integer, err == nil && integer >= 1
	default:
		return 0, false
	}
}
