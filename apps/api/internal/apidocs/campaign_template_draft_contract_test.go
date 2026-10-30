// SPDX-License-Identifier: AGPL-3.0-only

package apidocs

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/campaigntemplates"
)

// The draft-from-template routes accept a slug and report the tags a draft
// still carries; the published contract must say both, or generated clients
// reject slugs and drop unresolved_variables.
func TestCampaignFromTemplateContractAcceptsSlugsAndReportsUnfilledTags(t *testing.T) {
	var document struct {
		Paths      map[string]map[string]json.RawMessage `json:"paths"`
		Components struct {
			Schemas map[string]json.RawMessage `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}

	var input struct {
		Properties map[string]map[string]any `json:"properties"`
	}
	if err := json.Unmarshal(document.Components.Schemas["CampaignFromTemplateInput"], &input); err != nil {
		t.Fatalf("decode CampaignFromTemplateInput: %v", err)
	}
	templateID := input.Properties["template_id"]
	if _, pinned := templateID["format"]; pinned {
		t.Fatalf("template_id still declares format %v, but slugs are accepted", templateID["format"])
	}
	if description, _ := templateID["description"].(string); !strings.Contains(description, "slug") {
		t.Fatalf("template_id description does not mention slugs: %q", description)
	}

	for _, path := range []string{"/api/v1/campaigns/from-template", "/api/v1/campaign-templates/{id}/create-campaign"} {
		var operation campaignTemplateContractOperation
		if err := json.Unmarshal(document.Paths[path]["post"], &operation); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
		if !strings.Contains(string(operation.Responses["201"]), "#/components/schemas/CampaignFromTemplateResult") {
			t.Fatalf("%s 201 does not return CampaignFromTemplateResult: %s", path, operation.Responses["201"])
		}
	}
	result := strings.Join(strings.Fields(string(document.Components.Schemas["CampaignFromTemplateResult"])), "")
	for _, want := range []string{`"#/components/schemas/Campaign"`, `"unresolved_variables":{`, `"required":["unresolved_variables"]`} {
		if !strings.Contains(result, want) {
			t.Fatalf("CampaignFromTemplateResult lacks %s: %s", want, result)
		}
	}

	var template struct {
		Properties map[string]json.RawMessage `json:"properties"`
	}
	if err := json.Unmarshal(document.Components.Schemas["CampaignTemplate"], &template); err != nil {
		t.Fatalf("decode CampaignTemplate: %v", err)
	}
	var variableRoles struct {
		AdditionalProperties struct {
			Enum []string `json:"enum"`
		} `json:"additionalProperties"`
	}
	if err := json.Unmarshal(template.Properties["variable_roles"], &variableRoles); err != nil {
		t.Fatalf("CampaignTemplate.variable_roles is not documented: %v", err)
	}
	roles := variableRoles.AdditionalProperties.Enum
	for _, role := range []string{
		campaigntemplates.VariableRoleSubscriber,
		campaigntemplates.VariableRoleWorkspace,
		campaigntemplates.VariableRoleSendTime,
	} {
		if !slices.Contains(roles, role) {
			t.Fatalf("CampaignTemplate.variable_roles enum %v lacks the role %q the server emits", roles, role)
		}
	}
}
