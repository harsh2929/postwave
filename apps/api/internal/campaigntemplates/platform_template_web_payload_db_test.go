// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The web "Use template" dialog posts the template's own subject (the field
// is pre-filled with it) and one value for every declared variable: the
// declared default, or "" when there is none. These tests post exactly that
// for every built-in, so the drafts people actually get are checked, not only
// the drafts an API caller that sends nothing gets.

// webUseTemplatePayload mirrors template-actions.tsx: variableDefaults sends
// default ?? example ?? value ?? "" for each declared variable.
func webUseTemplatePayload(template *Template) map[string]any {
	variables := map[string]any{}
	for _, variable := range template.Variables {
		name, _ := variable["name"].(string)
		if name == "" {
			continue
		}
		value := ""
		for _, key := range []string{"default", "example", "value"} {
			if raw, ok := variable[key]; ok && raw != nil {
				value = fmt.Sprint(raw)
				break
			}
		}
		variables[name] = value
	}
	return map[string]any{
		"template_id": template.ID,
		"name":        template.Name + " campaign",
		"subject":     template.Subject,
		"variables":   variables,
	}
}

type fromTemplateResponse struct {
	campaigns.Campaign
	UnresolvedVariables *[]string `json:"unresolved_variables"`
}

func postWebUseTemplate(t *testing.T, ctx context.Context, router http.Handler, tenantID, userID string, payload map[string]any) fromTemplateResponse {
	t.Helper()
	body, _ := json.Marshal(payload)
	reqCtx := middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
	reqCtx = middleware.WithUser(reqCtx, &middleware.User{ID: userID, TenantID: tenantID, Role: "owner"})
	req := httptest.NewRequestWithContext(reqCtx, http.MethodPost, "/api/v1/campaigns/from-template", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST from-template status=%d body=%s", rec.Code, rec.Body.String())
	}
	var created fromTemplateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if created.UnresolvedVariables == nil {
		t.Fatalf("response has no unresolved_variables array: %s", rec.Body.String())
	}
	return created
}

func fromTemplateRouter(pool *db.Pool) (http.Handler, *campaigns.Repo) {
	campaignsRepo := &campaigns.Repo{Pool: pool}
	deps := &Deps{Repo: &Repo{Pool: pool}, Campaigns: campaignsRepo}
	router := chi.NewRouter()
	router.Post("/api/v1/campaigns/from-template", deps.CreateCampaignFromTemplate)
	return router, campaignsRepo
}

// linkVariables are the declared variables the migration left without a
// default: every one is a link only the author can supply.
func linkVariables(template *Template) []string {
	var names []string
	for _, variable := range template.Variables {
		name, _ := variable["name"].(string)
		if _, hasDefault := variable["default"]; !hasDefault && strings.HasSuffix(name, "_url") {
			names = append(names, name)
		}
	}
	return names
}

func TestWebUseDialogPayloadMakesSendableDraftsForEveryBuiltInDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	workspace := seedPlatformDraftWorkspace(t, ctx, pool)
	router, campaignsRepo := fromTemplateRouter(pool)
	repo := &Repo{Pool: pool}

	linkTotal := 0
	for slug := range platformTemplateSlugs(t, ctx, pool, workspace.tenantID) {
		t.Run(slug, func(t *testing.T) {
			template, err := repo.GetByIDOrSlug(ctx, workspace.tenantID, slug)
			if err != nil {
				t.Fatalf("resolve %s: %v", slug, err)
			}
			created := postWebUseTemplate(t, ctx, router, workspace.tenantID, workspace.userID, webUseTemplatePayload(template))
			campaign, err := campaignsRepo.Get(ctx, workspace.tenantID, created.ID)
			if err != nil {
				t.Fatalf("re-read campaign: %v", err)
			}
			if strings.Contains(campaign.BodyHTML, `href=""`) {
				t.Fatalf("draft has a link with an empty href:\n%s", excerptAround(campaign.BodyHTML, `href=""`))
			}
			// The engine compiles the subject as a template of its own and
			// rejects any {{ name }} action in it, so a subject that still
			// carries one fails every send. The preview text is read in the
			// inbox as-is.
			if strings.Contains(campaign.Subject, "{{") || strings.Contains(campaign.PreviewText, "{{") {
				t.Fatalf("subject %q / preview %q still carry merge tags", campaign.Subject, campaign.PreviewText)
			}
			unresolved := *created.UnresolvedVariables
			for _, name := range linkVariables(template) {
				linkTotal++
				if !strings.Contains(campaign.BodyHTML, "{{ "+name+" }}") {
					t.Errorf("unfilled link %s is not visible in the draft", name)
				}
				if !slices.Contains(unresolved, name) {
					t.Errorf("unfilled link %s is not reported; unresolved_variables = %v", name, unresolved)
				}
			}
			for _, name := range unresolved {
				if !strings.Contains(campaign.Subject+campaign.PreviewText+campaign.BodyHTML, "{{ "+name+" }}") {
					t.Errorf("reported %s, but the draft carries no {{ %s }} tag", name, name)
				}
			}
		})
	}
	// Migration 2055 declares 29 link variables across the built-ins; if the
	// count collapses, the loop above proved nothing.
	if linkTotal < 29 {
		t.Fatalf("checked %d unfilled link variables, want at least 29", linkTotal)
	}
}

func TestDraftForAWorkspaceWithoutReplyToReportsTheMissingAddressDB(t *testing.T) {
	pool, ctx := campaignTemplateSecurityDB(t)
	tenantID := seedCampaignTemplateTenant(t, ctx, pool)
	userID := seedCampaignTemplateUser(t, ctx, pool, tenantID)
	router, _ := fromTemplateRouter(pool)

	template, err := (&Repo{Pool: pool}).GetByIDOrSlug(ctx, tenantID, "welcome-reply-bait")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	created := postWebUseTemplate(t, ctx, router, tenantID, userID, webUseTemplatePayload(template))
	if !strings.Contains(created.BodyHTML, "mailto:{{ reply_to_email }}") {
		t.Fatalf("a workspace with no reply-to address should keep the tag visible; body excerpt:\n%s",
			excerptAround(created.BodyHTML, "mailto:"))
	}
	if !slices.Contains(*created.UnresolvedVariables, WorkspaceReplyToEmailToken) {
		t.Fatalf("unresolved_variables = %v, want it to name %s", *created.UnresolvedVariables, WorkspaceReplyToEmailToken)
	}
	if slices.Contains(*created.UnresolvedVariables, WorkspaceBrandNameToken) {
		t.Fatalf("brand_name is always known (the signup name) but was reported: %v", *created.UnresolvedVariables)
	}
}

func excerptAround(text, needle string) string {
	index := strings.Index(text, needle)
	if index < 0 {
		return ""
	}
	start := max(0, index-160)
	end := min(len(text), index+len(needle)+80)
	return text[start:end]
}
