// SPDX-License-Identifier: AGPL-3.0-only
package agenttools

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestValidateToolArgumentsFailsClosedAcrossNativeSchemaKeywords(t *testing.T) {
	schema := json.RawMessage(`{
  "type":"object",
  "additionalProperties":false,
  "properties":{
    "name":{"type":"string","minLength":2,"maxLength":4,"pattern":"^[a-z]+$"},
    "count":{"type":"integer","minimum":1,"maximum":3},
    "mode":{"type":"string","enum":["safe","strict"]},
    "tags":{"type":"array","minItems":1,"maxItems":2,"uniqueItems":true,"items":{"type":"string","maxLength":3}},
    "nested":{"type":"object","additionalProperties":false,"properties":{"enabled":{"type":"boolean"}},"required":["enabled"]},
    "id":{"type":"string","format":"uuid"},
    "at":{"type":"string","format":"date-time"}
  },
  "required":["name","count"]
}`)

	tests := []struct {
		name string
		args string
		ok   bool
	}{
		{name: "valid", args: `{"name":"wave","count":2,"mode":"safe","tags":["one","two"],"nested":{"enabled":true},"id":"123e4567-e89b-12d3-a456-426614174000","at":"2026-08-20T12:00:00Z"}`, ok: true},
		{name: "malformed", args: `{"name":`},
		{name: "trailing value", args: `{} {}`},
		{name: "root array", args: `[]`},
		{name: "root scalar", args: `"wave"`},
		{name: "missing required", args: `{"name":"wave"}`},
		{name: "wrong type", args: `{"name":"wave","count":"2"}`},
		{name: "integer only", args: `{"name":"wave","count":1.5}`},
		{name: "minimum", args: `{"name":"wave","count":0}`},
		{name: "maximum", args: `{"name":"wave","count":4}`},
		{name: "min length", args: `{"name":"w","count":1}`},
		{name: "max length", args: `{"name":"waves","count":1}`},
		{name: "pattern", args: `{"name":"WAVE","count":1}`},
		{name: "enum", args: `{"name":"wave","count":1,"mode":"fast"}`},
		{name: "unknown top-level", args: `{"name":"wave","count":1,"secret":"x"}`},
		{name: "unknown nested", args: `{"name":"wave","count":1,"nested":{"enabled":true,"extra":1}}`},
		{name: "array too short", args: `{"name":"wave","count":1,"tags":[]}`},
		{name: "array too long", args: `{"name":"wave","count":1,"tags":["a","b","c"]}`},
		{name: "array duplicate", args: `{"name":"wave","count":1,"tags":["one","one"]}`},
		{name: "array item bound", args: `{"name":"wave","count":1,"tags":["long"]}`},
		{name: "uuid format", args: `{"name":"wave","count":1,"id":"not-a-uuid"}`},
		{name: "date-time format", args: `{"name":"wave","count":1,"at":"tomorrow"}`},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateToolArguments(schema, json.RawMessage(test.args))
			if test.ok {
				if err != nil {
					t.Fatalf("valid arguments rejected: %v", err)
				}
				return
			}
			if !errors.Is(err, ErrInvalidArguments) {
				t.Fatalf("error=%v want ErrInvalidArguments", err)
			}
			var validation *ArgumentValidationError
			if !errors.As(err, &validation) || validation.Path == "" || validation.Reason == "" {
				t.Fatalf("error lacks safe path/reason: %v", err)
			}
		})
	}
}

func TestValidateToolArgumentsAppliesGlobalComplexityCaps(t *testing.T) {
	openSchema := json.RawMessage(`{"type":"object","additionalProperties":true}`)
	deep := `"leaf"`
	for range maxArgumentDepth + 2 {
		deep = `{"next":` + deep + `}`
	}
	if err := validateToolArguments(openSchema, json.RawMessage(deep)); !errors.Is(err, ErrInvalidArguments) {
		t.Fatalf("deep arguments bypassed complexity cap: %v", err)
	}

	oversizedString := `{"value":"` + strings.Repeat("x", maxArgumentStringRunes+1) + `"}`
	if err := validateToolArguments(openSchema, json.RawMessage(oversizedString)); !errors.Is(err, ErrInvalidArguments) {
		t.Fatalf("oversized string bypassed complexity cap: %v", err)
	}

	items := make([]string, maxArgumentArrayItems+1)
	for index := range items {
		items[index] = "0"
	}
	oversizedArray := `{"items":[` + strings.Join(items, ",") + `]}`
	if err := validateToolArguments(openSchema, json.RawMessage(oversizedArray)); !errors.Is(err, ErrInvalidArguments) {
		t.Fatalf("oversized array bypassed complexity cap: %v", err)
	}
}

func TestValidateToolArgumentsRequiresExplicitAdditionalPropertiesOptIn(t *testing.T) {
	closedByDefault := json.RawMessage(`{"type":"object","properties":{"known":{"type":"string"}}}`)
	if err := validateToolArguments(closedByDefault, json.RawMessage(`{"known":"ok","extra":"no"}`)); !errors.Is(err, ErrInvalidArguments) {
		t.Fatalf("implicit additionalProperties must fail closed, got %v", err)
	}

	open := json.RawMessage(`{"type":"object","additionalProperties":true}`)
	if err := validateToolArguments(open, json.RawMessage(`{"caller_defined":{"nested":true}}`)); err != nil {
		t.Fatalf("explicit additionalProperties=true rejected: %v", err)
	}
}

func TestValidateToolArgumentsNeverEchoesUnknownPropertyName(t *testing.T) {
	schema := json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"known":{"type":"string"}}}`)
	err := validateToolArguments(schema, json.RawMessage(`{"known":"ok","password=private-secret":"x"}`))
	var validation *ArgumentValidationError
	if !errors.As(err, &validation) {
		t.Fatalf("error=%v want ArgumentValidationError", err)
	}
	if validation.Path != "$.*" || strings.Contains(err.Error(), "password") || strings.Contains(err.Error(), "private-secret") {
		t.Fatalf("caller-controlled key escaped validation boundary: path=%q err=%v", validation.Path, err)
	}

	openTyped := json.RawMessage(`{"type":"object","additionalProperties":{"type":"integer"}}`)
	err = validateToolArguments(openTyped, json.RawMessage(`{"token=private-secret":"wrong"}`))
	if !errors.As(err, &validation) || validation.Path != "$.*" || strings.Contains(err.Error(), "private-secret") {
		t.Fatalf("typed additional property echoed key: path=%q err=%v", validation.Path, err)
	}
}

func TestValidateToolArgumentsSupportsAnyOfAndOneOf(t *testing.T) {
	schema := json.RawMessage(`{
  "type":"object",
  "additionalProperties":false,
  "properties":{
    "name":{"type":"string"},
    "description":{"type":"string"},
    "revision":{"oneOf":[{"type":"integer","minimum":1},{"type":"string","pattern":"^0*[1-9][0-9]*$"}]}
  },
  "required":["revision"],
  "anyOf":[{"required":["name"]},{"required":["description"]}]
}`)
	for _, valid := range []string{
		`{"name":"x","revision":1}`,
		`{"description":"x","revision":"002"}`,
	} {
		if err := validateToolArguments(schema, json.RawMessage(valid)); err != nil {
			t.Fatalf("valid anyOf/oneOf frame %s rejected: %v", valid, err)
		}
	}
	for _, invalid := range []string{
		`{"revision":1}`,
		`{"name":"x","revision":0}`,
		`{"name":"x","revision":"zero"}`,
	} {
		if err := validateToolArguments(schema, json.RawMessage(invalid)); !errors.Is(err, ErrInvalidArguments) {
			t.Fatalf("invalid anyOf/oneOf frame %s accepted: %v", invalid, err)
		}
	}
}
