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
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/campaigntemplates"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type campaignTemplateDiscoveryCatalog interface {
	RecordRecentView(context.Context, string, string, string) (*campaigntemplates.RecentTemplateView, error)
	ListRecentViews(context.Context, string, string, int) ([]campaigntemplates.RecentTemplateView, error)
	ClearRecentViews(context.Context, string, string, string) (int64, error)
	ListCollections(context.Context, string, string) ([]campaigntemplates.CampaignTemplateCollection, error)
	GetCollection(context.Context, string, string, string) (*campaigntemplates.CampaignTemplateCollection, error)
	CreateCollectionIdempotent(context.Context, string, string, string, campaigntemplates.CreateCampaignTemplateCollectionInput) (*campaigntemplates.CampaignTemplateCollection, error)
	UpdateCollectionIfVersion(context.Context, string, string, string, int64, campaigntemplates.UpdateCampaignTemplateCollectionInput) (*campaigntemplates.CampaignTemplateCollection, error)
	ReplaceCollectionItemsIfVersion(context.Context, string, string, string, int64, []string) (*campaigntemplates.CampaignTemplateCollection, error)
	DeleteCollectionIfVersion(context.Context, string, string, string, int64) (bool, error)
	ListSavedSearches(context.Context, string, string) ([]campaigntemplates.CampaignTemplateSavedSearch, error)
	GetSavedSearch(context.Context, string, string, string) (*campaigntemplates.CampaignTemplateSavedSearch, error)
	CreateSavedSearchIdempotent(context.Context, string, string, string, campaigntemplates.CreateCampaignTemplateSavedSearchInput) (*campaigntemplates.CampaignTemplateSavedSearch, error)
	UpdateSavedSearchIfVersion(context.Context, string, string, string, int64, campaigntemplates.UpdateCampaignTemplateSavedSearchInput) (*campaigntemplates.CampaignTemplateSavedSearch, error)
	DeleteSavedSearchIfVersion(context.Context, string, string, string, int64) (bool, error)
	CompareTemplates(context.Context, string, string, []string) (*campaigntemplates.CompareTemplatesResponse, error)
}

func discoveryCatalog(d *Deps) (campaignTemplateDiscoveryCatalog, error) {
	if d == nil || d.CampaignTemplates == nil {
		return nil, errors.New("campaign template discovery is unavailable: campaign templates are not configured")
	}
	catalog, ok := d.CampaignTemplates.(campaignTemplateDiscoveryCatalog)
	if !ok {
		return nil, errors.New("campaign template discovery is unavailable: durable discovery state is not configured")
	}
	return catalog, nil
}

func mcpTemplateUserID(ctx context.Context) (string, error) {
	user, ok := middleware.UserFromContext(ctx)
	if !ok || user == nil || strings.TrimSpace(user.ID) == "" {
		return "", errors.New("campaign template personal state requires an authenticated user context")
	}
	return user.ID, nil
}

func mcpDiscoveryIdempotencyKey(value string) (string, error) {
	if !utf8.ValidString(value) ||
		strings.IndexFunc(value, unicode.IsControl) >= 0 {
		return "", errors.New("idempotency_key must be 1-255 UTF-8 bytes without control characters")
	}
	normalized := strings.TrimSpace(value)
	if normalized == "" || len(normalized) > 255 {
		return "", errors.New("idempotency_key must be 1-255 UTF-8 bytes without control characters")
	}
	// Preserve the caller's exact value. The repository performs the same
	// canonical normalization used by REST before claiming durable identity.
	return value, nil
}

func mcpDiscoveryETagVersion(value, resource, id string) (int64, error) {
	if value == "" || value != strings.TrimSpace(value) {
		return 0, fmt.Errorf("if_match must be the exact current %s etag", resource)
	}
	prefix := `"` + resource + `:` + id + `:v`
	if strings.HasPrefix(value, "W/") ||
		strings.Contains(value, ",") ||
		!strings.HasPrefix(value, prefix) ||
		!strings.HasSuffix(value, `"`) {
		return 0, fmt.Errorf("if_match must be the exact current %s etag", resource)
	}
	versionText := strings.TrimSuffix(strings.TrimPrefix(value, prefix), `"`)
	version, err := strconv.ParseInt(versionText, 10, 64)
	if err != nil || version < 1 ||
		value != httpcache.ETagStrong(resource, id, version) {
		return 0, fmt.Errorf("if_match must be the exact current %s etag", resource)
	}
	return version, nil
}

type templateIdentifiersInput struct {
	Templates []string `json:"templates"`
}

func handleCompareCampaignTemplates(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	catalog, err := discoveryCatalog(d)
	if err != nil {
		return nil, err
	}
	var in templateIdentifiersInput
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
	result, err := catalog.CompareTemplates(
		ctx,
		tenantID,
		userID,
		in.Templates,
	)
	if err != nil {
		return nil, err
	}
	return projectNativeCampaignTemplateResponse(ctx, result), nil
}

type templateIDInput struct {
	TemplateID string `json:"template_id"`
}

func handleCampaignTemplateFavorite(
	ctx context.Context,
	d *Deps,
	args json.RawMessage,
	favorited bool,
) (any, error) {
	if d == nil || d.CampaignTemplates == nil {
		return nil, errors.New("campaign template favorites are unavailable: campaign templates are not configured")
	}
	var in templateIDInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := mcpTemplateUserID(ctx)
	if err != nil {
		return nil, err
	}
	if err := d.CampaignTemplates.SetFavorite(
		ctx, tenantID, userID, strings.TrimSpace(in.TemplateID), favorited,
	); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "favorited": favorited}, nil
}

func handleFavoriteCampaignTemplate(
	ctx context.Context, d *Deps, args json.RawMessage,
) (any, error) {
	return handleCampaignTemplateFavorite(ctx, d, args, true)
}

func handleUnfavoriteCampaignTemplate(
	ctx context.Context, d *Deps, args json.RawMessage,
) (any, error) {
	return handleCampaignTemplateFavorite(ctx, d, args, false)
}

func handleRecordRecentCampaignTemplate(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	catalog, err := discoveryCatalog(d)
	if err != nil {
		return nil, err
	}
	var in templateIDInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := mcpTemplateUserID(ctx)
	if err != nil {
		return nil, err
	}
	view, err := catalog.RecordRecentView(
		ctx,
		tenantID,
		userID,
		in.TemplateID,
	)
	if err != nil {
		return nil, err
	}
	return projectNativeCampaignTemplateResponse(ctx, view), nil
}

type recentCampaignTemplatesInput struct {
	Limit int `json:"limit"`
}

func handleListRecentCampaignTemplates(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	catalog, err := discoveryCatalog(d)
	if err != nil {
		return nil, err
	}
	var in recentCampaignTemplatesInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := mcpTemplateUserID(ctx)
	if err != nil {
		return nil, err
	}
	items, err := catalog.ListRecentViews(ctx, tenantID, userID, in.Limit)
	if err != nil {
		return nil, err
	}
	projectNativeCampaignTemplateResponse(ctx, items)
	return map[string]any{"items": items}, nil
}

func handleClearRecentCampaignTemplates(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	catalog, err := discoveryCatalog(d)
	if err != nil {
		return nil, err
	}
	var in templateIDInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := mcpTemplateUserID(ctx)
	if err != nil {
		return nil, err
	}
	cleared, err := catalog.ClearRecentViews(ctx, tenantID, userID, in.TemplateID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "cleared": cleared}, nil
}

type collectionIDInput struct {
	CollectionID string `json:"collection_id"`
}

func handleListCampaignTemplateCollections(ctx context.Context, d *Deps, _ json.RawMessage) (any, error) {
	catalog, err := discoveryCatalog(d)
	if err != nil {
		return nil, err
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := mcpTemplateUserID(ctx)
	if err != nil {
		return nil, err
	}
	items, err := catalog.ListCollections(ctx, tenantID, userID)
	if err != nil {
		return nil, err
	}
	projectNativeCampaignTemplateResponse(ctx, items)
	return map[string]any{"items": items}, nil
}

func handleGetCampaignTemplateCollection(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	catalog, err := discoveryCatalog(d)
	if err != nil {
		return nil, err
	}
	var in collectionIDInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := mcpTemplateUserID(ctx)
	if err != nil {
		return nil, err
	}
	collection, err := catalog.GetCollection(
		ctx,
		tenantID,
		userID,
		in.CollectionID,
	)
	if err != nil {
		return nil, err
	}
	return projectNativeCampaignTemplateResponse(ctx, collection), nil
}

func handleCreateCampaignTemplateCollection(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	catalog, err := discoveryCatalog(d)
	if err != nil {
		return nil, err
	}
	var in struct {
		IdempotencyKey string   `json:"idempotency_key"`
		Name           string   `json:"name"`
		Description    string   `json:"description"`
		TemplateIDs    []string `json:"template_ids"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	idempotencyKey, err := mcpDiscoveryIdempotencyKey(in.IdempotencyKey)
	if err != nil {
		return nil, err
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := mcpTemplateUserID(ctx)
	if err != nil {
		return nil, err
	}
	collection, err := catalog.CreateCollectionIdempotent(
		ctx,
		tenantID,
		userID,
		idempotencyKey,
		campaigntemplates.CreateCampaignTemplateCollectionInput{
			Name:        in.Name,
			Description: in.Description,
			TemplateIDs: in.TemplateIDs,
		},
	)
	if err != nil {
		return nil, err
	}
	return projectNativeCampaignTemplateResponse(ctx, collection), nil
}

type updateCollectionInput struct {
	CollectionID string  `json:"collection_id"`
	IfMatch      string  `json:"if_match"`
	Name         *string `json:"name"`
	Description  *string `json:"description"`
}

func handleUpdateCampaignTemplateCollection(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	catalog, err := discoveryCatalog(d)
	if err != nil {
		return nil, err
	}
	var in updateCollectionInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	version, err := mcpDiscoveryETagVersion(
		in.IfMatch,
		"campaign-template-collection",
		in.CollectionID,
	)
	if err != nil {
		return nil, err
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := mcpTemplateUserID(ctx)
	if err != nil {
		return nil, err
	}
	collection, err := catalog.UpdateCollectionIfVersion(
		ctx,
		tenantID,
		userID,
		in.CollectionID,
		version,
		campaigntemplates.UpdateCampaignTemplateCollectionInput{
			Name: in.Name, Description: in.Description,
		},
	)
	if err != nil {
		return nil, err
	}
	return projectNativeCampaignTemplateResponse(ctx, collection), nil
}

type replaceCollectionItemsInput struct {
	CollectionID string   `json:"collection_id"`
	IfMatch      string   `json:"if_match"`
	TemplateIDs  []string `json:"template_ids"`
}

func handleReplaceCampaignTemplateCollectionItems(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	catalog, err := discoveryCatalog(d)
	if err != nil {
		return nil, err
	}
	var in replaceCollectionItemsInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	version, err := mcpDiscoveryETagVersion(
		in.IfMatch,
		"campaign-template-collection",
		in.CollectionID,
	)
	if err != nil {
		return nil, err
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := mcpTemplateUserID(ctx)
	if err != nil {
		return nil, err
	}
	collection, err := catalog.ReplaceCollectionItemsIfVersion(
		ctx,
		tenantID,
		userID,
		in.CollectionID,
		version,
		in.TemplateIDs,
	)
	if err != nil {
		return nil, err
	}
	return projectNativeCampaignTemplateResponse(ctx, collection), nil
}

type deleteCollectionInput struct {
	CollectionID string `json:"collection_id"`
	IfMatch      string `json:"if_match"`
}

func handleDeleteCampaignTemplateCollection(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	catalog, err := discoveryCatalog(d)
	if err != nil {
		return nil, err
	}
	var in deleteCollectionInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	version, err := mcpDiscoveryETagVersion(
		in.IfMatch,
		"campaign-template-collection",
		in.CollectionID,
	)
	if err != nil {
		return nil, err
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := mcpTemplateUserID(ctx)
	if err != nil {
		return nil, err
	}
	deleted, err := catalog.DeleteCollectionIfVersion(
		ctx,
		tenantID,
		userID,
		in.CollectionID,
		version,
	)
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "deleted": deleted}, nil
}

type savedSearchIDInput struct {
	SavedSearchID string `json:"saved_search_id"`
}

func handleListCampaignTemplateSavedSearches(ctx context.Context, d *Deps, _ json.RawMessage) (any, error) {
	catalog, err := discoveryCatalog(d)
	if err != nil {
		return nil, err
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := mcpTemplateUserID(ctx)
	if err != nil {
		return nil, err
	}
	items, err := catalog.ListSavedSearches(ctx, tenantID, userID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"items": items}, nil
}

func handleGetCampaignTemplateSavedSearch(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	catalog, err := discoveryCatalog(d)
	if err != nil {
		return nil, err
	}
	var in savedSearchIDInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := mcpTemplateUserID(ctx)
	if err != nil {
		return nil, err
	}
	return catalog.GetSavedSearch(ctx, tenantID, userID, in.SavedSearchID)
}

func handleCreateCampaignTemplateSavedSearch(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	catalog, err := discoveryCatalog(d)
	if err != nil {
		return nil, err
	}
	var in struct {
		IdempotencyKey string                               `json:"idempotency_key"`
		Name           string                               `json:"name"`
		Filters        campaigntemplates.SavedSearchFilters `json:"filters"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	idempotencyKey, err := mcpDiscoveryIdempotencyKey(in.IdempotencyKey)
	if err != nil {
		return nil, err
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := mcpTemplateUserID(ctx)
	if err != nil {
		return nil, err
	}
	return catalog.CreateSavedSearchIdempotent(
		ctx,
		tenantID,
		userID,
		idempotencyKey,
		campaigntemplates.CreateCampaignTemplateSavedSearchInput{
			Name:    in.Name,
			Filters: in.Filters,
		},
	)
}

type updateSavedSearchInput struct {
	SavedSearchID string                                `json:"saved_search_id"`
	IfMatch       string                                `json:"if_match"`
	Name          *string                               `json:"name"`
	Filters       *campaigntemplates.SavedSearchFilters `json:"filters"`
}

func handleUpdateCampaignTemplateSavedSearch(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	catalog, err := discoveryCatalog(d)
	if err != nil {
		return nil, err
	}
	var in updateSavedSearchInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	version, err := mcpDiscoveryETagVersion(
		in.IfMatch,
		"campaign-template-saved-search",
		in.SavedSearchID,
	)
	if err != nil {
		return nil, err
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := mcpTemplateUserID(ctx)
	if err != nil {
		return nil, err
	}
	return catalog.UpdateSavedSearchIfVersion(ctx, tenantID, userID, in.SavedSearchID, version,
		campaigntemplates.UpdateCampaignTemplateSavedSearchInput{
			Name: in.Name, Filters: in.Filters,
		})
}

type deleteSavedSearchInput struct {
	SavedSearchID string `json:"saved_search_id"`
	IfMatch       string `json:"if_match"`
}

func handleDeleteCampaignTemplateSavedSearch(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	catalog, err := discoveryCatalog(d)
	if err != nil {
		return nil, err
	}
	var in deleteSavedSearchInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	version, err := mcpDiscoveryETagVersion(
		in.IfMatch,
		"campaign-template-saved-search",
		in.SavedSearchID,
	)
	if err != nil {
		return nil, err
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := mcpTemplateUserID(ctx)
	if err != nil {
		return nil, err
	}
	deleted, err := catalog.DeleteSavedSearchIfVersion(
		ctx,
		tenantID,
		userID,
		in.SavedSearchID,
		version,
	)
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "deleted": deleted}, nil
}

type savedSearchResultsInput struct {
	SavedSearchID string `json:"saved_search_id"`
	Cursor        string `json:"cursor"`
	PerPage       int    `json:"per_page"`
}

func handleCampaignTemplateSavedSearchResults(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	catalog, err := discoveryCatalog(d)
	if err != nil {
		return nil, err
	}
	var in savedSearchResultsInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	tenantID, err := mcpTenantID(ctx)
	if err != nil {
		return nil, err
	}
	userID, err := mcpTemplateUserID(ctx)
	if err != nil {
		return nil, err
	}
	saved, err := catalog.GetSavedSearch(ctx, tenantID, userID, in.SavedSearchID)
	if err != nil {
		return nil, err
	}
	filter := saved.Filters.SearchFilter(userID)
	filter.Cursor = in.Cursor
	filter.PerPage = in.PerPage
	result, err := d.CampaignTemplates.Search(ctx, tenantID, filter)
	if err != nil {
		return nil, err
	}
	return projectNativeCampaignTemplateResponse(ctx, result), nil
}
