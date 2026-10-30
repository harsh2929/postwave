// SPDX-License-Identifier: AGPL-3.0-only

package customobjects

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	maxTypeKeyBytes       = 64
	maxTypeLabelRunes     = 256
	maxTypeLabelBytes     = 1024
	maxPropertyKeyBytes   = 96
	maxExternalIDRunes    = 512
	maxExternalIDBytes    = 2048
	maxFilterValueRunes   = 1024
	maxFilterValueBytes   = 4096
	maxSchemaBytes        = 256 << 10
	maxPropertiesBytes    = 768 << 10
	maxSchemaDepth        = 20
	maxSchemaNodes        = 4096
	maxRecordDepth        = 32
	maxRecordNodes        = 20000
	maxJSONContainerItems = 1024
	maxJSONStringBytes    = 64 << 10
	maxRecordPageSize     = 500
	defaultRecordPageSize = 100
)

var (
	typeKeyPattern     = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
	propertyKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,95}$`)
)

// RequestValidationError is intentionally safe to return to a caller. It
// never embeds submitted schema values, record properties, or external IDs.
type RequestValidationError struct {
	Code    string
	Message string
}

func (e *RequestValidationError) Error() string { return e.Message }

func invalid(code, message string) error {
	return &RequestValidationError{Code: code, Message: message}
}

func validateCreateTypeParams(p *CreateTypeParams) error {
	if p == nil {
		return invalid("invalid_body", "A custom-object type body is required.")
	}
	if err := validateTypeKey(p.Key, "key"); err != nil {
		return err
	}
	if err := validateBoundedText(p.Label, "label", maxTypeLabelRunes, maxTypeLabelBytes); err != nil {
		return err
	}
	if p.PrimaryKey == "" {
		p.PrimaryKey = "external_id"
	}
	if err := validatePropertyKey(p.PrimaryKey, "primaryKey"); err != nil {
		return err
	}
	if len(p.Schema) == 0 {
		return invalid("invalid_schema", "Schema is required and must be a JSON object; use {} for an unconstrained type.")
	}
	schema, err := validateSchema(p.Schema)
	if err != nil {
		return err
	}
	if err := validatePrimaryKeySchema(p.PrimaryKey, schema); err != nil {
		return err
	}
	return nil
}

func validatePrimaryKeySchema(primaryKey string, schema map[string]any) error {
	if primaryKey == "external_id" {
		return nil
	}
	properties, ok := schema["properties"].(map[string]any)
	if !ok {
		return invalid("invalid_primary_key", "primaryKey must name a property declared by the schema.")
	}
	if _, exists := properties[primaryKey]; !exists {
		return invalid("invalid_primary_key", "primaryKey must name a property declared by the schema.")
	}
	return nil
}

func validateUpdatedSchemaPrimaryKey(primaryKey string, raw json.RawMessage) error {
	schema, err := validateSchema(raw)
	if err != nil {
		return err
	}
	return validatePrimaryKeySchema(primaryKey, schema)
}

func validateUpdateTypeParams(p UpdateTypeParams) error {
	if err := validateBoundedText(p.Label, "label", maxTypeLabelRunes, maxTypeLabelBytes); err != nil {
		return err
	}
	if !IsValidStatus(p.Status) {
		return invalid("invalid_status", "Status must be active, deprecated, or disabled.")
	}
	if len(p.Schema) == 0 {
		return invalid("invalid_schema", "Schema is required and must be a JSON object; use {} for an unconstrained type.")
	}
	if _, err := validateSchema(p.Schema); err != nil {
		return err
	}
	return validateExpectedVersion(p.ExpectedVersion, false)
}

func validateDeleteTypeParams(p DeleteTypeParams) error {
	if err := validateTypeKey(p.ConfirmationKey, "confirmationKey"); err != nil {
		return invalid("invalid_confirmation", "The immutable type key is required to confirm deletion.")
	}
	return validateExpectedVersion(p.ExpectedVersion, false)
}

func validateUpsertRecordParams(p UpsertRecordParams) error {
	if err := validateBoundedText(p.ExternalID, "externalId", maxExternalIDRunes, maxExternalIDBytes); err != nil {
		return err
	}
	if len(p.Properties) == 0 {
		return invalid("invalid_properties", "Properties are required and must be a JSON object; use {} for an empty record.")
	}
	if _, err := validateJSONObject(p.Properties, maxPropertiesBytes, maxRecordDepth, maxRecordNodes, "properties"); err != nil {
		return err
	}
	return validateExpectedVersion(p.ExpectedVersion, true)
}

func validateDeleteRecordParams(p DeleteRecordParams) error {
	if err := validateBoundedText(p.ConfirmationExternalID, "confirmationExternalId", maxExternalIDRunes, maxExternalIDBytes); err != nil {
		return invalid("invalid_confirmation", "The external ID is required to confirm record deletion.")
	}
	return validateExpectedVersion(p.ExpectedVersion, false)
}

func validateListRecordsFilter(f ListRecordsFilter) (ListRecordsFilter, error) {
	if f.Limit == 0 {
		f.Limit = defaultRecordPageSize
	}
	if f.Limit < 1 || f.Limit > maxRecordPageSize {
		return ListRecordsFilter{}, invalid("invalid_limit", "limit must be a whole number from 1 to 500.")
	}
	if (f.PropertyKey == "") != (f.PropertyValue == "") {
		return ListRecordsFilter{}, invalid("invalid_filter", "Property and value must be supplied together.")
	}
	if f.PropertyKey != "" {
		if err := validatePropertyKey(f.PropertyKey, "property"); err != nil {
			return ListRecordsFilter{}, err
		}
		if err := validateBoundedText(f.PropertyValue, "value", maxFilterValueRunes, maxFilterValueBytes); err != nil {
			return ListRecordsFilter{}, err
		}
	}
	return f, nil
}

func validateCanonicalUUID(raw string) error {
	if raw == "" || raw != strings.TrimSpace(raw) {
		return invalid("invalid_id", "The resource ID must be a canonical UUID.")
	}
	parsed, err := uuid.Parse(raw)
	if err != nil || parsed.String() != raw {
		return invalid("invalid_id", "The resource ID must be a canonical UUID.")
	}
	return nil
}

func validateTypeKey(value, field string) error {
	if !utf8.ValidString(value) || len(value) > maxTypeKeyBytes || !typeKeyPattern.MatchString(value) {
		return invalid("invalid_"+field, field+" must start with a lowercase letter and contain only lowercase letters, digits, or underscores (64 bytes maximum).")
	}
	return nil
}

func validatePropertyKey(value, field string) error {
	if !utf8.ValidString(value) || len(value) > maxPropertyKeyBytes || !propertyKeyPattern.MatchString(value) {
		return invalid("invalid_"+field, field+" must start with a letter or underscore and contain only letters, digits, underscores, or dashes (96 bytes maximum).")
	}
	return nil
}

func validateBoundedText(value, field string, maxRunes, maxBytes int) error {
	if value == "" || value != strings.TrimSpace(value) || !utf8.ValidString(value) ||
		utf8.RuneCountInString(value) > maxRunes || len(value) > maxBytes || hasControl(value) {
		return invalid("invalid_"+field, fmt.Sprintf("%s must be non-empty, trimmed, control-free text of at most %d characters.", field, maxRunes))
	}
	return nil
}

func hasControl(value string) bool {
	for _, r := range value {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

func validateExpectedVersion(version int64, allowAbsent bool) error {
	if allowAbsent && version == 0 {
		return nil
	}
	if version < 1 {
		return invalid("precondition_required", "expectedVersion must be the exact positive version loaded from the service.")
	}
	return nil
}

func validateSchema(raw json.RawMessage) (map[string]any, error) {
	if len(raw) > maxSchemaBytes {
		return nil, invalid("schema_too_large", "Schema must be 256 KiB or smaller.")
	}
	root, err := validateJSONObject(raw, maxSchemaBytes, maxSchemaDepth, maxSchemaNodes, "schema")
	if err != nil {
		return nil, err
	}
	if declared, ok := root["type"]; ok && declared != "object" {
		return nil, invalid("invalid_schema", "The root schema type must be object when it is declared.")
	}
	if err := validateSchemaNode(root, 0); err != nil {
		return nil, err
	}
	return root, nil
}

func validateJSONObject(raw json.RawMessage, maxBytes, maxDepth, maxNodes int, field string) (map[string]any, error) {
	if len(raw) == 0 || len(raw) > maxBytes || !json.Valid(raw) {
		return nil, invalid("invalid_"+field, field+" must be a bounded JSON object.")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, invalid("invalid_"+field, field+" must be a bounded JSON object.")
	}
	root, ok := value.(map[string]any)
	if !ok {
		return nil, invalid("invalid_"+field, field+" must be a JSON object.")
	}
	budget := maxNodes
	if err := walkJSON(root, 0, maxDepth, &budget); err != nil {
		return nil, invalid("invalid_"+field, field+" exceeds the supported JSON depth, size, or string limits.")
	}
	return root, nil
}

func walkJSON(value any, depth, maxDepth int, budget *int) error {
	if depth > maxDepth || *budget <= 0 {
		return errors.New("json budget exceeded")
	}
	(*budget)--
	switch typed := value.(type) {
	case map[string]any:
		if len(typed) > maxJSONContainerItems {
			return errors.New("object too large")
		}
		for key, child := range typed {
			if key == "" || !utf8.ValidString(key) || len(key) > maxPropertyKeyBytes || hasControl(key) {
				return errors.New("unsafe object key")
			}
			if err := walkJSON(child, depth+1, maxDepth, budget); err != nil {
				return err
			}
		}
	case []any:
		if len(typed) > maxJSONContainerItems {
			return errors.New("array too large")
		}
		for _, child := range typed {
			if err := walkJSON(child, depth+1, maxDepth, budget); err != nil {
				return err
			}
		}
	case string:
		if !utf8.ValidString(typed) || len(typed) > maxJSONStringBytes {
			return errors.New("string too large")
		}
	case json.Number:
		if _, err := strconv.ParseFloat(string(typed), 64); err != nil {
			return errors.New("invalid number")
		}
	case nil, bool:
		return nil
	default:
		return errors.New("unsupported json value")
	}
	return nil
}

func validateSchemaNode(node map[string]any, depth int) error {
	if depth > maxSchemaDepth {
		return invalid("invalid_schema", "Schema nesting exceeds the supported depth.")
	}
	if declared, ok := node["type"]; ok {
		typeName, ok := declared.(string)
		if !ok || !supportedSchemaType(typeName) {
			return invalid("invalid_schema", "Every declared schema type must be one of object, string, number, integer, boolean, or array.")
		}
	}

	properties := map[string]any(nil)
	if rawProperties, exists := node["properties"]; exists {
		var ok bool
		properties, ok = rawProperties.(map[string]any)
		if !ok || len(properties) > 256 {
			return invalid("invalid_schema", "Schema properties must be an object containing at most 256 fields.")
		}
		for name, rawChild := range properties {
			if err := validatePropertyKey(name, "property"); err != nil {
				return invalid("invalid_schema", "Every schema property must use a safe property key.")
			}
			child, ok := rawChild.(map[string]any)
			if !ok {
				return invalid("invalid_schema", "Every schema property definition must be a JSON object.")
			}
			if err := validateSchemaNode(child, depth+1); err != nil {
				return err
			}
		}
	}

	if rawRequired, exists := node["required"]; exists {
		required, ok := rawRequired.([]any)
		if !ok || len(required) > 256 {
			return invalid("invalid_schema", "Schema required must be an array containing at most 256 unique property names.")
		}
		seen := make(map[string]struct{}, len(required))
		for _, rawName := range required {
			name, ok := rawName.(string)
			if !ok || validatePropertyKey(name, "property") != nil {
				return invalid("invalid_schema", "Schema required must contain only safe property names.")
			}
			if _, duplicate := seen[name]; duplicate {
				return invalid("invalid_schema", "Schema required property names must be unique.")
			}
			seen[name] = struct{}{}
			if properties == nil {
				return invalid("invalid_schema", "Schema required names must also be declared in properties.")
			}
			if _, exists := properties[name]; !exists {
				return invalid("invalid_schema", "Schema required names must also be declared in properties.")
			}
		}
	}

	if rawItems, exists := node["items"]; exists {
		items, ok := rawItems.(map[string]any)
		if !ok {
			return invalid("invalid_schema", "Schema items must be a JSON object.")
		}
		if err := validateSchemaNode(items, depth+1); err != nil {
			return err
		}
	}
	if rawAdditional, exists := node["additionalProperties"]; exists {
		if _, ok := rawAdditional.(bool); !ok {
			return invalid("invalid_schema", "additionalProperties must be true or false.")
		}
	}
	if rawEnum, exists := node["enum"]; exists {
		enum, ok := rawEnum.([]any)
		if !ok || len(enum) == 0 || len(enum) > 100 {
			return invalid("invalid_schema", "Schema enum must contain between 1 and 100 values.")
		}
	}
	if err := validateLengthPair(node); err != nil {
		return err
	}
	if err := validateNumberPair(node); err != nil {
		return err
	}
	return nil
}

func supportedSchemaType(value string) bool {
	switch value {
	case "object", "string", "number", "integer", "boolean", "array":
		return true
	default:
		return false
	}
}

func validateLengthPair(node map[string]any) error {
	min, hasMin, err := nonNegativeIntegerKeyword(node, "minLength")
	if err != nil {
		return err
	}
	max, hasMax, err := nonNegativeIntegerKeyword(node, "maxLength")
	if err != nil {
		return err
	}
	if hasMin && hasMax && min > max {
		return invalid("invalid_schema", "minLength cannot be greater than maxLength.")
	}
	return nil
}

func nonNegativeIntegerKeyword(node map[string]any, name string) (int64, bool, error) {
	raw, exists := node[name]
	if !exists {
		return 0, false, nil
	}
	number, ok := raw.(json.Number)
	if !ok {
		return 0, false, invalid("invalid_schema", name+" must be a non-negative integer.")
	}
	value, err := strconv.ParseInt(string(number), 10, 64)
	if err != nil || value < 0 || value > 1_000_000 {
		return 0, false, invalid("invalid_schema", name+" must be a non-negative integer no greater than 1,000,000.")
	}
	return value, true, nil
}

func validateNumberPair(node map[string]any) error {
	min, hasMin, err := finiteNumberKeyword(node, "minimum")
	if err != nil {
		return err
	}
	max, hasMax, err := finiteNumberKeyword(node, "maximum")
	if err != nil {
		return err
	}
	if hasMin && hasMax && min > max {
		return invalid("invalid_schema", "minimum cannot be greater than maximum.")
	}
	return nil
}

func finiteNumberKeyword(node map[string]any, name string) (float64, bool, error) {
	raw, exists := node[name]
	if !exists {
		return 0, false, nil
	}
	number, ok := raw.(json.Number)
	if !ok {
		return 0, false, invalid("invalid_schema", name+" must be a finite number.")
	}
	value, err := strconv.ParseFloat(string(number), 64)
	if err != nil {
		return 0, false, invalid("invalid_schema", name+" must be a finite number.")
	}
	return value, true, nil
}
