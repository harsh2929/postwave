// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type unusedCampaignCreator struct{}

func (unusedCampaignCreator) Create(context.Context, string, campaigns.CreateInput) (*campaigns.Campaign, error) {
	return nil, nil
}

type capturingTemplateGenerator struct {
	request GenerateDesignRequest
}

func (generator *capturingTemplateGenerator) GenerateTemplate(_ context.Context, _ string, request GenerateDesignRequest) (GeneratedDesign, error) {
	generator.request = request
	return GeneratedDesign{Name: "Generated", Subject: "Generated subject", BodyHTML: "<p>{{company}}</p>"}, nil
}

func TestTemplateRequiresAdaptationEvenWhenReferenceContainsHTML(t *testing.T) {
	tpl := &Template{
		TemplateKind: "reference", BodyHTML: "<p>Imported reference</p>",
		ReviewStatus: reviewStatusApproved, ReferenceAdaptationAllowed: true,
	}
	if !templateRequiresAdaptation(tpl) {
		t.Fatal("reference template should require adaptation before campaign creation")
	}
	if templateRequiresAdaptation(&Template{TemplateKind: "editable", BodyHTML: tpl.BodyHTML}) {
		t.Fatal("editable template should be usable for campaign creation")
	}
}

func TestApplyDesignValuesEscapesHTMLAndSortsUnresolvedVariables(t *testing.T) {
	design := DesignResponse{
		Subject:     "News from {{ headline }}",
		PreviewText: "For {{zeta}} and {{alpha}}",
		BodyHTML:    "<p>{{company}}</p><p>{{zeta}}</p>",
	}
	applyDesignValues(&design, map[string]any{
		"headline": "A&B",
		"company":  `<script>alert("x")</script>`,
	})

	if design.Subject != "News from A&B" {
		t.Fatalf("subject = %q", design.Subject)
	}
	if design.BodyHTML != "<p>&lt;script&gt;alert(&#34;x&#34;)&lt;/script&gt;</p><p>{{zeta}}</p>" {
		t.Fatalf("body_html = %q", design.BodyHTML)
	}
	want := []string{"alpha", "zeta"}
	if !reflect.DeepEqual(design.UnresolvedVariables, want) {
		t.Fatalf("unresolved_variables = %#v, want %#v", design.UnresolvedVariables, want)
	}
}

// TMPL-B (design paths). A generated or adapted design carries the source
// template's sample values; applying them must never overwrite the tags that
// are rendered per recipient, and those tags are not "unresolved" work for the
// author.
func TestApplyDesignValuesKeepsPerRecipientTagsAndDoesNotReportThem(t *testing.T) {
	design := DesignResponse{
		Subject:  "Hi {{ first_name }}, from {{ brand_name }}",
		BodyHTML: `<p>Hi {{first_name}}</p><a href="{{unsubscribe_url}}">Unsubscribe</a><a href="{{ Unsubscribe.URL }}">x</a><p>{{ intro }}</p>`,
	}
	applyDesignValues(&design, map[string]any{
		"first_name":      "Friend",
		"unsubscribe_url": "https://moosewave.com/unsubscribe",
		"Unsubscribe.URL": "https://example.invalid/unsubscribe",
	})
	if design.Subject != "Hi {{ first_name }}, from {{ brand_name }}" {
		t.Fatalf("subject = %q, want the subscriber and workspace tags intact", design.Subject)
	}
	wantBody := `<p>Hi {{first_name}}</p><a href="{{unsubscribe_url}}">Unsubscribe</a><a href="{{ Unsubscribe.URL }}">x</a><p>{{ intro }}</p>`
	if design.BodyHTML != wantBody {
		t.Fatalf("body_html = %q, want %q", design.BodyHTML, wantBody)
	}
	if !reflect.DeepEqual(design.UnresolvedVariables, []string{"intro"}) {
		t.Fatalf("unresolved_variables = %#v, want only the content tag", design.UnresolvedVariables)
	}
}

func TestUniqueIDsPreservesFirstSeenOrder(t *testing.T) {
	got := uniqueIDs([]string{" one ", "two", "one", "", "two", "three"})
	want := []string{"one", "two", "three"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("uniqueIDs = %#v, want %#v", got, want)
	}
}

func TestVariableDefinitionsPreservesSortedUnresolvedPlaceholders(t *testing.T) {
	got := VariableDefinitions([]string{"zeta", "alpha", "zeta", ""}, map[string]any{"alpha": "fallback"})
	want := []map[string]interface{}{
		{"name": "alpha", "label": "alpha", "default": "fallback"},
		{"name": "zeta", "label": "zeta", "default": ""},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("VariableDefinitions = %#v, want %#v", got, want)
	}
}

func TestCompactImportedTemplateOmitsLargeBodies(t *testing.T) {
	full := Template{ID: "template-1", SourceExternalID: "source-1", BodyHTML: "<p>large</p>", BodyMJML: "<mjml />"}
	compact := compactImportedTemplate(full)
	if compact.BodyHTML != "" || compact.BodyMJML != "" {
		t.Fatalf("compact import result retained bodies: %#v", compact)
	}
	if compact.ID != full.ID || compact.SourceExternalID != full.SourceExternalID {
		t.Fatalf("compact import result lost identity/provenance: %#v", compact)
	}
}

func TestWorkflowHandlersReturnJSONErrorsForMalformedBodies(t *testing.T) {
	tests := map[string]func(*Deps, http.ResponseWriter, *http.Request){
		"from template": func(deps *Deps, w http.ResponseWriter, r *http.Request) {
			deps.CreateCampaignFromTemplate(w, r)
		},
	}
	for name, handler := range tests {
		t.Run(name, func(t *testing.T) {
			deps := &Deps{Campaigns: unusedCampaignCreator{}}
			req := httptest.NewRequest(http.MethodPost, "/api/v1/campaign-templates/test", strings.NewReader(`{"broken"`))
			req.Header.Set("Content-Type", "application/json")
			req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
			rec := httptest.NewRecorder()
			handler(deps, rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), `"error"`) {
				t.Fatalf("body = %s, want JSON error envelope", rec.Body.String())
			}
		})
	}
}

func TestAudienceListIDAcceptsIntegerAndStringJSON(t *testing.T) {
	for name, body := range map[string]string{
		"integer": `{"list_id": 9007199254740993}`,
		"string":  `{"list_id": "42"}`,
	} {
		t.Run(name, func(t *testing.T) {
			var input FromTemplateInput
			if err := json.Unmarshal([]byte(body), &input); err != nil {
				t.Fatalf("Unmarshal: %v", err)
			}
			want := "42"
			if name == "integer" {
				want = "9007199254740993"
			}
			if string(input.ListID) != want {
				t.Fatalf("list_id = %q, want %q", input.ListID, want)
			}
		})
	}
	var invalid FromTemplateInput
	if err := json.Unmarshal([]byte(`{"list_id": 1.5}`), &invalid); err == nil {
		t.Fatal("fractional list_id should fail")
	}
}

func TestLegacyGenerateRequiresDurableDesignWorkflow(t *testing.T) {
	generator := &capturingTemplateGenerator{}
	deps := &Deps{Generator: generator}
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/campaign-templates/generate",
		strings.NewReader(`{"brief":"Create a product digest"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()
	deps.Generate(rec, req)
	if rec.Code != http.StatusGone ||
		!strings.Contains(rec.Body.String(), `"code":"durable_design_workflow_required"`) {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Deprecation") != "true" ||
		!strings.Contains(rec.Header().Get("Link"), "/api/v1/campaign-template-designs") {
		t.Fatalf("retirement headers = %#v", rec.Header())
	}
	if generator.request.Brief != "" {
		t.Fatalf("retired route invoked generator: %#v", generator.request)
	}
}
