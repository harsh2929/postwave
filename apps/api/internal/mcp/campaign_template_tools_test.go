// SPDX-License-Identifier: AGPL-3.0-only

package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/campaigntemplates"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type campaignTemplateCatalogFake struct {
	template           *campaigntemplates.Template
	created            campaigntemplates.CreateInput
	updated            campaigntemplates.UpdateInput
	ifMatch            string
	creates            int
	favoriteTemplateID string
	favoriteUserID     string
	favorited          bool
	favoriteCalls      int
	lookedUp           string
	identity           campaigntemplates.WorkspaceIdentity
}

func (f *campaignTemplateCatalogFake) Search(context.Context, string, campaigntemplates.SearchFilter) (*campaigntemplates.SearchResponse, error) {
	return &campaigntemplates.SearchResponse{}, nil
}

func (f *campaignTemplateCatalogFake) Get(context.Context, string, string) (*campaigntemplates.Template, error) {
	return f.template, nil
}

func (f *campaignTemplateCatalogFake) GetByIDOrSlug(_ context.Context, _ string, identifier string) (*campaigntemplates.Template, error) {
	f.lookedUp = identifier
	return f.template, nil
}

func (f *campaignTemplateCatalogFake) WorkspaceIdentity(context.Context, string) (campaigntemplates.WorkspaceIdentity, error) {
	return f.identity, nil
}

func (f *campaignTemplateCatalogFake) Create(_ context.Context, _ string, in campaigntemplates.CreateInput) (*campaigntemplates.Template, error) {
	f.created = in
	f.creates++
	return &campaigntemplates.Template{Name: in.Name, Subject: in.Subject}, nil
}

func (*campaignTemplateCatalogFake) RecordUse(context.Context, string, string) error { return nil }

func (f *campaignTemplateCatalogFake) SetFavorite(
	_ context.Context, _ string, userID, templateID string, favorited bool,
) error {
	f.favoriteUserID = userID
	f.favoriteTemplateID = templateID
	f.favorited = favorited
	f.favoriteCalls++
	return nil
}

func (f *campaignTemplateCatalogFake) Update(
	_ context.Context, _ string, _ string, in campaigntemplates.UpdateInput,
) (*campaigntemplates.Template, error) {
	f.updated = in
	return f.template, nil
}

func (f *campaignTemplateCatalogFake) Archive(
	_ context.Context, _ string, _ string, ifMatch string,
) (*campaigntemplates.Template, error) {
	f.ifMatch = ifMatch
	return f.template, nil
}

func (f *campaignTemplateCatalogFake) Restore(
	_ context.Context, _ string, _ string, ifMatch string,
) (*campaigntemplates.Template, error) {
	f.ifMatch = ifMatch
	return f.template, nil
}

func (*campaignTemplateCatalogFake) ListRevisions(
	context.Context, string, string, int, int,
) (*campaigntemplates.TemplateRevisionPage, error) {
	return &campaigntemplates.TemplateRevisionPage{}, nil
}

func (f *campaignTemplateCatalogFake) GetRevision(
	context.Context, string, string, int64,
) (*campaigntemplates.TemplateRevision, error) {
	return &campaigntemplates.TemplateRevision{Snapshot: *f.template}, nil
}

type campaignTemplateWorkflowFake struct {
	createInput   campaigntemplates.CreateDesignDraftInput
	actor         campaigntemplates.ReferenceReviewActor
	key           string
	designID      string
	saveInput     campaigntemplates.SaveDesignDraftInput
	refineInput   campaigntemplates.RefineDesignDraftInput
	campaignInput campaigntemplates.CreateCampaignFromDesignDraftInput
	mutationKey   string
	listActor     campaigntemplates.ReferenceReviewActor
	accessActor   campaigntemplates.ReferenceReviewActor
	listFilter    campaigntemplates.DesignDraftListFilter
}

func (f *campaignTemplateWorkflowFake) StartDesignDraft(
	_ context.Context,
	_ string,
	actor campaigntemplates.ReferenceReviewActor,
	key string,
	in campaigntemplates.CreateDesignDraftInput,
) (*campaigntemplates.DesignDraft, bool, error) {
	f.actor, f.key, f.createInput = actor, key, in
	return &campaigntemplates.DesignDraft{ID: "design-1"}, false, nil
}

func (f *campaignTemplateWorkflowFake) FetchDesignDraft(
	_ context.Context,
	_ string,
	actor campaigntemplates.ReferenceReviewActor,
	_ string,
) (*campaigntemplates.DesignDraft, error) {
	f.accessActor = actor
	return &campaigntemplates.DesignDraft{ID: "design-1"}, nil
}

func (f *campaignTemplateWorkflowFake) ListRecoverableDesignDrafts(
	_ context.Context,
	_ string,
	actor campaigntemplates.ReferenceReviewActor,
	filter campaigntemplates.DesignDraftListFilter,
) (*campaigntemplates.DesignDraftPage, error) {
	f.listActor, f.listFilter = actor, filter
	return &campaigntemplates.DesignDraftPage{
		Items: []campaigntemplates.DesignDraftSummary{
			{ID: "design-1", Status: "queued"},
		},
	}, nil
}

func (f *campaignTemplateWorkflowFake) FetchDesignDraftRevisions(
	_ context.Context,
	_ string,
	actor campaigntemplates.ReferenceReviewActor,
	_ string,
) ([]campaigntemplates.DesignRevision, error) {
	f.accessActor = actor
	return []campaigntemplates.DesignRevision{{Revision: 1}}, nil
}

func (f *campaignTemplateWorkflowFake) QueueDesignDraftRefinementWithKey(
	_ context.Context,
	_ string,
	actor campaigntemplates.ReferenceReviewActor,
	id string,
	key string,
	in campaigntemplates.RefineDesignDraftInput,
) (*campaigntemplates.DesignDraft, bool, error) {
	f.accessActor = actor
	f.designID, f.mutationKey, f.refineInput = id, key, in
	return &campaigntemplates.DesignDraft{ID: id}, false, nil
}

func (f *campaignTemplateWorkflowFake) RetryDesignDraftJobWithKey(
	_ context.Context,
	_ string,
	actor campaigntemplates.ReferenceReviewActor,
	id, key string,
) (*campaigntemplates.DesignDraft, bool, error) {
	f.accessActor = actor
	f.mutationKey = key
	return &campaigntemplates.DesignDraft{ID: id}, false, nil
}

func (f *campaignTemplateWorkflowFake) ArchiveDesignDraftJobWithKey(
	_ context.Context,
	_ string,
	actor campaigntemplates.ReferenceReviewActor,
	id, key string,
) (*campaigntemplates.DesignDraft, bool, error) {
	f.accessActor = actor
	f.mutationKey = key
	return &campaigntemplates.DesignDraft{ID: id}, false, nil
}

func (f *campaignTemplateWorkflowFake) SaveDesignDraftRevisionWithKey(
	_ context.Context,
	_ string,
	actor campaigntemplates.ReferenceReviewActor,
	id string,
	key string,
	in campaigntemplates.SaveDesignDraftInput,
) (*campaigntemplates.Template, bool, error) {
	f.accessActor = actor
	f.designID, f.mutationKey, f.saveInput = id, key, in
	return &campaigntemplates.Template{ID: "template-1"}, false, nil
}

func (f *campaignTemplateWorkflowFake) CreateCampaignFromDesignRevisionWithKey(
	_ context.Context,
	_ string,
	actor campaigntemplates.ReferenceReviewActor,
	id string,
	key string,
	in campaigntemplates.CreateCampaignFromDesignDraftInput,
) (*campaigns.Campaign, bool, error) {
	f.accessActor = actor
	f.designID, f.mutationKey, f.campaignInput = id, key, in
	return &campaigns.Campaign{ID: "campaign-1"}, false, nil
}

func TestGenerateCampaignTemplateQueuesDurableGuidedDesign(t *testing.T) {
	workflow := &campaignTemplateWorkflowFake{}
	deps := &Deps{CampaignTemplateWorkflow: workflow}

	out, err := handleGenerateCampaignTemplate(dtCtx(), deps, json.RawMessage(`{
			"idempotency_key":"same-request",
			"brief":"Create a product digest",
			"kind":"newsletter",
			"category":"editorial",
		"subject":"Custom subject",
		"preview_text":"Custom preview",
			"industry":"technology",
			"style":"minimal",
			"layout":"three-section",
			"fidelity":"inspired",
			"sections":["Hero","Stories"],
			"cta":"Read now",
			"variables":{"company":"A&B"}
		}`))
	if err != nil {
		t.Fatalf("handleGenerateCampaignTemplate: %v", err)
	}
	if workflow.key != "same-request" || workflow.actor.Type != "service" {
		t.Fatalf("key=%q actor=%#v", workflow.key, workflow.actor)
	}
	if workflow.createInput.Mode != "generate" ||
		workflow.createInput.Fidelity != "inspired" ||
		len(workflow.createInput.Sections) != 2 ||
		workflow.createInput.CTA != "Read now" {
		t.Fatalf("durable create input = %#v", workflow.createInput)
	}
	result := out.(map[string]any)
	if result["next_action"] != "getCampaignTemplateDesign" {
		t.Fatalf("result = %#v", result)
	}
}

func TestSaveCampaignTemplateDesignCommitsBoundRevisionWithoutCallerHTML(t *testing.T) {
	workflow := &campaignTemplateWorkflowFake{}
	deps := &Deps{CampaignTemplateWorkflow: workflow}
	hash := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

	if _, err := handleSaveCampaignTemplateDesign(dtCtx(), deps, json.RawMessage(`{
			"idempotency_key":"save-design-2",
			"design_id":"design-1",
			"revision":2,
			"output_hash":"`+hash+`",
			"slug":"reviewed-weekly",
			"name":"Reviewed weekly",
			"subject":"This week",
			"body_html":"<script>must never cross the commit boundary</script>"
		}`)); err != nil {
		t.Fatalf("handleSaveCampaignTemplateDesign: %v", err)
	}
	if workflow.designID != "design-1" ||
		workflow.mutationKey != "save-design-2" ||
		workflow.saveInput.Revision != 2 ||
		workflow.saveInput.OutputHash != hash ||
		workflow.saveInput.Slug != "reviewed-weekly" {
		t.Fatalf("bound save = id %q input %#v", workflow.designID, workflow.saveInput)
	}
}

func TestDesignFollowupRequiresStableIdempotencyKey(t *testing.T) {
	workflow := &campaignTemplateWorkflowFake{}
	deps := &Deps{CampaignTemplateWorkflow: workflow}
	_, err := handleRefineCampaignTemplateDesign(dtCtx(), deps, json.RawMessage(`{
		"design_id":"design-1",
		"base_revision":1,
		"instructions":"Shorter hero"
	}`))
	if err == nil || !strings.Contains(err.Error(), "idempotency_key is required") {
		t.Fatalf("error=%v, want missing idempotency key", err)
	}
	if workflow.designID != "" {
		t.Fatalf("workflow mutated without idempotency key: %#v", workflow)
	}
}

func TestListCampaignTemplateDesignsUsesExactMCPActorAndCursor(t *testing.T) {
	workflow := &campaignTemplateWorkflowFake{}
	ctx := middleware.WithAPIKeyAuth(dtCtx())
	ctx = middleware.WithAPIKeyID(ctx, "api-key-1")
	ctx = middleware.WithActor(ctx, "agent", "Newsletter agent")

	out, err := handleListCampaignTemplateDesigns(
		ctx,
		&Deps{CampaignTemplateWorkflow: workflow},
		json.RawMessage(`{"limit":17,"cursor":"opaque-next-page"}`),
	)
	if err != nil {
		t.Fatalf("handleListCampaignTemplateDesigns: %v", err)
	}
	if workflow.listActor.Type != "api_key" ||
		workflow.listActor.ID != "api-key-1" ||
		workflow.listFilter.Limit != 17 ||
		workflow.listFilter.Cursor != "opaque-next-page" {
		t.Fatalf(
			"actor=%#v filter=%#v",
			workflow.listActor,
			workflow.listFilter,
		)
	}
	page, ok := out.(*campaigntemplates.DesignDraftPage)
	if !ok || len(page.Items) != 1 || page.Items[0].ID != "design-1" {
		t.Fatalf("list result = %#v", out)
	}
}

func TestCampaignTemplateDesignReadAndMutationUseExactMCPActor(t *testing.T) {
	ctx := middleware.WithAPIKeyAuth(dtCtx())
	ctx = middleware.WithAPIKeyID(ctx, "api-key-owner")
	ctx = middleware.WithActor(ctx, "agent", "Newsletter owner")

	readWorkflow := &campaignTemplateWorkflowFake{}
	if _, err := handleGetCampaignTemplateDesign(
		ctx,
		&Deps{CampaignTemplateWorkflow: readWorkflow},
		json.RawMessage(`{"design_id":"design-1"}`),
	); err != nil {
		t.Fatalf("handleGetCampaignTemplateDesign: %v", err)
	}
	if readWorkflow.accessActor.Type != "api_key" ||
		readWorkflow.accessActor.ID != "api-key-owner" {
		t.Fatalf("read actor=%#v", readWorkflow.accessActor)
	}

	mutationWorkflow := &campaignTemplateWorkflowFake{}
	if _, err := handleRefineCampaignTemplateDesign(
		ctx,
		&Deps{CampaignTemplateWorkflow: mutationWorkflow},
		json.RawMessage(`{
			"idempotency_key":"actor-private-refine",
			"design_id":"design-1",
			"base_revision":1,
			"instructions":"Improve the hierarchy"
		}`),
	); err != nil {
		t.Fatalf("handleRefineCampaignTemplateDesign: %v", err)
	}
	if mutationWorkflow.accessActor.Type != "api_key" ||
		mutationWorkflow.accessActor.ID != "api-key-owner" {
		t.Fatalf("mutation actor=%#v", mutationWorkflow.accessActor)
	}
}

func TestNativeDesignIdempotencyKeyRejectsControlCharacters(t *testing.T) {
	for name, key := range map[string]string{
		"newline":       "retry\nkey",
		"leading-tab":   "\tretry-key",
		"delete":        "retry\u007fkey",
		"unicode-c1":    "retry\u0085key",
		"trailing-crlf": "retry-key\r\n",
	} {
		t.Run(name, func(t *testing.T) {
			workflow := &campaignTemplateWorkflowFake{}
			deps := &Deps{CampaignTemplateWorkflow: workflow}
			payload, marshalErr := json.Marshal(map[string]string{
				"idempotency_key": key,
				"design_id":       "design-1",
			})
			if marshalErr != nil {
				t.Fatalf("marshal payload: %v", marshalErr)
			}
			_, err := handleRetryCampaignTemplateDesign(
				dtCtx(), deps, payload,
			)
			if err == nil || !strings.Contains(err.Error(), "control characters") {
				t.Fatalf("error=%v, want control-character rejection", err)
			}
			if workflow.mutationKey != "" {
				t.Fatalf("workflow mutated with control key %q", workflow.mutationKey)
			}
		})
	}
}

func TestGetCampaignTemplateProjectsReadOnlyKeyCapabilitiesAndFullSource(t *testing.T) {
	body := strings.Repeat("x", 70<<10)
	catalog := &campaignTemplateCatalogFake{template: &campaigntemplates.Template{
		ID: "template-1", TenantID: "tenant-1", Name: "Digest",
		Subject: "Weekly", BodyHTML: body, TemplateKind: "editable",
		ReviewStatus: "approved", SourceLicenseStatus: "owned", Version: 2,
	}}
	ctx := middleware.WithAPIKeyAuth(dtCtx())
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadCampaigns})
	out, err := handleGetCampaignTemplate(
		ctx, &Deps{CampaignTemplates: catalog},
		json.RawMessage(`{"template_id":"template-1"}`),
	)
	if err != nil {
		t.Fatalf("handleGetCampaignTemplate: %v", err)
	}
	template := out.(*campaigntemplates.Template)
	if template.Capabilities.CanEditDirectly || template.Capabilities.CanArchive {
		t.Fatalf("read-only key received write capabilities: %#v", template.Capabilities)
	}
	if template.BodyHTML != body {
		t.Fatalf("body bytes=%d, want full %d", len(template.BodyHTML), len(body))
	}
}

func TestCampaignTemplateFavoritesRequireBoundAPIKeyUserPrincipal(t *testing.T) {
	catalog := &campaignTemplateCatalogFake{}
	deps := &Deps{CampaignTemplates: catalog}
	unbound := middleware.WithAPIKeyAuth(dtCtx())
	unbound = apikeys.WithScopes(unbound, []apikeys.Scope{apikeys.ScopeReadCampaigns})

	if _, err := handleFavoriteCampaignTemplate(
		unbound, deps, json.RawMessage(`{"template_id":"template-1"}`),
	); err == nil || !strings.Contains(err.Error(), "authenticated user context") {
		t.Fatalf("unbound favorite error=%v, want fail-closed user-context error", err)
	}
	if catalog.favoriteCalls != 0 {
		t.Fatalf("unbound key mutated favorites %d times", catalog.favoriteCalls)
	}

	bound := middleware.WithUser(unbound, &middleware.User{
		ID: "user-1", TenantID: "tenant-1",
	})
	out, err := handleFavoriteCampaignTemplate(
		bound, deps, json.RawMessage(`{"template_id":" template-1 "}`),
	)
	if err != nil {
		t.Fatalf("favorite: %v", err)
	}
	if catalog.favoriteCalls != 1 || catalog.favoriteUserID != "user-1" ||
		catalog.favoriteTemplateID != "template-1" || !catalog.favorited {
		t.Fatalf("favorite call = %#v", catalog)
	}
	if result := out.(map[string]any); result["ok"] != true || result["favorited"] != true {
		t.Fatalf("favorite result = %#v", result)
	}

	if _, err := handleUnfavoriteCampaignTemplate(
		bound, deps, json.RawMessage(`{"template_id":"template-1"}`),
	); err != nil {
		t.Fatalf("unfavorite: %v", err)
	}
	if catalog.favoriteCalls != 2 || catalog.favorited {
		t.Fatalf("unfavorite call = %#v", catalog)
	}
}

func TestArchiveCampaignTemplateRequiresAndForwardsStrongETag(t *testing.T) {
	catalog := &campaignTemplateCatalogFake{template: &campaigntemplates.Template{
		ID: "template-1", TenantID: "tenant-1", TemplateKind: "editable",
		ReviewStatus: "approved", SourceLicenseStatus: "owned", Version: 3,
	}}
	deps := &Deps{CampaignTemplates: catalog}
	if _, err := handleArchiveEditableCampaignTemplate(
		dtCtx(), deps,
		json.RawMessage(`{"template_id":"template-1","if_match":"*"}`),
	); err == nil {
		t.Fatal("wildcard etag unexpectedly accepted")
	}
	etag := `"campaign-template:template-1:v3"`
	if _, err := handleArchiveEditableCampaignTemplate(
		dtCtx(), deps,
		json.RawMessage(`{"template_id":"template-1","if_match":`+strconv.Quote(etag)+`}`),
	); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if catalog.ifMatch != etag {
		t.Fatalf("if_match=%q, want %q", catalog.ifMatch, etag)
	}
}

func TestNativeCampaignTemplateLifecycleAndDesignSchemas(t *testing.T) {
	registered := (&Deps{}).allTools()
	byName := make(map[string]tool, len(registered))
	for _, candidate := range registered {
		byName[candidate.Name] = candidate
	}
	for _, name := range []string{
		"createCampaignTemplate",
		"updateCampaignTemplate",
		"favoriteCampaignTemplate",
		"unfavoriteCampaignTemplate",
		"archiveCampaignTemplate",
		"restoreCampaignTemplate",
		"listCampaignTemplateRevisions",
		"getCampaignTemplateRevision",
		"listCampaignTemplateDesigns",
	} {
		if _, ok := byName[name]; !ok {
			t.Fatalf("native lifecycle tool %q is not registered", name)
		}
	}
	if !byName["archiveCampaignTemplate"].Annotations.Destructive ||
		!byName["archiveCampaignTemplate"].Annotations.Idempotent {
		t.Fatalf("archive annotations=%#v", byName["archiveCampaignTemplate"].Annotations)
	}
	if !byName["favoriteCampaignTemplate"].Annotations.Idempotent ||
		byName["favoriteCampaignTemplate"].Annotations.Destructive ||
		!byName["unfavoriteCampaignTemplate"].Annotations.Idempotent ||
		!byName["unfavoriteCampaignTemplate"].Annotations.Destructive {
		t.Fatalf("favorite annotations=%#v unfavorite annotations=%#v",
			byName["favoriteCampaignTemplate"].Annotations,
			byName["unfavoriteCampaignTemplate"].Annotations)
	}
	if !byName["listCampaignTemplateDesigns"].Annotations.ReadOnly ||
		byName["listCampaignTemplateDesigns"].Annotations.Idempotent {
		t.Fatalf(
			"design recovery annotations=%#v",
			byName["listCampaignTemplateDesigns"].Annotations,
		)
	}
	for _, name := range []string{
		"adaptCampaignTemplate",
		"generateCampaignTemplate",
		"saveCampaignTemplateDesign",
		"refineCampaignTemplateDesign",
		"retryCampaignTemplateDesign",
		"createCampaignFromTemplateDesign",
		"archiveCampaignTemplateDesign",
	} {
		var schema struct {
			Required   []string `json:"required"`
			Properties map[string]struct {
				Pattern string `json:"pattern"`
			} `json:"properties"`
		}
		if err := json.Unmarshal(byName[name].InputSchema, &schema); err != nil {
			t.Fatalf("%s schema: %v", name, err)
		}
		found := false
		for _, required := range schema.Required {
			if required == "idempotency_key" {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("%s does not require idempotency_key: %#v", name, schema.Required)
		}
		if schema.Properties["idempotency_key"].Pattern != designIdempotencyKeyPattern {
			t.Fatalf("%s idempotency_key pattern=%q, want %q",
				name, schema.Properties["idempotency_key"].Pattern,
				designIdempotencyKeyPattern)
		}
		if !byName[name].Annotations.Idempotent {
			t.Fatalf("%s does not advertise replay-safe idempotency: %#v",
				name, byName[name].Annotations)
		}
	}
}

type templateCampaignCreatorFake struct {
	input campaigns.CreateInput
	calls int
}

func (f *templateCampaignCreatorFake) Create(_ context.Context, _ string, in campaigns.CreateInput) (*campaigns.Campaign, error) {
	f.calls++
	f.input = in
	return &campaigns.Campaign{ID: "campaign-1"}, nil
}

func TestCreateCampaignFromTemplatePreservesNumericListID(t *testing.T) {
	catalog := &campaignTemplateCatalogFake{template: &campaigntemplates.Template{
		ID: "template-1", Name: "Digest", Subject: "Weekly digest", BodyHTML: "<p>Hello</p>", TemplateKind: "editable",
		ReviewStatus: "approved", SourceLicenseStatus: "owned",
	}}
	creator := &templateCampaignCreatorFake{}
	deps := &Deps{CampaignTemplates: catalog, CampaignCreate: creator}

	if _, err := handleCreateCampaignFromTemplate(dtCtx(), deps, json.RawMessage(`{
		"template_id":"template-1",
		"list_id":9007199254740993
	}`)); err != nil {
		t.Fatalf("handleCreateCampaignFromTemplate: %v", err)
	}
	if creator.input.ListID != "9007199254740993" {
		t.Fatalf("list_id = %q", creator.input.ListID)
	}
}

func TestCreateCampaignFromTemplateRejectsIneligibleTemplate(t *testing.T) {
	creator := &templateCampaignCreatorFake{}
	deps := &Deps{
		CampaignTemplates: &campaignTemplateCatalogFake{template: &campaigntemplates.Template{
			ID: "pending", TemplateKind: "editable", ReviewStatus: "pending", SourceLicenseStatus: "owned",
		}},
		CampaignCreate: creator,
	}
	_, err := handleCreateCampaignFromTemplate(dtCtx(), deps, json.RawMessage(`{"template_id":"pending"}`))
	if !errors.Is(err, campaigntemplates.ErrTemplateIneligible) {
		t.Fatalf("error=%v, want ErrTemplateIneligible", err)
	}
	if creator.calls != 0 {
		t.Fatalf("campaign creator called %d times with input %#v", creator.calls, creator.input)
	}
}

// TMPL-B on the native MCP surface. Before this tool shared the HTTP route's
// chokepoint it kept its own copy of the substitution and baked every sample
// default into the draft: "Hi Friend", "Moosewave", creator@example.invalid,
// and https://moosewave.com/unsubscribe in place of the per-recipient link.
func TestNativeCreateCampaignFromTemplateResolvesSlugAndKeepsPerRecipientTags(t *testing.T) {
	catalog := &campaignTemplateCatalogFake{
		template: &campaigntemplates.Template{
			ID: "386daeaf-8296-4ce3-8ce6-26280361d36b", Slug: "welcome-negative-promise",
			Name: "Negative Welcome", Subject: "you're in",
			BodyHTML: `<p>Hi {{first_name}}, your seat on {{ brand_name }} is active.</p>` +
				`<a href="mailto:{{ reply_to_email }}">reply</a><a href="{{unsubscribe_url}}">unsubscribe</a>`,
			Variables: []map[string]interface{}{
				{"name": "first_name", "default": "there"},
				{"name": "unsubscribe_url", "default": "https://moosewave.com/unsubscribe"},
			},
			TemplateKind: "editable", ReviewStatus: "approved", SourceLicenseStatus: "owned",
		},
		identity: campaigntemplates.WorkspaceIdentity{
			BrandName: "Ember & Oak", SenderName: "Ember & Oak", ReplyToEmail: "hello@ember.example",
		},
	}
	creator := &templateCampaignCreatorFake{}
	deps := &Deps{CampaignTemplates: catalog, CampaignCreate: creator}

	if _, err := handleCreateCampaignFromTemplate(dtCtx(), deps, json.RawMessage(`{
		"template_id":"welcome-negative-promise",
		"brand":{"name":"Northstar"},
		"variables":{"unsubscribe_url":"https://evil.example"}
	}`)); err != nil {
		t.Fatalf("handleCreateCampaignFromTemplate: %v", err)
	}
	if catalog.lookedUp != "welcome-negative-promise" {
		t.Fatalf("template looked up by %q, want the slug passed through", catalog.lookedUp)
	}
	body := creator.input.BodyHTML
	for _, want := range []string{
		"Hi {{ first_name | default: 'there' }}", "seat on Northstar is active",
		`href="mailto:hello@ember.example"`, `href="{{unsubscribe_url}}"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("draft body missing %q:\n%s", want, body)
		}
	}
	for _, leaked := range []string{"moosewave.com", "evil.example"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("draft body baked %q:\n%s", leaked, body)
		}
	}
	if creator.input.SourceTemplateID != "386daeaf-8296-4ce3-8ce6-26280361d36b" {
		t.Fatalf("source_template_id = %q, want the resolved UUID", creator.input.SourceTemplateID)
	}
}

func TestNativeCreateCampaignFromTemplateReportsTagsLeftToFill(t *testing.T) {
	catalog := &campaignTemplateCatalogFake{
		template: &campaigntemplates.Template{
			ID: "386daeaf-8296-4ce3-8ce6-26280361d36b", Slug: "welcome-negative-promise",
			Name: "Negative Welcome", Subject: "you're in",
			BodyHTML: `<a href="{{ cta_url }}">Start</a><a href="mailto:{{ reply_to_email }}">reply</a>` +
				`<a href="{{ unsubscribe_url }}">unsubscribe</a>`,
			Variables:    []map[string]interface{}{{"name": "cta_url", "label": "Start URL"}},
			TemplateKind: "editable", ReviewStatus: "approved", SourceLicenseStatus: "owned",
		},
		identity: campaigntemplates.WorkspaceIdentity{BrandName: "Ember & Oak", SenderName: "Ember & Oak"},
	}
	deps := &Deps{CampaignTemplates: catalog, CampaignCreate: &templateCampaignCreatorFake{}}

	result, err := handleCreateCampaignFromTemplate(dtCtx(), deps, json.RawMessage(`{
		"template_id":"welcome-negative-promise","variables":{"cta_url":""}
	}`))
	if err != nil {
		t.Fatalf("handleCreateCampaignFromTemplate: %v", err)
	}
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	var decoded struct {
		ID                  string   `json:"id"`
		UnresolvedVariables []string `json:"unresolved_variables"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if strings.Join(decoded.UnresolvedVariables, ",") != "cta_url,reply_to_email" {
		t.Fatalf("unresolved_variables = %v, want the blank link and the missing reply-to; result %s",
			decoded.UnresolvedVariables, raw)
	}
}

func TestNativeGetCampaignTemplateAcceptsASlug(t *testing.T) {
	catalog := &campaignTemplateCatalogFake{template: &campaigntemplates.Template{
		ID: "386daeaf-8296-4ce3-8ce6-26280361d36b", Slug: "welcome-negative-promise", Name: "Negative Welcome",
		TemplateKind: "editable", ReviewStatus: "approved", SourceLicenseStatus: "owned",
	}}
	deps := &Deps{CampaignTemplates: catalog}
	if _, err := handleGetCampaignTemplate(dtCtx(), deps,
		json.RawMessage(`{"template_id":" welcome-negative-promise "}`)); err != nil {
		t.Fatalf("handleGetCampaignTemplate: %v", err)
	}
	if catalog.lookedUp != "welcome-negative-promise" {
		t.Fatalf("looked up %q, want the trimmed slug", catalog.lookedUp)
	}
}

func TestBoundedMCPTemplateTextDoesNotSplitUnicode(t *testing.T) {
	if got := boundedMCPTemplateText("a🚀b", 2); got != "a🚀…" {
		t.Fatalf("bounded text = %q", got)
	}
}
