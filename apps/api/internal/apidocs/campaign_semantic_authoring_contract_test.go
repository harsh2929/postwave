package apidocs

import (
	"encoding/json"
	"slices"
	"testing"
)

func TestCampaignOpenAPIPreservesSemanticAuthoringAuthority(t *testing.T) {
	var document struct {
		Components struct {
			Schemas map[string]struct {
				Required   []string                   `json:"required"`
				Properties map[string]json.RawMessage `json:"properties"`
			} `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}

	for _, schemaName := range []string{"Campaign", "CreateCampaignInput", "UpdateCampaignInput"} {
		schema, ok := document.Components.Schemas[schemaName]
		if !ok {
			t.Fatalf("schema %s missing", schemaName)
		}
		for _, field := range []string{
			"content_blocks", "source_mode", "content_schema_version", "fact_contract",
		} {
			if _, ok := schema.Properties[field]; !ok {
				t.Fatalf("%s.%s missing", schemaName, field)
			}
		}
	}

	campaign := document.Components.Schemas["Campaign"]
	for _, field := range []string{"source_mode", "content_schema_version", "fact_contract"} {
		if !slices.Contains(campaign.Required, field) {
			t.Fatalf("Campaign does not require server-owned %s", field)
		}
	}

	var sourceMode struct {
		Enum []string `json:"enum"`
	}
	if err := json.Unmarshal(campaign.Properties["source_mode"], &sourceMode); err != nil {
		t.Fatalf("decode source_mode: %v", err)
	}
	if !slices.Equal(sourceMode.Enum, []string{"semantic", "legacy_html"}) {
		t.Fatalf("source_mode enum = %v", sourceMode.Enum)
	}

	var schemaVersion struct {
		Minimum int `json:"minimum"`
		Maximum int `json:"maximum"`
	}
	if err := json.Unmarshal(campaign.Properties["content_schema_version"], &schemaVersion); err != nil {
		t.Fatalf("decode content_schema_version: %v", err)
	}
	if schemaVersion.Minimum != 1 || schemaVersion.Maximum != 1000 {
		t.Fatalf("content schema bounds = %d..%d", schemaVersion.Minimum, schemaVersion.Maximum)
	}
}
