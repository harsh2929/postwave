// SPDX-License-Identifier: AGPL-3.0-only
//
// custom_field_policy.go — how an import treats mapped custom-field columns.
//
// Settings → Custom fields has a validator mode per workspace, and the import
// has its own "create new custom fields" choice (auto_create_properties). The
// two are resolved into one policy, and preflight and execution apply exactly
// the same policy:
//
//   - auto:   mapped keys the workspace has not declared are created as text
//             fields when the import runs, if the import opted in (the default
//             for a new upload). An import that opted out fails those rows with
//             unknown_custom_field naming the key.
//   - strict: nothing is ever created. Undeclared keys fail their rows with
//             unknown_custom_field; PATCH refuses to opt in.
//   - off:    legacy passthrough. No registration and no coercion: values land
//             as the raw strings from the file, as customfields.Validator does
//             for ModeOff.

package subscriber_import

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/customfields"
	"github.com/postwave/postwave/apps/api/internal/db"

	migratecsv "github.com/postwave/migrate/csv"
)

// customFieldImportPolicy is the resolved custom-field behaviour of one import.
type customFieldImportPolicy struct {
	// Mode is the workspace validator mode the policy was derived from.
	Mode customfields.Mode
	// JobAutoCreate is the import's own auto_create_properties choice.
	JobAutoCreate bool
	// AutoCreate registers undeclared mapped keys as text fields at run time.
	AutoCreate bool
	// Validate coerces values against the declared schema; false is ModeOff's
	// raw passthrough.
	Validate bool
	// resolved distinguishes a policy read from the workspace from the zero
	// value, which must never be mistaken for ModeOff's "don't validate".
	resolved bool
}

func customFieldImportPolicyFor(mode customfields.Mode, jobAutoCreate bool) customFieldImportPolicy {
	policy := customFieldImportPolicy{Mode: mode, JobAutoCreate: jobAutoCreate, resolved: true}
	switch mode {
	case customfields.ModeStrict:
		policy.Validate = true
	case customfields.ModeOff:
	default:
		policy.Mode = customfields.ModeAuto
		policy.AutoCreate = jobAutoCreate
		policy.Validate = true
	}
	return policy
}

// resolveCustomFieldImportPolicy reads the workspace's current validator mode.
// A failed read fails the caller: guessing a mode would let an import create
// schema a strict workspace forbids, or skip validation it requires.
func resolveCustomFieldImportPolicy(ctx context.Context, pool *db.Pool, tenantID string, jobAutoCreate bool) (customFieldImportPolicy, error) {
	mode, err := (&customfields.Repo{Pool: pool}).GetMode(ctx, tenantID)
	if err != nil {
		return customFieldImportPolicy{}, fmt.Errorf("read custom field mode: %w", err)
	}
	return customFieldImportPolicyFor(mode, jobAutoCreate), nil
}

// prepareCustomFieldSchema loads the immutable snapshot every row is validated
// against. Keys the import will create are overlaid as text fields so the
// preflight judges rows exactly as they will be written after creation. It
// returns nil when the mapping has no custom columns or the policy does not
// validate.
func prepareCustomFieldSchema(ctx context.Context, pool *db.Pool, tenantID string, mapping migratecsv.Mapping, policy customFieldImportPolicy) (*customfields.ReadOnlySchema, error) {
	if !policy.Validate || !hasMappedCustomFields(mapping) {
		return nil, nil
	}
	validator := &customfields.Validator{Repo: &customfields.Repo{Pool: pool}}
	return validator.PrepareReadOnly(ctx, tenantID, prospectiveStringKeys(mapping, policy.AutoCreate))
}

// suggestCustomFieldKeys gives every detected custom column a valid, unique
// property key (lower-case letters, digits and underscores, starting with a
// letter) so the preview's default mapping can be confirmed as it stands.
// DetectMapping only lower-cases and replaces spaces, which leaves keys such as
// "plan-type" or "2024 spend" that PATCH would reject.
func suggestCustomFieldKeys(m *migratecsv.Mapping) {
	used := make(map[string]struct{})
	for i := range m.Columns {
		column := &m.Columns[i]
		if column.Kind != migratecsv.KindCustom {
			continue
		}
		key := canonicalCustomKey(*column)
		if !validPropertyKey(key) {
			key = propertyKeyFromHeader(column.Name, column.Index)
		}
		key = uniquePropertyKey(key, used)
		used[key] = struct{}{}
		column.CustomKey = key
	}
}

func propertyKeyFromHeader(header string, index int) string {
	var b strings.Builder
	separated := true
	for _, r := range strings.ToLower(header) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			separated = false
			continue
		}
		if !separated {
			b.WriteByte('_')
			separated = true
		}
	}
	key := strings.TrimRight(b.String(), "_")
	if key == "" {
		return fmt.Sprintf("column_%d", index+1)
	}
	if key[0] < 'a' || key[0] > 'z' {
		key = "field_" + key
	}
	return trimPropertyKey(key, maxPropertyKeyLength)
}

const maxPropertyKeyLength = 64

func trimPropertyKey(key string, limit int) string {
	if len(key) > limit {
		key = key[:limit]
	}
	return strings.TrimRight(key, "_")
}

func uniquePropertyKey(key string, used map[string]struct{}) string {
	if _, taken := used[key]; !taken {
		return key
	}
	for n := 2; ; n++ {
		suffix := fmt.Sprintf("_%d", n)
		candidate := trimPropertyKey(key, maxPropertyKeyLength-len(suffix)) + suffix
		if _, taken := used[candidate]; !taken {
			return candidate
		}
	}
}

// customFieldPolicyBinding wraps the catalog bindings when the policy changes
// what the job flag alone used to mean: a strict workspace refusing the
// import's opt-in, or an off workspace skipping validation. Everywhere else the
// behaviour is exactly the pre-policy behaviour, and the fingerprint keeps the
// pre-policy encoding, so imports reviewed or scheduled before this release
// still confirm and run; a mode change that alters behaviour invalidates them.
type customFieldPolicyBinding struct {
	Version    string          `json:"version"`
	Mode       string          `json:"mode"`
	AutoCreate bool            `json:"auto_create"`
	Validate   bool            `json:"validate"`
	Fields     json.RawMessage `json:"fields"`
}

func bindCustomFieldPolicy(fields []byte, policy customFieldImportPolicy) []byte {
	if policy.Validate && policy.AutoCreate == policy.JobAutoCreate {
		return fields
	}
	raw, _ := json.Marshal(customFieldPolicyBinding{
		Version:    "subscriber-import-custom-field-policy/v1",
		Mode:       string(policy.Mode),
		AutoCreate: policy.AutoCreate,
		Validate:   policy.Validate,
		Fields:     fields,
	})
	return raw
}

// Row failure codes for mapped custom fields. Messages name the key and the
// field's declared shape, never the cell value: a value is customer data, and
// ErrTypeMismatch / ErrValueViolation embed it in their Error() text.
const (
	rowCodeUnknownCustomField    = "unknown_custom_field"
	rowCodeCustomFieldType       = "custom_field_type_mismatch"
	rowCodeCustomFieldValidation = "custom_field_validation_failed"
)

func customFieldRowFailure(err error, schema *customfields.ReadOnlySchema, policy customFieldImportPolicy) (string, string) {
	var unknown *customfields.ErrUnknownKey
	var mismatch *customfields.ErrTypeMismatch
	var violation *customfields.ErrValueViolation
	switch {
	case errors.As(err, &unknown):
		field := upperFirst(customFieldName(unknown.Key))
		if policy.Mode == customfields.ModeStrict {
			return rowCodeUnknownCustomField, field + " isn't defined, and this workspace only accepts defined custom fields. Add it under Settings › Custom fields, or skip the column."
		}
		return rowCodeUnknownCustomField, field + " isn't defined. Let the import create it, add it under Settings › Custom fields, or skip the column."
	case errors.As(err, &mismatch):
		return rowCodeCustomFieldType, fmt.Sprintf("The value for %s must be %s.",
			customFieldName(mismatch.Key), customFieldTypeExpectation(mismatch.Declared))
	case errors.As(err, &violation):
		field := customFieldName(violation.Key)
		def, _ := schema.Field(violation.Key)
		switch def.Type {
		case customfields.TypeEnum:
			return rowCodeCustomFieldValidation, fmt.Sprintf("The value for %s isn't one of the options set for it under Settings › Custom fields.", field)
		case customfields.TypeEmail, customfields.TypeURL, customfields.TypePhone, customfields.TypeRegion:
			return rowCodeCustomFieldValidation, fmt.Sprintf("The value for %s must be %s.", field, customFieldTypeExpectation(def.Type))
		default:
			return rowCodeCustomFieldValidation, fmt.Sprintf("The value for %s doesn't match the format set for it under Settings › Custom fields.", field)
		}
	default:
		return rowCodeCustomFieldValidation, "This row's custom field values couldn't be checked against the workspace's custom fields."
	}
}

// customFieldName quotes a key only when it is a valid property key. Anything
// else came from an unreviewed header and could itself be personal data, which
// the import error log must never store.
func customFieldName(key string) string {
	if validPropertyKey(key) {
		return fmt.Sprintf("custom field %q", key)
	}
	return "a mapped custom field"
}

func upperFirst(s string) string {
	if s == "" || s[0] < 'a' || s[0] > 'z' {
		return s
	}
	return string(s[0]-'a'+'A') + s[1:]
}

func customFieldTypeExpectation(t customfields.FieldType) string {
	switch t {
	case customfields.TypeNumber:
		return "a number"
	case customfields.TypeBoolean:
		return "true or false"
	case customfields.TypeDate:
		return "a date, such as 2026-09-15"
	case customfields.TypeArray:
		return "a list of values"
	case customfields.TypeObject:
		return "a set of named values"
	case customfields.TypeEmail:
		return "a valid email address"
	case customfields.TypeURL:
		return "a valid web address"
	case customfields.TypePhone:
		return "a valid phone number"
	case customfields.TypeRegion:
		return "a valid region code"
	default:
		return "text"
	}
}
