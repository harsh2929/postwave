package merge_fields

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Repo wraps the pgx pool with merge_field_schema + merge_field_values
// CRUD. Every method goes through db.WithTenant so RLS fires.
type Repo struct {
	Pool *db.Pool
}

// validateKey enforces Mailchimp-style merge tags: A-Z 0-9 _, must
// start with a letter. We DON'T strip case in the input — operators
// upload schemas they paste from Mailchimp and rely on FNAME casing.
// We DO uppercase before persisting so the unique index is case-
// insensitive (Mailchimp parity — `fname` and `FNAME` collide).
func validateKey(s string) error {
	if s == "" {
		return fmt.Errorf("%w: key required", ErrInvalidInput)
	}
	if len(s) > MaxKeyLength {
		return fmt.Errorf("%w: key must be %d characters or fewer",
			ErrInvalidInput, MaxKeyLength)
	}
	for i, c := range s {
		first := i == 0
		ok := (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
			(c >= '0' && c <= '9' && !first) || c == '_'
		if !ok {
			return fmt.Errorf("%w: key must be [A-Za-z0-9_], starting with a letter (bad at %d)",
				ErrInvalidInput, i)
		}
	}
	return nil
}

func normalizeKey(s string) string {
	return strings.ToUpper(strings.TrimSpace(s))
}

// validateTypedValue keeps schema defaults and subscriber values coherent with
// the declared field type. Empty values are always valid because they mean
// "unset" and fall back to the schema default at read time.
func validateTypedValue(typ FieldType, value string) error {
	value = strings.TrimSpace(value)
	if utf8.RuneCountInString(value) > MaxValueLength {
		return fmt.Errorf("%w: value must be %d characters or fewer", ErrInvalidInput, MaxValueLength)
	}
	if value == "" {
		return nil
	}
	switch typ {
	case TypeNumber:
		parsed, err := strconv.ParseFloat(value, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return fmt.Errorf("%w: number values must be valid finite numbers", ErrInvalidInput)
		}
	case TypeBoolean:
		if value != "true" && value != "false" {
			return fmt.Errorf("%w: boolean values must be true or false", ErrInvalidInput)
		}
	case TypeDate:
		parsed, err := time.Parse("2006-01-02", value)
		if err != nil || parsed.Year() < 1 {
			return fmt.Errorf("%w: date values must use YYYY-MM-DD", ErrInvalidInput)
		}
	}
	return nil
}

// ListSchema returns every schema row for the tenant ordered by position ASC
// then created_at ASC (stable). Migration 1754 proves zero historical drift and
// enforces transactional mirrors, so declared-field usage is counted from the
// narrow sidecar index instead of rescanning every subscriber once per field.
func (r *Repo) ListSchema(ctx context.Context, tenantID string) ([]MergeFieldSchema, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
WITH value_counts AS MATERIALIZED (
	SELECT value.key, count(*)::bigint AS value_count
	  FROM merge_field_values value
	 WHERE value.tenant_id = $1::uuid
	 GROUP BY value.key
)
SELECT s.tenant_id::text, s.key, s.label, s.type, s.default_value, s.required, s.position,
	   COALESCE(value_counts.value_count, 0) AS value_count,
	   s.created_at::text, s.updated_at::text
  FROM merge_field_schema s
	LEFT JOIN value_counts ON value_counts.key = s.key
 WHERE s.tenant_id = $1::uuid
 ORDER BY s.position ASC, s.created_at ASC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MergeFieldSchema{}
	for rows.Next() {
		var m MergeFieldSchema
		var typ string
		if err := rows.Scan(&m.TenantID, &m.Key, &m.Label, &typ,
			&m.DefaultValue, &m.Required, &m.Position,
			&m.ValueCount,
			&m.CreatedAt, &m.UpdatedAt); err != nil {
			return nil, err
		}
		m.Type = FieldType(typ)
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// CreateSchema inserts one row. The tenant-scoped advisory lock serializes the
// count and insert across different keys, so concurrent creators cannot both
// observe the last free catalog slot. Returns ErrKeyConflict on duplicate and
// ErrSchemaLimit when the bounded catalog is full.
func (r *Repo) CreateSchema(ctx context.Context, tenantID string, in SchemaInput) (*MergeFieldSchema, error) {
	key := normalizeKey(in.Key)
	if err := validateKey(key); err != nil {
		return nil, err
	}
	label := strings.TrimSpace(in.Label)
	if label == "" || utf8.RuneCountInString(label) > MaxLabelLength {
		return nil, fmt.Errorf("%w: label required, max %d chars",
			ErrInvalidInput, MaxLabelLength)
	}
	typ := strings.ToLower(strings.TrimSpace(in.Type))
	if typ == "" {
		typ = string(TypeText)
	}
	if !isValidType(typ) {
		return nil, fmt.Errorf("%w: type must be one of text|number|boolean|date|address|phone",
			ErrInvalidInput)
	}
	defaultValue := strings.TrimSpace(in.DefaultValue)
	if err := validateTypedValue(FieldType(typ), defaultValue); err != nil {
		return nil, err
	}
	if in.Position < MinPosition || in.Position > MaxPosition {
		return nil, fmt.Errorf("%w: position must be between %d and %d", ErrInvalidInput, MinPosition, MaxPosition)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
SELECT pg_advisory_xact_lock(
	hashtextextended('merge-field-schema-cap:' || $1::uuid::text, 0)
)`, tenantID); err != nil {
		return nil, err
	}
	var fieldCount int
	var keyExists bool
	if err := tx.QueryRow(ctx, `
SELECT count(*)::int,
       EXISTS (
           SELECT 1
             FROM merge_field_schema existing
            WHERE existing.tenant_id = $1::uuid
              AND existing.key = $2
       )
  FROM merge_field_schema schema
 WHERE schema.tenant_id = $1::uuid`, tenantID, key).Scan(&fieldCount, &keyExists); err != nil {
		return nil, err
	}
	// Preserve duplicate-key semantics even when the catalog is full. This is
	// deterministic under the tenant lock and avoids turning a retried create
	// into a misleading quota response.
	if keyExists {
		return nil, ErrKeyConflict
	}
	if fieldCount >= MaxSchemaFields {
		return nil, ErrSchemaLimit
	}
	if _, err := tx.Exec(ctx, `
SELECT pg_advisory_xact_lock(merge_field_advisory_key($1::uuid, $2))`, tenantID, key); err != nil {
		return nil, err
	}
	var m MergeFieldSchema
	var got string
	err = tx.QueryRow(ctx, `
INSERT INTO merge_field_schema
    (tenant_id, key, label, type, default_value, required, position)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
RETURNING tenant_id::text, key, label, type, default_value, required, position,
          created_at::text, updated_at::text`,
		tenantID, key, label, typ, defaultValue, in.Required, in.Position).
		Scan(&m.TenantID, &m.Key, &m.Label, &got, &m.DefaultValue, &m.Required,
			&m.Position, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrKeyConflict
		}
		return nil, mapDatabaseError(err)
	}
	m.Type = FieldType(got)
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM merge_field_values value
 WHERE value.tenant_id = $1::uuid
   AND value.key = $2`, tenantID, key).Scan(&m.ValueCount); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &m, nil
}

// PatchSchema applies a partial update; nil fields are left alone.
func (r *Repo) PatchSchema(ctx context.Context, tenantID, key string, in SchemaPatch) (*MergeFieldSchema, error) {
	key = normalizeKey(key)
	if err := validateKey(key); err != nil {
		return nil, err
	}
	if in.Label != nil {
		l := strings.TrimSpace(*in.Label)
		if l == "" || utf8.RuneCountInString(l) > MaxLabelLength {
			return nil, fmt.Errorf("%w: label invalid", ErrInvalidInput)
		}
	}
	if in.Type != nil {
		if !isValidType(strings.ToLower(strings.TrimSpace(*in.Type))) {
			return nil, fmt.Errorf("%w: type invalid", ErrInvalidInput)
		}
	}
	if in.Position != nil && (*in.Position < MinPosition || *in.Position > MaxPosition) {
		return nil, fmt.Errorf("%w: position must be between %d and %d", ErrInvalidInput, MinPosition, MaxPosition)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var currentType string
	var currentDefault string
	// Lock the schema row first. The compatibility trigger uses the same
	// row-then-advisory order, avoiding subscriber/schema lock inversion.
	if err := tx.QueryRow(ctx, `
SELECT s.type, s.default_value
  FROM merge_field_schema s
 WHERE s.tenant_id = $1::uuid AND s.key = $2
 FOR UPDATE`, tenantID, key).Scan(&currentType, &currentDefault); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
SELECT pg_advisory_xact_lock(merge_field_advisory_key($1::uuid, $2))`, tenantID, key); err != nil {
		return nil, err
	}
	// A separate statement gets a fresh READ COMMITTED snapshot after any
	// writer that held a shared schema/advisory lock has committed.
	var valueCount int64
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM merge_field_values value
 WHERE value.tenant_id = $1::uuid
   AND value.key = $2`, tenantID, key).Scan(&valueCount); err != nil {
		return nil, err
	}
	effectiveType := FieldType(currentType)
	if in.Type != nil {
		effectiveType = FieldType(strings.ToLower(strings.TrimSpace(*in.Type)))
		if effectiveType != FieldType(currentType) && valueCount > 0 {
			return nil, ErrFieldInUse
		}
	}
	effectiveDefault := currentDefault
	if in.DefaultValue != nil {
		effectiveDefault = strings.TrimSpace(*in.DefaultValue)
	}
	if err := validateTypedValue(effectiveType, effectiveDefault); err != nil {
		return nil, mapDatabaseError(err)
	}
	var m MergeFieldSchema
	var got string
	row := tx.QueryRow(ctx, `
UPDATE merge_field_schema SET
    label         = COALESCE($3, label),
    type          = COALESCE($4, type),
    default_value = COALESCE($5, default_value),
    required      = COALESCE($6, required),
    position      = COALESCE($7, position),
    updated_at    = now()
 WHERE tenant_id = $1::uuid AND key = $2
RETURNING tenant_id::text, key, label, type, default_value, required, position,
          created_at::text, updated_at::text`,
		tenantID, key,
		strPtr(in.Label), lowerStrPtr(in.Type), strPtr(in.DefaultValue),
		boolPtr(in.Required), intPtr(in.Position))
	if err := row.Scan(&m.TenantID, &m.Key, &m.Label, &got, &m.DefaultValue,
		&m.Required, &m.Position, &m.CreatedAt, &m.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	m.Type = FieldType(got)
	m.ValueCount = valueCount
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &m, nil
}

// DeleteSchema removes an unused schema row. Existing values are never
// cascaded silently: operators must explicitly clear or migrate them first.
func (r *Repo) DeleteSchema(ctx context.Context, tenantID, key string) error {
	key = normalizeKey(key)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// See PatchSchema: row lock, exclusive advisory lock, then a fresh count.
	var existingKey string
	if err := tx.QueryRow(ctx, `
SELECT s.key
  FROM merge_field_schema s
 WHERE s.tenant_id = $1::uuid AND s.key = $2
 FOR UPDATE`, tenantID, key).Scan(&existingKey); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if _, err := tx.Exec(ctx, `
SELECT pg_advisory_xact_lock(merge_field_advisory_key($1::uuid, $2))`, tenantID, key); err != nil {
		return err
	}
	var valueCount int64
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM merge_field_values value
 WHERE value.tenant_id = $1::uuid
   AND value.key = $2`, tenantID, key).Scan(&valueCount); err != nil {
		return err
	}
	if valueCount > 0 {
		return ErrFieldInUse
	}
	tag, err := tx.Exec(ctx,
		`DELETE FROM merge_field_schema WHERE tenant_id = $1::uuid AND key = $2`,
		tenantID, key)
	if err != nil {
		return mapDatabaseError(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// GetSubscriberValues returns a key→value map (applying schema defaults
// for unset keys so the caller can render a fully-populated form).
func (r *Repo) GetSubscriberValues(ctx context.Context, tenantID, subscriberID string) (map[string]any, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var canonicalJSON []byte
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(merge_fields, '{}'::jsonb)::text::bytea
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID).Scan(&canonicalJSON); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	canonical := map[string]any{}
	if err := json.Unmarshal(canonicalJSON, &canonical); err != nil {
		return nil, fmt.Errorf("decode canonical merge fields: %w", err)
	}
	rows, err := tx.Query(ctx, `
SELECT s.key, s.type, s.default_value, v.value
  FROM merge_field_schema s
  LEFT JOIN merge_field_values v
    ON v.tenant_id = s.tenant_id
   AND v.key = s.key
   AND v.subscriber_id = $2::uuid
 WHERE s.tenant_id = $1::uuid
 ORDER BY s.position ASC, s.created_at ASC`, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]any{}
	for rows.Next() {
		var k, typ, defaultValue string
		var sidecarValue *string
		if err := rows.Scan(&k, &typ, &defaultValue, &sidecarValue); err != nil {
			return nil, err
		}
		value := defaultValue
		if raw, ok := canonical[k]; ok {
			canonicalValue, normalizeErr := normalizeSubscriberValue(raw)
			if normalizeErr != nil {
				return nil, fmt.Errorf("canonical merge field %s: %w", k, normalizeErr)
			}
			if canonicalValue != "" {
				if err := validateTypedValue(FieldType(typ), canonicalValue); err != nil {
					return nil, fmt.Errorf("canonical merge field %s: %w", k, err)
				}
				value = canonicalValue
			}
		} else if sidecarValue != nil {
			if err := validateTypedValue(FieldType(typ), *sidecarValue); err != nil {
				return nil, fmt.Errorf("legacy merge field %s: %w", k, err)
			}
			value = *sidecarValue
		}
		out[k] = value
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// PatchSubscriberValues upserts {key:value} pairs for the subscriber.
// Setting a value to "" clears it (delete row). Unknown keys are
// rejected so the schema stays the source of truth.
func (r *Repo) PatchSubscriberValues(ctx context.Context, tenantID, subscriberID string, in map[string]any) (map[string]any, error) {
	if len(in) == 0 {
		return r.GetSubscriberValues(ctx, tenantID, subscriberID)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Lock the canonical subscriber row for the full validation + dual-write so
	// a concurrent import/profile/bulk update cannot be overwritten by a stale
	// read-modify-write sequence.
	var lockedSubscriberID string
	if err := tx.QueryRow(ctx, `
SELECT id::text FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, tenantID, subscriberID).Scan(&lockedSubscriberID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	// Validate every key exists in schema and retain its declared type so the
	// stored representation cannot drift away from the editor contract.
	keys := make([]string, 0, len(in))
	seenKeys := make(map[string]struct{}, len(in))
	for k := range in {
		key := normalizeKey(k)
		if _, exists := seenKeys[key]; exists {
			return nil, fmt.Errorf("%w: duplicate normalized key %s", ErrInvalidInput, key)
		}
		seenKeys[key] = struct{}{}
		keys = append(keys, key)
	}
	slices.Sort(keys)
	rows, err := tx.Query(ctx, `
SELECT key, type, required FROM merge_field_schema
 WHERE tenant_id = $1::uuid AND key = ANY($2::text[])
 ORDER BY key
 FOR SHARE`, tenantID, keys)
	if err != nil {
		return nil, err
	}
	type fieldDefinition struct {
		Type     FieldType
		Required bool
	}
	fieldDefinitions := make(map[string]fieldDefinition, len(keys))
	for rows.Next() {
		var key, typ string
		var required bool
		if err := rows.Scan(&key, &typ, &required); err != nil {
			rows.Close()
			return nil, err
		}
		fieldDefinitions[key] = fieldDefinition{Type: FieldType(typ), Required: required}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	for _, key := range keys {
		if _, err := tx.Exec(ctx, `
SELECT pg_advisory_xact_lock_shared(merge_field_advisory_key($1::uuid, $2))`, tenantID, key); err != nil {
			return nil, err
		}
	}
	// A creator may have committed while a missing key waited on its advisory
	// lock. Re-read after lock acquisition before deciding it is unknown.
	if len(fieldDefinitions) != len(keys) {
		rows, err = tx.Query(ctx, `
SELECT key, type, required FROM merge_field_schema
 WHERE tenant_id = $1::uuid AND key = ANY($2::text[])
 ORDER BY key
 FOR SHARE`, tenantID, keys)
		if err != nil {
			return nil, err
		}
		fieldDefinitions = make(map[string]fieldDefinition, len(keys))
		for rows.Next() {
			var key, typ string
			var required bool
			if err := rows.Scan(&key, &typ, &required); err != nil {
				rows.Close()
				return nil, err
			}
			fieldDefinitions[key] = fieldDefinition{Type: FieldType(typ), Required: required}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	if len(fieldDefinitions) != len(keys) {
		return nil, fmt.Errorf("%w: one or more keys not in schema", ErrInvalidInput)
	}
	for k, raw := range in {
		key := normalizeKey(k)
		val, err := normalizeSubscriberValue(raw)
		if err != nil {
			return nil, fmt.Errorf("%w for %s", err, key)
		}
		definition := fieldDefinitions[key]
		if definition.Required && val == "" {
			return nil, fmt.Errorf("%w: %s is required and cannot be cleared", ErrInvalidInput, key)
		}
		if err := validateTypedValue(definition.Type, val); err != nil {
			return nil, fmt.Errorf("%w for %s", err, key)
		}
		if val == "" {
			if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET merge_fields = COALESCE(merge_fields, '{}'::jsonb) - $3,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
				tenantID, subscriberID, key); err != nil {
				return nil, mapDatabaseError(err)
			}
			continue
		}
		if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET merge_fields = COALESCE(merge_fields, '{}'::jsonb) || jsonb_build_object($3::text, $4::text),
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
			tenantID, subscriberID, key, val); err != nil {
			return nil, mapDatabaseError(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetSubscriberValues(ctx, tenantID, subscriberID)
}

// stringifyValue is the durable representation we persist. We keep
// values as text on the wire — the type column on the schema row tells
// the renderer how to parse it. This matches what Mailchimp does for
// merge tags (everything is a string in the tag substitution).
func stringifyValue(v any) string {
	if v == nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		// JSON numbers decode as float64 in Go's encoding/json. Trim
		// the trailing `.0` so integers render cleanly.
		if x == float64(int64(x)) {
			return fmt.Sprintf("%d", int64(x))
		}
		return fmt.Sprintf("%g", x)
	default:
		raw, _ := json.Marshal(v)
		return string(raw)
	}
}

// normalizeSubscriberValue rejects composite JSON. Every declared audience
// field is scalar; serializing an object/array into text would silently bypass
// its schema and make template output surprising.
func normalizeSubscriberValue(v any) (string, error) {
	if v == nil {
		return "", nil
	}
	switch v.(type) {
	case string, bool, float64, json.Number:
		return stringifyValue(v), nil
	default:
		return "", fmt.Errorf("%w: merge-field values must be scalar", ErrInvalidInput)
	}
}

func strPtr(p *string) any {
	if p == nil {
		return nil
	}
	return strings.TrimSpace(*p)
}

func lowerStrPtr(p *string) any {
	if p == nil {
		return nil
	}
	return strings.ToLower(strings.TrimSpace(*p))
}

func boolPtr(p *bool) any {
	if p == nil {
		return nil
	}
	return *p
}

func intPtr(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func isUniqueViolation(err error) bool {
	type sqlStater interface{ SQLState() string }
	var pgerr sqlStater
	if errors.As(err, &pgerr) {
		return pgerr.SQLState() == "23505"
	}
	return false
}

func mapDatabaseError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	switch pgErr.Code {
	case "PW001":
		return fmt.Errorf("%w: %s", ErrInvalidInput, pgErr.Message)
	case "PW002":
		return ErrFieldInUse
	default:
		return err
	}
}
