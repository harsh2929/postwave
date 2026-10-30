package apidocs

import (
	"encoding/json"
	"slices"
	"testing"
)

func TestMigrationDiscoveryContractReturnsAuthoritativeJobID(t *testing.T) {
	var document struct {
		Components struct {
			Schemas map[string]json.RawMessage `json:"schemas"`
		} `json:"components"`
		Paths map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}

	var report struct {
		Required   []string `json:"required"`
		Properties map[string]struct {
			Type      string `json:"type"`
			MinLength int    `json:"minLength"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(document.Components.Schemas["DiscoveryReport"], &report); err != nil {
		t.Fatalf("decode DiscoveryReport: %v", err)
	}
	if !slices.Contains(report.Required, "job_id") {
		t.Fatal("DiscoveryReport must require the authoritative job_id")
	}
	jobID := report.Properties["job_id"]
	if jobID.Type != "string" || jobID.MinLength != 1 {
		t.Fatalf("DiscoveryReport.job_id must be a non-empty string: %#v", jobID)
	}

	var route struct {
		Post struct {
			Responses map[string]struct {
				Content map[string]struct {
					Schema struct {
						Ref string `json:"$ref"`
					} `json:"schema"`
				} `json:"content"`
			} `json:"responses"`
		} `json:"post"`
	}
	const path = "/api/v1/migrations/{source}/discover"
	if err := json.Unmarshal(document.Paths[path], &route); err != nil {
		t.Fatalf("decode %s contract: %v", path, err)
	}
	if got := route.Post.Responses["200"].Content["application/json"].Schema.Ref; got != "#/components/schemas/DiscoveryReport" {
		t.Fatalf("discovery 200 schema = %q, want DiscoveryReport", got)
	}
}
