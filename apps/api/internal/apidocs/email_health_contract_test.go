// SPDX-License-Identifier: AGPL-3.0-only

package apidocs

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

type emailHealthOperation struct {
	RequiredScopes []string                   `json:"x-required-scopes"`
	RequiredRole   string                     `json:"x-required-role"`
	Parameters     []map[string]any           `json:"parameters"`
	RequestBody    map[string]any             `json:"requestBody"`
	Responses      map[string]json.RawMessage `json:"responses"`
}

func TestEmailHealthOpenAPIContractMatchesResolverSurface(t *testing.T) {
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
		method, path, responseRef string
	}{
		{method: "get", path: "/api/v1/verification/health", responseRef: "#/components/schemas/EmailHealthResult"},
		{method: "post", path: "/api/v1/verification/health/batch", responseRef: "#/components/schemas/EmailHealthBatchResponse"},
	}
	for _, test := range tests {
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			raw := document.Paths[test.path][test.method]
			if len(raw) == 0 {
				t.Fatalf("operation missing")
			}
			var operation emailHealthOperation
			if err := json.Unmarshal(raw, &operation); err != nil {
				t.Fatalf("decode operation: %v", err)
			}
			if !slices.Equal(operation.RequiredScopes, []string{"read:subscribers"}) || operation.RequiredRole != "viewer" {
				t.Fatalf("scope/role = %v/%q, want read:subscribers/viewer", operation.RequiredScopes, operation.RequiredRole)
			}
			for _, status := range []string{"200", "400", "401", "403", "500"} {
				if _, ok := operation.Responses[status]; !ok {
					t.Errorf("response %s missing", status)
				}
			}
			var success struct {
				Content map[string]struct {
					Schema map[string]any `json:"schema"`
				} `json:"content"`
			}
			if err := json.Unmarshal(operation.Responses["200"], &success); err != nil {
				t.Fatalf("decode success: %v", err)
			}
			if got := success.Content["application/json"].Schema["$ref"]; got != test.responseRef {
				t.Fatalf("success schema = %v, want %s", got, test.responseRef)
			}
		})
	}

	getRaw := document.Paths["/api/v1/verification/health"]["get"]
	var get emailHealthOperation
	if err := json.Unmarshal(getRaw, &get); err != nil {
		t.Fatalf("decode GET: %v", err)
	}
	if len(get.Parameters) != 1 || get.Parameters[0]["name"] != "email" || get.Parameters[0]["required"] != true {
		t.Fatalf("GET email parameter = %#v", get.Parameters)
	}
	parameterSchema := get.Parameters[0]["schema"].(map[string]any)
	if parameterSchema["minLength"] != float64(3) || parameterSchema["maxLength"] != float64(320) {
		t.Fatalf("GET email bounds = %#v", parameterSchema)
	}

	postRaw := document.Paths["/api/v1/verification/health/batch"]["post"]
	var post emailHealthOperation
	if err := json.Unmarshal(postRaw, &post); err != nil {
		t.Fatalf("decode POST: %v", err)
	}
	content := post.RequestBody["content"].(map[string]any)
	media := content["application/json"].(map[string]any)
	if schema := media["schema"].(map[string]any); schema["$ref"] != "#/components/schemas/EmailHealthBatchRequest" {
		t.Fatalf("batch request schema = %#v", schema)
	}
	for _, status := range []string{"413", "415"} {
		if _, ok := post.Responses[status]; !ok {
			t.Errorf("batch transport response %s missing", status)
		}
	}

	assertStringEnum(t, document.Components.Schemas["EmailHealthGrade"], []any{"A", "B", "C", "D", "F", "U"})
	assertStringEnum(t, document.Components.Schemas["EmailHealthRecommendation"], []any{"send", "caution", "do_not_send", "blocked"})
	assertStringEnum(t, document.Components.Schemas["EmailHealthVerificationStatus"],
		[]any{"valid", "invalid", "catch_all", "spamtrap", "abuse", "do_not_mail", "unknown"})

	result := document.Components.Schemas["EmailHealthResult"]
	required := result["required"].([]any)
	for _, field := range []string{
		"email", "grade", "recommendation", "hard_stop", "send_eligible",
		"reason_codes", "evidence", "model_version", "computed_at", "evidence_complete",
	} {
		if !slices.Contains(required, any(field)) {
			t.Errorf("EmailHealthResult required field %q missing: %v", field, required)
		}
	}
	properties := result["properties"].(map[string]any)
	model := properties["model_version"].(map[string]any)
	if model["const"] != "postwave-email-health-v1" {
		t.Fatalf("model version = %#v", model)
	}
	if score := properties["score"].(map[string]any); score["minimum"] != float64(0) || score["maximum"] != float64(10) {
		t.Fatalf("score bounds = %#v", score)
	}
	if complete := properties["evidence_complete"].(map[string]any); complete["type"] != "boolean" {
		t.Fatalf("evidence_complete = %#v", complete)
	}

	batch := document.Components.Schemas["EmailHealthBatchRequest"]
	emails := batch["properties"].(map[string]any)["emails"].(map[string]any)
	if emails["minItems"] != float64(1) || emails["maxItems"] != float64(1000) {
		t.Fatalf("batch bounds = %#v", emails)
	}
	summaryRequired := document.Components.Schemas["EmailHealthGradeSummary"]["required"].([]any)
	for _, grade := range []string{"A", "B", "C", "D", "F", "U"} {
		if !slices.Contains(summaryRequired, any(grade)) {
			t.Errorf("summary grade %q missing: %v", grade, summaryRequired)
		}
	}
}

func TestVerificationOpenAPIExposesOptionalHealthEnrichment(t *testing.T) {
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
		method, path, requestRef, responseRef, scope, role string
	}{
		{
			method: "post", path: "/api/v1/verification/verify",
			requestRef:  "#/components/schemas/VerificationRequest",
			responseRef: "#/components/schemas/VerificationResult",
			scope:       "write:subscribers", role: "editor",
		},
		{
			method: "post", path: "/api/v1/verification/verify-batch",
			requestRef:  "#/components/schemas/VerificationBatchRequest",
			responseRef: "#/components/schemas/VerificationBatchResponse",
			scope:       "write:subscribers", role: "editor",
		},
		{
			method: "get", path: "/api/v1/verification/jobs/{id}/results",
			responseRef: "#/components/schemas/VerificationJobResultsResponse",
			scope:       "read:subscribers", role: "viewer",
		},
	}
	for _, test := range tests {
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			raw := document.Paths[test.path][test.method]
			if len(raw) == 0 {
				t.Fatal("operation missing")
			}
			var operation emailHealthOperation
			if err := json.Unmarshal(raw, &operation); err != nil {
				t.Fatalf("decode operation: %v", err)
			}
			if !slices.Equal(operation.RequiredScopes, []string{test.scope}) || operation.RequiredRole != test.role {
				t.Fatalf("scope/role = %v/%q, want %s/%s", operation.RequiredScopes, operation.RequiredRole, test.scope, test.role)
			}
			var success struct {
				Content map[string]struct {
					Schema map[string]any `json:"schema"`
				} `json:"content"`
			}
			if err := json.Unmarshal(operation.Responses["200"], &success); err != nil {
				t.Fatalf("decode success: %v", err)
			}
			if got := success.Content["application/json"].Schema["$ref"]; got != test.responseRef {
				t.Fatalf("success schema = %v, want %s", got, test.responseRef)
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

	result := document.Components.Schemas["VerificationResult"]
	resultRequired := result["required"].([]any)
	if slices.Contains(resultRequired, any("health")) {
		t.Fatalf("VerificationResult health must stay optional: %v", resultRequired)
	}
	assertPropertyRef(t, result, "health", "#/components/schemas/EmailHealthResult")

	batch := document.Components.Schemas["VerificationBatchResponse"]
	batchRequired := batch["required"].([]any)
	for _, field := range []string{"results", "summary", "health_summary", "usage"} {
		if !slices.Contains(batchRequired, any(field)) {
			t.Errorf("VerificationBatchResponse required field %q missing: %v", field, batchRequired)
		}
	}
	assertPropertyRef(t, batch, "health_summary", "#/components/schemas/EmailHealthGradeSummary")

	jobItem := document.Components.Schemas["VerificationJobItem"]
	jobRequired := jobItem["required"].([]any)
	if slices.Contains(jobRequired, any("health")) {
		t.Fatalf("VerificationJobItem health must stay optional: %v", jobRequired)
	}
	assertPropertyRef(t, jobItem, "health", "#/components/schemas/EmailHealthResult")
}

func TestSynchronousVerificationRequiresDurableIdempotency(t *testing.T) {
	var document struct {
		Paths      map[string]map[string]json.RawMessage `json:"paths"`
		Components struct {
			Parameters map[string]map[string]any `json:"parameters"`
			Responses  map[string]map[string]any `json:"responses"`
		} `json:"components"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}

	parameter := document.Components.Parameters["VerificationIdempotencyKey"]
	if parameter["in"] != "header" || parameter["name"] != "Idempotency-Key" || parameter["required"] != true {
		t.Fatalf("verification idempotency parameter = %#v", parameter)
	}
	schema := parameter["schema"].(map[string]any)
	if schema["type"] != "string" || schema["minLength"] != float64(1) ||
		schema["maxLength"] != float64(255) || schema["x-postwave-max-utf8-bytes"] != float64(255) {
		t.Fatalf("verification idempotency bounds = %#v", schema)
	}

	for _, path := range []string{
		"/api/v1/verification/verify",
		"/api/v1/verification/verify-batch",
	} {
		t.Run(path, func(t *testing.T) {
			var operation struct {
				Description string                     `json:"description"`
				Parameters  []map[string]any           `json:"parameters"`
				Responses   map[string]json.RawMessage `json:"responses"`
			}
			if err := json.Unmarshal(document.Paths[path]["post"], &operation); err != nil {
				t.Fatalf("decode operation: %v", err)
			}
			if len(operation.Parameters) != 1 || operation.Parameters[0]["$ref"] !=
				"#/components/parameters/VerificationIdempotencyKey" {
				t.Fatalf("idempotency parameters = %#v", operation.Parameters)
			}
			for _, status := range []string{"409", "422"} {
				if _, ok := operation.Responses[status]; !ok {
					t.Errorf("idempotency response %s missing", status)
				}
			}
			for status, want := range map[string]string{
				"409": "#/components/responses/VerificationIdempotencyConflict",
				"422": "#/components/responses/VerificationIdempotencyMismatch",
			} {
				var responseRef map[string]any
				if err := json.Unmarshal(operation.Responses[status], &responseRef); err != nil {
					t.Fatalf("decode response %s: %v", status, err)
				}
				if responseRef["$ref"] != want {
					t.Errorf("response %s ref = %v, want %s", status, responseRef["$ref"], want)
				}
			}
			contract := strings.ToLower(strings.Join(strings.Fields(operation.Description), " "))
			for _, phrase := range []string{
				"24 hours", "byte-identical successful response",
				"without another provider call", "deterministic 2xx and 4xx",
				"pre-dispatch 5xx responses are discarded", "retry-after",
				"verification_provider_outcome_ambiguous",
			} {
				if !strings.Contains(contract, phrase) {
					t.Errorf("idempotency description does not contain %q: %q", phrase, operation.Description)
				}
			}
		})
	}

	pending := document.Components.Responses["VerificationIdempotencyConflict"]
	headers := pending["headers"].(map[string]any)
	retryAfter := headers["Retry-After"].(map[string]any)
	retrySchema := retryAfter["schema"].(map[string]any)
	if retrySchema["type"] != "integer" || retrySchema["minimum"] != float64(1) {
		t.Fatalf("Retry-After contract = %#v", retryAfter)
	}
	pendingContent := pending["content"].(map[string]any)
	pendingMedia := pendingContent["application/json"].(map[string]any)
	examples := pendingMedia["examples"].(map[string]any)
	for name, code := range map[string]string{
		"inProgress":               "idempotency_key_in_progress",
		"providerOutcomeAmbiguous": "verification_provider_outcome_ambiguous",
	} {
		value := examples[name].(map[string]any)["value"].(map[string]any)
		errorBody := value["error"].(map[string]any)
		if errorBody["code"] != code {
			t.Errorf("%s code = %#v, want %q", name, errorBody["code"], code)
		}
	}
	mismatch := document.Components.Responses["VerificationIdempotencyMismatch"]
	content := mismatch["content"].(map[string]any)
	media := content["application/json"].(map[string]any)
	example := media["example"].(map[string]any)
	errorBody := example["error"].(map[string]any)
	if errorBody["code"] != "idempotency_key_request_mismatch" {
		t.Fatalf("mismatch code = %#v", errorBody["code"])
	}
}

func assertPropertyRef(t *testing.T, schema map[string]any, property, want string) {
	t.Helper()
	properties := schema["properties"].(map[string]any)
	value := properties[property].(map[string]any)
	if direct, ok := value["$ref"]; ok {
		if direct != want {
			t.Fatalf("%s ref = %v, want %s", property, direct, want)
		}
		return
	}
	allOf := value["allOf"].([]any)
	if len(allOf) != 1 || allOf[0].(map[string]any)["$ref"] != want {
		t.Fatalf("%s schema = %#v, want %s", property, value, want)
	}
}

func assertStringEnum(t *testing.T, schema map[string]any, want []any) {
	t.Helper()
	if schema["type"] != "string" || !slices.Equal(schema["enum"].([]any), want) {
		t.Fatalf("enum = %#v, want %#v", schema, want)
	}
}
