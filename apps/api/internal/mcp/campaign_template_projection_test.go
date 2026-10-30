// SPDX-License-Identifier: AGPL-3.0-only

package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/campaigntemplates"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	nativeReferenceHTMLMarker = "REFERENCE_HTML_MUST_NOT_CROSS_MCP"
	nativeReferenceMJMLMarker = "REFERENCE_MJML_MUST_NOT_CROSS_MCP"
	nativeOwnedHTMLMarker     = "OWNED_HTML_MUST_REMAIN_EDITABLE"
	nativeOwnedMJMLMarker     = "OWNED_MJML_MUST_REMAIN_EDITABLE"
)

func nativeCampaignTemplateAPIKeyContext(scopes ...apikeys.Scope) context.Context {
	ctx := middleware.WithTenant(
		context.Background(),
		&middleware.Tenant{ID: "tenant-1"},
	)
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID: "user-1", TenantID: "tenant-1", Role: "owner",
	})
	ctx = middleware.WithAPIKeyAuth(ctx)
	return apikeys.WithScopes(ctx, scopes)
}

func nativeCampaignTemplateViewerContext() context.Context {
	ctx := middleware.WithTenant(
		context.Background(),
		&middleware.Tenant{ID: "tenant-1"},
	)
	return middleware.WithUser(ctx, &middleware.User{
		ID: "user-1", TenantID: "tenant-1", Role: "viewer",
	})
}

func nativeOwnedEditableTemplate() campaigntemplates.Template {
	return campaigntemplates.Template{
		ID: "owned-template", TenantID: "tenant-1", Slug: "owned-template",
		Name: "Owned template", Subject: "Owned subject",
		BodyHTML: nativeOwnedHTMLMarker, BodyMJML: nativeOwnedMJMLMarker,
		TemplateKind: "editable", ReviewStatus: "approved",
		SourceLicenseStatus: "owned", Version: 2,
		Capabilities: campaigntemplates.TemplateCapabilities{
			CanPreview: true, CanFavorite: true, CanAdapt: true,
			CanUseDirectly: true, CanCreateCampaign: true,
			CanEditDirectly: true, CanClone: true, CanDelete: true,
			CanArchive: true, HasSourceHTML: true, HasSourceMJML: true,
		},
		RecommendedAction: "campaign_template_create_campaign",
	}
}

func nativeCapturedReferenceTemplate() campaigntemplates.Template {
	return campaigntemplates.Template{
		ID: "reference-template", Slug: "reference-template",
		Name: "Reference template", Subject: "Reference subject",
		BodyHTML: nativeReferenceHTMLMarker, BodyMJML: nativeReferenceMJMLMarker,
		TemplateKind: "reference", ReviewStatus: "approved",
		SourceLicenseStatus: "unreviewed", Version: 2,
		ReferenceAdaptationAllowed: true,
		Capabilities: campaigntemplates.TemplateCapabilities{
			CanPreview: true, CanFavorite: true, CanAdapt: true,
			CanUseDirectly: true, CanCreateCampaign: true,
			CanEditDirectly: true, CanClone: true, CanDelete: true,
			CanArchive: true, HasSourceHTML: true, HasSourceMJML: true,
		},
		RecommendedAction: "campaign_template_create_campaign",
	}
}

func nativeCampaignTemplateResponseEnvelopes(
	template campaigntemplates.Template,
) []struct {
	name  string
	value any
} {
	return []struct {
		name  string
		value any
	}{
		{name: "template", value: &template},
		{
			name: "search",
			value: &campaigntemplates.SearchResponse{
				Items: []campaigntemplates.Template{template},
			},
		},
		{
			name:  "revision",
			value: &campaigntemplates.TemplateRevision{Snapshot: template},
		},
		{
			name:  "recent item",
			value: &campaigntemplates.RecentTemplateView{Template: template},
		},
		{
			name: "recent list",
			value: []campaigntemplates.RecentTemplateView{
				{Template: template},
			},
		},
		{
			name: "collection",
			value: &campaigntemplates.CampaignTemplateCollection{
				Items: []campaigntemplates.Template{template},
			},
		},
		{
			name: "collection list",
			value: []campaigntemplates.CampaignTemplateCollection{
				{Items: []campaigntemplates.Template{template}},
			},
		},
		{
			name: "comparison",
			value: &campaigntemplates.CompareTemplatesResponse{
				Items: []campaigntemplates.CompareTemplateItem{
					{Template: template},
				},
			},
		},
	}
}

func TestNativeCampaignTemplateResponseProjectionCoversEveryEnvelope(t *testing.T) {
	writeContext := nativeCampaignTemplateAPIKeyContext(
		apikeys.ScopeReadCampaigns,
		apikeys.ScopeWriteCampaigns,
	)

	for _, test := range nativeCampaignTemplateResponseEnvelopes(
		nativeCapturedReferenceTemplate(),
	) {
		t.Run("reference/"+test.name, func(t *testing.T) {
			projected := projectNativeCampaignTemplateResponse(
				writeContext,
				test.value,
			)
			encoded, err := json.Marshal(projected)
			if err != nil {
				t.Fatalf("marshal projected response: %v", err)
			}
			body := string(encoded)
			if strings.Contains(body, nativeReferenceHTMLMarker) ||
				strings.Contains(body, nativeReferenceMJMLMarker) {
				t.Fatalf("captured reference body crossed MCP: %s", body)
			}
			if !strings.Contains(body, `"has_source_html":true`) ||
				!strings.Contains(body, `"has_source_mjml":true`) {
				t.Fatalf("source-presence facts were lost: %s", body)
			}
		})
	}

	for _, test := range nativeCampaignTemplateResponseEnvelopes(
		nativeOwnedEditableTemplate(),
	) {
		t.Run("owned/"+test.name, func(t *testing.T) {
			projected := projectNativeCampaignTemplateResponse(
				writeContext,
				test.value,
			)
			encoded, err := json.Marshal(projected)
			if err != nil {
				t.Fatalf("marshal projected response: %v", err)
			}
			body := string(encoded)
			if !strings.Contains(body, nativeOwnedHTMLMarker) ||
				!strings.Contains(body, nativeOwnedMJMLMarker) {
				t.Fatalf("owned editable source was removed: %s", body)
			}
			if !strings.Contains(body, `"can_edit_directly":true`) ||
				!strings.Contains(body, `"can_create_campaign":true`) {
				t.Fatalf("write-authorized actions were removed: %s", body)
			}
		})
	}
}

type nativeCampaignTemplateProjectionCatalogFake struct {
	*campaignTemplateDiscoveryCatalogFake
	template campaigntemplates.Template
}

func newNativeCampaignTemplateProjectionCatalogFake(
	template campaigntemplates.Template,
) *nativeCampaignTemplateProjectionCatalogFake {
	return &nativeCampaignTemplateProjectionCatalogFake{
		campaignTemplateDiscoveryCatalogFake: newCampaignTemplateDiscoveryCatalogFake(),
		template:                             template,
	}
}

func (f *nativeCampaignTemplateProjectionCatalogFake) Search(
	context.Context,
	string,
	campaigntemplates.SearchFilter,
) (*campaigntemplates.SearchResponse, error) {
	return &campaigntemplates.SearchResponse{
		Items: []campaigntemplates.Template{f.template},
	}, nil
}

func (f *nativeCampaignTemplateProjectionCatalogFake) Get(
	context.Context,
	string,
	string,
) (*campaigntemplates.Template, error) {
	template := f.template
	return &template, nil
}

func (f *nativeCampaignTemplateProjectionCatalogFake) GetByIDOrSlug(
	ctx context.Context,
	tenantID string,
	identifier string,
) (*campaigntemplates.Template, error) {
	return f.Get(ctx, tenantID, identifier)
}

func (f *nativeCampaignTemplateProjectionCatalogFake) GetRevision(
	context.Context,
	string,
	string,
	int64,
) (*campaigntemplates.TemplateRevision, error) {
	return &campaigntemplates.TemplateRevision{
		Snapshot: f.template,
	}, nil
}

func (f *nativeCampaignTemplateProjectionCatalogFake) RecordRecentView(
	context.Context,
	string,
	string,
	string,
) (*campaigntemplates.RecentTemplateView, error) {
	return &campaigntemplates.RecentTemplateView{
		Template: f.template,
	}, nil
}

func (f *nativeCampaignTemplateProjectionCatalogFake) ListRecentViews(
	context.Context,
	string,
	string,
	int,
) ([]campaigntemplates.RecentTemplateView, error) {
	return []campaigntemplates.RecentTemplateView{
		{Template: f.template},
	}, nil
}

func (f *nativeCampaignTemplateProjectionCatalogFake) ListCollections(
	context.Context,
	string,
	string,
) ([]campaigntemplates.CampaignTemplateCollection, error) {
	return []campaigntemplates.CampaignTemplateCollection{
		{
			ID:    "collection-1",
			Items: []campaigntemplates.Template{f.template},
		},
	}, nil
}

func (f *nativeCampaignTemplateProjectionCatalogFake) templateCollection(
	version int64,
) *campaigntemplates.CampaignTemplateCollection {
	return &campaigntemplates.CampaignTemplateCollection{
		ID: "collection-1", Version: version,
		Items: []campaigntemplates.Template{f.template},
	}
}

func (f *nativeCampaignTemplateProjectionCatalogFake) GetCollection(
	context.Context,
	string,
	string,
	string,
) (*campaigntemplates.CampaignTemplateCollection, error) {
	return f.templateCollection(1), nil
}

func (f *nativeCampaignTemplateProjectionCatalogFake) CreateCollectionIdempotent(
	context.Context,
	string,
	string,
	string,
	campaigntemplates.CreateCampaignTemplateCollectionInput,
) (*campaigntemplates.CampaignTemplateCollection, error) {
	return f.templateCollection(1), nil
}

func (f *nativeCampaignTemplateProjectionCatalogFake) UpdateCollectionIfVersion(
	context.Context,
	string,
	string,
	string,
	int64,
	campaigntemplates.UpdateCampaignTemplateCollectionInput,
) (*campaigntemplates.CampaignTemplateCollection, error) {
	return f.templateCollection(2), nil
}

func (f *nativeCampaignTemplateProjectionCatalogFake) ReplaceCollectionItemsIfVersion(
	context.Context,
	string,
	string,
	string,
	int64,
	[]string,
) (*campaigntemplates.CampaignTemplateCollection, error) {
	return f.templateCollection(2), nil
}

func (f *nativeCampaignTemplateProjectionCatalogFake) CompareTemplates(
	context.Context,
	string,
	string,
	[]string,
) (*campaigntemplates.CompareTemplatesResponse, error) {
	return &campaigntemplates.CompareTemplatesResponse{
		Items: []campaigntemplates.CompareTemplateItem{
			{RequestedIdentifier: f.template.ID, Template: f.template},
		},
	}, nil
}

func assertNativeReadOnlyTemplateResponse(
	t *testing.T,
	response any,
) {
	t.Helper()
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal response: %v", err)
	}
	body := string(encoded)
	for _, forbidden := range []string{
		`"can_adapt":true`,
		`"can_use_directly":true`,
		`"can_create_campaign":true`,
		`"can_edit_directly":true`,
		`"can_clone":true`,
		`"can_delete":true`,
		`"can_archive":true`,
		`"can_restore":true`,
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("read-only MCP response contains %s: %s", forbidden, body)
		}
	}
	if !strings.Contains(body, `"can_edit_directly":false`) ||
		!strings.Contains(
			body,
			`"recommended_action":"request_campaign_write_access"`,
		) {
		t.Fatalf("read-only capability projection is missing: %s", body)
	}
	if !strings.Contains(body, nativeOwnedHTMLMarker) ||
		!strings.Contains(body, nativeOwnedMJMLMarker) {
		t.Fatalf("readable owned source was removed: %s", body)
	}
}

func TestNativeCampaignTemplateHandlersProjectReadOnlyCapabilities(t *testing.T) {
	tests := []struct {
		name string
		run  func(context.Context, *Deps) (any, error)
	}{
		{
			name: "search",
			run: func(ctx context.Context, deps *Deps) (any, error) {
				return handleSearchCampaignTemplates(ctx, deps, json.RawMessage(`{}`))
			},
		},
		{
			name: "get",
			run: func(ctx context.Context, deps *Deps) (any, error) {
				return handleGetCampaignTemplate(
					ctx,
					deps,
					json.RawMessage(`{"template_id":"owned-template"}`),
				)
			},
		},
		{
			name: "revision",
			run: func(ctx context.Context, deps *Deps) (any, error) {
				return handleGetEditableCampaignTemplateRevision(
					ctx,
					deps,
					json.RawMessage(
						`{"template_id":"owned-template","version":1}`,
					),
				)
			},
		},
		{
			name: "comparison",
			run: func(ctx context.Context, deps *Deps) (any, error) {
				return handleCompareCampaignTemplates(
					ctx,
					deps,
					json.RawMessage(
						`{"templates":["owned-template","other-template"]}`,
					),
				)
			},
		},
		{
			name: "record recent",
			run: func(ctx context.Context, deps *Deps) (any, error) {
				return handleRecordRecentCampaignTemplate(
					ctx,
					deps,
					json.RawMessage(`{"template_id":"owned-template"}`),
				)
			},
		},
		{
			name: "list recent",
			run: func(ctx context.Context, deps *Deps) (any, error) {
				return handleListRecentCampaignTemplates(
					ctx,
					deps,
					json.RawMessage(`{"limit":10}`),
				)
			},
		},
		{
			name: "list collections",
			run: func(ctx context.Context, deps *Deps) (any, error) {
				return handleListCampaignTemplateCollections(ctx, deps, nil)
			},
		},
		{
			name: "get collection",
			run: func(ctx context.Context, deps *Deps) (any, error) {
				return handleGetCampaignTemplateCollection(
					ctx,
					deps,
					json.RawMessage(`{"collection_id":"collection-1"}`),
				)
			},
		},
		{
			name: "create collection",
			run: func(ctx context.Context, deps *Deps) (any, error) {
				return handleCreateCampaignTemplateCollection(
					ctx,
					deps,
					json.RawMessage(
						`{"idempotency_key":"create-1","name":"Launches"}`,
					),
				)
			},
		},
		{
			name: "update collection",
			run: func(ctx context.Context, deps *Deps) (any, error) {
				return handleUpdateCampaignTemplateCollection(
					ctx,
					deps,
					json.RawMessage(
						`{"collection_id":"collection-1","if_match":"\"campaign-template-collection:collection-1:v1\"","name":"Launches v2"}`,
					),
				)
			},
		},
		{
			name: "replace collection items",
			run: func(ctx context.Context, deps *Deps) (any, error) {
				return handleReplaceCampaignTemplateCollectionItems(
					ctx,
					deps,
					json.RawMessage(
						`{"collection_id":"collection-1","if_match":"\"campaign-template-collection:collection-1:v1\"","template_ids":["owned-template"]}`,
					),
				)
			},
		},
		{
			name: "saved search results",
			run: func(ctx context.Context, deps *Deps) (any, error) {
				return handleCampaignTemplateSavedSearchResults(
					ctx,
					deps,
					json.RawMessage(`{"saved_search_id":"saved-1"}`),
				)
			},
		},
	}

	contexts := []struct {
		name string
		ctx  context.Context
	}{
		{
			name: "viewer role",
			ctx:  nativeCampaignTemplateViewerContext(),
		},
		{
			name: "read-only API key",
			ctx: nativeCampaignTemplateAPIKeyContext(
				apikeys.ScopeReadCampaigns,
			),
		},
	}
	for _, access := range contexts {
		t.Run(access.name, func(t *testing.T) {
			for _, test := range tests {
				t.Run(test.name, func(t *testing.T) {
					catalog := newNativeCampaignTemplateProjectionCatalogFake(
						nativeOwnedEditableTemplate(),
					)
					response, err := test.run(
						access.ctx,
						&Deps{CampaignTemplates: catalog},
					)
					if err != nil {
						t.Fatalf("handler returned an error: %v", err)
					}
					assertNativeReadOnlyTemplateResponse(t, response)
				})
			}
		})
	}
}

type nativeCampaignTemplateProjectionWorkflowFake struct {
	*campaignTemplateWorkflowFake
	template campaigntemplates.Template
}

func (f *nativeCampaignTemplateProjectionWorkflowFake) SaveDesignDraftRevisionWithKey(
	context.Context,
	string,
	campaigntemplates.ReferenceReviewActor,
	string,
	string,
	campaigntemplates.SaveDesignDraftInput,
) (*campaigntemplates.Template, bool, error) {
	template := f.template
	return &template, false, nil
}

func TestSaveCampaignTemplateDesignProjectsReturnedTemplate(t *testing.T) {
	tests := []struct {
		name                 string
		template             campaigntemplates.Template
		wantBodyMarker       string
		forbiddenBodyMarkers []string
	}{
		{
			name:           "owned editable source remains available",
			template:       nativeOwnedEditableTemplate(),
			wantBodyMarker: nativeOwnedHTMLMarker,
		},
		{
			name:     "reference source is redacted defensively",
			template: nativeCapturedReferenceTemplate(),
			forbiddenBodyMarkers: []string{
				nativeReferenceHTMLMarker,
				nativeReferenceMJMLMarker,
			},
		},
	}
	ctx := nativeCampaignTemplateAPIKeyContext(
		apikeys.ScopeReadCampaigns,
		apikeys.ScopeWriteCampaigns,
	)
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			workflow := &nativeCampaignTemplateProjectionWorkflowFake{
				campaignTemplateWorkflowFake: &campaignTemplateWorkflowFake{},
				template:                     test.template,
			}
			response, err := handleSaveCampaignTemplateDesign(
				ctx,
				&Deps{CampaignTemplateWorkflow: workflow},
				json.RawMessage(
					`{"idempotency_key":"save-1","design_id":"design-1"}`,
				),
			)
			if err != nil {
				t.Fatalf("save design: %v", err)
			}
			encoded, err := json.Marshal(response)
			if err != nil {
				t.Fatalf("marshal response: %v", err)
			}
			body := string(encoded)
			if test.wantBodyMarker != "" &&
				!strings.Contains(body, test.wantBodyMarker) {
				t.Fatalf("owned body was removed: %s", body)
			}
			for _, marker := range test.forbiddenBodyMarkers {
				if strings.Contains(body, marker) {
					t.Fatalf("reference body crossed MCP: %s", body)
				}
			}
		})
	}
}
