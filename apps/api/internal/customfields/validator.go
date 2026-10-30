// SPDX-License-Identifier: AGPL-3.0-only

package customfields

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// DataClassification is the SUB-057 schema-level data label attached to a
// custom field via FieldConfig.DataClassification. The policy engine reads it
// to enforce masking / retention / export / consent-filtering rules.
type DataClassification = string

// The closed data-classification taxonomy. Mirrors the migration 0549 CHECK
// constraint on config ->> 'data_classification'.
const (
	ClassificationPII       DataClassification = "pii"
	ClassificationPHI       DataClassification = "phi"
	ClassificationPCI       DataClassification = "pci"
	ClassificationSensitive DataClassification = "sensitive"
	ClassificationBusiness  DataClassification = "business"
	ClassificationNone      DataClassification = "none"
)

// validClassificationList is the operator-facing message listing every
// accepted data_classification value.
const validClassificationList = "pii, phi, pci, sensitive, business, none"

// isValidDataClassification reports whether s is one of the accepted
// data-classification values. The empty string is accepted (treated as
// unclassified) so a config that omits the field stays valid.
func isValidDataClassification(s string) bool {
	switch DataClassification(strings.ToLower(strings.TrimSpace(s))) {
	case "", ClassificationPII, ClassificationPHI, ClassificationPCI,
		ClassificationSensitive, ClassificationBusiness, ClassificationNone:
		return true
	}
	return false
}

// Mode controls how a Validator handles keys that aren't yet defined in
// tenant_custom_fields.
//
//	ModeStrict  — reject the write with a typed error. Use when the tenant
//	              wants their schema to be the source of truth.
//	ModeAuto    — register the missing key on the fly, inferring the type
//	              from the value. Ideal for migration imports + the
//	              first-90-days experience where forcing customers to
//	              pre-declare every field is friction.
//	ModeOff     — legacy passthrough; no validation, no auto-register.
//	              Kept for safety + ops emergencies (e.g. when the
//	              registry table itself is unhealthy).
type Mode string

const (
	ModeStrict Mode = "strict"
	ModeAuto   Mode = "auto"
	ModeOff    Mode = "off"
)

// DefaultMode is what the Validator falls back to when a tenant has no
// override. We bias toward Auto because the alternative (strict-by-default)
// would silently break existing migration importers that surface unknown
// MergeFields straight from the source platform.
const DefaultMode = ModeAuto

// ParseMode coerces an env-style string. Unknown values fall back to default.
func ParseMode(s string) Mode {
	switch Mode(strings.ToLower(strings.TrimSpace(s))) {
	case ModeStrict:
		return ModeStrict
	case ModeAuto:
		return ModeAuto
	case ModeOff:
		return ModeOff
	default:
		return DefaultMode
	}
}

// ErrUnknownKey is returned in ModeStrict when a write contains a key that
// has no matching row in tenant_custom_fields.
type ErrUnknownKey struct {
	Key string
}

func (e *ErrUnknownKey) Error() string {
	return fmt.Sprintf("custom field %q is not declared for this tenant (mode=strict)", e.Key)
}

// ErrTypeMismatch is returned when a value can't be coerced to the
// declared type (e.g. boolean field given the string "maybe").
type ErrTypeMismatch struct {
	Key      string
	Declared FieldType
	GotValue any
}

func (e *ErrTypeMismatch) Error() string {
	return fmt.Sprintf("custom field %q expects %s, got %T (%v)",
		e.Key, e.Declared, e.GotValue, e.GotValue)
}

// ErrValueViolation is returned by the richer-type validators (SUB-006) when
// a value is the right Go shape but violates the field's declared
// constraints — an enum value outside the option set, a string that fails the
// format check (email/url/phone) or the field's regex validation_rule, an
// array element of the wrong item type, or an object property that breaks the
// declared schema. It is distinct from ErrTypeMismatch so the handler can
// surface a "constraint violated" 422 with the specific reason.
type ErrValueViolation struct {
	Key    string
	Reason string
}

func (e *ErrValueViolation) Error() string {
	return fmt.Sprintf("custom field %q: %s", e.Key, e.Reason)
}

// Validator enforces the tenant_custom_fields schema against a free-form
// map[string]any (e.g. subscribers.custom_fields). It handles three things:
//
//  1. Unknown-key policy (strict / auto / off)
//  2. Type coercion (string "42" → number 42 when the declared type is number)
//  3. Soft normalisation (booleans accept "true"/"false"/"1"/"0",
//     dates accept RFC3339 strings)
//
// It is NOT a sanitiser — keys that pass validation are still written
// verbatim. The contract is "values are the right shape", not "values
// are clean".
type Validator struct {
	Repo *Repo
	// Mode is the *default* mode. Per-tenant overrides come from
	// tenants.custom_fields_mode (added in the same migration that
	// extends this validator). Empty defaults to DefaultMode.
	Mode Mode
}

// Validate normalises and (in Auto mode) auto-registers unknown keys.
// Returns the canonicalised map — callers should write THIS, not the
// input, so type coercions stick.
//
// A nil/empty input passes through as-is.
func (v *Validator) Validate(ctx context.Context, tenantID string, in map[string]any) (map[string]any, error) {
	if v == nil || len(in) == 0 {
		return in, nil
	}
	mode := v.resolveMode(ctx, tenantID)
	if mode == ModeOff {
		return in, nil
	}
	defs, err := v.loadDefs(ctx, tenantID)
	if err != nil {
		// Validator failures must not silently corrupt writes. Surface so
		// the caller can decide whether to retry or fail the request.
		return nil, fmt.Errorf("load custom field defs: %w", err)
	}
	out := make(map[string]any, len(in))
	var toRegister []registration
	for k, raw := range in {
		// Reserved internal keys (e.g. "_listmonk_id") that the system
		// stamps on subscribers must always pass through. They live in
		// the same jsonb blob but are not user-defined.
		if strings.HasPrefix(k, "_") {
			out[k] = raw
			continue
		}
		def, ok := defs[k]
		if !ok {
			if mode == ModeStrict {
				return nil, &ErrUnknownKey{Key: k}
			}
			// Auto: infer + queue for registration.
			inferred, err := inferType(k, raw)
			if err != nil {
				return nil, err
			}
			toRegister = append(toRegister, registration{
				Key: k, Type: inferred,
			})
			out[k] = raw // value already shaped — no coercion needed
			continue
		}
		coerced, err := coerceField(k, def, raw)
		if err != nil {
			return nil, err
		}
		out[k] = coerced
	}
	for _, reg := range toRegister {
		if err := v.autoRegister(ctx, tenantID, reg); err != nil {
			return nil, fmt.Errorf("auto-register %q: %w", reg.Key, err)
		}
	}
	return out, nil
}

// ValidateReadOnly performs deterministic schema validation without consulting
// a tenant's permissive mode and without auto-registering anything. Callers may
// provide prospectiveStringKeys for a separately reviewed auto-create step;
// those keys are treated as string definitions for this pass only. This is the
// import preflight/live parity surface: a dry run must never mutate schema.
func (v *Validator) ValidateReadOnly(ctx context.Context, tenantID string, in map[string]any, prospectiveStringKeys map[string]struct{}) (map[string]any, error) {
	if v == nil || len(in) == 0 {
		return in, nil
	}
	schema, err := v.PrepareReadOnly(ctx, tenantID, prospectiveStringKeys)
	if err != nil {
		return nil, err
	}
	return schema.Validate(in)
}

// ReadOnlySchema is an immutable tenant custom-field snapshot. Bulk callers
// prepare it once, then validate every row without re-querying the registry.
// This is particularly important for exhaustive imports, where per-row schema
// loads would otherwise turn one 250k-row preflight into 250k transactions.
type ReadOnlySchema struct {
	defs map[string]CustomField
}

// PrepareReadOnly loads a deterministic schema snapshot and overlays the
// separately reviewed prospective string keys used by import auto-create.
func (v *Validator) PrepareReadOnly(ctx context.Context, tenantID string, prospectiveStringKeys map[string]struct{}) (*ReadOnlySchema, error) {
	if v == nil || v.Repo == nil || v.Repo.Pool == nil {
		return nil, errors.New("custom field validator repository is unavailable")
	}
	defs, err := v.loadDefs(ctx, tenantID)
	if err != nil {
		return nil, fmt.Errorf("load custom field defs: %w", err)
	}
	for key := range prospectiveStringKeys {
		if _, exists := defs[key]; !exists {
			defs[key] = CustomField{Key: key, Type: TypeString}
		}
	}
	return &ReadOnlySchema{defs: defs}, nil
}

// Field returns the definition the snapshot validates key against, so a caller
// can explain a rejected value in terms of the field's settings (its type and
// constraints) instead of echoing the value, which may be personal data.
func (s *ReadOnlySchema) Field(key string) (CustomField, bool) {
	if s == nil {
		return CustomField{}, false
	}
	def, ok := s.defs[key]
	return def, ok
}

// Validate coerces one custom-field object against the prepared snapshot.
func (s *ReadOnlySchema) Validate(in map[string]any) (map[string]any, error) {
	if len(in) == 0 {
		return in, nil
	}
	if s == nil {
		return nil, errors.New("custom field schema snapshot is unavailable")
	}
	out := make(map[string]any, len(in))
	for key, raw := range in {
		if strings.HasPrefix(key, "_") {
			out[key] = raw
			continue
		}
		def, exists := s.defs[key]
		if !exists {
			return nil, &ErrUnknownKey{Key: key}
		}
		coerced, err := coerceField(key, def, raw)
		if err != nil {
			return nil, err
		}
		out[key] = coerced
	}
	return out, nil
}

// loadDefs returns a key→type map for the tenant. Cheap on the happy path
// (one query, indexed on tenant_id). We don't memoize because (a) defs
// change rarely so the query is small, (b) caching across requests adds
// stale-after-Create surprise, and (c) the call sits inside an existing
// tenant-scoped tx anyway.
func (v *Validator) loadDefs(ctx context.Context, tenantID string) (map[string]CustomField, error) {
	tx, err := db.WithTenant(ctx, v.Repo.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, key, label, type, config, validation_rule, created_at, updated_at
FROM tenant_custom_fields
WHERE tenant_id = $1::uuid`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]CustomField{}
	for rows.Next() {
		var f CustomField
		var configRaw []byte
		var validation *string
		if err := rows.Scan(&f.ID, &f.TenantID, &f.Key, &f.Label, &f.Type, &configRaw, &validation, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, err
		}
		if err := hydrateMeta(&f, configRaw, validation); err != nil {
			return nil, err
		}
		out[f.Key] = f
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// resolveMode reads the per-tenant override from tenants.custom_fields_mode
// when present; falls back to v.Mode; falls back to DefaultMode.
//
// We intentionally swallow read errors: a missing/inaccessible column
// should NOT block a subscriber upsert. The validator just degrades to
// the global default in that case.
func (v *Validator) resolveMode(ctx context.Context, tenantID string) Mode {
	tx, err := v.Repo.Pool.Begin(ctx)
	if err != nil {
		return v.fallbackMode()
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var raw *string
	err = tx.QueryRow(ctx,
		`SELECT custom_fields_mode FROM tenants WHERE id = $1::uuid`,
		tenantID,
	).Scan(&raw)
	if err != nil || raw == nil || *raw == "" {
		return v.fallbackMode()
	}
	return ParseMode(*raw)
}

func (v *Validator) fallbackMode() Mode {
	if v.Mode == "" {
		return DefaultMode
	}
	return v.Mode
}

// registration is one queued auto-register call.
type registration struct {
	Key  string
	Type FieldType
}

// autoRegister inserts a tenant_custom_fields row for a key the tenant
// hasn't declared yet. Idempotent: swallows ErrKeyConflict so concurrent
// writes registering the same key don't fight each other.
func (v *Validator) autoRegister(ctx context.Context, tenantID string, r registration) error {
	if err := validateKey(r.Key); err != nil {
		// Auto-register can't accept malformed keys (uppercase, dashes,
		// etc.). Better to fail the write with a clear error than to
		// silently drop the field. Tenants who want lax keys should run
		// in ModeOff.
		return fmt.Errorf("auto-register: %w", err)
	}
	label := defaultLabelForKey(r.Key)
	_, err := v.Repo.Create(ctx, tenantID, r.Key, label, r.Type)
	if err != nil && !isKeyConflict(err) {
		return err
	}
	return nil
}

func isKeyConflict(err error) bool {
	return err == ErrKeyConflict
}

// defaultLabelForKey turns "loyalty_tier" into "Loyalty Tier" so the
// auto-registered row has a presentable label for the admin UI without
// requiring the migration importer to invent one.
func defaultLabelForKey(k string) string {
	parts := strings.Split(k, "_")
	for i, p := range parts {
		if p == "" {
			continue
		}
		parts[i] = strings.ToUpper(p[:1]) + p[1:]
	}
	out := strings.Join(parts, " ")
	if len(out) > MaxLabelLength {
		out = out[:MaxLabelLength]
	}
	if out == "" {
		out = k
	}
	return out
}

// inferType picks a FieldType for an unknown key in Auto mode. We err on
// the side of "string" because it's the most permissive — coercion later
// can always promote a string to a number/bool if needed.
func inferType(_ string, raw any) (FieldType, error) {
	switch v := raw.(type) {
	case bool:
		return TypeBoolean, nil
	case float64, int, int32, int64:
		return TypeNumber, nil
	case time.Time:
		return TypeDate, nil
	case string:
		// Heuristic: a string that parses as RFC3339 is probably a date.
		// We keep this narrow on purpose — "123" is NOT auto-promoted
		// to a number because the caller might genuinely want it as a
		// string (e.g. zip codes, account ids).
		if _, err := time.Parse(time.RFC3339, v); err == nil {
			return TypeDate, nil
		}
		return TypeString, nil
	case nil:
		// A nil value carries no type signal. Default to string.
		return TypeString, nil
	default:
		// Maps, slices, etc. don't fit our four-type model. Reject so
		// the caller can flatten or stringify before retrying.
		return "", fmt.Errorf("custom field value of type %T is not supported (only string/number/boolean/date)", raw)
	}
}

// coerce normalises a value to its declared type. Returns the input
// untouched on a no-op match. Returns ErrTypeMismatch when nothing can
// reasonably be coerced.
func coerce(key string, t FieldType, raw any) (any, error) {
	if raw == nil {
		return nil, nil
	}
	switch t {
	case TypeString:
		// Anything stringifies. We avoid fmt.Sprint on []byte so we
		// don't accidentally render "[104 105]" for "hi".
		switch v := raw.(type) {
		case string:
			return v, nil
		case []byte:
			return string(v), nil
		case bool:
			if v {
				return "true", nil
			}
			return "false", nil
		case float64:
			return strconv.FormatFloat(v, 'f', -1, 64), nil
		case int:
			return strconv.Itoa(v), nil
		case int32:
			return strconv.FormatInt(int64(v), 10), nil
		case int64:
			return strconv.FormatInt(v, 10), nil
		case time.Time:
			return v.UTC().Format(time.RFC3339), nil
		default:
			return fmt.Sprint(v), nil
		}

	case TypeNumber:
		switch v := raw.(type) {
		case float64:
			return v, nil
		case int:
			return float64(v), nil
		case int32:
			return float64(v), nil
		case int64:
			return float64(v), nil
		case string:
			s := strings.TrimSpace(v)
			if s == "" {
				return nil, nil
			}
			f, err := strconv.ParseFloat(s, 64)
			if err != nil {
				return nil, &ErrTypeMismatch{Key: key, Declared: t, GotValue: raw}
			}
			return f, nil
		}
		return nil, &ErrTypeMismatch{Key: key, Declared: t, GotValue: raw}

	case TypeBoolean:
		switch v := raw.(type) {
		case bool:
			return v, nil
		case string:
			s := strings.ToLower(strings.TrimSpace(v))
			switch s {
			case "true", "1", "yes", "y", "t":
				return true, nil
			case "false", "0", "no", "n", "f", "":
				return false, nil
			}
		case float64:
			return v != 0, nil
		}
		return nil, &ErrTypeMismatch{Key: key, Declared: t, GotValue: raw}

	case TypeDate:
		switch v := raw.(type) {
		case time.Time:
			return v.UTC().Format(time.RFC3339), nil
		case string:
			s := strings.TrimSpace(v)
			if s == "" {
				return nil, nil
			}
			// Try a couple of common shapes before giving up.
			for _, layout := range []string{
				time.RFC3339,
				"2006-01-02",
				"2006-01-02T15:04:05",
				"2006-01-02 15:04:05",
			} {
				if ts, err := time.Parse(layout, s); err == nil {
					return ts.UTC().Format(time.RFC3339), nil
				}
			}
		}
		return nil, &ErrTypeMismatch{Key: key, Declared: t, GotValue: raw}
	}
	return nil, &ErrTypeMismatch{Key: key, Declared: t, GotValue: raw}
}

// coerceField is the richer-type-aware entry point (SUB-006). It dispatches
// on the field's declared Type: the four legacy scalars fall through to
// coerce() unchanged, while enum/array/object/email/url/phone/region get the
// new constraint-aware validators. The field's Config + ValidationRule drive
// the constraints.
func coerceField(key string, def CustomField, raw any) (any, error) {
	if raw == nil {
		return nil, nil
	}
	switch def.Type {
	case TypeString, TypeNumber, TypeBoolean, TypeDate:
		coerced, err := coerce(key, def.Type, raw)
		if err != nil {
			return nil, err
		}
		// A regex validation_rule may also be attached to a plain string.
		if def.Type == TypeString {
			if s, ok := coerced.(string); ok {
				if err := applyPattern(key, def, s); err != nil {
					return nil, err
				}
			}
		}
		return coerced, nil
	case TypeEnum:
		return coerceEnum(key, def, raw)
	case TypeArray:
		return coerceArray(key, def, raw)
	case TypeObject:
		return coerceObject(key, def, raw)
	case TypeEmail:
		return coerceFormat(key, def, raw, isEmail, "must be a valid email address")
	case TypeURL:
		return coerceFormat(key, def, raw, isURL, "must be a valid http(s) URL")
	case TypePhone:
		return coerceFormat(key, def, raw, isPhone, "must be a valid phone number")
	case TypeRegion:
		// Region is a free-text string subject only to an optional pattern.
		return coerceFormat(key, def, raw, func(string) bool { return true }, "")
	}
	return nil, &ErrTypeMismatch{Key: key, Declared: def.Type, GotValue: raw}
}

// coerceEnum validates a single value against the declared option set. The
// value is stringified (so 42 and "42" both match an option "42") and
// compared case-sensitively against Config.Options.
func coerceEnum(key string, def CustomField, raw any) (any, error) {
	s, err := coerce(key, TypeString, raw)
	if err != nil {
		return nil, err
	}
	str, _ := s.(string)
	opts := optionsOf(def)
	if len(opts) == 0 {
		return nil, &ErrValueViolation{Key: key, Reason: "enum field has no declared options"}
	}
	for _, o := range opts {
		if o == str {
			return str, nil
		}
	}
	return nil, &ErrValueViolation{
		Key:    key,
		Reason: fmt.Sprintf("value %q is not one of the allowed options [%s]", str, strings.Join(opts, ", ")),
	}
}

// coerceArray validates a slice, coercing each element to the declared
// item_type (defaulting to string when unset). Returns a new []any of
// coerced elements so type coercions stick.
func coerceArray(key string, def CustomField, raw any) (any, error) {
	arr, ok := raw.([]any)
	if !ok {
		return nil, &ErrTypeMismatch{Key: key, Declared: TypeArray, GotValue: raw}
	}
	itemType := TypeString
	if def.Config != nil && def.Config.ItemType != "" {
		if !isValidScalarType(def.Config.ItemType) {
			return nil, &ErrValueViolation{Key: key, Reason: fmt.Sprintf("array item_type %q is not a scalar type", def.Config.ItemType)}
		}
		itemType = FieldType(def.Config.ItemType)
	}
	out := make([]any, 0, len(arr))
	for i, el := range arr {
		c, err := coerce(fmt.Sprintf("%s[%d]", key, i), itemType, el)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, nil
}

// coerceObject validates a nested map against the declared schema (property
// name → scalar FieldType). Properties absent from the schema are passed
// through verbatim; declared properties are coerced. When no schema is
// declared the whole map passes through unchanged.
func coerceObject(key string, def CustomField, raw any) (any, error) {
	m, ok := raw.(map[string]any)
	if !ok {
		return nil, &ErrTypeMismatch{Key: key, Declared: TypeObject, GotValue: raw}
	}
	if def.Config == nil || len(def.Config.Schema) == 0 {
		return m, nil
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		typ, declared := def.Config.Schema[k]
		if !declared {
			out[k] = v
			continue
		}
		if !isValidScalarType(typ) {
			return nil, &ErrValueViolation{Key: key, Reason: fmt.Sprintf("object schema type %q for property %q is not a scalar type", typ, k)}
		}
		c, err := coerce(key+"."+k, FieldType(typ), v)
		if err != nil {
			return nil, err
		}
		out[k] = c
	}
	return out, nil
}

// coerceFormat validates a string-shaped scalar against a format predicate
// AND the optional field pattern / validation_rule. An empty string passes
// (the value is optional); a non-string is a type mismatch.
func coerceFormat(key string, def CustomField, raw any, ok func(string) bool, reason string) (any, error) {
	s, err := coerce(key, TypeString, raw)
	if err != nil {
		return nil, err
	}
	str, _ := s.(string)
	if strings.TrimSpace(str) == "" {
		return str, nil
	}
	if !ok(str) {
		return nil, &ErrValueViolation{Key: key, Reason: reason}
	}
	if err := applyPattern(key, def, str); err != nil {
		return nil, err
	}
	return str, nil
}

// applyPattern enforces Config.Pattern and ValidationRule (both regexes) when
// present. Either failing to compile or failing to match is a violation.
func applyPattern(key string, def CustomField, s string) error {
	patterns := make([]string, 0, 2)
	if def.Config != nil && strings.TrimSpace(def.Config.Pattern) != "" {
		patterns = append(patterns, def.Config.Pattern)
	}
	if strings.TrimSpace(def.ValidationRule) != "" {
		patterns = append(patterns, def.ValidationRule)
	}
	for _, p := range patterns {
		re, err := regexp.Compile(p)
		if err != nil {
			return &ErrValueViolation{Key: key, Reason: fmt.Sprintf("field pattern %q is not a valid regex: %v", p, err)}
		}
		if !re.MatchString(s) {
			return &ErrValueViolation{Key: key, Reason: fmt.Sprintf("value does not match required pattern %q", p)}
		}
	}
	return nil
}

func optionsOf(def CustomField) []string {
	if def.Config == nil {
		return nil
	}
	return def.Config.Options
}

func isValidScalarType(t string) bool {
	switch FieldType(t) {
	case TypeString, TypeNumber, TypeBoolean, TypeDate, TypeEmail, TypeURL, TypePhone, TypeRegion:
		return true
	}
	return false
}

var emailRE = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

func isEmail(s string) bool { return emailRE.MatchString(strings.TrimSpace(s)) }

func isURL(s string) bool {
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil {
		return false
	}
	return (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// phoneRE accepts an optional leading + and 7–15 digits, allowing spaces,
// dashes, dots, and parens as separators (stripped before counting).
var phoneDigitsRE = regexp.MustCompile(`^\+?[0-9]{7,15}$`)

func isPhone(s string) bool {
	cleaned := strings.NewReplacer(" ", "", "-", "", ".", "", "(", "", ")", "").Replace(strings.TrimSpace(s))
	return phoneDigitsRE.MatchString(cleaned)
}

// silence the unused-import lint when validator.go is built without
// the rest of the package. pgx is used inside loadDefs above.
var _ = pgx.ErrNoRows
