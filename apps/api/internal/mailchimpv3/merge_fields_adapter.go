package mailchimpv3

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/merge_fields"
)

// MergeFieldSchemaStore is the canonical audience-field schema boundary used
// by both the native API and the Mailchimp compatibility facade. Keeping this
// interface on the facade makes handler behavior independently testable while
// ensuring production writes land in merge_field_schema, never the generic
// compatibility platform-state table.
type MergeFieldSchemaStore interface {
	ListSchema(context.Context, string) ([]merge_fields.MergeFieldSchema, error)
	CreateSchema(context.Context, string, merge_fields.SchemaInput) (*merge_fields.MergeFieldSchema, error)
	PatchSchema(context.Context, string, string, merge_fields.SchemaPatch) (*merge_fields.MergeFieldSchema, error)
	DeleteSchema(context.Context, string, string) error
}

type mailchimpMergeFieldInput struct {
	Tag          *string         `json:"tag"`
	Name         *string         `json:"name"`
	Type         *string         `json:"type"`
	Required     *bool           `json:"required"`
	Public       *bool           `json:"public"`
	DisplayOrder *int            `json:"display_order"`
	DefaultValue json.RawMessage `json:"default_value"`
	HelpText     *string         `json:"help_text"`
	Options      map[string]any  `json:"options"`
}

var (
	errMergeFieldSchemaUnavailable = errors.New("mailchimp merge-field schema store unavailable")
	errMergeFieldIDAmbiguous       = errors.New("mailchimp merge-field identifier is ambiguous")
	errCanonicalMergeFieldType     = errors.New("canonical merge-field type is unsupported")
)

func (d *Deps) ListMergeFields(w http.ResponseWriter, r *http.Request) {
	t, listID, ok := tenantAndList(w, r)
	if !ok {
		return
	}
	listID = canonicalMergeFieldListID(t.Slug, t.ID, listID)
	if d.MergeFields == nil {
		writeMergeFieldSchemaError(w, errMergeFieldSchemaUnavailable)
		return
	}
	schema, err := d.MergeFields.ListSchema(r.Context(), t.ID)
	if err != nil {
		writeMergeFieldSchemaError(w, err)
		return
	}
	items := make([]map[string]any, 0, len(schema))
	for _, field := range schema {
		item, mapErr := mailchimpMergeFieldFromSchema(listID, field)
		if mapErr != nil {
			writeMergeFieldSchemaError(w, mapErr)
			return
		}
		items = append(items, item)
	}

	// We intentionally do not synthesize FNAME/LNAME/ADDRESS/PHONE here.
	// Default fields are returned only when onboarding or a migration has
	// persisted them in the canonical schema. A read-only phantom field would
	// make member validation and the native audience-field editor disagree.
	writeJSON(w, http.StatusOK, map[string]any{
		"merge_fields": items,
		"list_id":      listID,
		"total_items":  len(items),
	})
}

func (d *Deps) CreateMergeField(w http.ResponseWriter, r *http.Request) {
	t, listID, ok := tenantAndList(w, r)
	if !ok {
		return
	}
	listID = canonicalMergeFieldListID(t.Slug, t.ID, listID)
	if d.MergeFields == nil {
		writeMergeFieldSchemaError(w, errMergeFieldSchemaUnavailable)
		return
	}
	var in mailchimpMergeFieldInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}

	tagSource := stringPointerValue(in.Tag)
	if tagSource == "" {
		tagSource = stringPointerValue(in.Name)
	}
	tag := normalizeMergeTag(tagSource)
	if tag == "" {
		writeMergeFieldSchemaError(w, fmt.Errorf("%w: tag or name is required", merge_fields.ErrInvalidInput))
		return
	}
	label := strings.TrimSpace(stringPointerValue(in.Name))
	if label == "" {
		label = tag
	}
	typ, err := canonicalMergeFieldType(stringPointerValue(in.Type), in.Options)
	if err != nil {
		writeMergeFieldSchemaError(w, err)
		return
	}
	if err := validateMailchimpMergeFieldMetadata(in, typ); err != nil {
		writeMergeFieldSchemaError(w, err)
		return
	}
	defaultValue, _, err := canonicalDefaultValue(in.DefaultValue)
	if err != nil {
		writeMergeFieldSchemaError(w, err)
		return
	}
	position := 0
	if in.DisplayOrder != nil {
		position = *in.DisplayOrder
	}
	required := false
	if in.Required != nil {
		required = *in.Required
	}
	created, err := d.MergeFields.CreateSchema(r.Context(), t.ID, merge_fields.SchemaInput{
		Key:          tag,
		Label:        label,
		Type:         string(typ),
		DefaultValue: defaultValue,
		Required:     required,
		Position:     position,
	})
	if err != nil {
		writeMergeFieldSchemaError(w, err)
		return
	}
	if created == nil {
		writeMergeFieldSchemaError(w, errMergeFieldSchemaUnavailable)
		return
	}
	out, err := mailchimpMergeFieldFromSchema(listID, *created)
	if err != nil {
		writeMergeFieldSchemaError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) GetMergeField(w http.ResponseWriter, r *http.Request) {
	t, listID, ok := tenantAndList(w, r)
	if !ok {
		return
	}
	listID = canonicalMergeFieldListID(t.Slug, t.ID, listID)
	field, err := d.resolveMergeField(r.Context(), t.ID, listID, chi.URLParam(r, "merge_id"))
	if err != nil {
		writeMergeFieldSchemaError(w, err)
		return
	}
	out, err := mailchimpMergeFieldFromSchema(listID, *field)
	if err != nil {
		writeMergeFieldSchemaError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) UpdateMergeField(w http.ResponseWriter, r *http.Request) {
	t, listID, ok := tenantAndList(w, r)
	if !ok {
		return
	}
	listID = canonicalMergeFieldListID(t.Slug, t.ID, listID)
	existing, err := d.resolveMergeField(r.Context(), t.ID, listID, chi.URLParam(r, "merge_id"))
	if err != nil {
		writeMergeFieldSchemaError(w, err)
		return
	}
	var in mailchimpMergeFieldInput
	if !decodeMailchimpJSON(w, r, &in) {
		return
	}
	if in.Tag != nil && !strings.EqualFold(canonicalMergeFieldTag(*in.Tag), existing.Key) {
		writeMergeFieldSchemaError(w, fmt.Errorf("%w: merge-field tags cannot be renamed", merge_fields.ErrInvalidInput))
		return
	}

	patch := merge_fields.SchemaPatch{}
	if in.Name != nil {
		patch.Label = in.Name
	}
	effectiveType := existing.Type
	if in.Type != nil {
		typ, typeErr := canonicalMergeFieldType(*in.Type, in.Options)
		if typeErr != nil {
			writeMergeFieldSchemaError(w, typeErr)
			return
		}
		typeString := string(typ)
		patch.Type = &typeString
		effectiveType = typ
	}
	if err := validateMailchimpMergeFieldMetadata(in, effectiveType); err != nil {
		writeMergeFieldSchemaError(w, err)
		return
	}
	if defaultValue, provided, defaultErr := canonicalDefaultValue(in.DefaultValue); defaultErr != nil {
		writeMergeFieldSchemaError(w, defaultErr)
		return
	} else if provided {
		patch.DefaultValue = &defaultValue
	}
	patch.Required = in.Required
	patch.Position = in.DisplayOrder

	if patch.Label == nil && patch.Type == nil && patch.DefaultValue == nil && patch.Required == nil && patch.Position == nil {
		out, mapErr := mailchimpMergeFieldFromSchema(listID, *existing)
		if mapErr != nil {
			writeMergeFieldSchemaError(w, mapErr)
			return
		}
		writeJSON(w, http.StatusOK, out)
		return
	}
	updated, err := d.MergeFields.PatchSchema(r.Context(), t.ID, existing.Key, patch)
	if err != nil {
		writeMergeFieldSchemaError(w, err)
		return
	}
	if updated == nil {
		writeMergeFieldSchemaError(w, errMergeFieldSchemaUnavailable)
		return
	}
	out, err := mailchimpMergeFieldFromSchema(listID, *updated)
	if err != nil {
		writeMergeFieldSchemaError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteMergeField(w http.ResponseWriter, r *http.Request) {
	t, listID, ok := tenantAndList(w, r)
	if !ok {
		return
	}
	listID = canonicalMergeFieldListID(t.Slug, t.ID, listID)
	existing, err := d.resolveMergeField(r.Context(), t.ID, listID, chi.URLParam(r, "merge_id"))
	if err != nil {
		writeMergeFieldSchemaError(w, err)
		return
	}
	if err := d.MergeFields.DeleteSchema(r.Context(), t.ID, existing.Key); err != nil {
		writeMergeFieldSchemaError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) resolveMergeField(ctx context.Context, tenantID, listID, raw string) (*merge_fields.MergeFieldSchema, error) {
	if d.MergeFields == nil {
		return nil, errMergeFieldSchemaUnavailable
	}
	schema, err := d.MergeFields.ListSchema(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	raw = strings.TrimSpace(raw)
	var match *merge_fields.MergeFieldSchema
	for i := range schema {
		field := schema[i]
		if !strings.EqualFold(raw, field.Key) &&
			!strings.EqualFold(raw, canonicalMergeFieldItemID(listID, field.Key)) &&
			raw != strconv.Itoa(stableMergeFieldNumber(listID+":"+field.Key)) &&
			raw != strconv.Itoa(stableNumber(listID+":"+field.Key)) {
			continue
		}
		if match != nil && match.Key != field.Key {
			return nil, errMergeFieldIDAmbiguous
		}
		match = &schema[i]
	}
	if match == nil {
		return nil, merge_fields.ErrNotFound
	}
	return match, nil
}

func canonicalMergeFieldListID(tenantSlug, tenantID, validatedListID string) string {
	if slug := strings.TrimSpace(tenantSlug); slug != "" {
		return slug
	}
	if id := strings.TrimSpace(tenantID); id != "" {
		return id
	}
	return validatedListID
}

func canonicalMergeFieldTag(raw string) string {
	return strings.ToUpper(strings.Trim(strings.TrimSpace(raw), "*|"))
}

func canonicalMergeFieldItemID(listID, key string) string {
	return listID + ":" + strings.ToLower(canonicalMergeFieldTag(key))
}

func stableMergeFieldNumber(raw string) int {
	digest := stableID(raw)
	parsed, err := strconv.ParseUint(digest[:8], 16, 32)
	if err != nil {
		return 1
	}
	// Mailchimp exposes merge_id as a positive signed integer. A 31-bit hash
	// keeps the identifier stable while avoiding the legacy helper's 1,000,000
	// value collision ceiling. resolveMergeField still accepts that legacy ID
	// so existing clients can migrate without an abrupt lookup failure.
	number := int(parsed & 0x7fffffff)
	if number == 0 {
		return 1
	}
	return number
}

func mailchimpMergeFieldFromSchema(listID string, field merge_fields.MergeFieldSchema) (map[string]any, error) {
	typ, err := mailchimpMergeFieldType(field.Type)
	if err != nil {
		return nil, err
	}
	options := map[string]any{}
	if field.Type == merge_fields.TypeBoolean {
		options["choices"] = []string{"true", "false"}
	}
	return map[string]any{
		"id":            canonicalMergeFieldItemID(listID, field.Key),
		"merge_id":      stableMergeFieldNumber(listID + ":" + field.Key),
		"list_id":       listID,
		"tag":           field.Key,
		"name":          field.Label,
		"type":          typ,
		"required":      field.Required,
		"public":        true,
		"display_order": field.Position,
		"default_value": field.DefaultValue,
		"help_text":     "",
		"options":       options,
		"created_at":    field.CreatedAt,
		"updated_at":    field.UpdatedAt,
	}, nil
}

func canonicalMergeFieldType(raw string, options map[string]any) (merge_fields.FieldType, error) {
	switch strings.ToLower(strings.TrimSpace(defaulted(raw, "text"))) {
	case "text":
		return merge_fields.TypeText, nil
	case "number":
		return merge_fields.TypeNumber, nil
	case "date":
		return merge_fields.TypeDate, nil
	case "address":
		return merge_fields.TypeAddress, nil
	case "phone":
		return merge_fields.TypePhone, nil
	case "boolean":
		return merge_fields.TypeBoolean, nil
	case "radio":
		if len(options) > 0 && !booleanRadioOptions(options) {
			return "", fmt.Errorf("%w: radio fields support only true/false choices", merge_fields.ErrInvalidInput)
		}
		return merge_fields.TypeBoolean, nil
	default:
		return "", fmt.Errorf("%w: supported types are text, number, boolean/radio, date, address, and phone", merge_fields.ErrInvalidInput)
	}
}

func mailchimpMergeFieldType(typ merge_fields.FieldType) (string, error) {
	switch typ {
	case merge_fields.TypeText:
		return "text", nil
	case merge_fields.TypeNumber:
		return "number", nil
	case merge_fields.TypeBoolean:
		return "radio", nil
	case merge_fields.TypeDate:
		return "date", nil
	case merge_fields.TypeAddress:
		return "address", nil
	case merge_fields.TypePhone:
		return "phone", nil
	default:
		return "", fmt.Errorf("%w: %s", errCanonicalMergeFieldType, typ)
	}
}

func validateMailchimpMergeFieldMetadata(in mailchimpMergeFieldInput, typ merge_fields.FieldType) error {
	if in.Public != nil && !*in.Public {
		return fmt.Errorf("%w: private merge fields are not supported", merge_fields.ErrInvalidInput)
	}
	if in.HelpText != nil && strings.TrimSpace(*in.HelpText) != "" {
		return fmt.Errorf("%w: help_text is not supported", merge_fields.ErrInvalidInput)
	}
	if len(in.Options) == 0 {
		return nil
	}
	if typ == merge_fields.TypeBoolean && booleanRadioOptions(in.Options) {
		return nil
	}
	return fmt.Errorf("%w: options are not supported for this merge-field type", merge_fields.ErrInvalidInput)
}

func booleanRadioOptions(options map[string]any) bool {
	if len(options) != 1 {
		return false
	}
	raw, ok := options["choices"]
	if !ok {
		return false
	}
	values := stringSliceFromAny(raw)
	if len(values) != 2 {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(values[0]), "true") &&
		strings.EqualFold(strings.TrimSpace(values[1]), "false")
}

func canonicalDefaultValue(raw json.RawMessage) (string, bool, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return "", false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", true, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return "", true, fmt.Errorf("%w: default_value is invalid", merge_fields.ErrInvalidInput)
	}
	switch typed := value.(type) {
	case string:
		return typed, true, nil
	case bool:
		return strconv.FormatBool(typed), true, nil
	case json.Number:
		return typed.String(), true, nil
	default:
		return "", true, fmt.Errorf("%w: default_value must be a string, number, boolean, or null", merge_fields.ErrInvalidInput)
	}
}

func stringPointerValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func writeMergeFieldSchemaError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, merge_fields.ErrNotFound):
		writeProblem(w, http.StatusNotFound, "Resource Not Found", "The requested merge field could not be found.")
	case errors.Is(err, merge_fields.ErrKeyConflict):
		writeProblem(w, http.StatusConflict, "Invalid Resource", "A merge field with that tag already exists.")
	case errors.Is(err, merge_fields.ErrFieldInUse):
		writeProblem(w, http.StatusConflict, "Invalid Resource", "This merge field has stored subscriber values.")
	case errors.Is(err, merge_fields.ErrSchemaLimit):
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "This audience has reached the 50 merge-field limit.")
	case errors.Is(err, merge_fields.ErrInvalidInput):
		writeProblem(w, http.StatusBadRequest, "Invalid Resource", "Merge field input is invalid.")
	case errors.Is(err, errMergeFieldIDAmbiguous):
		writeProblem(w, http.StatusConflict, "Invalid Resource", "The merge field identifier is ambiguous.")
	default:
		writeProblem(w, http.StatusInternalServerError, "Internal Server Error", "An internal error occurred.")
	}
}
