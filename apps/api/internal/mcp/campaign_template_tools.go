// SPDX-License-Identifier: AGPL-3.0-only

package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"

	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/campaigntemplates"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type CampaignTemplateCatalog interface {
	Search(context.Context, string, campaigntemplates.SearchFilter) (*campaigntemplates.SearchResponse, error)
	Get(context.Context, string, string) (*campaigntemplates.Template, error)
	GetByIDOrSlug(context.Context, string, string) (*campaigntemplates.Template, error)
	WorkspaceIdentity(context.Context, string) (campaigntemplates.WorkspaceIdentity, error)
	Create(context.Context, string, campaigntemplates.CreateInput) (*campaigntemplates.Template, error)
	Update(context.Context, string, string, campaigntemplates.UpdateInput) (*campaigntemplates.Template, error)
	Archive(context.Context, string, string, string) (*campaigntemplates.Template, error)
	Restore(context.Context, string, string, string) (*campaigntemplates.Template, error)
	ListRevisions(context.Context, string, string, int, int) (*campaigntemplates.TemplateRevisionPage, error)
	GetRevision(context.Context, string, string, int64) (*campaigntemplates.TemplateRevision, error)
	RecordUse(context.Context, string, string) error
	SetFavorite(context.Context, string, string, string, bool) error
}

type campaignTemplateWorkflow interface {
	StartDesignDraft(
		context.Context,
		string,
		campaigntemplates.ReferenceReviewActor,
		string,
		campaigntemplates.CreateDesignDraftInput,
	) (*campaigntemplates.DesignDraft, bool, error)
	FetchDesignDraft(
		context.Context,
		string,
		campaigntemplates.ReferenceReviewActor,
		string,
	) (*campaigntemplates.DesignDraft, error)
	ListRecoverableDesignDrafts(
		context.Context,
		string,
		campaigntemplates.ReferenceReviewActor,
		campaigntemplates.DesignDraftListFilter,
	) (*campaigntemplates.DesignDraftPage, error)
	FetchDesignDraftRevisions(
		context.Context,
		string,
		campaigntemplates.ReferenceReviewActor,
		string,
	) ([]campaigntemplates.DesignRevision, error)
	QueueDesignDraftRefinementWithKey(
		context.Context,
		string,
		campaigntemplates.ReferenceReviewActor,
		string,
		string,
		campaigntemplates.RefineDesignDraftInput,
	) (*campaigntemplates.DesignDraft, bool, error)
	RetryDesignDraftJobWithKey(
		context.Context,
		string,
		campaigntemplates.ReferenceReviewActor,
		string,
		string,
	) (*campaigntemplates.DesignDraft, bool, error)
	ArchiveDesignDraftJobWithKey(
		context.Context,
		string,
		campaigntemplates.ReferenceReviewActor,
		string,
		string,
	) (*campaigntemplates.DesignDraft, bool, error)
	SaveDesignDraftRevisionWithKey(
		context.Context,
		string,
		campaigntemplates.ReferenceReviewActor,
		string,
		string,
		campaigntemplates.SaveDesignDraftInput,
	) (*campaigntemplates.Template, bool, error)
	CreateCampaignFromDesignRevisionWithKey(
		context.Context,
		string,
		campaigntemplates.ReferenceReviewActor,
		string,
		string,
		campaigntemplates.CreateCampaignFromDesignDraftInput,
	) (*campaigns.Campaign, bool, error)
}

type searchCampaignTemplatesInput struct {
	Query     string   `json:"query"`
	Goal      string   `json:"goal"`
	Category  string   `json:"category"`
	Source    string   `json:"source"`
	Provider  string   `json:"provider"`
	Industry  string   `json:"industry"`
	Style     string   `json:"style"`
	Layout    string   `json:"layout"`
	Kind      string   `json:"kind"`
	Tags      []string `json:"tags"`
	Featured  *bool    `json:"featured"`
	Favorited bool     `json:"favorited"`
	Sort      string   `json:"sort"`
	Archived  string   `json:"archived"`
	Cursor    string   `json:"cursor"`
	Page      int      `json:"page"`
	PerPage   int      `json:"per_page"`
}

func handleSearchCampaignTemplates(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	if d.CampaignTemplates == nil {
		return nil, errors.New("searchCampaignTemplates is unavailable: campaign templates are not configured")
	}
	var in searchCampaignTemplatesInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	userID := ""
	if user, ok := middleware.UserFromContext(ctx); ok && user != nil {
		userID = user.ID
	}
	out, err := d.CampaignTemplates.Search(ctx, tenantID, campaigntemplates.SearchFilter{
		Query: in.Query, Goal: in.Goal, Category: in.Category, Source: in.Source,
		Provider: in.Provider, Industry: in.Industry, Style: in.Style, Layout: in.Layout,
		Kind: in.Kind, Tags: in.Tags, Featured: in.Featured, FavoritedOnly: in.Favorited,
		UserID: userID, Sort: in.Sort, Archived: in.Archived,
		Cursor: in.Cursor, Page: in.Page, PerPage: in.PerPage,
	})
	if err != nil {
		return nil, err
	}
	return projectNativeCampaignTemplateResponse(ctx, out), nil
}

type getCampaignTemplateInput struct {
	TemplateID string `json:"template_id"`
}

func handleGetCampaignTemplate(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	if d.CampaignTemplates == nil {
		return nil, errors.New("getCampaignTemplate is unavailable: campaign templates are not configured")
	}
	var in getCampaignTemplateInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	in.TemplateID = strings.TrimSpace(in.TemplateID)
	if in.TemplateID == "" {
		return nil, errors.New("template_id is required")
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	// Accept the slug people and agents quote ("welcome-negative-promise")
	// as well as the UUID.
	tpl, err := d.CampaignTemplates.GetByIDOrSlug(ctx, tenantID, in.TemplateID)
	if err != nil {
		return nil, err
	}
	return projectNativeCampaignTemplateResponse(ctx, tpl), nil
}

type createEditableCampaignTemplateInput struct {
	Slug           string                   `json:"slug"`
	Name           string                   `json:"name"`
	Description    string                   `json:"description"`
	Category       string                   `json:"category"`
	Subject        string                   `json:"subject"`
	PreviewText    string                   `json:"preview_text"`
	BodyHTML       string                   `json:"body_html"`
	BodyMJML       string                   `json:"body_mjml"`
	Variables      []map[string]interface{} `json:"variables"`
	Tags           []string                 `json:"tags"`
	Goal           string                   `json:"goal"`
	Industry       string                   `json:"industry"`
	Style          string                   `json:"style"`
	Layout         string                   `json:"layout"`
	ThumbnailURL   string                   `json:"thumbnail_url"`
	DesignMetadata map[string]any           `json:"design_metadata"`
}

func handleCreateEditableCampaignTemplate(
	ctx context.Context,
	d *Deps,
	args json.RawMessage,
) (any, error) {
	if d.CampaignTemplates == nil {
		return nil, errors.New("createCampaignTemplate is unavailable: campaign templates are not configured")
	}
	var in createEditableCampaignTemplateInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	template, err := d.CampaignTemplates.Create(ctx, tenantID, campaigntemplates.CreateInput{
		Slug: in.Slug, Name: in.Name, Description: in.Description,
		Category: in.Category, Subject: in.Subject, PreviewText: in.PreviewText,
		BodyHTML: in.BodyHTML, BodyMJML: in.BodyMJML, Variables: in.Variables,
		Tags: in.Tags, Goal: in.Goal, Industry: in.Industry, Style: in.Style,
		Layout: in.Layout, ThumbnailURL: in.ThumbnailURL,
		DesignMetadata: in.DesignMetadata,
	})
	if err != nil {
		return nil, err
	}
	return projectNativeCampaignTemplateResponse(ctx, template), nil
}

type updateEditableCampaignTemplateInput struct {
	TemplateID string                        `json:"template_id"`
	IfMatch    string                        `json:"if_match"`
	Patch      campaigntemplates.UpdateInput `json:"patch"`
}

func strongMCPTemplateETag(value string) (string, error) {
	value = strings.TrimSpace(value)
	if len(value) < 2 || value == "*" || strings.HasPrefix(value, "W/") ||
		strings.Contains(value, ",") || value[0] != '"' || value[len(value)-1] != '"' {
		return "", errors.New("if_match must be the exact strong etag returned by getCampaignTemplate")
	}
	return value, nil
}

func handleUpdateEditableCampaignTemplate(
	ctx context.Context,
	d *Deps,
	args json.RawMessage,
) (any, error) {
	if d.CampaignTemplates == nil {
		return nil, errors.New("updateCampaignTemplate is unavailable: campaign templates are not configured")
	}
	var in updateEditableCampaignTemplateInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	ifMatch, err := strongMCPTemplateETag(in.IfMatch)
	if err != nil {
		return nil, err
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	in.Patch.IfMatch = ifMatch
	template, err := d.CampaignTemplates.Update(
		ctx, tenantID, strings.TrimSpace(in.TemplateID), in.Patch,
	)
	if err != nil {
		return nil, err
	}
	return projectNativeCampaignTemplateResponse(ctx, template), nil
}

type campaignTemplateLifecycleInput struct {
	TemplateID string `json:"template_id"`
	IfMatch    string `json:"if_match"`
}

func handleCampaignTemplateLifecycle(
	ctx context.Context,
	d *Deps,
	args json.RawMessage,
	restore bool,
) (any, error) {
	if d.CampaignTemplates == nil {
		return nil, errors.New("campaign template lifecycle is unavailable: campaign templates are not configured")
	}
	var in campaignTemplateLifecycleInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	ifMatch, err := strongMCPTemplateETag(in.IfMatch)
	if err != nil {
		return nil, err
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	var template *campaigntemplates.Template
	if restore {
		template, err = d.CampaignTemplates.Restore(
			ctx, tenantID, strings.TrimSpace(in.TemplateID), ifMatch,
		)
	} else {
		template, err = d.CampaignTemplates.Archive(
			ctx, tenantID, strings.TrimSpace(in.TemplateID), ifMatch,
		)
	}
	if err != nil {
		return nil, err
	}
	return projectNativeCampaignTemplateResponse(ctx, template), nil
}

func handleArchiveEditableCampaignTemplate(
	ctx context.Context, d *Deps, args json.RawMessage,
) (any, error) {
	return handleCampaignTemplateLifecycle(ctx, d, args, false)
}

func handleRestoreEditableCampaignTemplate(
	ctx context.Context, d *Deps, args json.RawMessage,
) (any, error) {
	return handleCampaignTemplateLifecycle(ctx, d, args, true)
}

type listCampaignTemplateRevisionsInput struct {
	TemplateID string `json:"template_id"`
	Page       int    `json:"page"`
	PerPage    int    `json:"per_page"`
}

func handleListEditableCampaignTemplateRevisions(
	ctx context.Context,
	d *Deps,
	args json.RawMessage,
) (any, error) {
	if d.CampaignTemplates == nil {
		return nil, errors.New("listCampaignTemplateRevisions is unavailable: campaign templates are not configured")
	}
	var in listCampaignTemplateRevisionsInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	return d.CampaignTemplates.ListRevisions(
		ctx, tenantID, strings.TrimSpace(in.TemplateID), in.Page, in.PerPage,
	)
}

type getCampaignTemplateRevisionInput struct {
	TemplateID string `json:"template_id"`
	Version    int64  `json:"version"`
}

func handleGetEditableCampaignTemplateRevision(
	ctx context.Context,
	d *Deps,
	args json.RawMessage,
) (any, error) {
	if d.CampaignTemplates == nil {
		return nil, errors.New("getCampaignTemplateRevision is unavailable: campaign templates are not configured")
	}
	var in getCampaignTemplateRevisionInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	revision, err := d.CampaignTemplates.GetRevision(
		ctx, tenantID, strings.TrimSpace(in.TemplateID), in.Version,
	)
	if err != nil {
		return nil, err
	}
	return projectNativeCampaignTemplateResponse(ctx, revision), nil
}

type generateCampaignTemplateInput struct {
	IdempotencyKey       string         `json:"idempotency_key"`
	Brief                string         `json:"brief"`
	Kind                 string         `json:"kind"`
	Tone                 string         `json:"tone"`
	Fidelity             string         `json:"fidelity"`
	Name                 string         `json:"name"`
	Goal                 string         `json:"goal"`
	Category             string         `json:"category"`
	Subject              string         `json:"subject"`
	PreviewText          string         `json:"preview_text"`
	Audience             string         `json:"audience"`
	Industry             string         `json:"industry"`
	Style                string         `json:"style"`
	Layout               string         `json:"layout"`
	Sections             []string       `json:"sections"`
	CTA                  string         `json:"cta"`
	Brand                map[string]any `json:"brand"`
	Content              map[string]any `json:"content"`
	Variables            map[string]any `json:"variables"`
	ReferenceTemplateIDs []string       `json:"reference_template_ids"`
}

func handleGenerateCampaignTemplate(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	if d.CampaignTemplateWorkflow == nil {
		return nil, errors.New("generateCampaignTemplate is unavailable: durable template design workflow is not configured")
	}
	var in generateCampaignTemplateInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	key := strings.TrimSpace(in.IdempotencyKey)
	if _, keyErr := requiredMCPDesignIdempotencyKey(key); keyErr != nil {
		return nil, keyErr
	}
	draft, replayed, err := d.CampaignTemplateWorkflow.StartDesignDraft(
		ctx,
		tenantID,
		mcpDesignActor(ctx),
		key,
		campaigntemplates.CreateDesignDraftInput{
			Mode: "generate", Brief: in.Brief, Kind: in.Kind, Tone: in.Tone,
			Fidelity: in.Fidelity, Name: in.Name, Goal: in.Goal,
			Category: in.Category, Subject: in.Subject,
			PreviewText: in.PreviewText, Audience: in.Audience,
			Industry: in.Industry, Style: in.Style, Layout: in.Layout,
			Sections: in.Sections, CTA: in.CTA, Brand: in.Brand,
			Content: in.Content, Variables: in.Variables,
			ReferenceTemplateIDs: in.ReferenceTemplateIDs,
		},
	)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"design": draft, "idempotent_replayed": replayed,
		"next_action": "getCampaignTemplateDesign",
	}, nil
}

type adaptCampaignTemplateInput struct {
	IdempotencyKey       string         `json:"idempotency_key"`
	TemplateID           string         `json:"template_id"`
	Instructions         string         `json:"instructions"`
	Tone                 string         `json:"tone"`
	Fidelity             string         `json:"fidelity"`
	Name                 string         `json:"name"`
	Subject              string         `json:"subject"`
	PreviewText          string         `json:"preview_text"`
	Audience             string         `json:"audience"`
	Industry             string         `json:"industry"`
	Style                string         `json:"style"`
	Layout               string         `json:"layout"`
	Sections             []string       `json:"sections"`
	CTA                  string         `json:"cta"`
	Brand                map[string]any `json:"brand"`
	Content              map[string]any `json:"content"`
	Variables            map[string]any `json:"variables"`
	ReferenceTemplateIDs []string       `json:"reference_template_ids"`
}

func handleAdaptCampaignTemplate(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	if d.CampaignTemplateWorkflow == nil {
		return nil, errors.New("adaptCampaignTemplate is unavailable: durable template design workflow is not configured")
	}
	var in adaptCampaignTemplateInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	key := strings.TrimSpace(in.IdempotencyKey)
	if _, keyErr := requiredMCPDesignIdempotencyKey(key); keyErr != nil {
		return nil, keyErr
	}
	draft, replayed, err := d.CampaignTemplateWorkflow.StartDesignDraft(
		ctx,
		tenantID,
		mcpDesignActor(ctx),
		key,
		campaigntemplates.CreateDesignDraftInput{
			Mode: "adapt", SourceTemplateID: in.TemplateID,
			Instructions: in.Instructions, Tone: in.Tone,
			Fidelity: in.Fidelity, Name: in.Name, Subject: in.Subject,
			PreviewText: in.PreviewText, Audience: in.Audience,
			Industry: in.Industry, Style: in.Style, Layout: in.Layout,
			Sections: in.Sections, CTA: in.CTA, Brand: in.Brand,
			Content: in.Content, Variables: in.Variables,
			ReferenceTemplateIDs: in.ReferenceTemplateIDs,
		},
	)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"design": draft, "idempotent_replayed": replayed,
		"next_action": "getCampaignTemplateDesign",
	}, nil
}

type saveCampaignTemplateDesignInput struct {
	IdempotencyKey string `json:"idempotency_key"`
	DesignID       string `json:"design_id"`
	Revision       int    `json:"revision"`
	OutputHash     string `json:"output_hash"`
	Slug           string `json:"slug"`
	Name           string `json:"name"`
	Subject        string `json:"subject"`
	PreviewText    string `json:"preview_text"`
}

func requiredMCPDesignIdempotencyKey(value string) (string, error) {
	for _, character := range value {
		if unicode.IsControl(character) {
			return "", errors.New("idempotency_key must not contain control characters")
		}
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return "", errors.New("idempotency_key is required; reuse it only for the exact same design mutation")
	}
	if len(value) > 255 {
		return "", errors.New("idempotency_key must be at most 255 characters")
	}
	return value, nil
}

func handleSaveCampaignTemplateDesign(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	if d.CampaignTemplateWorkflow == nil {
		return nil, errors.New("saveCampaignTemplateDesign is unavailable: durable template design workflow is not configured")
	}
	var in saveCampaignTemplateDesignInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	key, err := requiredMCPDesignIdempotencyKey(in.IdempotencyKey)
	if err != nil {
		return nil, err
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	template, replayed, err := d.CampaignTemplateWorkflow.SaveDesignDraftRevisionWithKey(
		ctx,
		tenantID,
		mcpDesignActor(ctx),
		strings.TrimSpace(in.DesignID),
		key,
		campaigntemplates.SaveDesignDraftInput{
			CommitDesignDraftInput: campaigntemplates.CommitDesignDraftInput{
				Revision: in.Revision, OutputHash: in.OutputHash,
			},
			Slug: in.Slug, Name: in.Name, Subject: in.Subject,
			PreviewText: in.PreviewText,
		},
	)
	if err != nil {
		return nil, err
	}
	projectNativeCampaignTemplateResponse(ctx, template)
	return map[string]any{
		"template": template, "idempotent_replayed": replayed,
	}, nil
}

type campaignTemplateDesignInput struct {
	DesignID string `json:"design_id"`
}

type listCampaignTemplateDesignsInput struct {
	Limit  int    `json:"limit"`
	Cursor string `json:"cursor"`
}

func handleListCampaignTemplateDesigns(
	ctx context.Context,
	d *Deps,
	args json.RawMessage,
) (any, error) {
	if d.CampaignTemplateWorkflow == nil {
		return nil, errors.New("listCampaignTemplateDesigns is unavailable: durable template design workflow is not configured")
	}
	var in listCampaignTemplateDesignsInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	return d.CampaignTemplateWorkflow.ListRecoverableDesignDrafts(
		ctx,
		tenantID,
		mcpDesignActor(ctx),
		campaigntemplates.DesignDraftListFilter{
			Limit:  in.Limit,
			Cursor: in.Cursor,
		},
	)
}

func handleGetCampaignTemplateDesign(
	ctx context.Context,
	d *Deps,
	args json.RawMessage,
) (any, error) {
	if d.CampaignTemplateWorkflow == nil {
		return nil, errors.New("getCampaignTemplateDesign is unavailable: durable template design workflow is not configured")
	}
	var in campaignTemplateDesignInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	return d.CampaignTemplateWorkflow.FetchDesignDraft(
		ctx, tenantID, mcpDesignActor(ctx), strings.TrimSpace(in.DesignID),
	)
}

func handleListCampaignTemplateDesignRevisions(
	ctx context.Context,
	d *Deps,
	args json.RawMessage,
) (any, error) {
	if d.CampaignTemplateWorkflow == nil {
		return nil, errors.New("listCampaignTemplateDesignRevisions is unavailable: durable template design workflow is not configured")
	}
	var in campaignTemplateDesignInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	items, err := d.CampaignTemplateWorkflow.FetchDesignDraftRevisions(
		ctx, tenantID, mcpDesignActor(ctx), strings.TrimSpace(in.DesignID),
	)
	if err != nil {
		return nil, err
	}
	return map[string]any{"items": items}, nil
}

type refineCampaignTemplateDesignInput struct {
	IdempotencyKey string `json:"idempotency_key"`
	DesignID       string `json:"design_id"`
	BaseRevision   int    `json:"base_revision"`
	Instructions   string `json:"instructions"`
}

func handleRefineCampaignTemplateDesign(
	ctx context.Context,
	d *Deps,
	args json.RawMessage,
) (any, error) {
	if d.CampaignTemplateWorkflow == nil {
		return nil, errors.New("refineCampaignTemplateDesign is unavailable: durable template design workflow is not configured")
	}
	var in refineCampaignTemplateDesignInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	key, err := requiredMCPDesignIdempotencyKey(in.IdempotencyKey)
	if err != nil {
		return nil, err
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	design, replayed, err := d.CampaignTemplateWorkflow.QueueDesignDraftRefinementWithKey(
		ctx,
		tenantID,
		mcpDesignActor(ctx),
		strings.TrimSpace(in.DesignID),
		key,
		campaigntemplates.RefineDesignDraftInput{
			Instructions: in.Instructions, BaseRevision: in.BaseRevision,
		},
	)
	if err != nil {
		return nil, err
	}
	return map[string]any{"design": design, "idempotent_replayed": replayed}, nil
}

type mutateCampaignTemplateDesignInput struct {
	IdempotencyKey string `json:"idempotency_key"`
	DesignID       string `json:"design_id"`
}

func handleRetryCampaignTemplateDesign(
	ctx context.Context,
	d *Deps,
	args json.RawMessage,
) (any, error) {
	if d.CampaignTemplateWorkflow == nil {
		return nil, errors.New("retryCampaignTemplateDesign is unavailable: durable template design workflow is not configured")
	}
	var in mutateCampaignTemplateDesignInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	key, err := requiredMCPDesignIdempotencyKey(in.IdempotencyKey)
	if err != nil {
		return nil, err
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	design, replayed, err := d.CampaignTemplateWorkflow.RetryDesignDraftJobWithKey(
		ctx, tenantID, mcpDesignActor(ctx),
		strings.TrimSpace(in.DesignID), key,
	)
	if err != nil {
		return nil, err
	}
	return map[string]any{"design": design, "idempotent_replayed": replayed}, nil
}

type createCampaignFromTemplateDesignInput struct {
	IdempotencyKey string                           `json:"idempotency_key"`
	DesignID       string                           `json:"design_id"`
	Revision       int                              `json:"revision"`
	OutputHash     string                           `json:"output_hash"`
	Name           string                           `json:"name"`
	Subject        string                           `json:"subject"`
	PreviewText    string                           `json:"preview_text"`
	Variables      map[string]any                   `json:"variables"`
	SegmentID      string                           `json:"segment_id"`
	ListID         campaigntemplates.AudienceListID `json:"list_id"`
}

func handleCreateCampaignFromTemplateDesign(
	ctx context.Context,
	d *Deps,
	args json.RawMessage,
) (any, error) {
	if d.CampaignTemplateWorkflow == nil {
		return nil, errors.New("createCampaignFromTemplateDesign is unavailable: durable template design workflow is not configured")
	}
	var in createCampaignFromTemplateDesignInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	key, err := requiredMCPDesignIdempotencyKey(in.IdempotencyKey)
	if err != nil {
		return nil, err
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	campaign, replayed, err := d.CampaignTemplateWorkflow.CreateCampaignFromDesignRevisionWithKey(
		ctx,
		tenantID,
		mcpDesignActor(ctx),
		strings.TrimSpace(in.DesignID),
		key,
		campaigntemplates.CreateCampaignFromDesignDraftInput{
			CommitDesignDraftInput: campaigntemplates.CommitDesignDraftInput{
				Revision: in.Revision, OutputHash: in.OutputHash,
			},
			Name: in.Name, Subject: in.Subject, PreviewText: in.PreviewText,
			Variables: in.Variables, SegmentID: in.SegmentID, ListID: in.ListID,
		},
	)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"campaign": campaign, "idempotent_replayed": replayed,
	}, nil
}

func handleArchiveCampaignTemplateDesign(
	ctx context.Context,
	d *Deps,
	args json.RawMessage,
) (any, error) {
	if d.CampaignTemplateWorkflow == nil {
		return nil, errors.New("archiveCampaignTemplateDesign is unavailable: durable template design workflow is not configured")
	}
	var in mutateCampaignTemplateDesignInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	key, err := requiredMCPDesignIdempotencyKey(in.IdempotencyKey)
	if err != nil {
		return nil, err
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	design, replayed, err := d.CampaignTemplateWorkflow.ArchiveDesignDraftJobWithKey(
		ctx, tenantID, mcpDesignActor(ctx),
		strings.TrimSpace(in.DesignID), key,
	)
	if err != nil {
		return nil, err
	}
	return map[string]any{"design": design, "idempotent_replayed": replayed}, nil
}

type createCampaignFromTemplateInput struct {
	TemplateID  string                           `json:"template_id"`
	Name        string                           `json:"name"`
	Subject     string                           `json:"subject"`
	PreviewText string                           `json:"preview_text"`
	Variables   map[string]any                   `json:"variables"`
	Content     map[string]any                   `json:"content"`
	Brand       map[string]any                   `json:"brand"`
	SegmentID   string                           `json:"segment_id"`
	ListID      campaigntemplates.AudienceListID `json:"list_id"`
}

func handleCreateCampaignFromTemplate(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	if d.CampaignTemplates == nil || d.CampaignCreate == nil {
		return nil, errors.New("createCampaignFromTemplate is unavailable: required services are not configured")
	}
	var in createCampaignFromTemplateInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if strings.TrimSpace(in.TemplateID) == "" {
		return nil, errors.New("template_id is required")
	}
	listID := strings.TrimSpace(string(in.ListID))
	if strings.TrimSpace(in.SegmentID) != "" && listID != "" {
		return nil, errors.New("pass segment_id or list_id, not both")
	}
	if listID != "" {
		parsed, parseErr := strconv.ParseInt(listID, 10, 64)
		if parseErr != nil || parsed <= 0 {
			return nil, errors.New("list_id must be a positive integer")
		}
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	tpl, err := d.CampaignTemplates.GetByIDOrSlug(ctx, tenantID, strings.TrimSpace(in.TemplateID))
	if err != nil {
		return nil, err
	}
	if err := campaigntemplates.ValidateTemplateEligibility(tpl); err != nil {
		return nil, err
	}
	if strings.EqualFold(strings.TrimSpace(tpl.TemplateKind), "reference") {
		return nil, errors.New("reference-only templates must be adapted or generated before campaign creation")
	}
	identity, err := d.CampaignTemplates.WorkspaceIdentity(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	// The same chokepoint as POST /api/v1/campaigns/from-template: the
	// send-time unsubscribe placeholder and subscriber merge tags survive, and
	// workspace tokens come from the workspace, never from sample defaults.
	draft, err := campaigntemplates.BuildCampaignDraft(ctx, tpl, campaigntemplates.CampaignDraftInput{
		Name: in.Name, Subject: in.Subject, PreviewText: in.PreviewText,
		Variables: in.Variables, Content: in.Content, Brand: in.Brand,
		SegmentID: in.SegmentID, ListID: listID,
	}, identity)
	if err != nil {
		return nil, err
	}
	campaign, err := d.CampaignCreate.Create(ctx, tenantID, draft)
	if err != nil {
		return nil, err
	}
	_ = d.CampaignTemplates.RecordUse(ctx, tenantID, tpl.ID)
	return campaigntemplates.CampaignDraftResult{
		Campaign: campaign, UnresolvedVariables: campaigntemplates.DraftUnresolvedVariables(draft),
	}, nil
}

func mcpPromptField(label, value string) string {
	if value = strings.TrimSpace(value); value != "" {
		return "\n" + label + ": " + boundedMCPTemplateText(value, 1500)
	}
	return ""
}

func mcpPromptMap(label string, values map[string]any) string {
	if len(values) == 0 {
		return ""
	}
	raw, _ := json.Marshal(values)
	return "\n" + label + ": " + boundedMCPTemplateText(string(raw), 2500)
}

func mcpGenerationKind(values ...string) string {
	for _, value := range values {
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "promo", "promotional", "marketing":
			return "promo"
		case "announcement":
			return "announcement"
		case "newsletter":
			return "newsletter"
		}
	}
	return "newsletter"
}

func mcpGoal(goal string) string {
	switch strings.ToLower(strings.TrimSpace(goal)) {
	case "welcome", "newsletter", "announcement", "promotional", "re_engagement", "transactional", "automation":
		return strings.ToLower(strings.TrimSpace(goal))
	default:
		return "newsletter"
	}
}

func mcpDesignActor(ctx context.Context) campaigntemplates.ReferenceReviewActor {
	if keyID := strings.TrimSpace(middleware.APIKeyIDFromContext(ctx)); keyID != "" {
		_, label := middleware.ActorFromContext(ctx)
		return campaigntemplates.ReferenceReviewActor{
			Type: "api_key", ID: keyID, Label: strings.TrimSpace(label),
		}
	}
	if user, ok := middleware.UserFromContext(ctx); ok && user != nil &&
		strings.TrimSpace(user.ID) != "" {
		return campaigntemplates.ReferenceReviewActor{
			Type: "user", ID: user.ID, Label: user.Email,
		}
	}
	// Native MCP is API-key authenticated in production. A stable service
	// actor keeps direct package tests and trusted in-process agent calls
	// auditable without accepting actor identity from tool arguments.
	return campaigntemplates.ReferenceReviewActor{
		Type: "service", ID: "native-mcp", Label: "Native MCP",
	}
}

func boundedMCPTemplateText(value string, maxRunes int) string {
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[:maxRunes]) + "…"
}
