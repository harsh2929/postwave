// SPDX-License-Identifier: AGPL-3.0-only
package customobjects

import (
	"encoding/json"
	"strings"
	"testing"
)

func mustJSON(t *testing.T, s string) json.RawMessage {
	t.Helper()
	if !json.Valid([]byte(s)) {
		t.Fatalf("invalid json fixture: %q", s)
	}
	return json.RawMessage(s)
}

func TestValidate_NoSchemaPassesEverything(t *testing.T) {
	for _, schema := range []string{"", "{}", "null"} {
		if errs := Validate(json.RawMessage(schema), mustJSON(t, `{"foo":"bar"}`)); errs.HasErrors() {
			t.Errorf("schema=%q should pass anything, got %v", schema, errs)
		}
	}
}

func TestValidate_TypeMismatch(t *testing.T) {
	schema := mustJSON(t, `{"type":"object","properties":{"name":{"type":"string"},"age":{"type":"integer"}}}`)
	errs := Validate(schema, mustJSON(t, `{"name":42,"age":"thirty"}`))
	if !errs.HasErrors() {
		t.Fatalf("expected type errors, got nothing")
	}
	codes := codeSet(errs)
	if _, ok := codes["type_mismatch"]; !ok {
		t.Errorf("expected type_mismatch in %v", errs)
	}
}

func TestValidate_RequiredMissing(t *testing.T) {
	schema := mustJSON(t, `{"type":"object","required":["email","tier"],"properties":{"email":{"type":"string"},"tier":{"type":"string"}}}`)
	errs := Validate(schema, mustJSON(t, `{"email":"x@example.com"}`))
	if len(errs) != 1 || errs[0].Field != "tier" || errs[0].Code != "required" {
		t.Errorf("expected single required error on 'tier', got %+v", errs)
	}
}

func TestValidate_EnumViolation(t *testing.T) {
	schema := mustJSON(t, `{"type":"object","properties":{"status":{"type":"string","enum":["open","closed","blocked"]}}}`)
	if errs := Validate(schema, mustJSON(t, `{"status":"open"}`)); errs.HasErrors() {
		t.Errorf("'open' is in enum but rejected: %v", errs)
	}
	errs := Validate(schema, mustJSON(t, `{"status":"merged"}`))
	if !errs.HasErrors() {
		t.Fatalf("expected enum violation for 'merged'")
	}
	if errs[0].Code != "enum_violation" {
		t.Errorf("code = %q, want enum_violation", errs[0].Code)
	}
}

func TestValidate_StringLengthConstraints(t *testing.T) {
	schema := mustJSON(t, `{"type":"object","properties":{"sku":{"type":"string","minLength":3,"maxLength":10}}}`)
	if errs := Validate(schema, mustJSON(t, `{"sku":"AB"}`)); !errs.HasErrors() || errs[0].Code != "min_length" {
		t.Errorf("expected min_length on short string, got %+v", errs)
	}
	if errs := Validate(schema, mustJSON(t, `{"sku":"ABCDEFGHIJK"}`)); !errs.HasErrors() || errs[0].Code != "max_length" {
		t.Errorf("expected max_length on long string, got %+v", errs)
	}
	if errs := Validate(schema, mustJSON(t, `{"sku":"ABC123"}`)); errs.HasErrors() {
		t.Errorf("valid-length string rejected: %v", errs)
	}
}

func TestValidate_NumberBounds(t *testing.T) {
	schema := mustJSON(t, `{"type":"object","properties":{"quantity":{"type":"integer","minimum":1,"maximum":100}}}`)
	if errs := Validate(schema, mustJSON(t, `{"quantity":0}`)); !errs.HasErrors() || errs[0].Code != "minimum" {
		t.Errorf("expected minimum violation, got %+v", errs)
	}
	if errs := Validate(schema, mustJSON(t, `{"quantity":101}`)); !errs.HasErrors() || errs[0].Code != "maximum" {
		t.Errorf("expected maximum violation, got %+v", errs)
	}
}

func TestValidate_IntegerVsNumber(t *testing.T) {
	schema := mustJSON(t, `{"type":"object","properties":{"count":{"type":"integer"}}}`)
	if errs := Validate(schema, mustJSON(t, `{"count":3.14}`)); !errs.HasErrors() {
		t.Errorf("3.14 must fail integer check")
	}
	if errs := Validate(schema, mustJSON(t, `{"count":42}`)); errs.HasErrors() {
		t.Errorf("integer 42 passes integer check")
	}
}

func TestValidate_NestedObjectAndArray(t *testing.T) {
	schema := mustJSON(t, `{
		"type":"object",
		"properties":{
			"line_items":{
				"type":"array",
				"items":{
					"type":"object",
					"required":["sku","price"],
					"properties":{
						"sku":{"type":"string","minLength":1},
						"price":{"type":"number","minimum":0}
					}
				}
			}
		}
	}`)
	good := mustJSON(t, `{"line_items":[{"sku":"X","price":9.99},{"sku":"Y","price":0}]}`)
	if errs := Validate(schema, good); errs.HasErrors() {
		t.Errorf("good nested array rejected: %v", errs)
	}
	bad := mustJSON(t, `{"line_items":[{"sku":"","price":-1}]}`)
	errs := Validate(schema, bad)
	if !errs.HasErrors() {
		t.Fatalf("bad nested array passed")
	}
	// We expect at least one error per offending field — empty sku
	// + negative price.
	codes := codeSet(errs)
	if _, ok := codes["min_length"]; !ok {
		t.Errorf("expected min_length on empty sku, got %+v", errs)
	}
	if _, ok := codes["minimum"]; !ok {
		t.Errorf("expected minimum on negative price, got %+v", errs)
	}
}

func TestValidate_AdditionalPropertiesGate(t *testing.T) {
	schemaOpen := mustJSON(t, `{"type":"object","additionalProperties":true,"properties":{"name":{"type":"string"}}}`)
	if errs := Validate(schemaOpen, mustJSON(t, `{"name":"x","extra":"y"}`)); errs.HasErrors() {
		t.Errorf("additionalProperties=true should allow extras, got %v", errs)
	}
	schemaClosed := mustJSON(t, `{"type":"object","additionalProperties":false,"properties":{"name":{"type":"string"}}}`)
	errs := Validate(schemaClosed, mustJSON(t, `{"name":"x","extra":"y"}`))
	if !errs.HasErrors() {
		t.Fatalf("additionalProperties=false should reject extras")
	}
	if !strings.Contains(errs.Error(), "extra") {
		t.Errorf("error should mention the offending field 'extra', got %v", errs)
	}
}

func TestValidate_NullValueAcceptsAnyType(t *testing.T) {
	// JSON null is treated as "nullable" — passes any declared type.
	schema := mustJSON(t, `{"type":"object","properties":{"closed_at":{"type":"string"}}}`)
	if errs := Validate(schema, mustJSON(t, `{"closed_at":null}`)); errs.HasErrors() {
		t.Errorf("null should pass any declared type, got %v", errs)
	}
}

func TestValidate_ErrorAggregationCollectsAll(t *testing.T) {
	schema := mustJSON(t, `{
		"type":"object",
		"required":["email","tier"],
		"properties":{
			"email":{"type":"string","minLength":3},
			"tier":{"type":"string","enum":["free","pro","enterprise"]}
		}
	}`)
	errs := Validate(schema, mustJSON(t, `{"email":"a","tier":"junk"}`))
	// Expect: email below minLength + tier enum violation.
	if len(errs) < 2 {
		t.Errorf("expected aggregated errors, got %d: %v", len(errs), errs)
	}
}

func TestValidationErrors_StringRender(t *testing.T) {
	errs := ValidationErrors{
		{Field: "x", Code: "type_mismatch", Message: "expected string"},
		{Field: "y", Code: "required", Message: "missing"},
	}
	s := errs.Error()
	if !strings.Contains(s, "x:") || !strings.Contains(s, "y:") {
		t.Errorf("Error() should include both fields, got %q", s)
	}
	if (ValidationErrors{}).Error() != "" {
		t.Errorf("empty errors should render as empty string")
	}
}

func codeSet(errs ValidationErrors) map[string]struct{} {
	out := map[string]struct{}{}
	for _, e := range errs {
		out[e.Code] = struct{}{}
	}
	return out
}
