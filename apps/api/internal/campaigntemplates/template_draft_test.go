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

	"github.com/postwave/postwave/apps/api/internal/archive_bar"
	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type capturingCampaignCreator struct {
	calls int
	input campaigns.CreateInput
}

func (creator *capturingCampaignCreator) Create(_ context.Context, _ string, input campaigns.CreateInput) (*campaigns.Campaign, error) {
	creator.calls++
	creator.input = input
	return &campaigns.Campaign{ID: "c0ffee00-0000-4000-8000-000000000001", Name: input.Name}, nil
}

// negativeWelcomeAsSeeded is the body of the built-in "Negative Welcome"
// starter as migrations 0240 and 1722 left it: every variable carries a
// sample default, including the send-time unsubscribe placeholder, and the
// body names the sender through legacy variables.
func negativeWelcomeAsSeeded() *Template {
	return &Template{
		ID: "386daeaf-8296-4ce3-8ce6-26280361d36b", Slug: "welcome-negative-promise",
		Name: "Negative Welcome", Subject: "you're in. here's what we won't do.",
		BodyHTML: `<p>A note from {{founder_name}}</p>` +
			`<p>Hi {{first_name}} &mdash; your <strong>{{plan_name}}</strong> seat on {{product}} is active.</p>` +
			`<a href="{{first_action_url}}">Start</a>` +
			`<a href="mailto:{{reply_email}}">{{reply_email}}</a>` +
			`<a href="{{unsubscribe_url}}">one-click unsubscribe</a>`,
		Variables: []map[string]interface{}{
			{"name": "first_name", "label": "First name", "default": "Friend"},
			{"name": "product", "label": "Product", "default": "Moosewave"},
			{"name": "plan_name", "label": "Plan", "default": "Starter"},
			{"name": "founder_name", "label": "Sender name", "default": "Alex"},
			{"name": "reply_email", "label": "Reply-to", "default": "creator@example.invalid"},
			{"name": "first_action_url", "label": "First task URL", "default": "https://app.moosewave.com/onboarding"},
			{"name": "unsubscribe_url", "label": "Unsubscribe URL", "default": "https://moosewave.com/unsubscribe"},
		},
		TemplateKind: templateKindEditable, SourceProvider: "postwave",
		SourceLicenseStatus: licenseStatusOwned, ReviewStatus: reviewStatusApproved,
	}
}

// negativeWelcomeWithWorkspaceTokens is the same starter written against the
// workspace tokens, as migration 2055 rewrites the built-in designs.
func negativeWelcomeWithWorkspaceTokens() *Template {
	tpl := negativeWelcomeAsSeeded()
	tpl.BodyHTML = `<p>A note from {{ sender_name }}</p>` +
		`<p>Hi {{ first_name }} &mdash; your <strong>{{ plan_name }}</strong> seat on {{ brand_name }} is active.</p>` +
		`<a href="{{ first_action_url }}">Start</a>` +
		`<a href="mailto:{{ reply_to_email }}">{{ reply_to_email }}</a>` +
		`<a href="{{ unsubscribe_url }}">one-click unsubscribe</a>`
	tpl.Variables = []map[string]interface{}{
		{"name": "first_name", "label": "First name", "default": "there"},
		{"name": "plan_name", "label": "Plan", "default": "Starter"},
		{"name": "first_action_url", "label": "First task URL", "default": "https://example.com/get-started"},
	}
	return tpl
}

func postFromTemplate(t *testing.T, deps *Deps, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	router := chi.NewRouter()
	router.Post("/api/v1/campaigns/from-template", deps.CreateCampaignFromTemplate)
	router.Post("/api/v1/campaign-templates/{id}/create-campaign", deps.CreateCampaignFromTemplate)
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestCreateCampaignFromTemplateKeepsTheSendTimeUnsubscribeToken(t *testing.T) {
	template := negativeWelcomeAsSeeded()
	creator := &capturingCampaignCreator{}
	deps := &Deps{
		Repo: &templateRepositoryStub{
			getFn: func(context.Context, string, string) (*Template, error) { return template, nil },
			recordUseFn: func(context.Context, string, string) error {
				return nil
			},
		},
		Campaigns: creator,
	}
	// The web dialog used to send every declared default back as a variable;
	// a hostile caller can send any URL. Neither may replace the token.
	rec := postFromTemplate(t, deps, "/api/v1/campaigns/from-template", `{
		"template_id": "386daeaf-8296-4ce3-8ce6-26280361d36b",
		"variables": {"unsubscribe_url": "https://evil.example/unsub", "UnsubscribeURL": "https://evil.example/2"}
	}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := creator.input.BodyHTML
	if !strings.Contains(body, `href="{{unsubscribe_url}}"`) {
		t.Fatalf("draft lost the send-time unsubscribe token:\n%s", body)
	}
	for _, leaked := range []string{"https://moosewave.com/unsubscribe", "https://evil.example"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("draft baked %q into the unsubscribe link:\n%s", leaked, body)
		}
	}
	if _, stored := creator.input.TemplateVariables["unsubscribe_url"]; stored {
		t.Fatalf("campaign template_variables recorded a value for the send-time token: %#v",
			creator.input.TemplateVariables)
	}
}

func TestCreateCampaignFromTemplateKeepsSubscriberMergeTagsWithTheirFallback(t *testing.T) {
	template := negativeWelcomeAsSeeded()
	template.Subject = "{{first_name}}, you're in"
	creator := &capturingCampaignCreator{}
	deps := &Deps{
		Repo: &templateRepositoryStub{
			getFn:       func(context.Context, string, string) (*Template, error) { return template, nil },
			recordUseFn: func(context.Context, string, string) error { return nil },
		},
		Campaigns: creator,
	}
	rec := postFromTemplate(t, deps, "/api/v1/campaigns/from-template",
		`{"template_id":"386daeaf-8296-4ce3-8ce6-26280361d36b"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(creator.input.BodyHTML, "Hi Friend") {
		t.Fatalf("draft greets every recipient with the sample name:\n%s", creator.input.BodyHTML)
	}
	if !strings.Contains(creator.input.BodyHTML, "Hi {{ first_name | default: 'Friend' }}") {
		t.Fatalf("draft should keep the first-name merge tag with the declared fallback:\n%s", creator.input.BodyHTML)
	}
	// The subject is one line for every recipient, and the engine compiles
	// it as a template of its own: a {{ first_name }} action there fails the
	// send, and filter text would show in the campaign list. It takes the
	// fallback itself.
	if creator.input.Subject != "Friend, you're in" {
		t.Fatalf("subject = %q, want the fallback written in", creator.input.Subject)
	}
}

func TestCreateCampaignFromTemplateRendersTheSubjectTheClientPrefilled(t *testing.T) {
	template := negativeWelcomeWithWorkspaceTokens()
	template.Subject = "Hi {{ first_name }}, your {{ plan_name }} seat on {{ brand_name }}"
	creator := &capturingCampaignCreator{}
	deps := &Deps{
		Repo: &templateRepositoryStub{
			getFn:       func(context.Context, string, string) (*Template, error) { return template, nil },
			recordUseFn: func(context.Context, string, string) error { return nil },
		},
		Campaigns: creator,
	}
	// The web dialog pre-fills its subject field with the template's subject
	// and posts it back unchanged.
	rec := postFromTemplate(t, deps, "/api/v1/campaigns/from-template", `{
		"template_id": "386daeaf-8296-4ce3-8ce6-26280361d36b",
		"subject": "Hi {{ first_name }}, your {{ plan_name }} seat on {{ brand_name }}"
	}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if got, want := creator.input.Subject, "Hi there, your Starter seat on {{ brand_name }}"; got != want {
		t.Fatalf("subject = %q, want %q (brand_name stays: this stub workspace has no identity)", got, want)
	}
}

func TestCreateCampaignFromTemplateLeavesBlankLinksVisibleAndReportsThem(t *testing.T) {
	template := negativeWelcomeWithWorkspaceTokens()
	template.Variables = []map[string]interface{}{
		{"name": "first_name", "label": "First name", "default": "there"},
		{"name": "plan_name", "label": "Plan", "default": "Starter"},
		// A saved design declares an unresolved placeholder with a blank
		// default (VariableDefinitions), as the reviewer's probe did.
		{"name": "first_action_url", "label": "First task URL", "default": ""},
	}
	creator := &capturingCampaignCreator{}
	deps := &Deps{
		Repo: &templateRepositoryStub{
			getFn:       func(context.Context, string, string) (*Template, error) { return template, nil },
			recordUseFn: func(context.Context, string, string) error { return nil },
		},
		Campaigns: creator,
	}
	for name, variables := range map[string]string{
		"declared blank default": `{}`,
		"web dialog blank value": `{"first_action_url": "  ", "plan_name": ""}`,
	} {
		t.Run(name, func(t *testing.T) {
			rec := postFromTemplate(t, deps, "/api/v1/campaigns/from-template",
				`{"template_id":"386daeaf-8296-4ce3-8ce6-26280361d36b","variables":`+variables+`}`)
			if rec.Code != http.StatusCreated {
				t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
			}
			body := creator.input.BodyHTML
			if strings.Contains(body, `href=""`) || strings.Contains(body, `href="  "`) {
				t.Fatalf("draft has an empty link:\n%s", body)
			}
			if !strings.Contains(body, `href="{{ first_action_url }}"`) {
				t.Fatalf("the unfilled link should stay a visible tag:\n%s", body)
			}
			if !strings.Contains(body, "<strong>Starter</strong>") {
				t.Fatalf("a blank caller value must not erase the declared default:\n%s", body)
			}
			var response struct {
				ID                  string   `json:"id"`
				UnresolvedVariables []string `json:"unresolved_variables"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
				t.Fatalf("decode: %v", err)
			}
			want := []string{"brand_name", "first_action_url", "reply_to_email", "sender_name"}
			if response.ID == "" || strings.Join(response.UnresolvedVariables, ",") != strings.Join(want, ",") {
				t.Fatalf("response id=%q unresolved_variables=%v, want %v", response.ID, response.UnresolvedVariables, want)
			}
		})
	}
}

func TestCreateCampaignFromTemplateFillsWorkspaceTokensFromTheWorkspace(t *testing.T) {
	template := negativeWelcomeWithWorkspaceTokens()
	creator := &capturingCampaignCreator{}
	deps := &Deps{
		Repo: &templateRepositoryStub{
			getFn:       func(context.Context, string, string) (*Template, error) { return template, nil },
			recordUseFn: func(context.Context, string, string) error { return nil },
			identity: WorkspaceIdentity{
				BrandName: "Ember & Oak", SenderName: "Ember & Oak", ReplyToEmail: "hello@ember.example",
			},
		},
		Campaigns: creator,
	}
	rec := postFromTemplate(t, deps, "/api/v1/campaigns/from-template",
		`{"template_id":"welcome-negative-promise"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := creator.input.BodyHTML
	for _, want := range []string{
		"A note from Ember &amp; Oak",
		"seat on Ember &amp; Oak is active",
		`href="mailto:hello@ember.example"`,
		"<strong>Starter</strong>",
		`href="https://example.com/get-started"`,
		`href="{{ unsubscribe_url }}"`,
		"Hi {{ first_name | default: 'there' }}",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("draft body missing %q:\n%s", want, body)
		}
	}
	if creator.input.TemplateVariables[WorkspaceBrandNameToken] != "Ember & Oak" {
		t.Fatalf("template_variables = %#v, want the workspace brand recorded", creator.input.TemplateVariables)
	}
}

func TestCreateCampaignFromTemplateCallerBrandWinsAndMissingReplyToStaysATag(t *testing.T) {
	template := negativeWelcomeWithWorkspaceTokens()
	creator := &capturingCampaignCreator{}
	deps := &Deps{
		Repo: &templateRepositoryStub{
			getFn:       func(context.Context, string, string) (*Template, error) { return template, nil },
			recordUseFn: func(context.Context, string, string) error { return nil },
			// A workspace with a name but no reply-to or compliance contact.
			identity: WorkspaceIdentity{BrandName: "Ember & Oak", SenderName: "Ember & Oak"},
		},
		Campaigns: creator,
	}
	rec := postFromTemplate(t, deps, "/api/v1/campaign-templates/welcome-negative-promise/create-campaign",
		`{"brand":{"name":"Northstar"},"variables":{"sender_name":"Mira","plan_name":"Pro"}}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := creator.input.BodyHTML
	for _, want := range []string{
		"A note from Mira", "seat on Northstar is active", "<strong>Pro</strong>",
		// No workspace value and no caller value: the tag stays for the
		// author to fill instead of reaching recipients as a fake address.
		`href="mailto:{{ reply_to_email }}"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("draft body missing %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "Ember") {
		t.Fatalf("caller-supplied brand and sender should win over the workspace:\n%s", body)
	}
}

func TestCreateCampaignFromTemplateNeverUsesSampleDefaultsForWorkspaceTokens(t *testing.T) {
	template := negativeWelcomeWithWorkspaceTokens()
	template.Variables = append(template.Variables,
		map[string]interface{}{"name": "brand_name", "label": "Brand", "default": "Moosewave"},
		map[string]interface{}{"name": "reply_to_email", "label": "Reply-to", "default": "creator@example.invalid"},
	)
	creator := &capturingCampaignCreator{}
	deps := &Deps{
		Repo: &templateRepositoryStub{
			getFn:       func(context.Context, string, string) (*Template, error) { return template, nil },
			recordUseFn: func(context.Context, string, string) error { return nil },
			identity:    WorkspaceIdentity{BrandName: "Ember & Oak", SenderName: "Ember & Oak"},
		},
		Campaigns: creator,
	}
	rec := postFromTemplate(t, deps, "/api/v1/campaigns/from-template",
		`{"template_id":"welcome-negative-promise"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	for _, sample := range []string{"Moosewave", "creator@example.invalid"} {
		if strings.Contains(creator.input.BodyHTML, sample) {
			t.Fatalf("draft used the template's sample %q for a workspace token:\n%s", sample, creator.input.BodyHTML)
		}
	}
}

func TestCreateCampaignFromTemplateReportsUnknownSlugAs404(t *testing.T) {
	deps := &Deps{
		Repo: &templateRepositoryStub{getFn: func(context.Context, string, string) (*Template, error) {
			return nil, ErrNotFound
		}},
		Campaigns: &capturingCampaignCreator{},
	}
	rec := postFromTemplate(t, deps, "/api/v1/campaigns/from-template", `{"template_id":"no-such-design"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var env struct {
		Error struct{ Code string } `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil || env.Error.Code != "template_not_found" {
		t.Fatalf("body = %s, want template_not_found", rec.Body.String())
	}
}

// The design → campaign path shares the substitution chokepoint: a reviewed
// design whose recorded values include the unsubscribe placeholder (carried
// over from the template it adapted) must not bake it either.
func TestCreateCampaignFromDesignKeepsTheSendTimeUnsubscribeToken(t *testing.T) {
	draft := readyDesignDraftForCommit()
	draft.Revision.Output.BodyHTML = `<html><body><p>Hi {{first_name}} from {{ brand_name }}</p>` +
		`<a href="{{ unsubscribe_url }}">Unsubscribe</a></body></html>`
	draft.Revision.Output.Variables = map[string]any{
		"unsubscribe_url": "https://moosewave.com/unsubscribe", "first_name": "Friend",
	}
	store := &designCommitStoreStub{draft: draft}
	campaignsRepo := &designCampaignRecoveryStub{}
	deps := &Deps{
		Designs:   store,
		Repo:      &templateRepositoryStub{identity: WorkspaceIdentity{BrandName: "Ember & Oak", SenderName: "Ember & Oak"}},
		Campaigns: campaignsRepo,
	}
	if _, err := deps.CreateCampaignFromDesignRevision(
		context.Background(), "tenant-1", designUnitTestActor, draft.ID,
		CreateCampaignFromDesignDraftInput{
			CommitDesignDraftInput: CommitDesignDraftInput{Revision: 1, OutputHash: draft.Revision.OutputHash},
			Variables:              map[string]any{"unsubscribe_url": "https://evil.example"},
		},
	); err != nil {
		t.Fatalf("CreateCampaignFromDesignRevision: %v", err)
	}
	body := campaignsRepo.createdInput.BodyHTML
	for _, want := range []string{`href="{{ unsubscribe_url }}"`, "Hi {{first_name}}", "from Ember &amp; Oak"} {
		if !strings.Contains(body, want) {
			t.Fatalf("campaign body missing %q:\n%s", want, body)
		}
	}
	for _, leaked := range []string{"moosewave.com", "evil.example", "Friend"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("campaign body baked %q:\n%s", leaked, body)
		}
	}
}

// The archive links are campaign-scoped tokens the send loop fills through
// archive_bar.Render. This drives that renderer for each name the draft
// treats as send-time, so the two lists cannot drift apart silently.
func TestArchiveTokensAreExactlyWhatTheArchiveRendererFills(t *testing.T) {
	for name := range archiveTokens {
		body := "<p>{{ " + name + " }}</p>"
		rendered := archive_bar.Render(body, archive_bar.RenderInputs{
			Defaults: archive_bar.TenantDefaults{
				ArchiveBarEnabled: true, ViewInBrowserEnabled: true, TenantArchiveSlug: "ember",
			},
			PublicBaseURL: "https://archive.example", CampaignArchiveSlug: "issue-1", CampaignPublic: true,
		})
		if rendered == body {
			t.Errorf("archive_bar.Render left {{ %s }} untouched; it is not a send-time token", name)
		}
		if variableRole(name) != VariableRoleSendTime {
			t.Errorf("variableRole(%q) = %q, want send_time", name, variableRole(name))
		}
	}
}

func TestCreateCampaignFromTemplateKeepsTheArchiveLinkForTheSendLoop(t *testing.T) {
	template := negativeWelcomeWithWorkspaceTokens()
	template.BodyHTML += `<a href="{{archive_url}}">Browse the archive</a>`
	template.Variables = append(template.Variables,
		map[string]interface{}{"name": "archive_url", "default": "https://moosewave.com/archive"})
	draft, err := BuildCampaignDraft(context.Background(), template, CampaignDraftInput{
		Variables: map[string]any{"archive_url": "https://elsewhere.example/archive"},
	}, WorkspaceIdentity{BrandName: "Ember & Oak"})
	if err != nil {
		t.Fatalf("BuildCampaignDraft: %v", err)
	}
	if !strings.Contains(draft.BodyHTML, `href="{{archive_url}}"`) {
		t.Fatalf("draft lost the archive token:\n%s", draft.BodyHTML)
	}
	for _, leaked := range []string{"moosewave.com", "elsewhere.example"} {
		if strings.Contains(draft.BodyHTML, leaked) {
			t.Fatalf("draft baked %q into the archive link:\n%s", leaked, draft.BodyHTML)
		}
	}
}

func TestBuildCampaignDraftFallbackOnlyCarriesSafeText(t *testing.T) {
	template := negativeWelcomeWithWorkspaceTokens()
	for _, tc := range []struct {
		fallback any
		want     string
	}{
		{"there", "Hi {{ first_name | default: 'there' }}"},
		{"Friend's", "Hi {{ first_name }}"},
		{"x' }}<script>", "Hi {{ first_name }}"},
		{"a|b", "Hi {{ first_name }}"},
		{"", "Hi {{ first_name }}"},
		{42.0, "Hi {{ first_name }}"},
	} {
		template.Variables[0]["default"] = tc.fallback
		draft, err := BuildCampaignDraft(context.Background(), template, CampaignDraftInput{}, WorkspaceIdentity{})
		if err != nil {
			t.Fatalf("BuildCampaignDraft: %v", err)
		}
		if !strings.Contains(draft.BodyHTML, tc.want) {
			t.Fatalf("fallback %#v: body = %s, want %q", tc.fallback, draft.BodyHTML, tc.want)
		}
	}
}

func TestTemplateVariableRolesClassifiesEveryNonContentTag(t *testing.T) {
	roles := TemplateVariableRoles(negativeWelcomeAsSeeded())
	want := map[string]string{
		"first_name":      VariableRoleSubscriber,
		"unsubscribe_url": VariableRoleSendTime,
	}
	if len(roles) != len(want) {
		t.Fatalf("roles = %#v, want exactly %#v", roles, want)
	}
	for name, role := range want {
		if roles[name] != role {
			t.Fatalf("roles[%q] = %q, want %q (all: %#v)", name, roles[name], role, roles)
		}
	}
	roles = TemplateVariableRoles(negativeWelcomeWithWorkspaceTokens())
	for name, role := range map[string]string{
		"first_name": VariableRoleSubscriber, "unsubscribe_url": VariableRoleSendTime,
		"sender_name": VariableRoleWorkspace, "brand_name": VariableRoleWorkspace,
		"reply_to_email": VariableRoleWorkspace,
	} {
		if roles[name] != role {
			t.Fatalf("roles[%q] = %q, want %q (all: %#v)", name, roles[name], role, roles)
		}
	}
	if _, ok := roles["plan_name"]; ok {
		t.Fatalf("content variable plan_name must not carry a role: %#v", roles)
	}
}
