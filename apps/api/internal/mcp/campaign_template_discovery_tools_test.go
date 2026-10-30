// SPDX-License-Identifier: AGPL-3.0-only

package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/campaigntemplates"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type campaignTemplateDiscoveryCatalogFake struct {
	*campaignTemplateCatalogFake

	createCollectionKey   string
	createCollectionInput campaigntemplates.CreateCampaignTemplateCollectionInput
	collectionID          string
	collectionVersion     int64
	updateCollectionInput campaigntemplates.UpdateCampaignTemplateCollectionInput
	collectionTemplateIDs []string
	deleteCollectionCalls int

	createSavedSearchKey   string
	createSavedSearchInput campaigntemplates.CreateCampaignTemplateSavedSearchInput
	savedSearchID          string
	savedSearchVersion     int64
	updateSavedSearchInput campaigntemplates.UpdateCampaignTemplateSavedSearchInput
	deleteSavedSearchCalls int
}

func newCampaignTemplateDiscoveryCatalogFake() *campaignTemplateDiscoveryCatalogFake {
	return &campaignTemplateDiscoveryCatalogFake{
		campaignTemplateCatalogFake: &campaignTemplateCatalogFake{},
	}
}

func (*campaignTemplateDiscoveryCatalogFake) RecordRecentView(
	context.Context, string, string, string,
) (*campaigntemplates.RecentTemplateView, error) {
	return &campaigntemplates.RecentTemplateView{}, nil
}

func (*campaignTemplateDiscoveryCatalogFake) ListRecentViews(
	context.Context, string, string, int,
) ([]campaigntemplates.RecentTemplateView, error) {
	return nil, nil
}

func (*campaignTemplateDiscoveryCatalogFake) ClearRecentViews(
	context.Context, string, string, string,
) (int64, error) {
	return 0, nil
}

func (*campaignTemplateDiscoveryCatalogFake) ListCollections(
	context.Context, string, string,
) ([]campaigntemplates.CampaignTemplateCollection, error) {
	return nil, nil
}

func (*campaignTemplateDiscoveryCatalogFake) GetCollection(
	context.Context, string, string, string,
) (*campaigntemplates.CampaignTemplateCollection, error) {
	return &campaigntemplates.CampaignTemplateCollection{}, nil
}

func (f *campaignTemplateDiscoveryCatalogFake) CreateCollectionIdempotent(
	_ context.Context,
	_, _ string,
	key string,
	in campaigntemplates.CreateCampaignTemplateCollectionInput,
) (*campaigntemplates.CampaignTemplateCollection, error) {
	f.createCollectionKey = key
	f.createCollectionInput = in
	return &campaigntemplates.CampaignTemplateCollection{ID: "collection-1"}, nil
}

func (f *campaignTemplateDiscoveryCatalogFake) UpdateCollectionIfVersion(
	_ context.Context,
	_, _, id string,
	version int64,
	in campaigntemplates.UpdateCampaignTemplateCollectionInput,
) (*campaigntemplates.CampaignTemplateCollection, error) {
	f.collectionID = id
	f.collectionVersion = version
	f.updateCollectionInput = in
	return &campaigntemplates.CampaignTemplateCollection{ID: id, Version: version + 1}, nil
}

func (f *campaignTemplateDiscoveryCatalogFake) ReplaceCollectionItemsIfVersion(
	_ context.Context,
	_, _, id string,
	version int64,
	templateIDs []string,
) (*campaigntemplates.CampaignTemplateCollection, error) {
	f.collectionID = id
	f.collectionVersion = version
	f.collectionTemplateIDs = templateIDs
	return &campaigntemplates.CampaignTemplateCollection{ID: id, Version: version + 1}, nil
}

func (f *campaignTemplateDiscoveryCatalogFake) DeleteCollectionIfVersion(
	_ context.Context, _, _, id string, version int64,
) (bool, error) {
	f.collectionID = id
	f.collectionVersion = version
	f.deleteCollectionCalls++
	return true, nil
}

func (*campaignTemplateDiscoveryCatalogFake) ListSavedSearches(
	context.Context, string, string,
) ([]campaigntemplates.CampaignTemplateSavedSearch, error) {
	return []campaigntemplates.CampaignTemplateSavedSearch{
		{
			ID: "saved-1",
			ObsoleteFilters: []campaigntemplates.CampaignTemplateSavedSearchFilter{
				{Field: "tags", Value: "retired-topic"},
			},
		},
	}, nil
}

func (*campaignTemplateDiscoveryCatalogFake) GetSavedSearch(
	context.Context, string, string, string,
) (*campaigntemplates.CampaignTemplateSavedSearch, error) {
	return &campaigntemplates.CampaignTemplateSavedSearch{
		ID: "saved-1",
		ObsoleteFilters: []campaigntemplates.CampaignTemplateSavedSearchFilter{
			{Field: "tags", Value: "retired-topic"},
		},
	}, nil
}

func (f *campaignTemplateDiscoveryCatalogFake) CreateSavedSearchIdempotent(
	_ context.Context,
	_, _ string,
	key string,
	in campaigntemplates.CreateCampaignTemplateSavedSearchInput,
) (*campaigntemplates.CampaignTemplateSavedSearch, error) {
	f.createSavedSearchKey = key
	f.createSavedSearchInput = in
	return &campaigntemplates.CampaignTemplateSavedSearch{ID: "saved-1"}, nil
}

func (f *campaignTemplateDiscoveryCatalogFake) UpdateSavedSearchIfVersion(
	_ context.Context,
	_, _, id string,
	version int64,
	in campaigntemplates.UpdateCampaignTemplateSavedSearchInput,
) (*campaigntemplates.CampaignTemplateSavedSearch, error) {
	f.savedSearchID = id
	f.savedSearchVersion = version
	f.updateSavedSearchInput = in
	return &campaigntemplates.CampaignTemplateSavedSearch{ID: id, Version: version + 1}, nil
}

func (f *campaignTemplateDiscoveryCatalogFake) DeleteSavedSearchIfVersion(
	_ context.Context, _, _, id string, version int64,
) (bool, error) {
	f.savedSearchID = id
	f.savedSearchVersion = version
	f.deleteSavedSearchCalls++
	return true, nil
}

func (*campaignTemplateDiscoveryCatalogFake) CompareTemplates(
	_ context.Context, _, _ string, identifiers []string,
) (*campaigntemplates.CompareTemplatesResponse, error) {
	return &campaigntemplates.CompareTemplatesResponse{
		Items: []campaigntemplates.CompareTemplateItem{
			{RequestedIdentifier: identifiers[0]},
		},
		UnavailableIdentifiers: []string{identifiers[1]},
	}, nil
}

func discoveryMutationTestContext() context.Context {
	ctx := middleware.WithTenant(
		context.Background(),
		&middleware.Tenant{ID: "tenant-1"},
	)
	return middleware.WithUser(
		ctx,
		&middleware.User{ID: "user-1", TenantID: "tenant-1"},
	)
}

func TestMCPDiscoveryMutationIdentityValidation(t *testing.T) {
	t.Parallel()

	const key = " collection-create-01 "
	got, err := mcpDiscoveryIdempotencyKey(key)
	if err != nil {
		t.Fatalf("valid idempotency key: %v", err)
	}
	if got != key {
		t.Fatalf("idempotency key = %q, want exact %q", got, key)
	}
	for _, invalid := range []string{"", " \t ", "unsafe\nkey", strings.Repeat("é", 128)} {
		if _, err := mcpDiscoveryIdempotencyKey(invalid); err == nil {
			t.Fatalf("idempotency key %q unexpectedly accepted", invalid)
		}
	}

	version, err := mcpDiscoveryETagVersion(
		`"campaign-template-collection:collection-1:v7"`,
		"campaign-template-collection",
		"collection-1",
	)
	if err != nil || version != 7 {
		t.Fatalf("etag version = %d, err = %v", version, err)
	}
	for _, invalid := range []string{
		`W/"campaign-template-collection:collection-1:v7"`,
		`"campaign-template-collection:collection-2:v7"`,
		`"campaign-template-saved-search:collection-1:v7"`,
		`"campaign-template-collection:collection-1:v7", "other"`,
		` "campaign-template-collection:collection-1:v7"`,
	} {
		if _, err := mcpDiscoveryETagVersion(
			invalid,
			"campaign-template-collection",
			"collection-1",
		); err == nil {
			t.Fatalf("etag %q unexpectedly accepted", invalid)
		}
	}
}

func TestMCPDiscoveryMutationHandlersForwardIdentityAndVersion(t *testing.T) {
	t.Parallel()

	catalog := newCampaignTemplateDiscoveryCatalogFake()
	deps := &Deps{CampaignTemplates: catalog}
	ctx := discoveryMutationTestContext()

	rawComparison, err := handleCompareCampaignTemplates(
		ctx,
		deps,
		json.RawMessage(`{"templates":["template-1","removed-template"]}`),
	)
	if err != nil {
		t.Fatalf("compare templates: %v", err)
	}
	comparison, ok := rawComparison.(*campaigntemplates.CompareTemplatesResponse)
	if !ok ||
		len(comparison.Items) != 1 ||
		len(comparison.UnavailableIdentifiers) != 1 ||
		comparison.UnavailableIdentifiers[0] != "removed-template" {
		t.Fatalf("partial compare result = %#v", rawComparison)
	}
	rawSavedSearches, err := handleListCampaignTemplateSavedSearches(
		ctx,
		deps,
		nil,
	)
	if err != nil {
		t.Fatalf("list saved searches: %v", err)
	}
	savedSearches, ok := rawSavedSearches.(map[string]any)
	items, itemsOK := savedSearches["items"].([]campaigntemplates.CampaignTemplateSavedSearch)
	if !ok || !itemsOK ||
		len(items) != 1 ||
		len(items[0].ObsoleteFilters) != 1 {
		t.Fatalf("saved-search drift result = %#v", rawSavedSearches)
	}

	if _, err := handleCreateCampaignTemplateCollection(ctx, deps, json.RawMessage(`{
		"idempotency_key":" collection-create-01 ",
		"name":"Launch set",
		"description":"Reviewed",
		"template_ids":["template-1","template-2"]
	}`)); err != nil {
		t.Fatalf("create collection: %v", err)
	}
	if catalog.createCollectionKey != " collection-create-01 " ||
		catalog.createCollectionInput.Name != "Launch set" ||
		len(catalog.createCollectionInput.TemplateIDs) != 2 {
		t.Fatalf("create collection call = %#v", catalog)
	}

	if _, err := handleUpdateCampaignTemplateCollection(ctx, deps, json.RawMessage(`{
		"collection_id":"collection-1",
		"if_match":"\"campaign-template-collection:collection-1:v7\"",
		"name":"Launch set v2"
	}`)); err != nil {
		t.Fatalf("update collection: %v", err)
	}
	if catalog.collectionID != "collection-1" ||
		catalog.collectionVersion != 7 ||
		catalog.updateCollectionInput.Name == nil ||
		*catalog.updateCollectionInput.Name != "Launch set v2" {
		t.Fatalf("update collection call = %#v", catalog)
	}

	if _, err := handleReplaceCampaignTemplateCollectionItems(ctx, deps, json.RawMessage(`{
		"collection_id":"collection-1",
		"if_match":"\"campaign-template-collection:collection-1:v8\"",
		"template_ids":["template-3"]
	}`)); err != nil {
		t.Fatalf("replace collection items: %v", err)
	}
	if catalog.collectionVersion != 8 ||
		len(catalog.collectionTemplateIDs) != 1 ||
		catalog.collectionTemplateIDs[0] != "template-3" {
		t.Fatalf("replace collection call = %#v", catalog)
	}

	if _, err := handleCreateCampaignTemplateSavedSearch(ctx, deps, json.RawMessage(`{
		"idempotency_key":"saved-create-01",
		"name":"Editorial",
		"filters":{"kind":"editable","favorited":true}
	}`)); err != nil {
		t.Fatalf("create saved search: %v", err)
	}
	if catalog.createSavedSearchKey != "saved-create-01" ||
		catalog.createSavedSearchInput.Name != "Editorial" ||
		catalog.createSavedSearchInput.Filters.Kind != "editable" ||
		!catalog.createSavedSearchInput.Filters.FavoritedOnly {
		t.Fatalf("create saved search call = %#v", catalog)
	}

	if _, err := handleDeleteCampaignTemplateSavedSearch(ctx, deps, json.RawMessage(`{
		"saved_search_id":"saved-1",
		"if_match":"\"campaign-template-saved-search:saved-1:v4\""
	}`)); err != nil {
		t.Fatalf("delete saved search: %v", err)
	}
	if catalog.savedSearchID != "saved-1" ||
		catalog.savedSearchVersion != 4 ||
		catalog.deleteSavedSearchCalls != 1 {
		t.Fatalf("delete saved search call = %#v", catalog)
	}

	if _, err := handleDeleteCampaignTemplateCollection(ctx, deps, json.RawMessage(`{
		"collection_id":"collection-1",
		"if_match":"\"campaign-template-saved-search:collection-1:v9\""
	}`)); err == nil {
		t.Fatal("cross-resource collection etag unexpectedly accepted")
	}
	if catalog.deleteCollectionCalls != 0 {
		t.Fatal("invalid etag reached collection repository")
	}
}
