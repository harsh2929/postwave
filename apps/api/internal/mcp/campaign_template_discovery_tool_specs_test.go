// SPDX-License-Identifier: AGPL-3.0-only

package mcp

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
)

func discoveryToolByName(t *testing.T, name string) tool {
	t.Helper()
	for _, candidate := range campaignTemplateDiscoveryTools() {
		if candidate.Name == name {
			return candidate
		}
	}
	t.Fatalf("discovery tool %q not registered", name)
	return tool{}
}

func discoveryToolSchema(t *testing.T, name string) map[string]any {
	t.Helper()
	candidate := discoveryToolByName(t, name)
	var schema map[string]any
	if err := json.Unmarshal(candidate.InputSchema, &schema); err != nil {
		t.Fatalf("%s schema: %v", name, err)
	}
	return schema
}

func schemaProperty(t *testing.T, schema map[string]any, name string) map[string]any {
	t.Helper()
	properties, ok := schema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("schema properties = %#v", schema["properties"])
	}
	property, ok := properties[name].(map[string]any)
	if !ok {
		t.Fatalf("schema property %q = %#v", name, properties[name])
	}
	return property
}

func schemaRequires(t *testing.T, schema map[string]any, names ...string) {
	t.Helper()
	required, ok := schema["required"].([]any)
	if !ok {
		t.Fatalf("schema required = %#v", schema["required"])
	}
	seen := make(map[string]bool, len(required))
	for _, value := range required {
		name, ok := value.(string)
		if !ok {
			t.Fatalf("schema required entry = %#v", value)
		}
		seen[name] = true
	}
	for _, name := range names {
		if !seen[name] {
			t.Fatalf("schema does not require %q: %#v", name, required)
		}
	}
}

func TestCampaignTemplateDiscoveryToolSchemasAndSafety(t *testing.T) {
	t.Parallel()

	tools := campaignTemplateDiscoveryTools()
	if len(tools) != 18 {
		t.Fatalf("discovery tools = %d, want 18", len(tools))
	}
	seen := make(map[string]struct{}, len(tools))
	for _, candidate := range tools {
		if _, duplicate := seen[candidate.Name]; duplicate {
			t.Fatalf("duplicate discovery tool %q", candidate.Name)
		}
		seen[candidate.Name] = struct{}{}
		wantScope := apikeys.ScopeReadCampaigns
		if candidate.WriteTier {
			wantScope = apikeys.ScopeWriteCampaigns
		}
		if len(candidate.RequiredScopes) != 1 || candidate.RequiredScopes[0] != wantScope {
			t.Fatalf("%s scopes = %#v", candidate.Name, candidate.RequiredScopes)
		}
	}

	compare := discoveryToolSchema(t, "compareCampaignTemplates")
	compareIDs := schemaProperty(t, compare, "templates")
	if compareIDs["minItems"] != float64(2) ||
		compareIDs["maxItems"] != float64(4) ||
		compareIDs["uniqueItems"] != true {
		t.Fatalf("compare template bounds = %#v", compareIDs)
	}
	if !strings.Contains(
		discoveryToolByName(t, "compareCampaignTemplates").Description,
		"unavailable_identifiers",
	) {
		t.Fatal("compare tool does not describe partial availability")
	}
	for _, name := range []string{
		"favoriteCampaignTemplate",
		"unfavoriteCampaignTemplate",
	} {
		schema := discoveryToolSchema(t, name)
		properties := schema["properties"].(map[string]any)
		if schema["additionalProperties"] != false || len(properties) != 1 {
			t.Fatalf("%s accepts impersonable or unknown fields: %#v", name, schema)
		}
		if _, ok := properties["template_id"]; !ok {
			t.Fatalf("%s template_id schema missing: %#v", name, schema)
		}
	}

	createCollection := discoveryToolSchema(t, "createCampaignTemplateCollection")
	schemaRequires(t, createCollection, "idempotency_key", "name")
	collectionKey := schemaProperty(t, createCollection, "idempotency_key")
	if collectionKey["maxLength"] != float64(255) ||
		collectionKey["pattern"] != designIdempotencyKeyPattern {
		t.Fatalf("collection idempotency key schema = %#v", collectionKey)
	}
	collectionIDs := schemaProperty(t, createCollection, "template_ids")
	if collectionIDs["maxItems"] != float64(100) ||
		collectionIDs["uniqueItems"] != true {
		t.Fatalf("collection membership bounds = %#v", collectionIDs)
	}
	if !discoveryToolByName(t, "createCampaignTemplateCollection").Annotations.Idempotent {
		t.Fatal("createCampaignTemplateCollection should advertise durable replay safety")
	}

	for _, name := range []string{
		"updateCampaignTemplateCollection",
		"replaceCampaignTemplateCollectionItems",
		"deleteCampaignTemplateCollection",
	} {
		schema := discoveryToolSchema(t, name)
		schemaRequires(t, schema, "collection_id", "if_match")
		if_match := schemaProperty(t, schema, "if_match")
		if if_match["pattern"] != `^"campaign-template-collection:[^"\\\s,]+:v[1-9][0-9]*"$` {
			t.Fatalf("%s if_match schema = %#v", name, if_match)
		}
		if discoveryToolByName(t, name).Annotations.Idempotent {
			t.Fatalf("%s must not advertise unconditional retry safety", name)
		}
	}

	runSaved := discoveryToolSchema(t, "runCampaignTemplateSavedSearch")
	cursor := schemaProperty(t, runSaved, "cursor")
	if cursor["maxLength"] != float64(2048) ||
		cursor["pattern"] != "^[A-Za-z0-9_-]+$" {
		t.Fatalf("saved-search cursor schema = %#v", cursor)
	}
	savedFilters := schemaProperty(
		t,
		discoveryToolSchema(t, "createCampaignTemplateSavedSearch"),
		"filters",
	)
	createSaved := discoveryToolSchema(t, "createCampaignTemplateSavedSearch")
	schemaRequires(t, createSaved, "idempotency_key", "name", "filters")
	savedKey := schemaProperty(t, createSaved, "idempotency_key")
	if savedKey["maxLength"] != float64(255) ||
		savedKey["pattern"] != designIdempotencyKeyPattern {
		t.Fatalf("saved-search idempotency key schema = %#v", savedKey)
	}
	if !discoveryToolByName(t, "createCampaignTemplateSavedSearch").Annotations.Idempotent {
		t.Fatal("createCampaignTemplateSavedSearch should advertise durable replay safety")
	}
	for _, name := range []string{
		"updateCampaignTemplateSavedSearch",
		"deleteCampaignTemplateSavedSearch",
	} {
		schema := discoveryToolSchema(t, name)
		schemaRequires(t, schema, "saved_search_id", "if_match")
		if_match := schemaProperty(t, schema, "if_match")
		if if_match["pattern"] != `^"campaign-template-saved-search:[^"\\\s,]+:v[1-9][0-9]*"$` {
			t.Fatalf("%s if_match schema = %#v", name, if_match)
		}
		if discoveryToolByName(t, name).Annotations.Idempotent {
			t.Fatalf("%s must not advertise unconditional retry safety", name)
		}
	}
	filterProperties, ok := savedFilters["properties"].(map[string]any)
	if !ok {
		t.Fatalf("saved filter properties = %#v", savedFilters["properties"])
	}
	for _, forbidden := range []string{"cursor", "page", "per_page"} {
		if _, exists := filterProperties[forbidden]; exists {
			t.Fatalf("saved filter persists %q", forbidden)
		}
	}
	for _, name := range []string{
		"listCampaignTemplateSavedSearches",
		"getCampaignTemplateSavedSearch",
		"updateCampaignTemplateSavedSearch",
	} {
		if !strings.Contains(
			discoveryToolByName(t, name).Description,
			"obsolete_filters",
		) {
			t.Fatalf("%s does not describe authoritative drift cleanup", name)
		}
	}

	for _, name := range []string{
		"compareCampaignTemplates",
		"listRecentCampaignTemplates",
		"listCampaignTemplateCollections",
		"getCampaignTemplateCollection",
		"listCampaignTemplateSavedSearches",
		"getCampaignTemplateSavedSearch",
		"runCampaignTemplateSavedSearch",
	} {
		candidate := discoveryToolByName(t, name)
		if !candidate.Annotations.ReadOnly || candidate.WriteTier {
			t.Fatalf("%s should be read-only: %#v", name, candidate)
		}
	}
	for _, name := range []string{
		"unfavoriteCampaignTemplate",
		"clearRecentCampaignTemplates",
	} {
		candidate := discoveryToolByName(t, name)
		if !candidate.WriteTier ||
			!candidate.Annotations.Destructive ||
			!candidate.Annotations.Idempotent {
			t.Fatalf("%s deletion annotations = %#v", name, candidate)
		}
	}
	for _, name := range []string{
		"deleteCampaignTemplateCollection",
		"deleteCampaignTemplateSavedSearch",
	} {
		candidate := discoveryToolByName(t, name)
		if !candidate.WriteTier ||
			!candidate.Annotations.Destructive ||
			candidate.Annotations.Idempotent {
			t.Fatalf("%s conditional deletion annotations = %#v", name, candidate)
		}
	}
	favorite := discoveryToolByName(t, "favoriteCampaignTemplate")
	if !favorite.WriteTier || favorite.Annotations.Destructive ||
		!favorite.Annotations.Idempotent {
		t.Fatalf("favorite annotations = %#v", favorite)
	}
	for _, candidate := range campaignTemplateDiscoveryTools() {
		if !candidate.WriteTier {
			continue
		}
		if len(candidate.RequiredScopes) != 1 || candidate.RequiredScopes[0] != apikeys.ScopeWriteCampaigns {
			t.Fatalf("write-tier tool %s scopes=%v, want exact write:campaigns", candidate.Name, candidate.RequiredScopes)
		}
	}
}
