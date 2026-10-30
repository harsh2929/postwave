// SPDX-License-Identifier: AGPL-3.0-only
//
// validator.go — a small JSON-Schema subset for custom-object
// properties. We deliberately don't pull a full JSON-Schema lib
// because:
//
//   • Tenants don't write JSON Schema by hand; the dashboard's type
//     editor emits a constrained shape. The set of constructs we
//     ever see is small.
//
//   • Full JSON Schema brings $ref + $defs + draft compatibility +
//     keyword vocabularies we don't want to teach customers.
//
//   • The runtime cost matters — record upserts can arrive at high
//     rate from importers and warehouse syncs; a tight validator
//     beats a generic engine.
//
// Supported keywords:
//
//   • type: "object" | "string" | "number" | "integer" | "boolean" | "array"
//   • required: []string
//   • properties: map[string]ofThisSchema (recursive)
//   • items: ofThisSchema (only when type=array)
//   • enum: []any
//   • minLength / maxLength (strings)
//   • minimum / maximum (numbers + integers)
//   • additionalProperties: bool (default true)
//
// Anything else is ignored — silently. The validator is intentionally
// permissive about extra keywords so tenants can layer their own
// hints (e.g. "uiHint": "currency") without breaking validation.

package customobjects

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strings"
	"unicode/utf8"
)

const maxValidationErrors = 100

// ValidationError is the structured failure shape callers can render
// inline next to the offending field.
type ValidationError struct {
	Field   string `json:"field"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ValidationErrors collects multiple per-field errors so a single
// upsert response can list every problem at once.
type ValidationErrors []ValidationError

// Error implements error. The dashboard prefers the structured form
// but tests and logs use this string fallback.
func (v ValidationErrors) Error() string {
	if len(v) == 0 {
		return ""
	}
	parts := make([]string, 0, len(v))
	for _, e := range v {
		parts = append(parts, fmt.Sprintf("%s: %s", e.Field, e.Message))
	}
	return strings.Join(parts, "; ")
}

// HasErrors reports whether the slice is non-empty. Useful when
// callers want to combine multiple validations into one response.
func (v ValidationErrors) HasErrors() bool { return len(v) > 0 }

// Validate runs the schema against the properties doc and returns
// any validation failures. A nil error means the record is valid.
func Validate(schema, properties json.RawMessage) ValidationErrors {
	var schemaDoc map[string]any
	if len(schema) == 0 || string(schema) == "{}" || string(schema) == "null" {
		return nil // no schema = no validation; everything passes
	}
	if _, err := validateSchema(schema); err != nil {
		return ValidationErrors{{Field: "$schema", Code: "schema_parse_error", Message: "The saved schema is invalid or exceeds validation limits."}}
	}
	if _, err := validateJSONObject(properties, maxPropertiesBytes, maxRecordDepth, maxRecordNodes, "properties"); err != nil {
		return ValidationErrors{{Field: "$properties", Code: "properties_parse_error", Message: "The submitted properties are invalid or exceed validation limits."}}
	}
	if err := json.Unmarshal(schema, &schemaDoc); err != nil {
		return ValidationErrors{{Field: "$schema", Code: "schema_parse_error", Message: "The saved schema could not be read."}}
	}
	var propsDoc any
	if len(properties) == 0 || string(properties) == "null" {
		propsDoc = map[string]any{}
	} else if err := json.Unmarshal(properties, &propsDoc); err != nil {
		return ValidationErrors{{Field: "$properties", Code: "properties_parse_error", Message: "The submitted properties could not be read."}}
	}
	errs := validateNode(schemaDoc, propsDoc, "")
	if len(errs) > maxValidationErrors {
		errs = errs[:maxValidationErrors]
	}
	return errs
}

// validateNode is the recursive core. path is the dotted accessor
// ("address.city") used to populate ValidationError.Field.
func validateNode(schema map[string]any, value any, path string) ValidationErrors {
	var errs ValidationErrors

	// type check
	if t, ok := stringField(schema, "type"); ok {
		if v := checkType(t, value); v != nil {
			errs = append(errs, ValidationError{Field: pathOr(path, "$"), Code: "type_mismatch", Message: v.Error()})
			// Fail fast on type mismatch — nested constraints can't
			// apply when the shape is wrong.
			return errs
		}
	}

	if value == nil {
		return errs
	}

	// enum
	if enum, ok := schema["enum"].([]any); ok {
		matched := false
		for _, candidate := range enum {
			if equalJSONValues(value, candidate) {
				matched = true
				break
			}
		}
		if !matched {
			errs = append(errs, ValidationError{
				Field: pathOr(path, "$"), Code: "enum_violation",
				Message: "The value is not in the allowed set.",
			})
		}
	}

	// string-only constraints
	if s, ok := value.(string); ok {
		length := utf8.RuneCountInString(s)
		if mn, ok := numberField(schema, "minLength"); ok && float64(length) < mn {
			errs = append(errs, ValidationError{Field: pathOr(path, "$"), Code: "min_length",
				Message: "The string is shorter than the allowed minimum."})
		}
		if mx, ok := numberField(schema, "maxLength"); ok && float64(length) > mx {
			errs = append(errs, ValidationError{Field: pathOr(path, "$"), Code: "max_length",
				Message: "The string is longer than the allowed maximum."})
		}
	}

	// number-only constraints
	if n, ok := value.(float64); ok {
		if mn, ok := numberField(schema, "minimum"); ok && n < mn {
			errs = append(errs, ValidationError{Field: pathOr(path, "$"), Code: "minimum",
				Message: "The number is below the allowed minimum."})
		}
		if mx, ok := numberField(schema, "maximum"); ok && n > mx {
			errs = append(errs, ValidationError{Field: pathOr(path, "$"), Code: "maximum",
				Message: "The number is above the allowed maximum."})
		}
	}

	// object — required + properties + additionalProperties
	if obj, ok := value.(map[string]any); ok {
		if req, ok := schema["required"].([]any); ok {
			for _, r := range req {
				name, _ := r.(string)
				if name == "" {
					continue
				}
				if _, present := obj[name]; !present {
					errs = append(errs, ValidationError{
						Field: pathJoin(path, name), Code: "required",
						Message: "required property missing",
					})
				}
			}
		}
		props, _ := schema["properties"].(map[string]any)
		additional := true
		if v, ok := schema["additionalProperties"].(bool); ok {
			additional = v
		}
		keys := make([]string, 0, len(obj))
		for key := range obj {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, k := range keys {
			v := obj[k]
			childSchema, defined := props[k].(map[string]any)
			if !defined {
				if !additional {
					errs = append(errs, ValidationError{
						Field: pathJoin(path, k), Code: "additional_property",
						Message: "additional property not permitted",
					})
				}
				continue
			}
			errs = append(errs, validateNode(childSchema, v, pathJoin(path, k))...)
		}
	}

	// array — items
	if arr, ok := value.([]any); ok {
		if items, ok := schema["items"].(map[string]any); ok {
			for i, item := range arr {
				errs = append(errs, validateNode(items, item, fmt.Sprintf("%s[%d]", path, i))...)
			}
		}
	}

	return errs
}

// checkType returns nil when value matches the declared JSON-Schema
// type, or an error describing the mismatch.
func checkType(declared string, value any) error {
	if value == nil {
		return nil // null passes any type — same as JSON Schema's "nullable" relaxation
	}
	switch declared {
	case "string":
		if _, ok := value.(string); !ok {
			return errors.New("expected string")
		}
	case "number":
		if _, ok := value.(float64); !ok {
			return errors.New("expected number")
		}
	case "integer":
		f, ok := value.(float64)
		if !ok || math.IsInf(f, 0) || math.IsNaN(f) || f != math.Trunc(f) {
			return errors.New("expected integer")
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return errors.New("expected boolean")
		}
	case "array":
		if _, ok := value.([]any); !ok {
			return errors.New("expected array")
		}
	case "object":
		if _, ok := value.(map[string]any); !ok {
			return errors.New("expected object")
		}
	}
	return nil
}

func stringField(m map[string]any, key string) (string, bool) {
	v, ok := m[key].(string)
	return v, ok
}

func numberField(m map[string]any, key string) (float64, bool) {
	switch v := m[key].(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	}
	return 0, false
}

func pathOr(p, def string) string {
	if p == "" {
		return def
	}
	return p
}

func pathJoin(parent, child string) string {
	if parent == "" {
		return child
	}
	return parent + "." + child
}

// equalJSONValues compares two values for JSON-equality. We need this
// because the JSON parser uses float64 for all numbers; an enum entry
// like 5 (Go int) wouldn't equal-compare with a parsed value of 5.0.
func equalJSONValues(a, b any) bool {
	switch av := a.(type) {
	case float64:
		if bv, ok := b.(float64); ok {
			return av == bv
		}
	case string:
		if bv, ok := b.(string); ok {
			return av == bv
		}
	case bool:
		if bv, ok := b.(bool); ok {
			return av == bv
		}
	}
	return reflect.DeepEqual(a, b)
}
