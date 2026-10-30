// SPDX-License-Identifier: AGPL-3.0-only
//
// Package customfields implements the tenant custom-fields registry —
// the per-workspace schema layer that names + types the keys a tenant
// stores in subscribers.custom_fields (jsonb).
//
// Closes the OpenAPI/SDK ghost-route finding: POST /api/v1/custom-fields
// existed in the spec + sdk-ts but had no gateway handler.
package customfields

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// FieldType is the JSON-level value type we'll enforce for this field.
type FieldType string

const (
	TypeString  FieldType = "string"
	TypeNumber  FieldType = "number"
	TypeBoolean FieldType = "boolean"
	TypeDate    FieldType = "date"
	// Richer custom-attribute types (SUB-006). enum is a single-select over
	// a fixed option set; array is a homogeneous list; object is a nested
	// map; email/url/phone/region are format-validated scalar strings.
	TypeEnum   FieldType = "enum"
	TypeArray  FieldType = "array"
	TypeObject FieldType = "object"
	TypeEmail  FieldType = "email"
	TypeURL    FieldType = "url"
	TypePhone  FieldType = "phone"
	TypeRegion FieldType = "region"
)

func isValidType(t string) bool {
	switch FieldType(t) {
	case TypeString, TypeNumber, TypeBoolean, TypeDate,
		TypeEnum, TypeArray, TypeObject, TypeEmail, TypeURL, TypePhone, TypeRegion:
		return true
	}
	return false
}

// validTypeList is the operator-facing message listing every accepted type.
const validTypeList = "string, number, boolean, date, enum, array, object, email, url, phone, region"

// FieldConfig is the type-specific metadata attached to a custom field
// (SUB-006). It is stored as the jsonb `config` column on
// tenant_custom_fields and is nil for the legacy scalar types unless the
// tenant attaches flags. All members are optional; the validator reads only
// the ones relevant to the field's declared Type.
type FieldConfig struct {
	// Options enumerates the allowed values for an enum field.
	Options []string `json:"options,omitempty"`
	// ItemType is the element type for an array field (one of the scalar
	// FieldType values).
	ItemType string `json:"item_type,omitempty"`
	// Schema maps property name → scalar FieldType for an object field.
	Schema map[string]string `json:"schema,omitempty"`
	// Pattern is an optional regex applied to scalar string-shaped values
	// (string/email/url/phone/region). When set it must compile.
	Pattern string `json:"pattern,omitempty"`
	// PIIFlag marks the field as containing personally-identifiable
	// information (drives masking + export policy downstream).
	PIIFlag bool `json:"pii_flag,omitempty"`
	// EncryptionFlag requests at-rest encryption for the field's values.
	EncryptionFlag bool `json:"encryption_flag,omitempty"`
	// DataClassification is the SUB-057 schema-level data label
	// (pii / phi / pci / sensitive / business / none). It is the richer
	// successor to the PIIFlag boolean: the policy engine reads it to enforce
	// masking, retention, export, and consent-filtering rules downstream.
	// Empty or "none" means unclassified. Pinned to the closed taxonomy by
	// validateConfigShape + the migration 0549 CHECK constraint.
	DataClassification string `json:"data_classification,omitempty"`
	// Required marks the field mandatory in the admin UI (SETC-052). A
	// stored intent surfaced on forms; enforcement on subscriber upsert is
	// a separate policy concern.
	Required bool `json:"required,omitempty"`
	// Default is the JSON value pre-filled when the field is absent
	// (SETC-052). Validated against the field type / enum options.
	Default json.RawMessage `json:"default,omitempty"`
}

// CustomField is the persisted row.
type CustomField struct {
	ID       string    `json:"id"`
	TenantID string    `json:"tenant_id"`
	Key      string    `json:"key"`
	Label    string    `json:"label"`
	Type     FieldType `json:"type"`
	// Config carries the type-specific metadata (SUB-006). Nil when the
	// field has no extra config (the common scalar case).
	Config *FieldConfig `json:"config,omitempty"`
	// ValidationRule is an optional regex/format constraint applied at
	// write time. Empty for fields without a custom rule.
	ValidationRule string `json:"validation_rule,omitempty"`
	// Searchable marks the field as part of the indexed/searchable set
	// (SUB-015). Searchable fields count against the tenant's
	// max_searchable_fields cap.
	Searchable bool      `json:"searchable"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// CreateInput is the body of POST /api/v1/custom-fields.
type CreateInput struct {
	Key            string       `json:"key"`
	Label          string       `json:"label"`
	Type           string       `json:"type"`
	Config         *FieldConfig `json:"config,omitempty"`
	ValidationRule string       `json:"validation_rule,omitempty"`
	// Searchable opts the field into the indexed/searchable set (SUB-015).
	// Defaults false; when true the create is rejected if the tenant is at
	// its max_searchable_fields cap.
	Searchable bool `json:"searchable,omitempty"`
}

// UpdateInput is the body of PATCH /api/v1/custom-fields/{id} (SUB-006).
// Pointer fields distinguish "omitted" from "explicit". Only label, config,
// and validation_rule are mutable — key + type are immutable once created
// (changing them would silently invalidate stored values).
type UpdateInput struct {
	Label          *string      `json:"label"`
	Config         *FieldConfig `json:"config"`
	ValidationRule *string      `json:"validation_rule"`
}

// MaxKeyLength caps the machine-name field. Keys map 1:1 to JSONB
// property names on subscribers.custom_fields and surface in URLs +
// query strings, so unbounded keys are a footgun.
const MaxKeyLength = 64

// MaxLabelLength caps the display name.
const MaxLabelLength = 200

// keyRE matches the allowed shape for a custom-field key:
// lowercase letters, digits, and underscores; must start with a letter.
// This is intentionally strict — keys flow into JSONB property names and
// some downstream consumers expect identifier-like values.
func validateKey(s string) error {
	if s == "" {
		return errors.New("key required")
	}
	if len(s) > MaxKeyLength {
		return fmt.Errorf("key must be %d characters or fewer", MaxKeyLength)
	}
	for i, c := range s {
		first := i == 0
		ok := (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9' && !first) || c == '_'
		if !ok {
			return fmt.Errorf("key must be lowercase alphanumeric+underscore, starting with a letter (bad char at %d)", i)
		}
	}
	return nil
}

// ErrKeyConflict is returned by Create when a (tenant_id, key) pair
// already exists. Maps to 409 in the handler.
var ErrKeyConflict = errors.New("custom field key already exists")

// ErrNotFound is returned by Get when no row matches.
var ErrNotFound = errors.New("custom field not found")

// Repo wraps the pgx pool with tenant_custom_fields CRUD. RLS forces
// app.tenant_id to be set — every method goes through db.WithTenant.
type Repo struct {
	Pool *db.Pool
}

// Create inserts a new custom field. Returns ErrKeyConflict on (tenant_id, key)
// duplicates so the handler can surface 409.
//
// The variadic opts let auto-register (validator.go) keep calling Create with
// just the four positional args while the handler passes config +
// validation_rule. At most one opts entry is honoured.
func (r *Repo) Create(ctx context.Context, tenantID, key, label string, t FieldType, opts ...CreateMeta) (*CustomField, error) {
	var meta CreateMeta
	if len(opts) > 0 {
		meta = opts[0]
	}
	configRaw, err := marshalConfig(meta.Config)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// SUB-015: soft-limit enforcement. Counts existing fields inside this tx
	// (consistent with the INSERT) and returns ErrLimitExceeded before we
	// write when the tenant is at its max_custom_fields / max_searchable_fields
	// cap.
	if err := checkCreateLimit(ctx, tx, tenantID, meta.Searchable); err != nil {
		return nil, err
	}
	var f CustomField
	var configOut []byte
	var validationOut *string
	row := tx.QueryRow(ctx, `
INSERT INTO tenant_custom_fields (tenant_id, key, label, type, config, validation_rule, searchable)
VALUES ($1::uuid, $2, $3, $4, $5::jsonb, NULLIF($6, ''), $7)
RETURNING id::text, tenant_id::text, key, label, type, config, validation_rule, searchable, created_at, updated_at`,
		tenantID, key, label, string(t), configRaw, meta.ValidationRule, meta.Searchable)
	if err := row.Scan(&f.ID, &f.TenantID, &f.Key, &f.Label, &f.Type, &configOut, &validationOut, &f.Searchable, &f.CreatedAt, &f.UpdatedAt); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrKeyConflict
		}
		return nil, err
	}
	if err := hydrateMeta(&f, configOut, validationOut); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &f, nil
}

// CreateMeta carries the optional config + validation_rule + searchable flag
// for Create.
type CreateMeta struct {
	Config         *FieldConfig
	ValidationRule string
	// Searchable marks the new field as part of the searchable set (SUB-015).
	Searchable bool
}

// marshalConfig serialises a *FieldConfig to a jsonb-ready string, or ""
// (→ SQL NULL via the $5::jsonb cast of an empty string is invalid, so we
// pass the literal nil-equivalent). A nil config is stored as SQL NULL.
func marshalConfig(c *FieldConfig) (any, error) {
	if c == nil {
		return nil, nil
	}
	b, err := json.Marshal(c)
	if err != nil {
		return nil, fmt.Errorf("marshal config: %w", err)
	}
	return string(b), nil
}

// hydrateMeta decodes the scanned config jsonb + validation_rule into the
// CustomField struct fields.
func hydrateMeta(f *CustomField, configRaw []byte, validation *string) error {
	if len(configRaw) > 0 && string(configRaw) != "null" {
		var c FieldConfig
		if err := json.Unmarshal(configRaw, &c); err != nil {
			return fmt.Errorf("decode config: %w", err)
		}
		f.Config = &c
	}
	if validation != nil {
		f.ValidationRule = *validation
	}
	return nil
}

// Update patches a custom field's mutable metadata (label, config,
// validation_rule). key + type are immutable. Returns ErrNotFound when no
// row matches the tenant-scoped id.
func (r *Repo) Update(ctx context.Context, tenantID, id string, in UpdateInput) (*CustomField, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// COALESCE-style partial update driven by the three nullable params.
	// A nil pointer leaves the column untouched; an explicit value writes
	// it (config nil-pointer writes SQL NULL only when the key is present,
	// which we model by a sentinel jsonb on the SQL side).
	var (
		labelArg      *string
		configArg     any
		configSet     bool
		validationArg *string
		validationSet bool
	)
	if in.Label != nil {
		labelArg = in.Label
	}
	if in.Config != nil {
		raw, err := marshalConfig(in.Config)
		if err != nil {
			return nil, err
		}
		configArg = raw
		configSet = true
	}
	if in.ValidationRule != nil {
		validationArg = in.ValidationRule
		validationSet = true
	}

	var f CustomField
	var configOut []byte
	var validationOut *string
	row := tx.QueryRow(ctx, `
UPDATE tenant_custom_fields SET
    label = COALESCE($3, label),
    config = CASE WHEN $4::boolean THEN $5::jsonb ELSE config END,
    validation_rule = CASE WHEN $6::boolean THEN NULLIF($7, '') ELSE validation_rule END,
    updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING id::text, tenant_id::text, key, label, type, config, validation_rule, searchable, created_at, updated_at`,
		tenantID, id, labelArg, configSet, configArg, validationSet, derefOrEmpty(validationArg))
	if err := row.Scan(&f.ID, &f.TenantID, &f.Key, &f.Label, &f.Type, &configOut, &validationOut, &f.Searchable, &f.CreatedAt, &f.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "22P02" {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := hydrateMeta(&f, configOut, validationOut); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &f, nil
}

func derefOrEmpty(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// List returns every custom field for the tenant, oldest-first so admin
// UIs can show the order they were created.
func (r *Repo) List(ctx context.Context, tenantID string) ([]CustomField, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, key, label, type, config, validation_rule, searchable, created_at, updated_at
FROM tenant_custom_fields
WHERE tenant_id = $1::uuid
ORDER BY created_at ASC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CustomField{}
	for rows.Next() {
		var f CustomField
		var configRaw []byte
		var validation *string
		if err := rows.Scan(&f.ID, &f.TenantID, &f.Key, &f.Label, &f.Type, &configRaw, &validation, &f.Searchable, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, err
		}
		if err := hydrateMeta(&f, configRaw, validation); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// Delete removes a custom field by id. Returns ErrNotFound if no row
// matched (either the id is wrong OR the tenant scope rejects it via RLS).
func (r *Repo) Delete(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx,
		`DELETE FROM tenant_custom_fields WHERE id = $1::uuid`, id)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "22P02" {
			// Invalid UUID syntax — surface as not-found rather than 500.
			return ErrNotFound
		}
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// GetMode reads the tenant's custom_fields_mode override (the policy the
// validator applies on every subscriber upsert), defaulting to DefaultMode
// when unset. Tenant-scoped via RLS (db.WithTenant) so the read is confined
// to the caller's own tenants row.
func (r *Repo) GetMode(ctx context.Context, tenantID string) (Mode, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var raw *string
	if err := tx.QueryRow(ctx,
		`SELECT custom_fields_mode FROM tenants WHERE id = $1::uuid`,
		tenantID).Scan(&raw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	if raw == nil || *raw == "" {
		return DefaultMode, nil
	}
	return ParseMode(*raw), nil
}

// SetMode writes the tenant's custom_fields_mode override and returns the
// stored value. Tenant-scoped via RLS (db.WithTenant): the
// tenant_isolation_update policy's WITH CHECK restricts the write to the
// caller's own tenants row, so a forged tenantID can't reach another tenant.
func (r *Repo) SetMode(ctx context.Context, tenantID string, mode Mode) (Mode, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var raw *string
	if err := tx.QueryRow(ctx,
		`UPDATE tenants SET custom_fields_mode = $2 WHERE id = $1::uuid
		 RETURNING custom_fields_mode`,
		tenantID, string(mode)).Scan(&raw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	if raw == nil || *raw == "" {
		return DefaultMode, nil
	}
	return ParseMode(*raw), nil
}

// Deps bundles the repo for handler wiring.
type Deps struct {
	Repo *Repo
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// the underlying error server-side while returning a generic
	// envelope to the client. nil-safe at the call site.
	Logger *slog.Logger
}

const customFieldJSONMaxBodyBytes int64 = 32 << 10 // 32 KiB

// Create POST /api/v1/custom-fields
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, customFieldJSONMaxBodyBytes, &in); err != nil {
		// httpbody errors (bad_json / payload_too_large) author their own
		// operator-safe messages — safe to echo via the validation helper.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Key = strings.TrimSpace(in.Key)
	in.Label = strings.TrimSpace(in.Label)
	in.Type = strings.TrimSpace(in.Type)
	if err := validateKey(in.Key); err != nil {
		// validateKey returns operator-authored, sanitized messages.
		httperror.Write(w, http.StatusBadRequest, "invalid_key", err.Error())
		return
	}
	if in.Label == "" || len(in.Label) > MaxLabelLength {
		httperror.Write(w, http.StatusBadRequest, "invalid_label",
			fmt.Sprintf("label required, max %d characters", MaxLabelLength))
		return
	}
	if !isValidType(in.Type) {
		httperror.Write(w, http.StatusBadRequest, "invalid_type",
			"type must be one of: "+validTypeList)
		return
	}
	if err := validateConfig(FieldType(in.Type), in.Config); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_config", httperror.MessageForStatus(http.StatusBadRequest))
		return
	}
	if err := validateRule(in.ValidationRule); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_validation_rule", httperror.MessageForStatus(http.StatusBadRequest))
		return
	}
	f, err := d.Repo.Create(r.Context(), t.ID, in.Key, in.Label, FieldType(in.Type), CreateMeta{
		Config:         in.Config,
		ValidationRule: strings.TrimSpace(in.ValidationRule),
		Searchable:     in.Searchable,
	})
	if err != nil {
		if errors.Is(err, ErrKeyConflict) {
			httperror.Write(w, http.StatusConflict, "key_conflict",
				fmt.Sprintf("a custom field with key %q already exists", in.Key))
			return
		}
		if errors.Is(err, ErrLimitExceeded) {
			// SUB-015: well-formed request that violates a workspace
			// governance cap → 422. The wrapped message carries the
			// "used/max" detail so the client can surface it.
			httperror.Write(w, http.StatusUnprocessableEntity, "limit_exceeded", err.Error())
			return
		}
		// Unknown / pgx-shaped errors — never echo to client.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, f)
}

// Update PATCH /api/v1/custom-fields/{id} (SUB-006).
//
// Patches the mutable metadata (label, config, validation_rule). key + type
// are immutable: changing them would silently invalidate stored values, so
// they are not accepted here.
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := strings.TrimSpace(chiURLParam(r, "id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "id required"))
		return
	}
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, customFieldJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Label != nil {
		label := strings.TrimSpace(*in.Label)
		if label == "" || len(label) > MaxLabelLength {
			httperror.Write(w, http.StatusBadRequest, "invalid_label",
				fmt.Sprintf("label required, max %d characters", MaxLabelLength))
			return
		}
		in.Label = &label
	}
	// Config is validated against the row's *current* type. We don't know
	// the type until we read the row, so validate config shape independent
	// of type here (the type-specific checks run again in the validator at
	// write time) and let validateConfig accept any type by passing "".
	if in.Config != nil {
		if err := validateConfigShape(in.Config); err != nil {
			httperror.Write(w, http.StatusBadRequest, "invalid_config", httperror.MessageForStatus(http.StatusBadRequest))
			return
		}
	}
	if in.ValidationRule != nil {
		if err := validateRule(*in.ValidationRule); err != nil {
			httperror.Write(w, http.StatusBadRequest, "invalid_validation_rule", httperror.MessageForStatus(http.StatusBadRequest))
			return
		}
		rule := strings.TrimSpace(*in.ValidationRule)
		in.ValidationRule = &rule
	}
	f, err := d.Repo.Update(r.Context(), t.ID, id, in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "no such custom field")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, f)
}

// validateConfig checks that the supplied config is consistent with the
// declared field type (enum needs options, array's item_type must be a
// scalar, object's schema types must be scalar) and that any regex compiles.
func validateConfig(t FieldType, c *FieldConfig) error {
	if c == nil {
		return nil
	}
	if err := validateConfigShape(c); err != nil {
		return err
	}
	switch t {
	case TypeEnum:
		if len(c.Options) == 0 {
			return errors.New("enum field requires a non-empty config.options array")
		}
	case TypeArray:
		if c.ItemType != "" && !isValidScalarType(c.ItemType) {
			return fmt.Errorf("array config.item_type %q must be a scalar type", c.ItemType)
		}
	case TypeObject:
		for k, v := range c.Schema {
			if !isValidScalarType(v) {
				return fmt.Errorf("object config.schema[%q] type %q must be a scalar type", k, v)
			}
		}
	}
	// SETC-052: a supplied default must be valid JSON, and for an enum it
	// must be one of the declared options.
	if len(c.Default) > 0 {
		var v any
		if err := json.Unmarshal(c.Default, &v); err != nil {
			return fmt.Errorf("config.default must be valid JSON: %w", err)
		}
		if t == TypeEnum {
			s, ok := v.(string)
			match := false
			for _, opt := range c.Options {
				if opt == s {
					match = true
					break
				}
			}
			if !ok || !match {
				return errors.New("config.default must be one of config.options for an enum field")
			}
		}
	}
	return nil
}

// validateConfigShape runs the type-independent config checks: the regex
// pattern (if any) must compile, and the SUB-057 data_classification (if set)
// must be one of the closed taxonomy values. It also canonicalises
// data_classification to lowercase in place so the stored jsonb matches the
// migration 0549 CHECK constraint.
func validateConfigShape(c *FieldConfig) error {
	if c == nil {
		return nil
	}
	if strings.TrimSpace(c.Pattern) != "" {
		if _, err := regexp.Compile(c.Pattern); err != nil {
			return fmt.Errorf("config.pattern is not a valid regex: %v", err)
		}
	}
	if dc := strings.ToLower(strings.TrimSpace(c.DataClassification)); dc != c.DataClassification {
		c.DataClassification = dc
	}
	if !isValidDataClassification(c.DataClassification) {
		return fmt.Errorf("config.data_classification must be one of: %s", validClassificationList)
	}
	return nil
}

// validateRule confirms a validation_rule, when present, compiles as a regex.
func validateRule(rule string) error {
	rule = strings.TrimSpace(rule)
	if rule == "" {
		return nil
	}
	if _, err := regexp.Compile(rule); err != nil {
		return fmt.Errorf("validation_rule is not a valid regex: %v", err)
	}
	return nil
}

// List GET /api/v1/custom-fields
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	out, err := d.Repo.List(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Delete DELETE /api/v1/custom-fields/{id}
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := strings.TrimSpace(chiURLParam(r, "id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "id required"))
		return
	}
	if err := d.Repo.Delete(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "no such custom field")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// References GET /api/v1/custom-fields/{id}/references — where-used lookup so
// the delete dialog can warn about downstream segments/flows/forms (SETC-032).
func (d *Deps) References(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := strings.TrimSpace(chiURLParam(r, "id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "id required"))
		return
	}
	out, err := d.Repo.References(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "no such custom field")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ModeResponse is the wire shape of GET/PATCH /api/v1/custom-fields/mode.
type ModeResponse struct {
	CustomFieldsMode Mode `json:"custom_fields_mode"`
}

// ModeUpdate is the body of PATCH /api/v1/custom-fields/mode.
type ModeUpdate struct {
	CustomFieldsMode string `json:"custom_fields_mode"`
}

// GetMode GET /api/v1/custom-fields/mode — returns the tenant's validator
// mode (strict/auto/off), defaulting to auto when unset.
func (d *Deps) GetMode(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	mode, err := d.Repo.GetMode(r.Context(), t.ID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "tenant not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, ModeResponse{CustomFieldsMode: mode})
}

// UpdateMode PATCH /api/v1/custom-fields/mode — sets the tenant's validator
// mode. The mode governs what happens when a subscriber write carries an
// undeclared custom-field key (strict rejects, auto registers, off ignores).
func (d *Deps) UpdateMode(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in ModeUpdate
	if err := httpbody.DecodeJSON(w, r, customFieldJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	raw := strings.ToLower(strings.TrimSpace(in.CustomFieldsMode))
	switch Mode(raw) {
	case ModeStrict, ModeAuto, ModeOff:
		// valid
	default:
		httperror.Write(w, http.StatusBadRequest, "invalid_mode",
			"custom_fields_mode must be one of: strict, auto, off")
		return
	}
	mode, err := d.Repo.SetMode(r.Context(), t.ID, Mode(raw))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "tenant not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, ModeResponse{CustomFieldsMode: mode})
}

// chiURLParam isolates the chi import to one place; tests can call the
// handler directly with a context that already has the URL-param injected
// without dragging chi into this file otherwise. We use the chi struct
// to read the path param at runtime — the indirection here is just a
// place to swap a fake in unit tests.
func chiURLParam(r *http.Request, key string) string {
	return chiURLParamImpl(r, key)
}

// silence unused lint when no callers — pgx import is needed for the
// pgErr check inside Repo methods.
var _ = pgx.ErrNoRows

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
