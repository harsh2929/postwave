// SPDX-License-Identifier: AGPL-3.0-only
package agenttools

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/url"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// ArgumentValidationError is a safe, typed client error. Path uses JSON-path
// notation rooted at "$"; Reason never includes the rejected value, so a
// caller can correct its frame without secrets being copied into logs/errors.
type ArgumentValidationError struct {
	Path   string
	Reason string
}

func (e *ArgumentValidationError) Error() string {
	return fmt.Sprintf("%v at %s: %s", ErrInvalidArguments, e.Path, e.Reason)
}

func (e *ArgumentValidationError) Unwrap() error { return ErrInvalidArguments }

func invalidArgument(path, reason string) error {
	return &ArgumentValidationError{Path: path, Reason: reason}
}

// validateToolArguments enforces the JSON-Schema subset used by the native
// registry. Empty arguments mean an empty object, as MCP permits arguments to
// be omitted. Unknown object fields fail closed unless additionalProperties is
// explicitly true or supplies a schema.
func validateToolArguments(schemaJSON, argsJSON json.RawMessage) error {
	var schema map[string]any
	if err := decodeOneJSON(schemaJSON, &schema); err != nil || schema == nil {
		return fmt.Errorf("%w: invalid registered input schema", ErrInternal)
	}
	if len(bytes.TrimSpace(argsJSON)) == 0 {
		argsJSON = json.RawMessage(`{}`)
	}
	var value any
	if err := decodeOneJSON(argsJSON, &value); err != nil {
		return invalidArgument("$", "arguments must be exactly one valid JSON value")
	}
	if err := validateArgumentComplexity(value); err != nil {
		return err
	}
	return validateSchemaValue(schema, value, "$", true)
}

const (
	maxArgumentDepth            = 32
	maxArgumentNodes            = 16_384
	maxArgumentStringRunes      = 65_536
	maxArgumentObjectProperties = 1_024
	maxArgumentArrayItems       = 4_096
	maxArgumentPropertyRunes    = 256
)

type argumentNode struct {
	value any
	depth int
}

// validateArgumentComplexity walks the decoded value iteratively before any
// recursive schema traversal. The limits apply even below an explicitly-open
// additionalProperties object, preventing a bounded HTTP frame from turning
// into unbounded validator depth/work.
func validateArgumentComplexity(root any) error {
	stack := []argumentNode{{value: root, depth: 0}}
	nodes := 0
	for len(stack) > 0 {
		last := len(stack) - 1
		current := stack[last]
		stack = stack[:last]
		nodes++
		if nodes > maxArgumentNodes {
			return invalidArgument("$", "arguments contain too many JSON nodes")
		}
		if current.depth > maxArgumentDepth {
			return invalidArgument("$", "arguments exceed the maximum nesting depth")
		}
		switch value := current.value.(type) {
		case string:
			if utf8.RuneCountInString(value) > maxArgumentStringRunes {
				return invalidArgument("$", "arguments contain an oversized string")
			}
		case map[string]any:
			if len(value) > maxArgumentObjectProperties {
				return invalidArgument("$", "arguments contain an object with too many properties")
			}
			for key, child := range value {
				if utf8.RuneCountInString(key) > maxArgumentPropertyRunes {
					return invalidArgument("$", "arguments contain an oversized property name")
				}
				stack = append(stack, argumentNode{value: child, depth: current.depth + 1})
			}
		case []any:
			if len(value) > maxArgumentArrayItems {
				return invalidArgument("$", "arguments contain an array with too many items")
			}
			for _, child := range value {
				stack = append(stack, argumentNode{value: child, depth: current.depth + 1})
			}
		}
	}
	return nil
}

func decodeOneJSON(raw []byte, dst any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var trailing any
	if err := dec.Decode(&trailing); err == nil {
		return fmt.Errorf("multiple JSON values")
	} else if err != io.EOF {
		return fmt.Errorf("trailing JSON data: %w", err)
	}
	return nil
}

func validateSchemaValue(schema map[string]any, value any, path string, rejectUnknownByDefault bool) error {
	if branches, ok := schema["allOf"].([]any); ok {
		for _, branch := range branches {
			branchSchema, ok := branch.(map[string]any)
			if !ok {
				return fmt.Errorf("%w: invalid allOf schema", ErrInternal)
			}
			if err := validateSchemaValue(branchSchema, value, path, rejectUnknownByDefault); err != nil {
				return err
			}
		}
	}
	if branches, ok := schema["anyOf"].([]any); ok {
		matched := false
		for _, branch := range branches {
			branchSchema, ok := branch.(map[string]any)
			if !ok {
				return fmt.Errorf("%w: invalid anyOf schema", ErrInternal)
			}
			if validateSchemaValue(branchSchema, value, path, false) == nil {
				matched = true
				break
			}
		}
		if !matched {
			return invalidArgument(path, "value does not satisfy any allowed shape")
		}
	}
	if branches, ok := schema["oneOf"].([]any); ok {
		matches := 0
		for _, branch := range branches {
			branchSchema, ok := branch.(map[string]any)
			if !ok {
				return fmt.Errorf("%w: invalid oneOf schema", ErrInternal)
			}
			if validateSchemaValue(branchSchema, value, path, false) == nil {
				matches++
			}
		}
		if matches != 1 {
			return invalidArgument(path, "value must satisfy exactly one allowed shape")
		}
	}

	if enums, ok := schema["enum"].([]any); ok {
		matched := false
		for _, candidate := range enums {
			if reflect.DeepEqual(candidate, value) {
				matched = true
				break
			}
		}
		if !matched {
			return invalidArgument(path, "value is not in the allowed enum")
		}
	}

	if rawType, ok := schema["type"]; ok && !matchesSchemaType(rawType, value) {
		return invalidArgument(path, "value has the wrong JSON type")
	}

	switch typed := value.(type) {
	case map[string]any:
		if err := validateObject(schema, typed, path, rejectUnknownByDefault); err != nil {
			return err
		}
	case []any:
		if err := validateArray(schema, typed, path, rejectUnknownByDefault); err != nil {
			return err
		}
	case string:
		if err := validateString(schema, typed, path); err != nil {
			return err
		}
	case json.Number:
		if err := validateNumber(schema, typed, path); err != nil {
			return err
		}
	}
	return nil
}

func matchesSchemaType(rawType, value any) bool {
	types := make([]string, 0, 1)
	switch t := rawType.(type) {
	case string:
		types = append(types, t)
	case []any:
		for _, item := range t {
			if s, ok := item.(string); ok {
				types = append(types, s)
			}
		}
	default:
		return false
	}
	for _, want := range types {
		switch want {
		case "object":
			_, ok := value.(map[string]any)
			if ok {
				return true
			}
		case "array":
			_, ok := value.([]any)
			if ok {
				return true
			}
		case "string":
			_, ok := value.(string)
			if ok {
				return true
			}
		case "integer":
			if n, ok := value.(json.Number); ok && isJSONInteger(n) {
				return true
			}
		case "number":
			if _, ok := value.(json.Number); ok {
				return true
			}
		case "boolean":
			if _, ok := value.(bool); ok {
				return true
			}
		case "null":
			if value == nil {
				return true
			}
		}
	}
	return false
}

func validateObject(schema map[string]any, value map[string]any, path string, rejectUnknownByDefault bool) error {
	if minimum, ok := schemaNumber(schema["minProperties"]); ok && float64(len(value)) < minimum {
		return invalidArgument(path, "object has too few properties")
	}
	if maximum, ok := schemaNumber(schema["maxProperties"]); ok && float64(len(value)) > maximum {
		return invalidArgument(path, "object has too many properties")
	}
	if required, ok := schema["required"].([]any); ok {
		for _, rawName := range required {
			name, ok := rawName.(string)
			if !ok {
				return fmt.Errorf("%w: invalid required schema", ErrInternal)
			}
			if _, present := value[name]; !present {
				return invalidArgument(childPath(path, name), "required property is missing")
			}
		}
	}
	properties, _ := schema["properties"].(map[string]any)
	for name, item := range value {
		if rawProperty, declared := properties[name]; declared {
			propertySchema, ok := rawProperty.(map[string]any)
			if !ok {
				return fmt.Errorf("%w: invalid property schema", ErrInternal)
			}
			if err := validateSchemaValue(propertySchema, item, childPath(path, name), rejectUnknownByDefault); err != nil {
				return err
			}
			continue
		}

		extra, explicitlySet := schema["additionalProperties"]
		// name is caller-controlled. Never echo an undeclared property name into
		// the validation path because LLM-facing adapters and traces retain this
		// bounded error contract.
		extraPath := path + ".*"
		if allowed, ok := extra.(bool); ok {
			if allowed {
				continue
			}
			return invalidArgument(extraPath, "unknown property is not allowed")
		}
		if extraSchema, ok := extra.(map[string]any); ok {
			if err := validateSchemaValue(extraSchema, item, extraPath, rejectUnknownByDefault); err != nil {
				return err
			}
			continue
		}
		if rejectUnknownByDefault || explicitlySet {
			return invalidArgument(extraPath, "unknown property is not allowed")
		}
	}
	return nil
}

func validateArray(schema map[string]any, value []any, path string, rejectUnknownByDefault bool) error {
	if minimum, ok := schemaNumber(schema["minItems"]); ok && float64(len(value)) < minimum {
		return invalidArgument(path, "array has too few items")
	}
	if maximum, ok := schemaNumber(schema["maxItems"]); ok && float64(len(value)) > maximum {
		return invalidArgument(path, "array has too many items")
	}
	if unique, _ := schema["uniqueItems"].(bool); unique {
		seen := make(map[string]struct{}, len(value))
		for _, item := range value {
			encoded, err := json.Marshal(item)
			if err != nil {
				return fmt.Errorf("%w: could not canonicalize array item", ErrInternal)
			}
			key := string(encoded)
			if _, duplicate := seen[key]; duplicate {
				return invalidArgument(path, "array items must be unique")
			}
			seen[key] = struct{}{}
		}
	}
	if rawItems, ok := schema["items"]; ok {
		itemSchema, ok := rawItems.(map[string]any)
		if !ok {
			return fmt.Errorf("%w: invalid items schema", ErrInternal)
		}
		for index, item := range value {
			if err := validateSchemaValue(itemSchema, item, fmt.Sprintf("%s[%d]", path, index), rejectUnknownByDefault); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateString(schema map[string]any, value, path string) error {
	length := float64(utf8.RuneCountInString(value))
	if minimum, ok := schemaNumber(schema["minLength"]); ok && length < minimum {
		return invalidArgument(path, "string is shorter than allowed")
	}
	if maximum, ok := schemaNumber(schema["maxLength"]); ok && length > maximum {
		return invalidArgument(path, "string is longer than allowed")
	}
	if pattern, ok := schema["pattern"].(string); ok {
		re, err := regexp.Compile(pattern)
		if err != nil {
			return fmt.Errorf("%w: invalid registered pattern", ErrInternal)
		}
		if !re.MatchString(value) {
			return invalidArgument(path, "string does not match the required pattern")
		}
	}
	if format, ok := schema["format"].(string); ok {
		switch format {
		case "uuid":
			if !uuidPattern.MatchString(value) {
				return invalidArgument(path, "string is not a valid UUID")
			}
		case "date-time":
			if _, err := time.Parse(time.RFC3339, value); err != nil {
				return invalidArgument(path, "string is not a valid RFC3339 date-time")
			}
		case "uri":
			parsed, err := url.Parse(value)
			if err != nil || parsed.Scheme == "" {
				return invalidArgument(path, "string is not a valid absolute URI")
			}
		}
	}
	return nil
}

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var propertyNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func validateNumber(schema map[string]any, value json.Number, path string) error {
	number, err := strconv.ParseFloat(value.String(), 64)
	if err != nil {
		return invalidArgument(path, "number is invalid")
	}
	if minimum, ok := schemaNumber(schema["minimum"]); ok && number < minimum {
		return invalidArgument(path, "number is below the allowed minimum")
	}
	if maximum, ok := schemaNumber(schema["maximum"]); ok && number > maximum {
		return invalidArgument(path, "number is above the allowed maximum")
	}
	return nil
}

func schemaNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case json.Number:
		n, err := strconv.ParseFloat(typed.String(), 64)
		return n, err == nil
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	default:
		return 0, false
	}
}

func isJSONInteger(number json.Number) bool {
	text := number.String()
	if !strings.ContainsAny(text, ".eE") {
		_, err := strconv.ParseInt(text, 10, 64)
		if err == nil {
			return true
		}
	}
	parsed, err := strconv.ParseFloat(text, 64)
	return err == nil && !math.IsInf(parsed, 0) && math.Trunc(parsed) == parsed
}

func childPath(parent, child string) string {
	if propertyNamePattern.MatchString(child) {
		return parent + "." + child
	}
	encoded, _ := json.Marshal(child)
	return parent + "[" + string(encoded) + "]"
}
