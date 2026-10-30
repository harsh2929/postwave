// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestReferenceReviewPermissionsSeparateAdaptationFromDirectUse(t *testing.T) {
	adaptationOnly := &Template{
		TemplateKind:               templateKindReference,
		ReviewStatus:               reviewStatusApproved,
		SourceLicenseStatus:        licenseStatusUnreviewed,
		ReferenceAdaptationAllowed: true,
	}
	if err := ValidateTemplateAdaptationEligibility(adaptationOnly); err != nil {
		t.Fatalf("adaptation-only review rejected from adaptation: %v", err)
	}
	if err := ValidateTemplateEligibility(adaptationOnly); err != ErrTemplateIneligible {
		t.Fatalf("adaptation-only direct gate error=%v, want ErrTemplateIneligible", err)
	}

	directOnly := &Template{
		TemplateKind:              templateKindReference,
		ReviewStatus:              reviewStatusApproved,
		SourceLicenseStatus:       licenseStatusOwned,
		ReferenceDirectUseAllowed: true,
	}
	if err := ValidateTemplateEligibility(directOnly); err != nil {
		t.Fatalf("owned direct-use review rejected: %v", err)
	}
	if err := ValidateTemplateAdaptationEligibility(directOnly); err != ErrTemplateIneligible {
		t.Fatalf("direct-only adaptation gate error=%v, want ErrTemplateIneligible", err)
	}
}

func TestTemplateCapabilitiesAreActionableAndRequestAware(t *testing.T) {
	template := &Template{
		ID: "reference-1", TenantID: "tenant-1", TemplateKind: templateKindReference,
		ReviewStatus: reviewStatusApproved, SourceLicenseStatus: licenseStatusUnreviewed,
		ReferenceAdaptationAllowed: true, ThumbnailURL: "https://example.test/preview.png",
		PreviewAssets: []TemplatePreviewAsset{
			{Variant: "desktop", URL: "https://assets.example.test/desktop.png"},
			{Variant: "mobile", URL: "https://assets.example.test/mobile.png"},
		},
		SourceMetadata: map[string]any{
			"mobile_screenshot": "https://example.test/mobile.png",
		},
	}
	projectTemplate(template, templatePresentationAccess{CanWrite: true, CanFavorite: true})
	if !template.Capabilities.CanAdapt || template.Capabilities.CanUseDirectly ||
		template.Capabilities.CanCreateCampaign || template.Capabilities.CanEditDirectly ||
		template.Capabilities.CanDelete || !template.Capabilities.CanPreview ||
		!template.Capabilities.HasDesktopPreview || !template.Capabilities.HasMobilePreview {
		t.Fatalf("editor capabilities=%+v", template.Capabilities)
	}
	if template.RecommendedAction != "campaign_template_adapt" ||
		!hasTemplateWarning(template.Warnings, "adaptation_only") ||
		!hasTemplateWarning(template.Warnings, "metadata_only_reference") {
		t.Fatalf("editor action/warnings=%q/%+v", template.RecommendedAction, template.Warnings)
	}

	projectTemplate(template, templatePresentationAccess{CanFavorite: true})
	if template.Capabilities.CanAdapt || !template.Capabilities.CanFavorite ||
		template.RecommendedAction != "request_campaign_write_access" ||
		!hasTemplateWarning(template.Warnings, "write_permission_required") {
		t.Fatalf("viewer capabilities/action/warnings=%+v/%q/%+v",
			template.Capabilities, template.RecommendedAction, template.Warnings)
	}
}

func TestAPIKeyTemplateCapabilitiesKeepBoundPersonalPrincipal(t *testing.T) {
	bound := middleware.WithUser(context.Background(), &middleware.User{
		ID: "00000000-0000-4000-8000-000000000111", TenantID: "tenant-1",
	})
	bound = middleware.WithAPIKeyAuth(bound)
	bound = apikeys.WithScopes(bound, []apikeys.Scope{apikeys.ScopeReadCampaigns})
	access := templatePresentationAccessFromContext(bound)
	if !access.CanFavorite || access.CanWrite {
		t.Fatalf("bound read-only API-key access=%+v", access)
	}

	unbound := middleware.WithAPIKeyAuth(context.Background())
	unbound = apikeys.WithScopes(unbound, []apikeys.Scope{apikeys.ScopeWriteCampaigns})
	access = templatePresentationAccessFromContext(unbound)
	if access.CanFavorite || !access.CanWrite {
		t.Fatalf("unbound write API-key access=%+v", access)
	}
}

func TestTemplateMobilePreviewMetadataFailsClosedWithoutOwnedOrRenderableContent(t *testing.T) {
	onlyMJML := &Template{
		TemplateKind: templateKindReference, ReviewStatus: reviewStatusPending,
		HasSourceMJML: true,
	}
	projectTemplate(onlyMJML, unrestrictedTemplatePresentation)
	if onlyMJML.Capabilities.HasMobilePreview {
		t.Fatalf("MJML source was mistaken for a rendered mobile preview: %+v",
			onlyMJML.Capabilities)
	}

	mobileOnly := &Template{
		TemplateKind: templateKindReference, ReviewStatus: reviewStatusPending,
		DesignMetadata: map[string]any{"has_mobile_preview": true},
	}
	projectTemplate(mobileOnly, unrestrictedTemplatePresentation)
	if mobileOnly.Capabilities.HasMobilePreview ||
		mobileOnly.Capabilities.CanPreview ||
		mobileOnly.Capabilities.HasDesktopPreview {
		t.Fatalf("upstream-only preview metadata did not fail closed: %+v",
			mobileOnly.Capabilities)
	}

	retainedReference := &Template{
		TemplateKind: templateKindReference, ReviewStatus: reviewStatusPending,
		BodyHTML:       "<p>retained only for server-side adaptation</p>",
		DesignMetadata: map[string]any{"has_mobile_preview": true},
	}
	projectTemplate(retainedReference, unrestrictedTemplatePresentation)
	if retainedReference.Capabilities.HasMobilePreview ||
		retainedReference.Capabilities.HasDesktopPreview ||
		retainedReference.Capabilities.CanPreview ||
		!retainedReference.Capabilities.HasSourceHTML ||
		retainedReference.BodyHTML != "" {
		t.Fatalf("retained reference markup crossed the client boundary: %+v body=%q",
			retainedReference.Capabilities, retainedReference.BodyHTML)
	}

	editableRendered := &Template{
		TemplateKind: templateKindEditable, TenantID: "tenant-1",
		ReviewStatus:   reviewStatusApproved,
		DesignMetadata: map[string]any{"has_mobile_preview": true},
	}
	projectTemplate(editableRendered, unrestrictedTemplatePresentation)
	if !editableRendered.Capabilities.HasMobilePreview ||
		!editableRendered.Capabilities.CanPreview {
		t.Fatalf("owned renderer metadata was not projected: %+v",
			editableRendered.Capabilities)
	}
}

func TestProviderPreviewMetadataFailsClosedUntilHosted(t *testing.T) {
	providerOnly := &Template{
		TemplateKind: templateKindReference, ReviewStatus: reviewStatusPending,
		ThumbnailURL: "https://provider.example.test/desktop.png",
		SourceMetadata: map[string]any{
			"desktop_screenshot": "https://provider.example.test/desktop.png",
			"mobile_screenshot":  "https://provider.example.test/mobile.png",
		},
	}
	projectTemplate(providerOnly, unrestrictedTemplatePresentation)
	if providerOnly.Capabilities.CanPreview ||
		providerOnly.Capabilities.HasDesktopPreview ||
		providerOnly.Capabilities.HasMobilePreview ||
		!hasTemplateWarning(providerOnly.Warnings, "preview_unavailable") {
		t.Fatalf("provider-only preview metadata did not fail closed: %+v/%+v",
			providerOnly.Capabilities, providerOnly.Warnings)
	}
}

func hasTemplateWarning(warnings []TemplateWarning, code string) bool {
	for _, warning := range warnings {
		if warning.Code == code {
			return true
		}
	}
	return false
}

type capabilityProjectionRepository struct {
	templateRepository
	template Template
}

func (repo *capabilityProjectionRepository) List(context.Context, string, ListFilter) ([]Template, error) {
	return []Template{repo.template}, nil
}

func (repo *capabilityProjectionRepository) Search(context.Context, string, SearchFilter) (*SearchResponse, error) {
	return &SearchResponse{Items: []Template{repo.template}, Facets: CatalogFacets{}}, nil
}

func (repo *capabilityProjectionRepository) Get(context.Context, string, string) (*Template, error) {
	out := repo.template
	return &out, nil
}

func (repo *capabilityProjectionRepository) GetByIDOrSlug(ctx context.Context, tenantID, identifier string) (*Template, error) {
	return repo.Get(ctx, tenantID, identifier)
}

func TestListSearchAndGetAlwaysProjectCapabilities(t *testing.T) {
	repo := &capabilityProjectionRepository{template: Template{
		ID: "reference-1", TenantID: "tenant-1", Slug: "reference-1",
		Name: "Reference", Subject: "Reference", Variables: []map[string]interface{}{}, Tags: []string{},
		TemplateKind: templateKindReference, ReviewStatus: reviewStatusApproved,
		SourceLicenseStatus: licenseStatusUnreviewed, ReferenceAdaptationAllowed: true,
		ThumbnailURL: "https://example.test/reference.png",
	}}
	deps := &Deps{Repo: repo}
	editorRequest := func(method, target string) *http.Request {
		req := tenantRequest(method, target, "")
		return req.WithContext(middleware.WithUser(req.Context(), &middleware.User{
			ID: "user-1", TenantID: "tenant-1", Role: "editor",
		}))
	}
	tests := []struct {
		name   string
		target string
		call   func(http.ResponseWriter, *http.Request)
	}{
		{name: "list", target: "/api/v1/campaign-templates", call: deps.List},
		{name: "search", target: "/api/v1/campaign-templates/search", call: deps.Search},
		{name: "get", target: "/api/v1/campaign-templates/reference-1", call: deps.Get},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			test.call(rec, editorRequest(http.MethodGet, test.target))
			if rec.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			for _, fragment := range []string{
				`"capabilities":`, `"can_adapt":true`, `"can_use_directly":false`,
				`"recommended_action":"campaign_template_adapt"`, `"warnings":`,
			} {
				if !strings.Contains(rec.Body.String(), fragment) {
					t.Fatalf("response missing %s: %s", fragment, rec.Body.String())
				}
			}
		})
	}
}

type reviewDecisionRepository struct {
	templateRepository
	input ReferenceReviewDecisionInput
	actor ReferenceReviewActor
	err   error
}

func (repo *reviewDecisionRepository) ReviewReference(
	_ context.Context,
	_, _ string,
	in ReferenceReviewDecisionInput,
	actor ReferenceReviewActor,
) (*ReferenceReviewResult, error) {
	repo.input, repo.actor = in, actor
	if repo.err != nil {
		return nil, repo.err
	}
	return &ReferenceReviewResult{
		Decision: ReferenceReviewDecision{
			ID: "decision-1", TemplateID: "reference-1", Decision: in.Decision,
			AdaptationAllowed: in.AdaptationAllowed, DirectUseAllowed: in.DirectUseAllowed,
			Note: in.Note, ActorType: actor.Type, ActorID: actor.ID,
		},
		ReviewStatus: reviewStatusApproved, SourceLicenseStatus: licenseStatusUnreviewed,
	}, nil
}

func TestReviewReferenceDecisionDerivesActorAndNeverAcceptsLicenseClaims(t *testing.T) {
	repo := &reviewDecisionRepository{}
	deps := &Deps{Repo: repo}
	router := chi.NewRouter()
	router.Post("/api/v1/campaign-templates/{id}/review-decisions", deps.ReviewReferenceDecision)
	req := tenantRequest(http.MethodPost, "/api/v1/campaign-templates/reference-1/review-decisions", `{
		"decision":"approve",
		"adaptation_allowed":true,
		"direct_use_allowed":false,
		"note":"Approved for original inspiration only"
	}`)
	req = req.WithContext(middleware.WithUser(req.Context(), &middleware.User{
		ID:       "00000000-0000-4000-8000-000000000111",
		TenantID: "tenant-1", Email: "reviewer@example.test", Role: "admin",
	}))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if repo.actor.Type != "user" || repo.actor.ID != "00000000-0000-4000-8000-000000000111" ||
		repo.actor.Label != "reviewer@example.test" || !repo.input.AdaptationAllowed ||
		repo.input.DirectUseAllowed {
		t.Fatalf("captured input/actor=%+v/%+v", repo.input, repo.actor)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response JSON: %v", err)
	}
	if strings.Contains(rec.Body.String(), `"source_license_status":"owned"`) {
		t.Fatalf("review response relabeled source as owned: %s", rec.Body.String())
	}
}

func TestReviewReferenceDecisionMapsDirectUseLicenseFailure(t *testing.T) {
	repo := &reviewDecisionRepository{err: ErrDirectUseLicenseRequired}
	deps := &Deps{Repo: repo}
	router := chi.NewRouter()
	router.Post("/api/v1/campaign-templates/{id}/review-decisions", deps.ReviewReferenceDecision)
	req := tenantRequest(http.MethodPost, "/api/v1/campaign-templates/reference-1/review-decisions", `{
		"decision":"approve","adaptation_allowed":true,"direct_use_allowed":true,
		"note":"Requested direct use"
	}`)
	req = req.WithContext(middleware.WithUser(req.Context(), &middleware.User{
		ID: "user-1", TenantID: "tenant-1", Role: "admin",
	}))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnprocessableEntity ||
		!strings.Contains(rec.Body.String(), `"code":"direct_use_license_required"`) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestDeleteMapsReferenceImmutability(t *testing.T) {
	repo := &templateRepositoryStub{deleteFn: func(context.Context, string, string, string) (*Template, error) {
		return nil, ErrReferenceDeleteBlocked
	}}
	deps := &Deps{Repo: repo}
	rec := httptest.NewRecorder()
	req := tenantRequest(http.MethodDelete, "/api/v1/campaign-templates/reference-1", "")
	req.Header.Set("If-Match", `"campaign-template:reference-1:v1"`)
	deps.Delete(rec, req)
	if rec.Code != http.StatusUnprocessableEntity ||
		!strings.Contains(rec.Body.String(), `"code":"reference_read_only"`) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}
