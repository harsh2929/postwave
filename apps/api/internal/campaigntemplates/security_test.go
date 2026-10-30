// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type templateRepositoryStub struct {
	templateRepository
	createFn           func(context.Context, string, CreateInput) (*Template, error)
	getFn              func(context.Context, string, string) (*Template, error)
	updateFn           func(context.Context, string, string, UpdateInput) (*Template, error)
	cloneFn            func(context.Context, string, string, CloneInput) (*Template, error)
	deleteFn           func(context.Context, string, string, string) (*Template, error)
	archiveFn          func(context.Context, string, string, string) (*Template, error)
	restoreFn          func(context.Context, string, string, string) (*Template, error)
	upsertImportedFn   func(context.Context, string, CreateInput) (*Template, bool, error)
	getByDesignDraftFn func(context.Context, string, string) (*Template, error)
	recordUseFn        func(context.Context, string, string) error
	setFavoriteFn      func(context.Context, string, string, string, bool) error
	identity           WorkspaceIdentity
}

func (stub *templateRepositoryStub) Create(ctx context.Context, tenantID string, in CreateInput) (*Template, error) {
	return stub.createFn(ctx, tenantID, in)
}

func (stub *templateRepositoryStub) Get(ctx context.Context, tenantID, id string) (*Template, error) {
	return stub.getFn(ctx, tenantID, id)
}

// GetByIDOrSlug resolves through getFn, so a stub keyed by identifier serves
// both lookups exactly as its test intends.
func (stub *templateRepositoryStub) GetByIDOrSlug(ctx context.Context, tenantID, identifier string) (*Template, error) {
	return stub.getFn(ctx, tenantID, identifier)
}

// WorkspaceIdentity returns the stub's configured identity (empty unless a
// test sets one), matching a workspace that has saved no settings.
func (stub *templateRepositoryStub) WorkspaceIdentity(context.Context, string) (WorkspaceIdentity, error) {
	return stub.identity, nil
}

func (stub *templateRepositoryStub) Update(ctx context.Context, tenantID, id string, in UpdateInput) (*Template, error) {
	return stub.updateFn(ctx, tenantID, id, in)
}

func (stub *templateRepositoryStub) Clone(ctx context.Context, tenantID, id string, in CloneInput) (*Template, error) {
	return stub.cloneFn(ctx, tenantID, id, in)
}

func (stub *templateRepositoryStub) Delete(ctx context.Context, tenantID, id, ifMatch string) (*Template, error) {
	return stub.deleteFn(ctx, tenantID, id, ifMatch)
}

func (stub *templateRepositoryStub) Archive(ctx context.Context, tenantID, id, ifMatch string) (*Template, error) {
	return stub.archiveFn(ctx, tenantID, id, ifMatch)
}

func (stub *templateRepositoryStub) Restore(ctx context.Context, tenantID, id, ifMatch string) (*Template, error) {
	return stub.restoreFn(ctx, tenantID, id, ifMatch)
}

func (stub *templateRepositoryStub) UpsertImported(ctx context.Context, tenantID string, in CreateInput) (*Template, bool, error) {
	return stub.upsertImportedFn(ctx, tenantID, in)
}

func (stub *templateRepositoryStub) GetByDesignDraft(
	ctx context.Context,
	tenantID, designDraftID string,
) (*Template, error) {
	if stub.getByDesignDraftFn == nil {
		return nil, ErrNotFound
	}
	return stub.getByDesignDraftFn(ctx, tenantID, designDraftID)
}

func (stub *templateRepositoryStub) RecordUse(ctx context.Context, tenantID, id string) error {
	if stub.recordUseFn == nil {
		return nil
	}
	return stub.recordUseFn(ctx, tenantID, id)
}

func (stub *templateRepositoryStub) SetFavorite(ctx context.Context, tenantID, userID, id string, favorited bool) error {
	return stub.setFavoriteFn(ctx, tenantID, userID, id, favorited)
}

func tenantRequest(method, target, body string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
}

func TestCreateServerStampsAuthoringGovernance(t *testing.T) {
	var captured CreateInput
	repo := &templateRepositoryStub{createFn: func(_ context.Context, tenantID string, in CreateInput) (*Template, error) {
		if tenantID != "tenant-1" {
			t.Fatalf("tenant = %q", tenantID)
		}
		captured = in
		return &Template{ID: "template-1", Slug: in.Slug, Name: in.Name}, nil
	}}
	deps := &Deps{Repo: repo}
	req := tenantRequest(http.MethodPost, "/api/v1/campaign-templates", `{
		"slug":"weekly-update",
		"name":"Weekly update",
		"subject":"Hello",
		"goal":" NEWSLETTER ",
		"reference_template_ids":[],
		"generation_metadata":{}
	}`)
	rec := httptest.NewRecorder()
	deps.Create(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if captured.TemplateKind != templateKindEditable || captured.SourceProvider != "postwave" ||
		captured.SourceLicenseStatus != licenseStatusOwned || captured.ReviewStatus != reviewStatusApproved {
		t.Fatalf("governance stamp = %#v", captured)
	}
	if captured.QualityScore != defaultAuthorQualityScore || captured.ContentHash != "" || captured.ImportedAt != nil {
		t.Fatalf("quality/import stamp = %#v", captured)
	}
	if captured.Goal != "newsletter" || len(captured.ReferenceTemplateIDs) != 0 || len(captured.GenerationMetadata) != 0 {
		t.Fatalf("goal/lineage stamp = %#v", captured)
	}
}

func TestCreateRejectsForgedOrInvalidGovernanceBeforeRepository(t *testing.T) {
	tests := []struct {
		name, extra, code string
	}{
		{name: "valid kind is still server controlled", extra: `"template_kind":"reference"`, code: "server_controlled_fields"},
		{name: "invalid kind is not normalized", extra: `"template_kind":"weaponized"`, code: "invalid_template_kind"},
		{name: "valid review is still server controlled", extra: `"review_status":"approved"`, code: "server_controlled_fields"},
		{name: "invalid review is not approved", extra: `"review_status":"rubber-stamped"`, code: "invalid_review_status"},
		{name: "provider claim", extra: `"source_provider":"postwave"`, code: "server_controlled_fields"},
		{name: "license claim", extra: `"source_license_status":"owned"`, code: "server_controlled_fields"},
		{name: "explicit zero quality", extra: `"quality_score":0`, code: "server_controlled_fields"},
		{name: "content hash", extra: `"content_hash":"forged"`, code: "server_controlled_fields"},
		{name: "import time", extra: `"imported_at":"2020-01-01T00:00:00Z"`, code: "server_controlled_fields"},
		{name: "lineage", extra: `"reference_template_ids":["00000000-0000-4000-8000-000000000001"]`, code: "server_controlled_fields"},
		{name: "generation metadata", extra: `"generation_metadata":{"operation":"reviewed"}`, code: "server_controlled_fields"},
		{name: "invalid goal", extra: `"goal":"sell_everything"`, code: "invalid_goal"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			called := false
			repo := &templateRepositoryStub{createFn: func(context.Context, string, CreateInput) (*Template, error) {
				called = true
				return nil, nil
			}}
			deps := &Deps{Repo: repo}
			body := `{"slug":"weekly-update","name":"Weekly update","subject":"Hello",` + tt.extra + `}`
			rec := httptest.NewRecorder()
			deps.Create(rec, tenantRequest(http.MethodPost, "/api/v1/campaign-templates", body))
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"`+tt.code+`"`) {
				t.Fatalf("status=%d body=%s, want 400/%s", rec.Code, rec.Body.String(), tt.code)
			}
			if called {
				t.Fatal("repository called for rejected governance input")
			}
		})
	}
}

func TestRepositoryCreateRejectsInvalidTaxonomyBeforeOpeningDatabase(t *testing.T) {
	repo := &Repo{}
	for name, input := range map[string]CreateInput{
		"goal":   {Slug: "valid-slug", Name: "Valid", Goal: "unknown-goal"},
		"kind":   {Slug: "valid-slug", Name: "Valid", TemplateKind: "unknown-kind"},
		"review": {Slug: "valid-slug", Name: "Valid", ReviewStatus: "self-approved"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := repo.Create(context.Background(), "tenant-1", input)
			want := map[string]error{
				"goal": ErrInvalidGoal, "kind": ErrInvalidTemplateKind, "review": ErrInvalidReviewStatus,
			}[name]
			if !errors.Is(err, want) {
				t.Fatalf("error=%v, want %v before database access", err, want)
			}
		})
	}
	_, err := (&Repo{}).Create(context.Background(), "tenant-1", CreateInput{
		Slug: "valid-slug", Name: "Valid", Subject: "Valid",
		ReferenceTemplateIDs: []string{"not-a-uuid"},
	})
	if !errors.Is(err, ErrInvalidTemplateContent) {
		t.Fatalf("invalid reference id error=%v, want ErrInvalidTemplateContent before database access", err)
	}
}

func TestUpdateRejectsInvalidContentBeforeRepository(t *testing.T) {
	tooManyVariables := make([]map[string]interface{}, maxTemplateVariables+1)
	for i := range tooManyVariables {
		tooManyVariables[i] = map[string]interface{}{"name": "variable"}
	}
	tooManyTags := make([]string, maxTemplateTags+1)
	for i := range tooManyTags {
		tooManyTags[i] = "tag"
	}
	encode := func(value any) string {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("marshal update body: %v", err)
		}
		return string(raw)
	}
	tests := []struct {
		name, body string
	}{
		{name: "blank name", body: `{"name":"   "}`},
		{name: "long name", body: encode(map[string]any{"name": strings.Repeat("n", MaxNameLength+1)})},
		{name: "long subject", body: encode(map[string]any{"subject": strings.Repeat("s", maxTemplateSubjectRunes+1)})},
		{name: "long preview", body: encode(map[string]any{"preview_text": strings.Repeat("p", maxTemplatePreviewRunes+1)})},
		{name: "large html", body: encode(map[string]any{"body_html": strings.Repeat("h", maxTemplateBodyBytes+1)})},
		{name: "large combined bodies", body: encode(map[string]any{
			"body_html": strings.Repeat("h", maxTemplateCombinedBodyBytes/2+1),
			"body_mjml": strings.Repeat("m", maxTemplateCombinedBodyBytes/2+1),
		})},
		{name: "too many variables", body: encode(map[string]any{"variables": tooManyVariables})},
		{name: "too many tags", body: encode(map[string]any{"tags": tooManyTags})},
		{name: "blank tag", body: `{"tags":["release",""]}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			called := false
			repo := &templateRepositoryStub{updateFn: func(context.Context, string, string, UpdateInput) (*Template, error) {
				called = true
				return nil, nil
			}}
			deps := &Deps{Repo: repo}
			rec := httptest.NewRecorder()
			deps.Update(rec, tenantRequest(http.MethodPatch, "/api/v1/campaign-templates/template-1", tt.body))
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"invalid_template_content"`) {
				t.Fatalf("status=%d body=%s, want 400/invalid_template_content", rec.Code, rec.Body.String())
			}
			if called {
				t.Fatal("repository called for invalid patch")
			}
		})
	}

	blank := " "
	if _, err := (&Repo{}).Update(context.Background(), "tenant-1", "template-1", UpdateInput{Name: &blank}); !errors.Is(err, ErrInvalidTemplateContent) {
		t.Fatalf("repository validation error=%v, want ErrInvalidTemplateContent before database access", err)
	}
}

func TestUpdateMapsSharedTemplateImmutabilityToNotFound(t *testing.T) {
	repo := &templateRepositoryStub{updateFn: func(context.Context, string, string, UpdateInput) (*Template, error) {
		return nil, ErrNotFound
	}}
	deps := &Deps{Repo: repo}
	rec := httptest.NewRecorder()
	req := tenantRequest(http.MethodPatch, "/api/v1/campaign-templates/platform-template", `{"name":"Do not mutate"}`)
	req.Header.Set("If-Match", `"campaign-template:platform-template:v1"`)
	deps.Update(rec, req)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"code":"not_found"`) {
		t.Fatalf("status=%d body=%s, want nondisclosing 404/not_found", rec.Code, rec.Body.String())
	}
}

func TestUpdateMapsReferenceImmutabilityToAdaptationRequired(t *testing.T) {
	repo := &templateRepositoryStub{updateFn: func(context.Context, string, string, UpdateInput) (*Template, error) {
		return nil, ErrReferenceMutationBlocked
	}}
	deps := &Deps{Repo: repo}
	rec := httptest.NewRecorder()
	req := tenantRequest(http.MethodPatch, "/api/v1/campaign-templates/reference-template", `{"name":"Do not mutate"}`)
	req.Header.Set("If-Match", `"campaign-template:reference-template:v1"`)
	deps.Update(rec, req)
	if rec.Code != http.StatusUnprocessableEntity ||
		!strings.Contains(rec.Body.String(), `"code":"adaptation_required"`) ||
		!strings.Contains(rec.Body.String(), "Make it mine") {
		t.Fatalf("status=%d body=%s, want 422/adaptation_required with recovery guidance", rec.Code, rec.Body.String())
	}
}

func TestImportUnconditionallyStampsUnreviewedReference(t *testing.T) {
	attackerTime := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	var captured CreateInput
	repo := &templateRepositoryStub{upsertImportedFn: func(_ context.Context, _ string, in CreateInput) (*Template, bool, error) {
		captured = in
		return &Template{
			ID: "reference-1", Slug: in.Slug, Name: in.Name,
			TemplateKind: in.TemplateKind, ReviewStatus: in.ReviewStatus,
			SourceLicenseStatus: in.SourceLicenseStatus,
		}, true, nil
	}}
	deps := &Deps{Repo: repo}
	req := tenantRequest(http.MethodPost, "/api/v1/campaign-templates/import", `{
		"items":[{
			"slug":"captured-reference","name":"Captured","subject":"Source",
			"source_provider":"external","source_external_id":"source-1",
			"content_hash":"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			"template_kind":"editable","review_status":"approved",
			"source_license_status":"owned","imported_at":"2020-01-01T00:00:00Z",
			"reference_template_ids":["00000000-0000-4000-8000-000000000001"],
			"generation_metadata":{"operation":"self-approved"}
		}]
	}`)
	rec := httptest.NewRecorder()
	deps.Import(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if captured.TemplateKind != templateKindReference || captured.ReviewStatus != reviewStatusPending ||
		captured.SourceLicenseStatus != licenseStatusUnreviewed {
		t.Fatalf("import governance = %#v", captured)
	}
	if captured.ImportedAt == nil || !captured.ImportedAt.After(attackerTime) {
		t.Fatalf("imported_at = %v, attacker timestamp was trusted", captured.ImportedAt)
	}
	if len(captured.ReferenceTemplateIDs) != 0 || len(captured.GenerationMetadata) != 0 {
		t.Fatalf("import forged lineage survived: %#v", captured)
	}
}

func TestImportRejectsContentHashMismatchBeforeRepositoryAccess(t *testing.T) {
	repositoryCalled := false
	repo := &templateRepositoryStub{upsertImportedFn: func(
		context.Context,
		string,
		CreateInput,
	) (*Template, bool, error) {
		repositoryCalled = true
		return nil, false, nil
	}}
	deps := &Deps{Repo: repo}
	req := tenantRequest(http.MethodPost, "/api/v1/campaign-templates/import", `{
		"items":[{
			"slug":"hash-mismatch","name":"Hash mismatch","subject":"Source",
			"body_html":"<p>Captured source</p>",
			"content_hash":"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			"source_provider":"external","source_external_id":"source-hash-mismatch"
		}]
	}`)
	rec := httptest.NewRecorder()
	deps.Import(rec, req)
	if rec.Code != http.StatusMultiStatus ||
		!strings.Contains(rec.Body.String(), `"code":"content_hash_mismatch"`) {
		t.Fatalf("status=%d body=%s, want 207/content_hash_mismatch", rec.Code, rec.Body.String())
	}
	if repositoryCalled {
		t.Fatal("content hash mismatch reached repository")
	}

	if _, _, err := (&Repo{}).UpsertImported(
		context.Background(),
		"tenant-1",
		CreateInput{
			BodyHTML:    "<p>Captured source</p>",
			ContentHash: importBodyHTMLHash("different body"),
		},
	); !errors.Is(err, ErrImportContentHashMismatch) {
		t.Fatalf("repository error=%v, want ErrImportContentHashMismatch", err)
	}
}

func TestTemplateEligibilityFailsClosed(t *testing.T) {
	tests := []struct {
		name     string
		template *Template
		wantErr  error
	}{
		{name: "approved owned", template: &Template{ReviewStatus: "approved", SourceLicenseStatus: "owned"}},
		{name: "pending", template: &Template{ReviewStatus: "pending", SourceLicenseStatus: "owned"}, wantErr: ErrTemplateIneligible},
		{name: "rejected", template: &Template{ReviewStatus: "rejected", SourceLicenseStatus: "owned"}, wantErr: ErrTemplateIneligible},
		{name: "unreviewed license", template: &Template{ReviewStatus: "approved", SourceLicenseStatus: "personal-use-unreviewed"}, wantErr: ErrTemplateIneligible},
		{name: "unknown license", template: &Template{ReviewStatus: "approved", SourceLicenseStatus: "licensed"}, wantErr: ErrTemplateIneligible},
		{name: "noncanonical approval", template: &Template{ReviewStatus: " Approved ", SourceLicenseStatus: "owned"}, wantErr: ErrTemplateIneligible},
		{name: "noncanonical ownership", template: &Template{ReviewStatus: "approved", SourceLicenseStatus: "Owned"}, wantErr: ErrTemplateIneligible},
		{name: "unknown kind", template: &Template{TemplateKind: "executable", ReviewStatus: "approved", SourceLicenseStatus: "owned"}, wantErr: ErrTemplateIneligible},
		{name: "nil", wantErr: ErrNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateTemplateEligibility(tt.template)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("error=%v, want %v", err, tt.wantErr)
			}
		})
	}
}

func TestCloneRejectsReferencesAndPreservesEligibleDerivativeLineage(t *testing.T) {
	base := Template{
		ID: "source-template", Slug: "source", Name: "Source", Subject: "Subject",
		TemplateKind: templateKindEditable, ReviewStatus: reviewStatusApproved,
		SourceLicenseStatus:  licenseStatusOwned,
		ReferenceTemplateIDs: []string{"reference-a", "reference-b"},
	}

	for name, mutate := range map[string]func(*Template){
		"pending":    func(template *Template) { template.ReviewStatus = reviewStatusPending },
		"rejected":   func(template *Template) { template.ReviewStatus = reviewStatusRejected },
		"unlicensed": func(template *Template) { template.SourceLicenseStatus = licenseStatusUnreviewed },
	} {
		t.Run(name, func(t *testing.T) {
			source := base
			mutate(&source)
			if _, err := cloneCreateInput(&source, CloneInput{Slug: "copy", Name: "Copy"}); !errors.Is(err, ErrTemplateIneligible) {
				t.Fatalf("error=%v, want ErrTemplateIneligible", err)
			}
		})
	}

	reference := base
	reference.TemplateKind = templateKindReference
	if _, err := cloneCreateInput(&reference, CloneInput{Slug: "copy", Name: "Copy"}); !errors.Is(err, ErrReferenceCloneBlocked) {
		t.Fatalf("reference clone error=%v", err)
	}

	clone, err := cloneCreateInput(&base, CloneInput{Slug: "copy", Name: "Copy"})
	if err != nil {
		t.Fatalf("eligible clone: %v", err)
	}
	wantCloneLineage := []string{base.ID}
	if !reflect.DeepEqual(clone.ReferenceTemplateIDs, wantCloneLineage) {
		t.Fatalf("clone lineage=%v, want %v", clone.ReferenceTemplateIDs, wantCloneLineage)
	}
	if clone.GenerationMetadata["source_template_id"] != base.ID {
		t.Fatalf("clone metadata=%#v", clone.GenerationMetadata)
	}
	if ancestors := clone.GenerationMetadata["ancestor_reference_template_ids"]; !reflect.DeepEqual(ancestors, base.ReferenceTemplateIDs) {
		t.Fatalf("clone ancestry metadata=%#v, want %v", ancestors, base.ReferenceTemplateIDs)
	}
	cardinalitySource := base
	cardinalitySource.ReferenceTemplateIDs = []string{"a", "b", "c"}
	cardinalityClone, err := cloneCreateInput(&cardinalitySource, CloneInput{Slug: "cardinality-copy", Name: "Copy"})
	if err != nil {
		t.Fatalf("clone three-reference source: %v", err)
	}
	if !reflect.DeepEqual(cardinalityClone.ReferenceTemplateIDs, []string{base.ID}) {
		t.Fatalf("direct clone lineage=%v, want only immediate source", cardinalityClone.ReferenceTemplateIDs)
	}
	maxSlugSource := base
	maxSlugSource.Slug = "a" + strings.Repeat("b", MaxSlugLength-1)
	derived, err := cloneCreateInput(&maxSlugSource, CloneInput{})
	if err != nil {
		t.Fatalf("derive clone slug from max-length source: %v", err)
	}
	if len(derived.Slug) > MaxSlugLength || validateSlug(derived.Slug) != nil || !strings.Contains(derived.Slug, "-copy-") {
		t.Fatalf("derived slug=%q (%d bytes), want valid <=%d-byte clone slug", derived.Slug, len(derived.Slug), MaxSlugLength)
	}
	maxNameSource := base
	maxNameSource.Name = strings.Repeat("é", MaxNameLength/2)
	derived, err = cloneCreateInput(&maxNameSource, CloneInput{Slug: "bounded-name-copy"})
	if err != nil {
		t.Fatalf("derive clone name from max-byte source: %v", err)
	}
	if len(derived.Name) > MaxNameLength || !utf8.ValidString(derived.Name) || !strings.HasSuffix(derived.Name, " (copy)") {
		t.Fatalf("derived name=%q (%d bytes), want valid <=%d-byte copy name", derived.Name, len(derived.Name), MaxNameLength)
	}
	if _, err := cloneCreateInput(&base, CloneInput{Slug: "long-name-copy", Name: strings.Repeat("x", MaxNameLength+1)}); !errors.Is(err, ErrInvalidTemplateContent) {
		t.Fatalf("custom long clone name error=%v, want ErrInvalidTemplateContent", err)
	}
}

func TestResolveReferencesRejectsIneligibleRecords(t *testing.T) {
	repo := &templateRepositoryStub{getFn: func(_ context.Context, _, id string) (*Template, error) {
		if id == "eligible" {
			return &Template{ID: id, ReviewStatus: reviewStatusApproved, SourceLicenseStatus: licenseStatusOwned}, nil
		}
		return &Template{ID: id, ReviewStatus: reviewStatusPending, SourceLicenseStatus: licenseStatusUnreviewed}, nil
	}}
	deps := &Deps{Repo: repo}
	if _, err := deps.resolveReferences(context.Background(), "tenant-1", []string{"eligible", "pending"}); !errors.Is(err, ErrTemplateIneligible) {
		t.Fatalf("error=%v, want ErrTemplateIneligible", err)
	}
	refs, err := deps.resolveReferences(context.Background(), "tenant-1", []string{"eligible"})
	if err != nil || len(refs) != 1 || !refs[0].eligibilityValidated {
		t.Fatalf("eligible references=%#v error=%v", refs, err)
	}
}

type securityTemplateGenerator struct {
	calls   int
	request GenerateDesignRequest
}

func (generator *securityTemplateGenerator) GenerateTemplate(_ context.Context, _ string, request GenerateDesignRequest) (GeneratedDesign, error) {
	generator.calls++
	generator.request = request
	return GeneratedDesign{Name: "Original", Subject: "Original subject", BodyHTML: "<p>Original</p>"}, nil
}

func TestLegacyAdaptNeverRunsGeneration(t *testing.T) {
	for _, source := range []*Template{
		{ID: "source", TemplateKind: templateKindReference, ReviewStatus: reviewStatusPending, SourceLicenseStatus: licenseStatusOwned},
		{ID: "source", TemplateKind: templateKindReference, ReviewStatus: reviewStatusRejected, SourceLicenseStatus: licenseStatusOwned},
		{ID: "source", TemplateKind: templateKindReference, ReviewStatus: reviewStatusApproved, SourceLicenseStatus: licenseStatusUnreviewed},
	} {
		source := source
		t.Run(source.ReviewStatus+"/"+source.SourceLicenseStatus, func(t *testing.T) {
			generator := &securityTemplateGenerator{}
			created := false
			repo := &templateRepositoryStub{
				getFn: func(context.Context, string, string) (*Template, error) { return source, nil },
				createFn: func(context.Context, string, CreateInput) (*Template, error) {
					created = true
					return nil, nil
				},
			}
			deps := &Deps{Repo: repo, Generator: generator}
			router := chi.NewRouter()
			router.Post("/api/v1/campaign-templates/{id}/adapt", deps.Adapt)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, tenantRequest(http.MethodPost, "/api/v1/campaign-templates/source/adapt", `{}`))
			if rec.Code != http.StatusGone ||
				!strings.Contains(rec.Body.String(), "durable_design_workflow_required") {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if generator.calls != 0 || created {
				t.Fatalf("generator calls=%d created=%v", generator.calls, created)
			}
		})
	}
}

func TestLegacyApprovedAdaptationCannotReturnUnboundDesign(t *testing.T) {
	sources := map[string]*Template{
		"source": {
			ID: "source", Slug: "source", Name: "Source", Subject: "Source subject",
			TemplateKind: templateKindReference, ReviewStatus: reviewStatusApproved,
			SourceLicenseStatus: licenseStatusOwned, ReferenceAdaptationAllowed: true,
			Goal: "newsletter", Category: "newsletter",
		},
		"additional": {
			ID: "additional", Name: "Additional", TemplateKind: templateKindReference,
			ReviewStatus: reviewStatusApproved, SourceLicenseStatus: licenseStatusOwned,
			ReferenceAdaptationAllowed: true,
		},
	}
	created := false
	repo := &templateRepositoryStub{
		getFn: func(_ context.Context, _, id string) (*Template, error) { return sources[id], nil },
		createFn: func(_ context.Context, _ string, in CreateInput) (*Template, error) {
			created = true
			return &Template{ID: "unexpected"}, nil
		},
	}
	generator := &securityTemplateGenerator{}
	deps := &Deps{Repo: repo, Generator: generator}
	router := chi.NewRouter()
	router.Post("/api/v1/campaign-templates/{id}/adapt", deps.Adapt)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, tenantRequest(http.MethodPost, "/api/v1/campaign-templates/source/adapt", `{
		"reference_template_ids":["additional"]
	}`))
	if rec.Code != http.StatusGone ||
		!strings.Contains(rec.Body.String(), "durable_design_workflow_required") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if created {
		t.Fatal("adapt persisted a template before explicit review")
	}
	if generator.calls != 0 || len(generator.request.References) != 0 {
		t.Fatalf("generator calls=%d request=%#v", generator.calls, generator.request)
	}
}

func TestSaveGeneratedDesignRejectsRetiredDirectCommitWithoutRepositoryAccess(t *testing.T) {
	getCalls := 0
	var saved CreateInput
	repo := &templateRepositoryStub{
		getFn: func(_ context.Context, tenantID, id string) (*Template, error) {
			getCalls++
			if tenantID != "tenant-1" || id != "reference-input" {
				t.Fatalf("Get(%q, %q)", tenantID, id)
			}
			return &Template{
				ID: "reference-canonical", Name: "Reference", TemplateKind: templateKindReference,
				ReviewStatus: reviewStatusApproved, SourceLicenseStatus: licenseStatusOwned,
				ReferenceAdaptationAllowed: true,
			}, nil
		},
		createFn: func(_ context.Context, tenantID string, in CreateInput) (*Template, error) {
			if tenantID != "tenant-1" {
				t.Fatalf("tenant=%q", tenantID)
			}
			saved = in
			return &Template{ID: "saved-template", Slug: in.Slug, Name: in.Name}, nil
		},
	}
	deps := &Deps{Repo: repo}
	rec := httptest.NewRecorder()
	deps.SaveGeneratedDesign(rec, tenantRequest(http.MethodPost, "/api/v1/campaign-templates/from-generated-design", `{
		"slug":"reviewed-design",
		"name":" Reviewed design ",
		"subject":"Reviewed {{first_name}}",
		"preview_text":"Exact preview",
		"body_html":"  <main><p>Reviewed {{first_name}}</p><p>{{company}}</p></main>  ",
		"category":" editorial ",
		"goal":" NEWSLETTER ",
		"industry":"technology",
		"style":"minimal",
		"layout":"digest",
		"variables":{"first_name":"Ada","edition":7,"vip":true},
		"reference_template_ids":[" reference-input "]
	}`))
	if rec.Code != http.StatusGone || !strings.Contains(rec.Body.String(), `"code":"design_commit_retired"`) {
		t.Fatalf("status=%d body=%s, want 410/design_commit_retired", rec.Code, rec.Body.String())
	}
	if getCalls != 0 || saved.Slug != "" {
		t.Fatalf("retired endpoint touched repository: getCalls=%d saved=%#v", getCalls, saved)
	}
}

func TestSaveGeneratedDesignRejectsUntrustedGovernanceFields(t *testing.T) {
	deps := &Deps{Repo: &templateRepositoryStub{}}
	rec := httptest.NewRecorder()
	deps.SaveGeneratedDesign(rec, tenantRequest(http.MethodPost, "/api/v1/campaign-templates/from-generated-design", `{
		"slug":"reviewed-design","name":"Reviewed","subject":"Subject","body_html":"<p>Body</p>",
		"review_status":"approved"
	}`))
	if rec.Code != http.StatusGone || !strings.Contains(rec.Body.String(), "design_commit_retired") {
		t.Fatalf("status=%d body=%s, want retired endpoint response", rec.Code, rec.Body.String())
	}
}

func TestSaveGeneratedDesignRejectsIneligibleReferenceBeforeCreate(t *testing.T) {
	created := false
	repo := &templateRepositoryStub{
		getFn: func(context.Context, string, string) (*Template, error) {
			return &Template{
				ID: "pending-reference", TemplateKind: templateKindReference,
				ReviewStatus: reviewStatusPending, SourceLicenseStatus: licenseStatusUnreviewed,
			}, nil
		},
		createFn: func(context.Context, string, CreateInput) (*Template, error) {
			created = true
			return nil, nil
		},
	}
	deps := &Deps{Repo: repo}
	rec := httptest.NewRecorder()
	deps.SaveGeneratedDesign(rec, tenantRequest(http.MethodPost, "/api/v1/campaign-templates/from-generated-design", `{
		"slug":"reviewed-design","name":"Reviewed","subject":"Subject","body_html":"<p>Body</p>",
		"reference_template_ids":["pending-reference"]
	}`))
	if rec.Code != http.StatusGone || !strings.Contains(rec.Body.String(), "design_commit_retired") {
		t.Fatalf("status=%d body=%s, want retired endpoint response", rec.Code, rec.Body.String())
	}
	if created {
		t.Fatal("repository Create called for an ineligible reference")
	}
}

func TestReviewedDesignBoundsFailBeforePersistence(t *testing.T) {
	valid := SaveGeneratedDesignInput{
		Slug: "reviewed-design", Name: "Reviewed", Subject: "Subject", BodyHTML: "<p>Body</p>",
	}
	tests := []struct {
		name   string
		mutate func(*SaveGeneratedDesignInput)
		want   error
	}{
		{name: "invalid slug", mutate: func(in *SaveGeneratedDesignInput) { in.Slug = "Invalid Slug" }, want: ErrInvalidSlug},
		{name: "invalid goal", mutate: func(in *SaveGeneratedDesignInput) { in.Goal = "viral" }, want: ErrInvalidGoal},
		{name: "long subject", mutate: func(in *SaveGeneratedDesignInput) { in.Subject = strings.Repeat("s", reviewedDesignMaxSubjectRunes+1) }, want: ErrInvalidReviewedDesign},
		{name: "long preview", mutate: func(in *SaveGeneratedDesignInput) {
			in.PreviewText = strings.Repeat("p", reviewedDesignMaxPreviewRunes+1)
		}, want: ErrInvalidReviewedDesign},
		{name: "large html", mutate: func(in *SaveGeneratedDesignInput) { in.BodyHTML = strings.Repeat("h", reviewedDesignMaxBodyBytes+1) }, want: ErrInvalidReviewedDesign},
		{name: "nested variable", mutate: func(in *SaveGeneratedDesignInput) {
			in.Variables = map[string]any{"unsafe": map[string]any{"nested": true}}
		}, want: ErrInvalidReviewedDesign},
		{name: "invalid variable name", mutate: func(in *SaveGeneratedDesignInput) { in.Variables = map[string]any{"unsafe variable": "x"} }, want: ErrInvalidReviewedDesign},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			input := valid
			tt.mutate(&input)
			_, err := reviewedDesignCreateInput(input, nil)
			if !errors.Is(err, tt.want) {
				t.Fatalf("error=%v, want %v", err, tt.want)
			}
		})
	}
	for _, ids := range [][]string{{""}, {"a", "b", "c", "d"}} {
		if _, err := reviewedReferenceIDs(ids); !errors.Is(err, ErrInvalidReviewedDesign) {
			t.Fatalf("reviewedReferenceIDs(%v) error=%v", ids, err)
		}
	}
}

type recordingCampaignCreator struct{ calls int }

func (creator *recordingCampaignCreator) Create(context.Context, string, campaigns.CreateInput) (*campaigns.Campaign, error) {
	creator.calls++
	return &campaigns.Campaign{ID: "campaign-1"}, nil
}

func TestCreateCampaignRejectsIneligibleTemplateBeforePersistence(t *testing.T) {
	repo := &templateRepositoryStub{getFn: func(context.Context, string, string) (*Template, error) {
		return &Template{
			ID: "template-1", TemplateKind: templateKindEditable,
			ReviewStatus: reviewStatusPending, SourceLicenseStatus: licenseStatusOwned,
		}, nil
	}}
	creator := &recordingCampaignCreator{}
	deps := &Deps{Repo: repo, Campaigns: creator}
	router := chi.NewRouter()
	router.Post("/api/v1/campaign-templates/{id}/create-campaign", deps.CreateCampaignFromTemplate)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, tenantRequest(http.MethodPost, "/api/v1/campaign-templates/template-1/create-campaign", `{}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "template_ineligible") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if creator.calls != 0 {
		t.Fatalf("campaign creator called %d times", creator.calls)
	}
}

func TestCreateCampaignPathRejectsMismatchedBodyTemplateID(t *testing.T) {
	getCalled := false
	repo := &templateRepositoryStub{getFn: func(context.Context, string, string) (*Template, error) {
		getCalled = true
		return nil, nil
	}}
	deps := &Deps{Repo: repo, Campaigns: &recordingCampaignCreator{}}
	router := chi.NewRouter()
	router.Post("/api/v1/campaign-templates/{id}/create-campaign", deps.CreateCampaignFromTemplate)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, tenantRequest(http.MethodPost, "/api/v1/campaign-templates/path-template/create-campaign", `{
		"template_id":"different-template"
	}`))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "template_id_mismatch") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if getCalled {
		t.Fatal("repository called for a path/body template_id mismatch")
	}
}

func TestFavoriteNotFoundContractDoesNotExposeReason(t *testing.T) {
	repo := &templateRepositoryStub{setFavoriteFn: func(context.Context, string, string, string, bool) error {
		return ErrNotFound
	}}
	deps := &Deps{Repo: repo}
	for _, id := range []string{"missing", "foreign-tenant"} {
		req := tenantRequest(http.MethodPost, "/api/v1/campaign-templates/"+id+"/favorite", `{}`)
		req = req.WithContext(middleware.WithUser(req.Context(), &middleware.User{ID: "user-1", TenantID: "tenant-1"}))
		routeCtx := chi.NewRouteContext()
		routeCtx.URLParams.Add("id", id)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
		rec := httptest.NewRecorder()
		deps.Favorite(rec, req)
		if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"code":"not_found"`) {
			t.Fatalf("id=%s status=%d body=%s", id, rec.Code, rec.Body.String())
		}
	}
}

func TestCloneWritesStrictRequestBodyErrors(t *testing.T) {
	tests := []struct {
		name, body, code string
		status           int
	}{
		{name: "malformed", body: `{"name":`, status: http.StatusBadRequest, code: "bad_json"},
		{name: "unknown field", body: `{"name":"Copy","review_status":"approved"}`, status: http.StatusBadRequest, code: "unknown_field"},
		{name: "oversize", body: `{"name":"` + strings.Repeat("x", int(campaignTemplateJSONMaxBodyBytes)+1) + `"}`, status: http.StatusRequestEntityTooLarge, code: "payload_too_large"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			called := false
			repo := &templateRepositoryStub{cloneFn: func(context.Context, string, string, CloneInput) (*Template, error) {
				called = true
				return nil, nil
			}}
			deps := &Deps{Repo: repo}
			rec := httptest.NewRecorder()
			deps.Clone(rec, tenantRequest(http.MethodPost, "/api/v1/campaign-templates/template-1/clone", tt.body))
			if rec.Code != tt.status || !strings.Contains(rec.Body.String(), `"code":"`+tt.code+`"`) {
				t.Fatalf("status=%d body=%s, want %d/%s", rec.Code, rec.Body.String(), tt.status, tt.code)
			}
			if called {
				t.Fatal("repository called after request-body rejection")
			}
		})
	}
}

func TestCloneMapsInvalidContentToValidationResponse(t *testing.T) {
	repo := &templateRepositoryStub{cloneFn: func(context.Context, string, string, CloneInput) (*Template, error) {
		return nil, ErrInvalidTemplateContent
	}}
	deps := &Deps{Repo: repo}
	rec := httptest.NewRecorder()
	deps.Clone(rec, tenantRequest(http.MethodPost, "/api/v1/campaign-templates/template-1/clone", `{"name":"Copy"}`))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"invalid_template_content"`) {
		t.Fatalf("status=%d body=%s, want 400/invalid_template_content", rec.Code, rec.Body.String())
	}
}

func TestDeleteRequiresStrongPreconditionBeforeSafeArchive(t *testing.T) {
	called := false
	repo := &templateRepositoryStub{deleteFn: func(context.Context, string, string, string) (*Template, error) {
		called = true
		return nil, nil
	}}
	deps := &Deps{Repo: repo}
	req := tenantRequest(http.MethodDelete, "/api/v1/campaign-templates/template-1", "")
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", "template-1")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
	rec := httptest.NewRecorder()
	deps.Delete(rec, req)
	if rec.Code != http.StatusPreconditionRequired || !strings.Contains(rec.Body.String(), `"code":"precondition_required"`) {
		t.Fatalf("status=%d body=%s, want 428/precondition_required", rec.Code, rec.Body.String())
	}
	if called {
		t.Fatal("repository called without If-Match")
	}
}

func TestImportedStampHelperCannotBeSelfApproved(t *testing.T) {
	wantTime := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	got := stampImportedInput(CreateInput{
		TemplateKind: templateKindEditable, ReviewStatus: reviewStatusApproved,
		SourceLicenseStatus:  licenseStatusOwned,
		ImportedAt:           func() *time.Time { value := time.Unix(1, 0); return &value }(),
		ReferenceTemplateIDs: []string{"forged"},
		GenerationMetadata:   map[string]any{"operation": "forged"},
	}, wantTime)
	if got.TemplateKind != templateKindReference || got.ReviewStatus != reviewStatusPending || got.SourceLicenseStatus != licenseStatusUnreviewed {
		t.Fatalf("stamp=%#v", got)
	}
	if got.ImportedAt == nil || !got.ImportedAt.Equal(wantTime) || len(got.ReferenceTemplateIDs) != 0 || len(got.GenerationMetadata) != 0 {
		t.Fatalf("stamp lineage/time=%#v", got)
	}
	if _, err := json.Marshal(got); err != nil {
		t.Fatalf("stamped input must remain JSON encodable: %v", err)
	}
}
