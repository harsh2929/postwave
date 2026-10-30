package apidocs

import (
	"encoding/json"
	"slices"
	"testing"
)

func TestSavedSegmentPreviewContractIsAggregateOnly(t *testing.T) {
	var document struct {
		Components struct {
			Schemas map[string]json.RawMessage `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}
	if _, exposed := document.Components.Schemas["SampleProfile"]; exposed {
		t.Fatal("saved-segment member sample schema must not be published")
	}
	var preview struct {
		Properties map[string]json.RawMessage `json:"properties"`
		Required   []string                   `json:"required"`
	}
	if err := json.Unmarshal(document.Components.Schemas["SavedSegmentPreview"], &preview); err != nil {
		t.Fatalf("decode SavedSegmentPreview schema: %v", err)
	}
	for _, forbidden := range []string{"sample_profiles", "email", "subscriber_id"} {
		if _, exposed := preview.Properties[forbidden]; exposed {
			t.Fatalf("SavedSegmentPreview exposes %q", forbidden)
		}
	}
	for _, aggregate := range []string{"id", "count", "workspace_total", "workspace_percentage", "generated_at"} {
		if _, present := preview.Properties[aggregate]; !present {
			t.Fatalf("SavedSegmentPreview missing %q", aggregate)
		}
		if !slices.Contains(preview.Required, aggregate) {
			t.Fatalf("SavedSegmentPreview does not require %q", aggregate)
		}
	}
}
