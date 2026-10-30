// SPDX-License-Identifier: AGPL-3.0-only
//
// SUB-072 — AI gateway / privacy firewall for prompts.
//
// gateway.go ties the pieces together:
//
//   - Repo: per-tenant pii_tokenization_config CRUD (migration 0560) and the
//     ephemeral pii_token_mappings reversal store (migration 0561), including a
//     TTL purge.
//   - BuildSensitiveValues: resolves the concrete sensitive values for a
//     subscriber from its identifiers + custom/merge fields against the tenant's
//     sensitivity config.
//   - WrapVoiceClient: a middleware adapter that sanitizes the prompt in-flight
//     before delegating to an inner Generate, then detokenizes the response. It
//     is generic over the model-call signature so the aicompose.VoiceClient and
//     llmactions executor can both wrap their calls without this package
//     importing either of them (keeps the dependency direction one-way).
//
// The gateway is deliberately fail-safe in one direction only: if config cannot
// be read we tokenize the built-in identifiers but skip the custom fields
// (never sending MORE than we would have anyway), and if a value set is empty
// the prompt passes through unchanged.

package pii_gateway

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Repo is the Postgres-backed store for the PII gateway. All methods bind
// app.tenant_id before touching the RLS-protected tables.
type Repo struct {
	Pool *db.Pool
}

// ErrNotFound is returned when a requested config/token row does not exist.
var ErrNotFound = errors.New("pii_gateway: not found")

// UpdateFieldInput is one field-sensitivity flag in a PATCH /settings/pii-config
// body. A nil Sensitive leaves the existing flag unchanged.
type UpdateFieldInput struct {
	FieldName string `json:"field_name"`
	Sensitive *bool  `json:"sensitive"`
}

// LoadConfig returns every field-sensitivity flag for the tenant. The built-in
// identifier fields (email/phone) are always implied sensitive by the sanitizer
// and are NOT required to have a row here; rows returned are the operator's
// explicit custom-field decisions plus any built_in rows the UI persisted.
func (r *Repo) LoadConfig(ctx context.Context, tenantID string) ([]FieldSensitivity, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT field_name, sensitive, built_in
  FROM pii_tokenization_config
 WHERE tenant_id = $1::uuid
 ORDER BY field_name ASC`, tenantID)
	if err != nil {
		return nil, err
	}
	out := []FieldSensitivity{}
	for rows.Next() {
		var f FieldSensitivity
		if err := rows.Scan(&f.FieldName, &f.Sensitive, &f.BuiltIn); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	return out, tx.Commit(ctx)
}

// UpsertConfig applies a batch of field-sensitivity flags and returns the full
// resolved config. Each input upserts one (tenant, field) row; a nil Sensitive
// is treated as true (the operator is adding a field they want protected).
func (r *Repo) UpsertConfig(ctx context.Context, tenantID string, in []UpdateFieldInput) ([]FieldSensitivity, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, f := range in {
		name := strings.ToLower(strings.TrimSpace(f.FieldName))
		if name == "" {
			continue
		}
		sensitive := true
		if f.Sensitive != nil {
			sensitive = *f.Sensitive
		}
		builtIn := isBuiltIn(name)
		if _, err := tx.Exec(ctx, `
INSERT INTO pii_tokenization_config (tenant_id, field_name, sensitive, built_in)
VALUES ($1::uuid, $2, $3, $4)
ON CONFLICT (tenant_id, field_name) DO UPDATE
   SET sensitive = EXCLUDED.sensitive,
       updated_at = now()`, tenantID, name, sensitive, builtIn); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.LoadConfig(ctx, tenantID)
}

// SaveTokenMapping persists one ephemeral token->value reversal for async
// detokenization (migration 0561). The TTL is owned by the column default.
func (r *Repo) SaveTokenMapping(ctx context.Context, tenantID, token, value, fieldKind string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO pii_token_mappings (tenant_id, token, value, field_kind)
VALUES ($1::uuid, $2, $3, $4)
ON CONFLICT (tenant_id, token) DO UPDATE
   SET value = EXCLUDED.value,
       field_kind = EXCLUDED.field_kind`, tenantID, token, value, fieldKind); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SaveTokenMappings persists a batch of token->value reversals (the registry's
// Mappings()). field_kind is left empty for batch persistence; the per-token
// kind is recoverable from the token itself.
func (r *Repo) SaveTokenMappings(ctx context.Context, tenantID string, mappings map[string]string) error {
	if len(mappings) == 0 {
		return nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for tok, val := range mappings {
		if _, err := tx.Exec(ctx, `
INSERT INTO pii_token_mappings (tenant_id, token, value, field_kind)
VALUES ($1::uuid, $2, $3, '')
ON CONFLICT (tenant_id, token) DO UPDATE
   SET value = EXCLUDED.value`, tenantID, tok, val); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// LookupToken returns the cleartext value for a token, honouring the TTL: an
// expired row is treated as absent (ErrNotFound). Used by the internal
// detokenization endpoint for an async completion.
func (r *Repo) LookupToken(ctx context.Context, tenantID, token string) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var value string
	err = tx.QueryRow(ctx, `
SELECT value
  FROM pii_token_mappings
 WHERE tenant_id = $1::uuid AND token = $2 AND expires_at > now()`, tenantID, token).Scan(&value)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	return value, tx.Commit(ctx)
}

// PurgeExpired deletes token mappings past their TTL across all tenants. Runs
// without a tenant GUC (it is a maintenance sweep); callers gate it to a
// privileged context. Returns the number of rows purged.
func (r *Repo) PurgeExpired(ctx context.Context) (int64, error) {
	tag, err := r.Pool.Exec(ctx, `DELETE FROM pii_token_mappings WHERE expires_at <= now()`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// BuildSensitiveValues resolves the concrete sensitive (kind, value) pairs for
// one subscriber, given the tenant's sensitivity set. email and phone are the
// built-in identifiers; customFields / mergeFields contribute any string-valued
// field whose key the tenant marked sensitive. Non-string field values are
// skipped (only scalar text can appear in a rendered prompt).
func BuildSensitiveValues(set *SensitiveFieldSet, email, phone string, customFields, mergeFields map[string]any) []KindValue {
	out := []KindValue{}
	if email != "" && (set == nil || set.IsSensitive("email")) {
		out = append(out, KindValue{Kind: "EMAIL", Value: email})
	}
	if phone != "" && (set == nil || set.IsSensitive("phone")) {
		out = append(out, KindValue{Kind: "PHONE", Value: phone})
	}
	collect := func(fields map[string]any) {
		for k, v := range fields {
			if !set.IsSensitive(k) {
				continue
			}
			s, ok := v.(string)
			if !ok || strings.TrimSpace(s) == "" {
				continue
			}
			out = append(out, KindValue{Kind: strings.ToUpper(k), Value: s})
		}
	}
	collect(customFields)
	collect(mergeFields)
	return out
}

// GenerateFunc is the model-call signature the gateway wraps. It is the common
// shape of aicompose.VoiceClient.Generate and the llmactions executor's model
// call, declared here so this package imports neither of them.
type GenerateFunc func(ctx context.Context, prompt string) (string, error)

// WrapVoiceClient returns a GenerateFunc that sanitizes the prompt with the
// supplied sanitizer before calling inner, then restores tokens in the
// response. A nil sanitizer (or one with no sensitive values) is a transparent
// pass-through, so wiring the gateway can never break a model call that has
// nothing to protect.
func WrapVoiceClient(s Sanitizer, inner GenerateFunc) GenerateFunc {
	return func(ctx context.Context, prompt string) (string, error) {
		if s == nil {
			return inner(ctx, prompt)
		}
		sanitized := s.Sanitize(prompt)
		resp, err := inner(ctx, sanitized)
		if err != nil {
			return resp, err
		}
		return s.Restore(resp), nil
	}
}

// SanitizeForTenant is a one-shot convenience that loads the tenant config,
// resolves the subscriber's sensitive values, and returns a request-scoped
// sanitizer plus the resolved value count. salt should be a per-request id. On
// a config-load error it falls back to the built-in identifiers only (fail
// safe: tokenize at least email/phone rather than leaking everything).
func (r *Repo) SanitizeForTenant(ctx context.Context, tenantID, salt, email, phone string, customFields, mergeFields map[string]any) (*ValueSanitizer, error) {
	cfg, err := r.LoadConfig(ctx, tenantID)
	var set *SensitiveFieldSet
	if err != nil {
		// Fail safe: built-ins only.
		set = NewSensitiveFieldSet(nil)
	} else {
		set = NewSensitiveFieldSet(cfg)
	}
	values := BuildSensitiveValues(set, email, phone, customFields, mergeFields)
	san := NewSanitizerFromKindValues(salt, values)
	if err != nil {
		return san, fmt.Errorf("pii_gateway: config load (fell back to built-ins): %w", err)
	}
	return san, nil
}
