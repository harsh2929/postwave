// SPDX-License-Identifier: AGPL-3.0-only

package apidocs

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func TestVerificationControlPlaneOpenAPIIsTypedAndAuthorized(t *testing.T) {
	var document struct {
		Paths      map[string]map[string]json.RawMessage `json:"paths"`
		Components struct {
			Schemas map[string]map[string]any `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}

	tests := []struct {
		method, path, role, scope, success, responseRef, requestRef string
	}{
		{method: "get", path: "/api/v1/verification/jobs", role: "viewer", scope: "read:subscribers", success: "200", responseRef: "#/components/schemas/VerificationJobListResponse"},
		{method: "get", path: "/api/v1/verification/jobs/{id}", role: "viewer", scope: "read:subscribers", success: "200", responseRef: "#/components/schemas/VerificationJobDetailResponse"},
		{method: "post", path: "/api/v1/verification/jobs/{id}/cancel", role: "editor", scope: "write:subscribers", success: "204"},
		{method: "get", path: "/api/v1/verification/providers", role: "admin", scope: "admin", success: "200", responseRef: "#/components/schemas/VerificationProviderListResponse"},
		{method: "put", path: "/api/v1/verification/providers/{provider}", role: "admin", scope: "admin", success: "200", responseRef: "#/components/schemas/VerificationProviderConfig", requestRef: "#/components/schemas/VerificationProviderUpsertRequest"},
		{method: "delete", path: "/api/v1/verification/providers/{provider}", role: "admin", scope: "admin", success: "204"},
		{method: "get", path: "/api/v1/verification/policy", role: "admin", scope: "admin", success: "200", responseRef: "#/components/schemas/VerificationPolicyResponse"},
		{method: "put", path: "/api/v1/verification/policy", role: "admin", scope: "admin", success: "200", responseRef: "#/components/schemas/VerificationPolicyUpdateResponse", requestRef: "#/components/schemas/VerificationPolicy"},
		{method: "get", path: "/api/v1/verification/credits", role: "viewer", scope: "read:subscribers", success: "200", responseRef: "#/components/schemas/VerificationCreditsResponse"},
		{method: "get", path: "/api/v1/verification/cache", role: "viewer", scope: "read:subscribers", success: "200", responseRef: "#/components/schemas/VerificationCacheSummary"},
		{method: "delete", path: "/api/v1/verification/cache", role: "editor", scope: "write:subscribers", success: "200", responseRef: "#/components/schemas/VerificationCacheInvalidateResponse", requestRef: "#/components/schemas/VerificationCacheInvalidateRequest"},
	}

	for _, test := range tests {
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			raw := document.Paths[test.path][test.method]
			if len(raw) == 0 {
				t.Fatal("operation missing")
			}
			var operation struct {
				RequiredScopes []string                   `json:"x-required-scopes"`
				RequiredRole   string                     `json:"x-required-role"`
				Security       []map[string][]string      `json:"security"`
				Description    string                     `json:"description"`
				RequestBody    map[string]any             `json:"requestBody"`
				Responses      map[string]json.RawMessage `json:"responses"`
			}
			if err := json.Unmarshal(raw, &operation); err != nil {
				t.Fatalf("decode operation: %v", err)
			}
			if !slices.Equal(operation.RequiredScopes, []string{test.scope}) || operation.RequiredRole != test.role {
				t.Fatalf("scope/role = %v/%q, want %s/%s", operation.RequiredScopes, operation.RequiredRole, test.scope, test.role)
			}
			wantSecurity := []map[string][]string{{"bearerAuth": {}}, {"sessionCookie": {}}}
			if !slices.EqualFunc(operation.Security, wantSecurity, func(a, b map[string][]string) bool {
				return len(a) == 1 && len(b) == 1 && mapKey(a) == mapKey(b)
			}) {
				t.Fatalf("security = %#v, want bearer + session", operation.Security)
			}
			for _, status := range []string{"401", "403"} {
				if _, ok := operation.Responses[status]; !ok {
					t.Errorf("response %s missing", status)
				}
			}
			if strings.Contains(operation.Description, "Endpoint-specific JSON payload") {
				t.Fatal("operation retained an untyped generated-stub description")
			}
			if _, ok := operation.Responses[test.success]; !ok {
				t.Fatalf("success response %s missing", test.success)
			}
			if test.responseRef != "" {
				if got := openAPISuccessRef(t, operation.Responses[test.success]); got != test.responseRef {
					t.Fatalf("success schema = %q, want %q", got, test.responseRef)
				}
			}
			if test.requestRef != "" {
				content := operation.RequestBody["content"].(map[string]any)
				media := content["application/json"].(map[string]any)
				if got := media["schema"].(map[string]any)["$ref"]; got != test.requestRef {
					t.Fatalf("request schema = %v, want %s", got, test.requestRef)
				}
			}
		})
	}

	for _, name := range []string{
		"VerificationJobListResponse", "VerificationJobDetailResponse",
		"VerificationProviderListResponse", "VerificationProviderConfig",
		"VerificationProviderUpsertRequest", "VerificationPolicy",
		"VerificationPolicyResponse", "VerificationPolicyUpdateResponse",
		"VerificationCreditsResponse", "VerificationCacheSummary",
		"VerificationCacheInvalidateRequest", "VerificationCacheInvalidateResponse",
	} {
		schema, ok := document.Components.Schemas[name]
		if !ok {
			t.Errorf("schema %s missing", name)
			continue
		}
		if schema["type"] != "object" || schema["additionalProperties"] != false {
			t.Errorf("schema %s is not a closed object: %#v", name, schema)
		}
	}
	assertStringEnum(t, document.Components.Schemas["VerificationExternalProvider"], []any{"zerobounce", "kickbox"})
	assertStringEnum(t, document.Components.Schemas["VerificationMode"], []any{"off", "local", "full"})
	assertStringEnum(t, document.Components.Schemas["VerificationRejectableStatus"],
		[]any{"invalid", "spamtrap", "abuse", "do_not_mail", "catch_all", "unknown"})
	policyProperties := document.Components.Schemas["VerificationPolicy"]["properties"].(map[string]any)
	rejectStatuses := policyProperties["forms_reject_statuses"].(map[string]any)
	items := rejectStatuses["items"].(map[string]any)
	if got := items["$ref"]; got != "#/components/schemas/VerificationRejectableStatus" {
		t.Fatalf("forms_reject_statuses item schema = %v, want rejectable-status vocabulary", got)
	}
	cacheProperties := document.Components.Schemas["VerificationCacheInvalidateRequest"]["properties"].(map[string]any)
	cacheEmails := cacheProperties["emails"].(map[string]any)
	if cacheEmails["minItems"] != float64(1) || cacheEmails["maxItems"] != float64(1000) {
		t.Fatalf("cache invalidation bounds = %#v", cacheEmails)
	}
	cacheEmail := cacheEmails["items"].(map[string]any)
	if cacheEmail["minLength"] != float64(1) || cacheEmail["maxLength"] != float64(320) ||
		cacheEmail["x-postwave-max-utf8-bytes"] != float64(320) || cacheEmail["pattern"] == "" {
		t.Fatalf("cache invalidation item contract = %#v", cacheEmail)
	}
}

func openAPISuccessRef(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var response struct {
		Content map[string]struct {
			Schema map[string]any `json:"schema"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("decode success response: %v", err)
	}
	ref, _ := response.Content["application/json"].Schema["$ref"].(string)
	return ref
}

func mapKey(value map[string][]string) string {
	for key := range value {
		return key
	}
	return ""
}
