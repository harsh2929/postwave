package apidocs

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func TestSubscriberGrowthContractDeclaresPartialAndUnavailableMetrics(t *testing.T) {
	var document struct {
		Components struct {
			Schemas map[string]json.RawMessage `json:"schemas"`
		} `json:"components"`
		Paths map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}
	var response struct {
		Required   []string `json:"required"`
		Properties map[string]struct {
			Description string          `json:"description"`
			Items       json.RawMessage `json:"items"`
			Const       string          `json:"const"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(document.Components.Schemas["SubscriberGrowthResponse"], &response); err != nil {
		t.Fatalf("decode SubscriberGrowthResponse: %v", err)
	}
	for _, field := range []string{"days", "series", "metric_contract_version", "unavailable_metrics", "partial_metrics", "total_added", "total_unsubbed", "delta", "delta_pct", "note"} {
		if !slices.Contains(response.Required, field) {
			t.Fatalf("SubscriberGrowthResponse does not require %q", field)
		}
	}
	if !strings.Contains(strings.ToLower(response.Properties["total_unsubbed"].Description), "not the tenant's exhaustive") {
		t.Fatal("total_unsubbed must be documented as a non-exhaustive verified lower bound")
	}
	if got := response.Properties["metric_contract_version"].Const; got != "verified-exact-ledger-v2" {
		t.Fatalf("growth metric contract const = %q", got)
	}
	var point struct {
		Properties map[string]struct {
			Description string `json:"description"`
			Enum        []int  `json:"enum"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(document.Components.Schemas["SubscriberGrowthPoint"], &point); err != nil {
		t.Fatalf("decode SubscriberGrowthPoint: %v", err)
	}
	if got := point.Properties["lapsed"].Enum; len(got) != 1 || got[0] != 0 {
		t.Fatalf("lapsed must remain an explicit zero placeholder, got %v", got)
	}
	if !strings.Contains(strings.ToLower(point.Properties["unsubbed"].Description), "verified lower bound") {
		t.Fatal("unsubbed must be documented as a verified lower bound")
	}
	if !strings.Contains(strings.ToLower(point.Properties["unsubbed"].Description), "later profile archival") {
		t.Fatal("unsubbed must disclose immutable-transition behavior after profile archival")
	}

	var route struct {
		Get struct {
			Description string                     `json:"description"`
			Responses   map[string]json.RawMessage `json:"responses"`
		} `json:"get"`
	}
	if err := json.Unmarshal(document.Paths["/api/v1/subscribers/growth"], &route); err != nil {
		t.Fatalf("decode growth route: %v", err)
	}
	for _, status := range []string{"200", "400", "401", "403", "503"} {
		if _, ok := route.Get.Responses[status]; !ok {
			t.Fatalf("subscriber growth route does not document %s", status)
		}
	}
	if !strings.Contains(route.Get.Description, "subscriber_growth_verified_history") ||
		!strings.Contains(route.Get.Description, "never returned or backfilled") {
		t.Fatal("growth route must disclose the physically isolated, non-backfilled v2 ledger")
	}
}
