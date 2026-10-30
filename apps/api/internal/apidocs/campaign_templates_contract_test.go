package apidocs

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

type campaignTemplateContractOperation struct {
	RequiredScopes []string                   `json:"x-required-scopes"`
	RequiredRole   string                     `json:"x-required-role"`
	Parameters     []map[string]any           `json:"parameters"`
	RequestBody    map[string]any             `json:"requestBody"`
	Responses      map[string]json.RawMessage `json:"responses"`
}

func TestCampaignTemplateOpenAPICoversEveryMountedRouteAndScope(t *testing.T) {
	var document struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}

	routes := []struct {
		method, path, scope, success string
	}{
		{method: "get", path: "/api/v1/campaign-templates", scope: "read:campaigns", success: "200"},
		{method: "get", path: "/api/v1/campaign-templates/search", scope: "read:campaigns", success: "200"},
		{method: "get", path: "/api/v1/campaign-templates/compare", scope: "read:campaigns", success: "200"},
		{method: "get", path: "/api/v1/campaign-templates/recent", scope: "read:campaigns", success: "200"},
		{method: "delete", path: "/api/v1/campaign-templates/recent", scope: "read:campaigns", success: "200"},
		{method: "delete", path: "/api/v1/campaign-templates/recent/{id}", scope: "read:campaigns", success: "200"},
		{method: "get", path: "/api/v1/campaign-template-collections", scope: "read:campaigns", success: "200"},
		{method: "post", path: "/api/v1/campaign-template-collections", scope: "read:campaigns", success: "201"},
		{method: "get", path: "/api/v1/campaign-template-collections/{id}", scope: "read:campaigns", success: "200"},
		{method: "patch", path: "/api/v1/campaign-template-collections/{id}", scope: "read:campaigns", success: "200"},
		{method: "delete", path: "/api/v1/campaign-template-collections/{id}", scope: "read:campaigns", success: "200"},
		{method: "put", path: "/api/v1/campaign-template-collections/{id}/items", scope: "read:campaigns", success: "200"},
		{method: "get", path: "/api/v1/campaign-template-saved-searches", scope: "read:campaigns", success: "200"},
		{method: "post", path: "/api/v1/campaign-template-saved-searches", scope: "read:campaigns", success: "201"},
		{method: "get", path: "/api/v1/campaign-template-saved-searches/{id}", scope: "read:campaigns", success: "200"},
		{method: "patch", path: "/api/v1/campaign-template-saved-searches/{id}", scope: "read:campaigns", success: "200"},
		{method: "delete", path: "/api/v1/campaign-template-saved-searches/{id}", scope: "read:campaigns", success: "200"},
		{method: "get", path: "/api/v1/campaign-template-saved-searches/{id}/results", scope: "read:campaigns", success: "200"},
		{method: "get", path: "/api/v1/campaign-templates/stats", scope: "read:campaigns", success: "200"},
		{method: "get", path: "/api/v1/campaign-templates/goals", scope: "read:campaigns", success: "200"},
		{method: "get", path: "/api/v1/campaign-templates/{id}", scope: "read:campaigns", success: "200"},
		{method: "get", path: "/api/v1/campaign-templates/{id}/revisions", scope: "read:campaigns", success: "200"},
		{method: "get", path: "/api/v1/campaign-templates/{id}/revisions/{version}", scope: "read:campaigns", success: "200"},
		{method: "get", path: "/api/v1/campaign-templates/{id}/regions", scope: "read:campaigns", success: "200"},
		{method: "post", path: "/api/v1/campaign-templates", scope: "write:campaigns", success: "201"},
		{method: "post", path: "/api/v1/campaign-templates/generate", scope: "write:campaigns", success: "410"},
		{method: "post", path: "/api/v1/campaign-templates/from-generated-design", scope: "write:campaigns", success: "410"},
		{method: "post", path: "/api/v1/campaign-templates/import", scope: "write:campaigns", success: "201"},
		{method: "patch", path: "/api/v1/campaign-templates/{id}", scope: "write:campaigns", success: "200"},
		{method: "patch", path: "/api/v1/campaign-templates/{id}/archive", scope: "write:campaigns", success: "200"},
		{method: "patch", path: "/api/v1/campaign-templates/{id}/restore", scope: "write:campaigns", success: "200"},
		{method: "delete", path: "/api/v1/campaign-templates/{id}", scope: "write:campaigns", success: "200"},
		{method: "post", path: "/api/v1/campaign-templates/{id}/review-decisions", scope: "admin", success: "201"},
		{method: "post", path: "/api/v1/campaign-templates/{id}/clone", scope: "write:campaigns", success: "201"},
		{method: "post", path: "/api/v1/campaign-templates/{id}/adapt", scope: "write:campaigns", success: "410"},
		{method: "post", path: "/api/v1/campaign-templates/{id}/create-campaign", scope: "write:campaigns", success: "201"},
		{method: "post", path: "/api/v1/campaign-templates/{id}/use", scope: "write:campaigns", success: "200"},
		{method: "post", path: "/api/v1/campaign-templates/{id}/favorite", scope: "read:campaigns", success: "200"},
		{method: "post", path: "/api/v1/campaign-templates/{id}/unfavorite", scope: "read:campaigns", success: "200"},
		{method: "post", path: "/api/v1/campaign-templates/{id}/view", scope: "read:campaigns", success: "200"},
		{method: "get", path: "/api/v1/campaign-template-designs", scope: "read:campaigns", success: "200"},
		{method: "get", path: "/api/v1/campaign-template-designs/{id}", scope: "read:campaigns", success: "200"},
		{method: "get", path: "/api/v1/campaign-template-designs/{id}/revisions", scope: "read:campaigns", success: "200"},
		{method: "post", path: "/api/v1/campaign-template-designs", scope: "write:campaigns", success: "202"},
		{method: "post", path: "/api/v1/campaign-template-designs/{id}/refine", scope: "write:campaigns", success: "202"},
		{method: "post", path: "/api/v1/campaign-template-designs/{id}/retry", scope: "write:campaigns", success: "202"},
		{method: "post", path: "/api/v1/campaign-template-designs/{id}/save", scope: "write:campaigns", success: "201"},
		{method: "post", path: "/api/v1/campaign-template-designs/{id}/create-campaign", scope: "write:campaigns", success: "201"},
		{method: "post", path: "/api/v1/campaign-template-designs/{id}/archive", scope: "write:campaigns", success: "200"},
		{method: "get", path: "/api/v1/analytics/template-leaderboard", scope: "read:reports", success: "200"},
	}
	for _, route := range routes {
		route := route
		t.Run(strings.ToUpper(route.method)+" "+route.path, func(t *testing.T) {
			t.Parallel()
			pathItem, ok := document.Paths[route.path]
			if !ok {
				t.Fatal("path missing")
			}
			raw, ok := pathItem[route.method]
			if !ok {
				t.Fatal("operation missing")
			}
			var operation campaignTemplateContractOperation
			if err := json.Unmarshal(raw, &operation); err != nil {
				t.Fatalf("decode operation: %v", err)
			}
			if !slices.Equal(operation.RequiredScopes, []string{route.scope}) {
				t.Fatalf("scopes = %v, want [%s]", operation.RequiredScopes, route.scope)
			}
			if _, ok := operation.Responses[route.success]; !ok {
				t.Fatalf("success response %s missing", route.success)
			}
			for _, status := range []string{"401", "403"} {
				if _, ok := operation.Responses[status]; !ok {
					t.Fatalf("authorization response %s missing", status)
				}
			}
		})
	}

	for path := range document.Paths {
		if strings.HasPrefix(path, "/api/v1/campaign-templates/") && strings.Contains(path, "thumbnail") {
			t.Fatalf("unsafe campaign-template thumbnail route is documented as reachable: %s", path)
		}
	}
	if _, ok := document.Paths["/api/v1/templates/{id}/thumbnail.png"]; ok {
		t.Fatal("unmounted legacy email-template thumbnail handler is documented as reachable")
	}
}

func TestCampaignTemplateDesignRecoveryIsBoundedAndCompact(t *testing.T) {
	var document struct {
		Components struct {
			Schemas map[string]map[string]any `json:"schemas"`
		} `json:"components"`
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}
	var operation struct {
		Parameters []struct {
			Name   string         `json:"name"`
			In     string         `json:"in"`
			Schema map[string]any `json:"schema"`
		} `json:"parameters"`
		Responses map[string]json.RawMessage `json:"responses"`
	}
	if err := json.Unmarshal(
		document.Paths["/api/v1/campaign-template-designs"]["get"],
		&operation,
	); err != nil {
		t.Fatalf("decode recovery operation: %v", err)
	}
	parameters := make(map[string]map[string]any, len(operation.Parameters))
	for _, parameter := range operation.Parameters {
		if parameter.In == "query" {
			parameters[parameter.Name] = parameter.Schema
		}
	}
	if parameters["limit"]["default"] != float64(20) ||
		parameters["limit"]["maximum"] != float64(50) ||
		parameters["limit"]["minimum"] != float64(1) {
		t.Fatalf("limit contract = %#v", parameters["limit"])
	}
	if parameters["cursor"]["maxLength"] != float64(1024) {
		t.Fatalf("cursor contract = %#v", parameters["cursor"])
	}
	for _, status := range []string{"200", "400", "401", "403", "503"} {
		if _, ok := operation.Responses[status]; !ok {
			t.Errorf("recovery response %s missing", status)
		}
	}

	page := document.Components.Schemas["CampaignTemplateDesignPage"]
	pageProperties := page["properties"].(map[string]any)
	items := pageProperties["items"].(map[string]any)
	if items["maxItems"] != float64(50) {
		t.Fatalf("recovery page items = %#v", items)
	}
	summary := document.Components.Schemas["CampaignTemplateDesignSummary"]
	summaryProperties := summary["properties"].(map[string]any)
	for _, unbounded := range []string{"request", "revision"} {
		if _, ok := summaryProperties[unbounded]; ok {
			t.Errorf("recovery summary exposes unbounded %s", unbounded)
		}
	}
	for _, required := range []string{
		"id",
		"status",
		"current_revision",
		"capabilities",
		"recommended_action",
		"expires_at",
		"updated_at",
	} {
		if _, ok := summaryProperties[required]; !ok {
			t.Errorf("recovery summary is missing %s", required)
		}
	}
}

func TestCampaignTemplateDesignContractDocumentsExactActorOwnership(t *testing.T) {
	spec := string(SpecJSON)
	if got := strings.Count(
		spec,
		"same-tenant foreign-actor ids return the same non-disclosing 404",
	); got != 7 {
		t.Fatalf(
			"actor-private design path descriptions=%d, want 7",
			got,
		)
	}
	if !strings.Contains(
		spec,
		"resulting draft are private to the exact authenticated actor",
	) {
		t.Fatal("design create does not document exact-actor ownership")
	}
}

func TestOpenAPIUsesCanonicalIdempotentReplayedHeader(t *testing.T) {
	var document struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}
	canonicalCount := 0
	for path, pathItem := range document.Paths {
		for method, raw := range pathItem {
			if !slices.Contains(
				[]string{"get", "post", "put", "patch", "delete"},
				method,
			) {
				continue
			}
			var operation struct {
				Responses map[string]struct {
					Headers map[string]json.RawMessage `json:"headers"`
				} `json:"responses"`
			}
			if err := json.Unmarshal(raw, &operation); err != nil {
				t.Fatalf("decode %s %s: %v", method, path, err)
			}
			for status, response := range operation.Responses {
				for header := range response.Headers {
					switch header {
					case "Idempotent-Replayed":
						canonicalCount++
					case "Idempotent-Replay", "X-Idempotent-Replay":
						t.Errorf(
							"%s %s response %s documents legacy replay header %s",
							method,
							path,
							status,
							header,
						)
					}
				}
			}
		}
	}
	if canonicalCount == 0 {
		t.Fatal("no canonical Idempotent-Replayed response headers documented")
	}
}

func TestCampaignTemplateDesignMutationsDocumentIdempotentReplay(t *testing.T) {
	var document struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}

	for _, route := range []struct {
		path, success string
	}{
		{path: "/api/v1/campaign-template-designs", success: "202"},
		{path: "/api/v1/campaign-template-designs/{id}/refine", success: "202"},
		{path: "/api/v1/campaign-template-designs/{id}/retry", success: "202"},
		{path: "/api/v1/campaign-template-designs/{id}/archive", success: "200"},
		{path: "/api/v1/campaign-template-designs/{id}/save", success: "201"},
		{path: "/api/v1/campaign-template-designs/{id}/create-campaign", success: "201"},
	} {
		var operation struct {
			Parameters []struct {
				In       string `json:"in"`
				Name     string `json:"name"`
				Required bool   `json:"required"`
			} `json:"parameters"`
			Responses map[string]struct {
				Headers map[string]json.RawMessage `json:"headers"`
			} `json:"responses"`
		}
		if err := json.Unmarshal(document.Paths[route.path]["post"], &operation); err != nil {
			t.Fatalf("decode POST %s: %v", route.path, err)
		}
		foundIdempotencyKey := false
		for _, parameter := range operation.Parameters {
			if parameter.In == "header" && parameter.Name == "Idempotency-Key" &&
				parameter.Required {
				foundIdempotencyKey = true
			}
		}
		if !foundIdempotencyKey {
			t.Errorf("POST %s does not require Idempotency-Key", route.path)
		}
		response, ok := operation.Responses[route.success]
		if !ok {
			t.Errorf("POST %s response %s missing", route.path, route.success)
			continue
		}
		if _, ok := response.Headers["Idempotent-Replayed"]; !ok {
			t.Errorf("POST %s response %s does not document Idempotent-Replayed", route.path, route.success)
		}
	}
}

func TestCampaignTemplateDiscoveryDocumentsIdentityIdempotencyAndConcurrency(t *testing.T) {
	var document struct {
		Components struct {
			Schemas map[string]map[string]any `json:"schemas"`
		} `json:"components"`
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}

	for _, schemaName := range []string{
		"CampaignTemplateCollection",
		"CampaignTemplateSavedSearch",
	} {
		schema := document.Components.Schemas[schemaName]
		properties, ok := schema["properties"].(map[string]any)
		if !ok {
			t.Fatalf("%s properties missing: %#v", schemaName, schema)
		}
		required, ok := schema["required"].([]any)
		if !ok {
			t.Fatalf("%s required missing: %#v", schemaName, schema)
		}
		for _, field := range []string{"version", "etag"} {
			if _, ok := properties[field]; !ok {
				t.Fatalf("%s missing %s", schemaName, field)
			}
			if !slices.Contains(required, any(field)) {
				t.Fatalf("%s does not require %s", schemaName, field)
			}
		}
	}
	savedSchema := document.Components.Schemas["CampaignTemplateSavedSearch"]
	savedProperties := savedSchema["properties"].(map[string]any)
	savedRequired := savedSchema["required"].([]any)
	if _, ok := savedProperties["obsolete_filters"]; !ok ||
		!slices.Contains(savedRequired, any("obsolete_filters")) {
		t.Fatal("saved-search schema does not require authoritative obsolete_filters")
	}
	compareSchema := document.Components.Schemas["CampaignTemplateCompareResponse"]
	compareProperties := compareSchema["properties"].(map[string]any)
	compareRequired := compareSchema["required"].([]any)
	if _, ok := compareProperties["unavailable_identifiers"]; !ok ||
		!slices.Contains(compareRequired, any("unavailable_identifiers")) {
		t.Fatal("compare schema does not require unavailable_identifiers")
	}

	for _, path := range []string{
		"/api/v1/campaign-template-collections",
		"/api/v1/campaign-template-saved-searches",
	} {
		var operation campaignTemplateContractOperation
		if err := json.Unmarshal(document.Paths[path]["post"], &operation); err != nil {
			t.Fatalf("decode POST %s: %v", path, err)
		}
		foundKey := false
		for _, parameter := range operation.Parameters {
			if parameter["in"] == "header" &&
				parameter["name"] == "Idempotency-Key" &&
				parameter["required"] == true {
				foundKey = true
			}
		}
		if !foundKey {
			t.Fatalf("POST %s does not require Idempotency-Key", path)
		}
		if _, ok := operation.Responses["422"]; !ok {
			t.Fatalf("POST %s does not document changed-payload key conflict", path)
		}
		var success struct {
			Headers map[string]json.RawMessage `json:"headers"`
		}
		if err := json.Unmarshal(operation.Responses["201"], &success); err != nil {
			t.Fatalf("decode POST %s success: %v", path, err)
		}
		if _, ok := success.Headers["ETag"]; !ok {
			t.Fatalf("POST %s success omits ETag", path)
		}
	}

	for _, route := range []struct {
		method, path, success string
		expectETag            bool
	}{
		{method: "patch", path: "/api/v1/campaign-template-collections/{id}", success: "200", expectETag: true},
		{method: "delete", path: "/api/v1/campaign-template-collections/{id}", success: "200"},
		{method: "put", path: "/api/v1/campaign-template-collections/{id}/items", success: "200", expectETag: true},
		{method: "patch", path: "/api/v1/campaign-template-saved-searches/{id}", success: "200", expectETag: true},
		{method: "delete", path: "/api/v1/campaign-template-saved-searches/{id}", success: "200"},
	} {
		var operation campaignTemplateContractOperation
		if err := json.Unmarshal(document.Paths[route.path][route.method], &operation); err != nil {
			t.Fatalf("decode %s %s: %v", route.method, route.path, err)
		}
		foundIfMatch := false
		for _, parameter := range operation.Parameters {
			if parameter["in"] == "header" &&
				parameter["name"] == "If-Match" &&
				parameter["required"] == true {
				foundIfMatch = true
			}
		}
		if !foundIfMatch {
			t.Fatalf("%s %s does not require If-Match", route.method, route.path)
		}
		for _, status := range []string{"412", "428"} {
			if _, ok := operation.Responses[status]; !ok {
				t.Fatalf("%s %s response %s missing", route.method, route.path, status)
			}
		}
		if route.expectETag {
			var success struct {
				Headers map[string]json.RawMessage `json:"headers"`
			}
			if err := json.Unmarshal(operation.Responses[route.success], &success); err != nil {
				t.Fatalf("decode %s %s success: %v", route.method, route.path, err)
			}
			if _, ok := success.Headers["ETag"]; !ok {
				t.Fatalf("%s %s success omits ETag", route.method, route.path)
			}
		}
	}

	var search campaignTemplateContractOperation
	if err := json.Unmarshal(
		document.Paths["/api/v1/campaign-templates/search"]["get"],
		&search,
	); err != nil {
		t.Fatalf("decode catalog search: %v", err)
	}
	foundFailClosedSource := false
	for _, parameter := range search.Parameters {
		if parameter["name"] == "source" {
			description, _ := parameter["description"].(string)
			foundFailClosedSource = strings.Contains(description, "no_user") &&
				strings.Contains(description, "never broaden")
		}
	}
	if !foundFailClosedSource {
		t.Fatal("catalog source filter does not document fail-closed mine/team identity")
	}
}

func TestCampaignTemplateDeleteDocumentsSafeArchivePreconditions(t *testing.T) {
	var document struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}
	var operation campaignTemplateContractOperation
	if err := json.Unmarshal(document.Paths["/api/v1/campaign-templates/{id}"]["delete"], &operation); err != nil {
		t.Fatalf("decode campaign-template delete operation: %v", err)
	}
	if _, ok := operation.Responses["409"]; ok {
		t.Fatal("safe archive alias still documents lineage as a deletion conflict")
	}
	for _, status := range []string{"200", "412", "422", "428"} {
		if _, ok := operation.Responses[status]; !ok {
			t.Fatalf("safe archive alias response %s missing", status)
		}
	}
	foundIfMatch := false
	for _, parameter := range operation.Parameters {
		if parameter["name"] == "If-Match" && parameter["required"] == true {
			foundIfMatch = true
		}
	}
	if !foundIfMatch {
		t.Fatal("safe archive alias does not require If-Match")
	}
}

func TestCampaignTemplateOpenAPIDocumentsCapabilitiesAndAuditedReview(t *testing.T) {
	var document struct {
		Components struct {
			Schemas map[string]map[string]any `json:"schemas"`
		} `json:"components"`
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}

	capabilities := document.Components.Schemas["CampaignTemplateCapabilities"]
	required, ok := capabilities["required"].([]any)
	if !ok {
		t.Fatalf("capability required fields missing: %#v", capabilities)
	}
	requiredSet := make(map[string]bool, len(required))
	for _, field := range required {
		requiredSet[field.(string)] = true
	}
	for _, field := range []string{
		"can_preview", "can_favorite", "can_adapt", "can_use_directly",
		"can_create_campaign", "can_edit_directly", "can_clone", "can_delete",
		"can_archive", "can_restore",
		"has_source_html", "has_source_mjml", "has_desktop_preview", "has_mobile_preview",
	} {
		if !requiredSet[field] {
			t.Fatalf("capability contract does not require %q", field)
		}
	}

	templateProperties, ok := document.Components.Schemas["CampaignTemplate"]["properties"].(map[string]any)
	if !ok {
		t.Fatal("campaign template properties missing")
	}
	for _, field := range []string{
		"version", "etag", "archived_at", "capabilities", "recommended_action", "warnings",
		"reference_review_decision_id", "reference_reviewed_at",
	} {
		if _, ok := templateProperties[field]; !ok {
			t.Fatalf("campaign template response missing %q", field)
		}
	}

	var review campaignTemplateContractOperation
	if err := json.Unmarshal(
		document.Paths["/api/v1/campaign-templates/{id}/review-decisions"]["post"],
		&review,
	); err != nil {
		t.Fatalf("decode reference review operation: %v", err)
	}
	if review.RequiredRole != "admin" ||
		!slices.Equal(review.RequiredScopes, []string{"admin"}) {
		t.Fatalf("reference review role/scopes=%q/%v, want admin/admin",
			review.RequiredRole, review.RequiredScopes)
	}
	input := document.Components.Schemas["CampaignTemplateReferenceReviewDecisionInput"]
	if input["additionalProperties"] != false {
		t.Fatalf("reference review input is not strict: %#v", input)
	}
	inputProperties, ok := input["properties"].(map[string]any)
	if !ok {
		t.Fatalf("reference review properties missing: %#v", input)
	}
	note, ok := inputProperties["note"].(map[string]any)
	if !ok || note["minLength"] != float64(1) || note["maxLength"] != float64(2000) {
		t.Fatalf("reference review note bounds missing: %#v", note)
	}
}

func TestCampaignTemplateOpenAPIKeepsFavoritesReadScopedAndEligibilityExplicit(t *testing.T) {
	var document struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}

	for _, path := range []string{
		"/api/v1/campaign-templates/{id}/favorite",
		"/api/v1/campaign-templates/{id}/unfavorite",
	} {
		var operation campaignTemplateContractOperation
		if err := json.Unmarshal(document.Paths[path]["post"], &operation); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
		if operation.RequiredRole != "viewer" || !slices.Equal(operation.RequiredScopes, []string{"read:campaigns"}) {
			t.Fatalf("%s role/scopes = %q/%v, want viewer/read:campaigns", path, operation.RequiredRole, operation.RequiredScopes)
		}
		if !strings.Contains(string(operation.Responses["401"]), `"no_user"`) {
			t.Fatalf("%s does not document the session-only no_user contract", path)
		}
	}

	for _, route := range []struct {
		method, path string
	}{
		{method: "post", path: "/api/v1/campaign-templates/{id}/clone"},
		{method: "post", path: "/api/v1/campaign-templates/{id}/create-campaign"},
	} {
		var operation campaignTemplateContractOperation
		if err := json.Unmarshal(document.Paths[route.path][route.method], &operation); err != nil {
			t.Fatalf("decode %s: %v", route.path, err)
		}
		if _, ok := operation.Responses["422"]; !ok {
			t.Fatalf("%s does not document fail-closed eligibility", route.path)
		}
	}
}

func TestCampaignTemplateOpenAPIProtectsGovernanceAndReviewedDesignBounds(t *testing.T) {
	var document struct {
		Components struct {
			Schemas map[string]map[string]any `json:"schemas"`
		} `json:"components"`
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}

	create := document.Components.Schemas["CampaignTemplateCreateInput"]
	properties, ok := create["properties"].(map[string]any)
	if !ok || create["additionalProperties"] != false {
		t.Fatalf("create schema is not strict: %#v", create)
	}
	for _, field := range []string{
		"template_kind", "source_provider", "source_license_status", "review_status",
		"quality_score", "content_hash", "imported_at",
	} {
		if _, ok := properties[field]; ok {
			t.Fatalf("normal create exposes server-controlled field %q", field)
		}
	}
	for field, bound := range map[string]float64{
		"reference_template_ids": 0,
		"generation_metadata":    0,
	} {
		property, ok := properties[field].(map[string]any)
		if !ok {
			t.Fatalf("legacy compatibility field %s missing", field)
		}
		key := "maxItems"
		if field == "generation_metadata" {
			key = "maxProperties"
		}
		if property[key] != bound {
			t.Fatalf("%s %s=%v, want 0", field, key, property[key])
		}
	}

	for _, schemaName := range []string{"CampaignTemplateCreateInput", "CampaignTemplateUpdateInput"} {
		schema := document.Components.Schemas[schemaName]
		content, ok := schema["properties"].(map[string]any)
		if !ok {
			t.Fatalf("%s properties missing: %#v", schemaName, schema)
		}
		for field, maximum := range map[string]float64{
			"name": 200, "subject": 998, "preview_text": 500,
			"body_html": 1048576, "body_mjml": 1048576,
		} {
			property, ok := content[field].(map[string]any)
			if !ok || property["maxLength"] != maximum {
				t.Fatalf("%s.%s bound = %#v, want maxLength=%v", schemaName, field, property, maximum)
			}
		}
		variables, ok := content["variables"].(map[string]any)
		if !ok || variables["maxItems"] != float64(100) || !strings.Contains(variables["description"].(string), "65,536") {
			t.Fatalf("%s variables bounds missing: %#v", schemaName, variables)
		}
		tags, ok := content["tags"].(map[string]any)
		if !ok || tags["maxItems"] != float64(50) || !strings.Contains(tags["description"].(string), "16,384") {
			t.Fatalf("%s tag collection bounds missing: %#v", schemaName, tags)
		}
		tag, ok := tags["items"].(map[string]any)
		if !ok || tag["maxLength"] != float64(120) || tag["pattern"] != `\S` {
			t.Fatalf("%s tag item bounds missing: %#v", schemaName, tag)
		}
	}
	authoringVariable := document.Components.Schemas["CampaignTemplateAuthoringVariableDefinition"]
	allOf, ok := authoringVariable["allOf"].([]any)
	if !ok || len(allOf) != 2 {
		t.Fatalf("authoring variable schema missing: %#v", authoringVariable)
	}
	variableBounds, ok := allOf[1].(map[string]any)
	if !ok || variableBounds["maxProperties"] != float64(32) {
		t.Fatalf("authoring variable field-count bound missing: %#v", variableBounds)
	}
	variableNames, ok := variableBounds["propertyNames"].(map[string]any)
	if !ok || variableNames["maxLength"] != float64(64) || variableNames["pattern"] != `\S` {
		t.Fatalf("authoring variable field-name bounds missing: %#v", variableNames)
	}

	for _, route := range []struct{ method, path string }{
		{method: "post", path: "/api/v1/campaign-templates"},
		{method: "patch", path: "/api/v1/campaign-templates/{id}"},
		{method: "post", path: "/api/v1/campaign-templates/{id}/clone"},
	} {
		var operation campaignTemplateContractOperation
		if err := json.Unmarshal(document.Paths[route.path][route.method], &operation); err != nil {
			t.Fatalf("decode %s %s: %v", route.method, route.path, err)
		}
		if !strings.Contains(string(operation.Responses["400"]), `"invalid_template_content"`) {
			t.Fatalf("%s %s does not document invalid_template_content", route.method, route.path)
		}
	}

	reviewed := document.Components.Schemas["CampaignTemplateReviewedDesignInput"]
	reviewedProperties, ok := reviewed["properties"].(map[string]any)
	if !ok || reviewed["additionalProperties"] != false {
		t.Fatalf("reviewed-design schema is not strict: %#v", reviewed)
	}
	for _, required := range []string{"slug", "name", "subject", "body_html"} {
		requiredFields, _ := reviewed["required"].([]any)
		if !slices.ContainsFunc(requiredFields, func(value any) bool { return value == required }) {
			t.Fatalf("reviewed-design required fields omit %q: %v", required, requiredFields)
		}
	}
	variables, ok := reviewedProperties["variables"].(map[string]any)
	if !ok || variables["maxProperties"] != float64(100) {
		t.Fatalf("reviewed-design variable bound missing: %#v", variables)
	}
	refs, ok := reviewedProperties["reference_template_ids"].(map[string]any)
	if !ok || refs["maxItems"] != float64(3) {
		t.Fatalf("reviewed-design reference bound missing: %#v", refs)
	}

	for _, path := range []string{
		"/api/v1/campaign-templates/generate",
		"/api/v1/campaign-templates/{id}/adapt",
		"/api/v1/campaign-templates/from-generated-design",
	} {
		var operation campaignTemplateContractOperation
		if err := json.Unmarshal(document.Paths[path]["post"], &operation); err != nil {
			t.Fatalf("decode retired operation %s: %v", path, err)
		}
		if _, ok := operation.Responses["410"]; !ok {
			t.Fatalf("retired endpoint %s does not document 410", path)
		}
		if len(operation.RequestBody) != 0 {
			t.Fatalf("retired endpoint %s still advertises an accepted request body", path)
		}
	}
}

func TestTemplateLeaderboardOpenAPIBoundsWindowAndResponse(t *testing.T) {
	var document struct {
		Components struct {
			Schemas map[string]map[string]any `json:"schemas"`
		} `json:"components"`
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}
	var operation campaignTemplateContractOperation
	if err := json.Unmarshal(document.Paths["/api/v1/analytics/template-leaderboard"]["get"], &operation); err != nil {
		t.Fatalf("decode leaderboard operation: %v", err)
	}
	if len(operation.Parameters) != 1 || operation.Parameters[0]["name"] != "days" {
		t.Fatalf("leaderboard parameters = %#v", operation.Parameters)
	}
	schema, ok := operation.Parameters[0]["schema"].(map[string]any)
	if !ok || schema["minimum"] != float64(1) || schema["maximum"] != float64(365) || schema["default"] != float64(90) {
		t.Fatalf("leaderboard days schema = %#v", schema)
	}
	if _, ok := operation.Responses["400"]; !ok {
		t.Fatal("leaderboard does not document bad_days")
	}

	responseProperties, ok := document.Components.Schemas["TemplateLeaderboardResponse"]["properties"].(map[string]any)
	if !ok {
		t.Fatalf("leaderboard response properties missing: %#v", document.Components.Schemas["TemplateLeaderboardResponse"])
	}
	items, ok := responseProperties["items"].(map[string]any)
	if !ok || items["maxItems"] != float64(50) {
		t.Fatalf("leaderboard response item bound = %#v, want maxItems=50", items)
	}
	itemProperties, ok := document.Components.Schemas["TemplateLeaderboardItem"]["properties"].(map[string]any)
	if !ok {
		t.Fatalf("leaderboard item properties missing: %#v", document.Components.Schemas["TemplateLeaderboardItem"])
	}
	for _, field := range []string{"open_rate", "click_rate"} {
		rate, ok := itemProperties[field].(map[string]any)
		if !ok || rate["minimum"] != float64(0) || rate["maximum"] != float64(1) {
			t.Fatalf("leaderboard %s bounds = %#v, want [0,1]", field, rate)
		}
	}
}
