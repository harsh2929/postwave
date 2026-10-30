// SPDX-License-Identifier: AGPL-3.0-only

package customobjects

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func validationCode(err error) string {
	var target *RequestValidationError
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}

func TestCustomObjectSchemaValidationRejectsAmbiguousOrUnboundedDefinitions(t *testing.T) {
	deep := `{}`
	for range maxSchemaDepth + 2 {
		deep = `{"hint":` + deep + `}`
	}
	cases := []struct {
		name   string
		schema string
	}{
		{"non-object", `[]`},
		{"wrong root type", `{"type":"string"}`},
		{"unknown declared type", `{"type":"date"}`},
		{"property definition is scalar", `{"type":"object","properties":{"status":"string"}}`},
		{"unsafe property", `{"type":"object","properties":{"bad.property":{"type":"string"}}}`},
		{"required missing definition", `{"type":"object","required":["missing"],"properties":{}}`},
		{"duplicate required", `{"type":"object","required":["x","x"],"properties":{"x":{"type":"string"}}}`},
		{"inverted string bounds", `{"type":"object","properties":{"x":{"type":"string","minLength":3,"maxLength":2}}}`},
		{"inverted numeric bounds", `{"type":"object","properties":{"x":{"type":"number","minimum":3,"maximum":2}}}`},
		{"empty enum", `{"type":"object","properties":{"x":{"type":"string","enum":[]}}}`},
		{"excessive depth", deep},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			_, err := validateSchema(json.RawMessage(test.schema))
			if err == nil {
				t.Fatalf("schema unexpectedly accepted: %s", test.schema)
			}
		})
	}
}

func TestCustomObjectInputBoundsAndCanonicalVersions(t *testing.T) {
	cases := []struct {
		name string
		call func() error
		code string
	}{
		{"uppercase type key", func() error { return validateTypeKey("Order", "key") }, "invalid_key"},
		{"control in label", func() error {
			return validateBoundedText("Order\nsecret", "label", maxTypeLabelRunes, maxTypeLabelBytes)
		}, "invalid_label"},
		{"surrounding whitespace", func() error { return validateBoundedText(" Order ", "label", maxTypeLabelRunes, maxTypeLabelBytes) }, "invalid_label"},
		{"missing update version", func() error { return validateExpectedVersion(0, false) }, "precondition_required"},
		{"negative create version", func() error { return validateExpectedVersion(-1, true) }, "precondition_required"},
		{"create-only version", func() error { return validateExpectedVersion(0, true) }, ""},
		{"canonical update version", func() error { return validateExpectedVersion(7, false) }, ""},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			err := test.call()
			if got := validationCode(err); got != test.code {
				t.Fatalf("code=%q err=%v want %q", got, err, test.code)
			}
		})
	}
}

func TestCustomObjectPrimaryKeyMustRemainDeclared(t *testing.T) {
	create := CreateTypeParams{
		Key: "order", Label: "Order", PrimaryKey: "order_id", Schema: json.RawMessage(`{}`),
	}
	if err := validateCreateTypeParams(&create); validationCode(err) != "invalid_primary_key" {
		t.Fatalf("undeclared create primary key err=%v", err)
	}
	create.Schema = json.RawMessage(`{"type":"object","properties":{"order_id":{"type":"string"}}}`)
	if err := validateCreateTypeParams(&create); err != nil {
		t.Fatalf("declared create primary key rejected: %v", err)
	}
	if err := validateUpdatedSchemaPrimaryKey("order_id", json.RawMessage(`{"type":"object","properties":{}}`)); validationCode(err) != "invalid_primary_key" {
		t.Fatalf("removed update primary key err=%v", err)
	}
}

func TestValidateCapsFailuresAndUsesUnicodeLength(t *testing.T) {
	properties := make(map[string]any, maxValidationErrors+20)
	required := make([]string, 0, maxValidationErrors+20)
	for index := 0; index < maxValidationErrors+20; index++ {
		name := fmt.Sprintf("field_%03d", index)
		properties[name] = map[string]any{"type": "string"}
		required = append(required, name)
	}
	schemaBytes, err := json.Marshal(map[string]any{
		"type": "object", "properties": properties, "required": required,
	})
	if err != nil {
		t.Fatal(err)
	}
	violations := Validate(schemaBytes, json.RawMessage(`{}`))
	if len(violations) != maxValidationErrors {
		t.Fatalf("violations=%d want cap %d", len(violations), maxValidationErrors)
	}

	unicodeSchema := json.RawMessage(`{"type":"object","properties":{"name":{"type":"string","minLength":2,"maxLength":2}}}`)
	if got := Validate(unicodeSchema, json.RawMessage(`{"name":"é🙂"}`)); got.HasErrors() {
		t.Fatalf("two Unicode code points were measured as bytes: %+v", got)
	}
	if got := Validate(unicodeSchema, json.RawMessage(`{"name":"é"}`)); !got.HasErrors() || got[0].Code != "min_length" {
		t.Fatalf("one Unicode code point did not fail minLength: %+v", got)
	}
}

func TestValidationMessagesNeverReflectValues(t *testing.T) {
	schema := json.RawMessage(`{"type":"object","properties":{"status":{"type":"string","enum":["allowed-secret"]},"count":{"type":"number","minimum":10}}}`)
	properties := json.RawMessage(`{"status":"submitted-secret","count":3}`)
	violations := Validate(schema, properties)
	if len(violations) != 2 {
		t.Fatalf("violations=%+v", violations)
	}
	encoded, _ := json.Marshal(violations)
	for _, forbidden := range []string{"allowed-secret", "submitted-secret", "10", "3 <"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("validation response reflected %q: %s", forbidden, encoded)
		}
	}
}
