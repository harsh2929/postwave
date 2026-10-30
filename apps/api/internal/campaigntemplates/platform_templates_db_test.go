// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"encoding/json"
	"html"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sending"
	"github.com/postwave/postwave/apps/api/internal/unsubscribetoken"
)

// These tests run the real handlers and repositories against the migrated
// database as the RLS-bound application role, over the built-in templates as
// migration 2055 leaves them. They are the end-to-end proof that a draft made
// from any built-in design is a real email for the workspace that made it.

type platformDraftWorkspace struct {
	tenantID string
	userID   string
	brand    string
	replyTo  string
}

func seedPlatformDraftWorkspace(t *testing.T, ctx context.Context, pool *db.Pool) platformDraftWorkspace {
	t.Helper()
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	userID := seedCampaignTemplateUser(t, ctx, pool, tenantID)
	workspace := platformDraftWorkspace{
		tenantID: tenantID, userID: userID,
		brand: "Ember & Oak", replyTo: "hello@ember.example",
	}
	campaignTemplateSecurityExec(t, ctx, pool, tenantID, `
INSERT INTO workspace_settings (tenant_id, display_name, default_reply_to)
VALUES ($1::uuid, $2, $3)`, tenantID, workspace.brand, workspace.replyTo)
	return workspace
}

// builtInStarterSlugs are the 29 built-in starters migration 2055 rewrites.
// They are pinned by name rather than by counting platform rows: other suites
// seed platform fixtures of their own (email_template's thumbnail tests do)
// and may run at the same time, and a starter that disappears must still
// fail loudly.
var builtInStarterSlugs = []string{
	"announcement-milestone-typographic",
	"announcement-product-launch",
	"announcement-sunset-with-runway",
	"announcement-we-didnt-ship",
	"automation-anomaly-with-reasoning",
	"automation-day-three-tip",
	"automation-milestone-cohort-hit",
	"automation-post-send-debrief",
	"newsletter-card-grid-digest",
	"newsletter-editorial-masthead",
	"newsletter-margin-notes",
	"newsletter-one-link",
	"newsletter-weekly",
	"promotional-flash-sale",
	"promotional-gradient-bold",
	"promotional-honest-math",
	"promotional-loyalty-no-coupon",
	"re-engagement-gentle",
	"re-engagement-letter-from-future-self",
	"re-engagement-pause-choice",
	"transactional-export-ready",
	"transactional-magic-link-mono-code",
	"transactional-password-reset-timed",
	"transactional-receipt",
	"transactional-security-new-device",
	"welcome-day-one-cohort",
	"welcome-launch",
	"welcome-negative-promise",
	"welcome-reply-bait",
}

func platformTemplateSlugs(t *testing.T, ctx context.Context, pool *db.Pool, tenantID string) map[string]string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT slug, COALESCE(goal, '') FROM campaign_templates
 WHERE tenant_id IS NULL AND template_kind = 'editable' AND archived_at IS NULL
   AND slug = ANY($1::text[])
 ORDER BY slug`, builtInStarterSlugs)
	if err != nil {
		t.Fatalf("list platform templates: %v", err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var slug, goal string
		if err := rows.Scan(&slug, &goal); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out[slug] = goal
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	for _, slug := range builtInStarterSlugs {
		if _, ok := out[slug]; !ok {
			t.Errorf("built-in starter %s is not a visible, active, editable platform template", slug)
		}
	}
	if t.Failed() {
		t.FailNow()
	}
	return out
}

// fixedSixHundredRE finds a table pinned to 600px wide (max-width:600px, the
// fluid replacement, is fine).
var fixedSixHundredRE = regexp.MustCompile(`width="600"|[;"\s]width:\s*600px`)

// sampleOrForeignValues are values the seeds used to bake into every draft.
var sampleOrForeignValues = regexp.MustCompile(`(?i)postwave|example\.invalid|loomstack|creator@|\bMira\b|\bAlex\b|Hi Friend`)

func TestEveryBuiltInTemplateMakesARealDraftDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	workspace := seedPlatformDraftWorkspace(t, ctx, pool)
	campaignsRepo := &campaigns.Repo{Pool: pool}
	deps := &Deps{Repo: &Repo{Pool: pool}, Campaigns: campaignsRepo}
	router := chi.NewRouter()
	router.Post("/api/v1/campaigns/from-template", deps.CreateCampaignFromTemplate)

	escapedBrand := html.EscapeString(workspace.brand)
	for slug, goal := range platformTemplateSlugs(t, ctx, pool, workspace.tenantID) {
		t.Run(slug, func(t *testing.T) {
			template, err := (&Repo{Pool: pool}).GetByIDOrSlug(ctx, workspace.tenantID, slug)
			if err != nil {
				t.Fatalf("resolve %s: %v", slug, err)
			}
			body, _ := json.Marshal(map[string]any{"template_id": slug})
			reqCtx := middleware.WithTenant(ctx, &middleware.Tenant{ID: workspace.tenantID})
			reqCtx = middleware.WithUser(reqCtx, &middleware.User{ID: workspace.userID, TenantID: workspace.tenantID, Role: "owner"})
			req := httptest.NewRequestWithContext(reqCtx, http.MethodPost, "/api/v1/campaigns/from-template",
				strings.NewReader(string(body)))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusCreated {
				t.Fatalf("POST from-template status=%d body=%s", rec.Code, rec.Body.String())
			}
			var created campaigns.Campaign
			if decodeErr := json.Unmarshal(rec.Body.Bytes(), &created); decodeErr != nil {
				t.Fatalf("decode campaign: %v", decodeErr)
			}
			campaign, err := campaignsRepo.Get(ctx, workspace.tenantID, created.ID)
			if err != nil {
				t.Fatalf("re-read campaign: %v", err)
			}
			if campaign.SourceTemplateID != template.ID {
				t.Fatalf("source_template_id = %q, want %q", campaign.SourceTemplateID, template.ID)
			}
			draft := campaign.Subject + "\n" + campaign.PreviewText + "\n" + campaign.BodyHTML
			if match := sampleOrForeignValues.FindString(draft); match != "" {
				t.Fatalf("draft carries sample or foreign value %q", match)
			}
			if strings.Contains(template.BodyHTML, "brand_name") && !strings.Contains(campaign.BodyHTML, escapedBrand) {
				t.Fatalf("draft does not name the workspace brand %q", workspace.brand)
			}
			if strings.Contains(template.BodyHTML, "reply_to_email") && !strings.Contains(campaign.BodyHTML, workspace.replyTo) {
				t.Fatalf("draft does not use the workspace reply-to %q", workspace.replyTo)
			}
			for _, token := range []string{WorkspaceBrandNameToken, WorkspaceSenderNameToken, WorkspaceReplyToEmailToken} {
				if strings.Contains(draft, "{{ "+token+" }}") {
					t.Fatalf("draft left workspace token %q unfilled although the workspace has it", token)
				}
			}
			if goal == "transactional" {
				return
			}
			if !unsubscribetoken.Contains(campaign.BodyHTML) {
				t.Fatal("marketing draft has no send-time unsubscribe placeholder")
			}
			const preferences = "https://app.example.com/preferences/9f2c"
			if rendered := sending.RenderUnsubscribePlaceholder(campaign.BodyHTML, preferences); !strings.Contains(rendered, `href="`+preferences+`"`) {
				t.Fatal("the send loop would not render a per-recipient unsubscribe link into this draft")
			}
			for _, check := range campaignsRepo.BuildChecklist(ctx, workspace.tenantID, campaign).Checks {
				if check.Key == "unsubscribe_link_present" && check.Status != campaigns.CheckPass {
					t.Fatalf("checklist unsubscribe_link_present = %s (%s)", check.Status, check.Detail)
				}
			}
		})
	}
}

func TestBuiltInTemplatesDeclareNoSendTimeOrSampleIdentityVariablesDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}
	for slug := range platformTemplateSlugs(t, ctx, pool, tenantID) {
		template, err := repo.GetByIDOrSlug(ctx, tenantID, slug)
		if err != nil {
			t.Fatalf("resolve %s: %v", slug, err)
		}
		if template.BodyMJML != "" {
			t.Errorf("%s still stores MJML; drafts would compile a different design from the HTML preview", slug)
		}
		for _, variable := range template.Variables {
			name, _ := variable["name"].(string)
			if role := variableRole(name); role == VariableRoleSendTime || role == VariableRoleWorkspace {
				t.Errorf("%s declares %s variable %q with default %v", slug, role, name, variable["default"])
			}
			if text, _ := variable["default"].(string); sampleOrForeignValues.MatchString(text) || strings.Contains(text, "http") {
				t.Errorf("%s variable %q defaults to %q", slug, name, text)
			}
		}
		for _, marker := range []string{`<meta name="viewport"`, "@media only screen and (max-width:620px)"} {
			if !strings.Contains(template.BodyHTML, marker) {
				t.Errorf("%s body lacks %q", slug, marker)
			}
		}
		if fixedSixHundredRE.MatchString(template.BodyHTML) {
			t.Errorf("%s still has a fixed 600px table", slug)
		}
	}
}

func TestGetByIDOrSlugResolvesTheVisibleTemplateDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	otherTenantID := seedCampaignTemplateTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}

	platform, err := repo.GetByIDOrSlug(ctx, tenantID, "welcome-negative-promise")
	if err != nil {
		t.Fatalf("platform slug: %v", err)
	}
	if platform.TenantID != "" || platform.Name != "Negative Welcome" {
		t.Fatalf("platform slug resolved to %#v", platform)
	}
	byID, err := repo.GetByIDOrSlug(ctx, tenantID, strings.ToUpper(platform.ID))
	if err != nil || byID.ID != platform.ID {
		t.Fatalf("uppercase UUID resolved to %v, %v", byID, err)
	}
	if _, caseErr := repo.GetByIDOrSlug(ctx, tenantID, "Welcome-Negative-Promise"); caseErr != nil {
		t.Fatalf("slug lookup should be case-insensitive: %v", caseErr)
	}

	prefix := "slug-lookup-" + randHex4(t)
	own, err := repo.Create(ctx, tenantID, CreateInput{
		Slug: prefix, Name: "Own", Subject: "Own", BodyHTML: "<p>own</p>",
		TemplateKind: templateKindEditable, SourceProvider: "postwave",
		SourceLicenseStatus: licenseStatusOwned, ReviewStatus: reviewStatusApproved,
	})
	if err != nil {
		t.Fatalf("create tenant template: %v", err)
	}
	got, err := repo.GetByIDOrSlug(ctx, tenantID, prefix)
	if err != nil || got.ID != own.ID {
		t.Fatalf("own slug resolved to %v, %v; want %s", got, err, own.ID)
	}
	if _, foreignErr := repo.GetByIDOrSlug(ctx, otherTenantID, prefix); foreignErr != ErrNotFound {
		t.Fatalf("another workspace resolved a private slug: err=%v", foreignErr)
	}

	// A workspace's own template shadows the starter it shares a slug with,
	// but not once it is archived.
	shadow, err := repo.Create(ctx, tenantID, CreateInput{
		Slug: "welcome-negative-promise", Name: "Our welcome", Subject: "Hi", BodyHTML: "<p>ours</p>",
		TemplateKind: templateKindEditable, SourceProvider: "postwave",
		SourceLicenseStatus: licenseStatusOwned, ReviewStatus: reviewStatusApproved,
	})
	if err != nil {
		t.Fatalf("create shadowing template: %v", err)
	}
	if got, err := repo.GetByIDOrSlug(ctx, tenantID, "welcome-negative-promise"); err != nil || got.ID != shadow.ID {
		t.Fatalf("shadowed slug resolved to %v, %v; want the workspace's own %s", got, err, shadow.ID)
	}
	if got, err := repo.GetByIDOrSlug(ctx, otherTenantID, "welcome-negative-promise"); err != nil || got.ID != platform.ID {
		t.Fatalf("other workspace resolved %v, %v; want the platform starter", got, err)
	}
	if _, err := repo.Archive(ctx, tenantID, shadow.ID, templateETag(shadow)); err != nil {
		t.Fatalf("archive shadow: %v", err)
	}
	if got, err := repo.GetByIDOrSlug(ctx, tenantID, "welcome-negative-promise"); err != nil || got.ID != platform.ID {
		t.Fatalf("archived shadow still resolved: %v, %v", got, err)
	}

	for _, missing := range []string{"no-such-design", "not a slug!", "", "00000000-0000-4000-8000-000000000000"} {
		if _, err := repo.GetByIDOrSlug(ctx, tenantID, missing); err != ErrNotFound {
			t.Fatalf("GetByIDOrSlug(%q) err=%v, want ErrNotFound", missing, err)
		}
	}
}

func TestGetTemplateBySlugThroughTheRouteDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	deps := &Deps{Repo: &Repo{Pool: pool}}
	router := chi.NewRouter()
	router.Get("/api/v1/campaign-templates/{id}", deps.Get)
	req := httptest.NewRequestWithContext(
		middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID}),
		http.MethodGet, "/api/v1/campaign-templates/welcome-negative-promise", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET by slug status=%d body=%s", rec.Code, rec.Body.String())
	}
	var got Template
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Slug != "welcome-negative-promise" || got.BodyHTML == "" {
		t.Fatalf("GET by slug returned %s / %d body bytes", got.Slug, len(got.BodyHTML))
	}
	for name, role := range map[string]string{
		"first_name": VariableRoleSubscriber, "unsubscribe_url": VariableRoleSendTime,
		"brand_name": VariableRoleWorkspace, "sender_name": VariableRoleWorkspace,
		"reply_to_email": VariableRoleWorkspace,
	} {
		if got.VariableRoles[name] != role {
			t.Fatalf("variable_roles[%q] = %q, want %q (all: %v)", name, got.VariableRoles[name], role, got.VariableRoles)
		}
	}
}

func TestSearchFindsTemplatesBySlugAndTheDefaultInspirationViewIsPopulatedDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}

	bySlug, err := repo.Search(ctx, tenantID, SearchFilter{Query: "welcome-negative-promise"})
	if err != nil {
		t.Fatalf("search by slug: %v", err)
	}
	if bySlug.Total != 1 || len(bySlug.Items) != 1 || bySlug.Items[0].Slug != "welcome-negative-promise" {
		t.Fatalf("search by slug total=%d items=%v", bySlug.Total, bySlug.Items)
	}

	// The web gallery's default Inspiration view (TMPL-A): the platform
	// catalogue for the newsletter goal, which must include every built-in
	// newsletter starter, each usable directly. The catalogue may grow (a
	// later platform design, references published per the TMPL-A3 runbook),
	// so the starters are pinned by slug rather than by counting rows.
	inspiration, err := repo.Search(ctx, tenantID, SearchFilter{
		Source: "platform", Goal: "newsletter", Sort: "recommended", PerPage: 100,
	})
	if err != nil {
		t.Fatalf("inspiration search: %v", err)
	}
	found := map[string]bool{}
	for _, item := range inspiration.Items {
		if item.TenantID != "" {
			t.Fatalf("inspiration item %s belongs to a workspace (tenant=%q)", item.Slug, item.TenantID)
		}
		if strings.HasPrefix(item.Slug, "newsletter-") && slices.Contains(builtInStarterSlugs, item.Slug) {
			if item.TemplateKind != templateKindEditable || !item.Capabilities.CanUseDirectly {
				t.Fatalf("starter %s kind=%q use=%v, want an editable template usable directly",
					item.Slug, item.TemplateKind, item.Capabilities.CanUseDirectly)
			}
			found[item.Slug] = true
		}
	}
	for _, slug := range builtInStarterSlugs {
		if strings.HasPrefix(slug, "newsletter-") && !found[slug] {
			t.Errorf("the default Inspiration view does not show the built-in starter %s", slug)
		}
	}
	if len(found) == 0 {
		t.Fatal("no built-in newsletter starter is pinned; the loop above proved nothing")
	}
}

func TestWorkspaceIdentityPrecedenceDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	repo := &Repo{Pool: pool}

	identity, err := repo.WorkspaceIdentity(ctx, tenantID)
	if err != nil {
		t.Fatalf("WorkspaceIdentity: %v", err)
	}
	if identity.BrandName != "Campaign template q-filter test" || identity.SenderName != identity.BrandName || identity.ReplyToEmail != "" {
		t.Fatalf("bare workspace identity = %#v, want the signup name and no reply-to", identity)
	}

	campaignTemplateSecurityExec(t, ctx, pool, tenantID, `
INSERT INTO email_compliance_profiles (tenant_id, legal_sender_name, compliance_contact_email)
VALUES ($1::uuid, 'Ember and Oak Coffee LLC', 'legal@ember.example')`, tenantID)
	identity, err = repo.WorkspaceIdentity(ctx, tenantID)
	if err != nil {
		t.Fatalf("WorkspaceIdentity: %v", err)
	}
	if identity.BrandName != "Ember and Oak Coffee LLC" || identity.ReplyToEmail != "legal@ember.example" {
		t.Fatalf("identity with a sender profile = %#v", identity)
	}

	campaignTemplateSecurityExec(t, ctx, pool, tenantID, `
INSERT INTO workspace_settings (tenant_id, display_name, default_reply_to)
VALUES ($1::uuid, '  Ember & Oak  ', 'hello@ember.example')`, tenantID)
	identity, err = repo.WorkspaceIdentity(ctx, tenantID)
	if err != nil {
		t.Fatalf("WorkspaceIdentity: %v", err)
	}
	if identity.BrandName != "Ember & Oak" || identity.SenderName != "Ember & Oak" || identity.ReplyToEmail != "hello@ember.example" {
		t.Fatalf("identity with workspace settings = %#v", identity)
	}
}
