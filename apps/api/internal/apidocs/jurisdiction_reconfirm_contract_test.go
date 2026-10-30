package apidocs

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func TestJurisdictionReconfirmContractPinsReviewedVersionAndFreshResponse(t *testing.T) {
	var document struct {
		Paths map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}
	var path struct {
		Patch struct {
			RequestBody struct {
				Content map[string]struct {
					Schema struct {
						Required   []string `json:"required"`
						Properties map[string]struct {
							Pattern string `json:"pattern"`
						} `json:"properties"`
					} `json:"schema"`
				} `json:"content"`
			} `json:"requestBody"`
			Responses map[string]struct {
				Headers map[string]struct {
					Schema struct {
						Pattern string `json:"pattern"`
					} `json:"schema"`
				} `json:"headers"`
				Content map[string]struct {
					Schema struct {
						AllOf []json.RawMessage `json:"allOf"`
					} `json:"schema"`
				} `json:"content"`
			} `json:"responses"`
		} `json:"patch"`
	}
	const route = "/api/v1/subscribers/{id}/jurisdiction-reconfirm"
	if err := json.Unmarshal(document.Paths[route], &path); err != nil {
		t.Fatalf("decode %s contract: %v", route, err)
	}
	request := path.Patch.RequestBody.Content["application/json"].Schema
	if !slices.Contains(request.Required, "expected_subscriber_version") {
		t.Fatal("jurisdiction reconfirmation must require expected_subscriber_version")
	}
	pattern := request.Properties["expected_subscriber_version"].Pattern
	for _, requiredFragment := range []string{"subscriber:", ":v", `^"`, `"$`} {
		if !strings.Contains(pattern, requiredFragment) {
			t.Fatalf("subscriber version pattern %q does not pin %q", pattern, requiredFragment)
		}
	}
	success := path.Patch.Responses["200"]
	if success.Headers["ETag"].Schema.Pattern != pattern {
		t.Fatalf("ETag pattern %q does not match request version pattern %q", success.Headers["ETag"].Schema.Pattern, pattern)
	}
	allOf := success.Content["application/json"].Schema.AllOf
	if len(allOf) != 2 {
		t.Fatalf("jurisdiction success must combine Subscriber with exact result constraints; got %d schemas", len(allOf))
	}
	var constraints struct {
		Required   []string `json:"required"`
		Properties map[string]struct {
			Pattern string `json:"pattern"`
			Enum    []bool `json:"enum"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(allOf[1], &constraints); err != nil {
		t.Fatalf("decode jurisdiction success constraints: %v", err)
	}
	for _, field := range []string{"id", "version", "jurisdiction_reconfirm_required"} {
		if !slices.Contains(constraints.Required, field) {
			t.Fatalf("jurisdiction success does not require %q", field)
		}
	}
	if constraints.Properties["version"].Pattern != pattern {
		t.Fatal("jurisdiction response body version pattern must match the reviewed version pattern")
	}
	if got := constraints.Properties["jurisdiction_reconfirm_required"].Enum; len(got) != 1 || got[0] {
		t.Fatalf("jurisdiction response must pin jurisdiction_reconfirm_required=false, got %v", got)
	}
}
