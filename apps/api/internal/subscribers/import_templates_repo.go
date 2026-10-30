// SPDX-License-Identifier: AGPL-3.0-only
//
// import_templates_repo.go — SUB-109 reusable import-mapping templates.
//
// A team that imports the same fixed-layout CSV every week (a nightly CRM
// dump, a Mailchimp export) shouldn't re-do the column->field mapping by hand
// on every run. This file is the persistence layer for named, tenant-scoped
// mapping templates (table subscriber_import_templates, migration 1336):
// SaveImportTemplate upserts by (tenant, name), ListImportTemplates returns
// the tenant's templates newest-first, and DeleteImportTemplate removes one.
//
// The mapping jsonb is byte-identical in shape to subscriber_imports.mapping
// so the wizard can drop a template straight onto a preview row without any
// translation.

package subscribers

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ImportTemplate is one saved column-mapping template.
type ImportTemplate struct {
	ID         string         `json:"id"`
	Name       string         `json:"name"`
	Mapping    map[string]any `json:"mapping"`
	SourceHint string         `json:"source_hint"`
	CreatedAt  time.Time      `json:"created_at"`
	UpdatedAt  time.Time      `json:"updated_at"`
}

// SaveImportTemplateInput is the create/update payload. Name is required;
// Mapping + SourceHint are optional (Mapping defaults to {} in the DB).
type SaveImportTemplateInput struct {
	Name       string         `json:"name"`
	Mapping    map[string]any `json:"mapping"`
	SourceHint string         `json:"source_hint"`
}

// SaveImportTemplate upserts a template by (tenant_id, name): a second save
// under the same name overwrites the mapping + source_hint and bumps
// updated_at, so "Save as template" with an existing name is an idempotent
// re-save rather than a duplicate-name error. The returned row carries the
// stored mapping (the DB default {} is materialised when Mapping is nil).
func (r *Repo) SaveImportTemplate(ctx context.Context, tenantID string, in SaveImportTemplateInput) (*ImportTemplate, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Marshal the mapping to jsonb. A nil/empty map becomes {} so the column
	// is always a well-formed object.
	mapping := in.Mapping
	if mapping == nil {
		mapping = map[string]any{}
	}
	mappingJSON, err := json.Marshal(mapping)
	if err != nil {
		return nil, err
	}

	var out ImportTemplate
	var mappingRaw []byte
	err = tx.QueryRow(ctx, `
INSERT INTO subscriber_import_templates (tenant_id, name, mapping, source_hint)
VALUES ($1::uuid, $2, $3::jsonb, $4)
ON CONFLICT (tenant_id, name) DO UPDATE
   SET mapping     = EXCLUDED.mapping,
       source_hint = EXCLUDED.source_hint,
       updated_at  = now()
RETURNING id::text, name, mapping, source_hint, created_at, updated_at`,
		tenantID, in.Name, mappingJSON, in.SourceHint,
	).Scan(&out.ID, &out.Name, &mappingRaw, &out.SourceHint, &out.CreatedAt, &out.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if err := unmarshalMapping(mappingRaw, &out); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListImportTemplates returns every template for the tenant, newest-first.
// Always returns a non-nil slice (empty when the tenant has none) so the
// JSON response is `[]` rather than `null`.
func (r *Repo) ListImportTemplates(ctx context.Context, tenantID string) ([]ImportTemplate, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT id::text, name, mapping, source_hint, created_at, updated_at
  FROM subscriber_import_templates
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC, id DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	out, err := scanImportTemplates(rows)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// DeleteImportTemplate removes one template by id. Returns ErrNotFound when
// no row matched (wrong id, or another tenant's id — RLS already clamps the
// DELETE to the caller's tenant, so a cross-tenant id simply affects 0 rows).
func (r *Repo) DeleteImportTemplate(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	ct, err := tx.Exec(ctx, `
DELETE FROM subscriber_import_templates
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func scanImportTemplates(rows pgx.Rows) ([]ImportTemplate, error) {
	defer rows.Close()
	out := []ImportTemplate{}
	for rows.Next() {
		var t ImportTemplate
		var mappingRaw []byte
		if err := rows.Scan(&t.ID, &t.Name, &mappingRaw, &t.SourceHint, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, err
		}
		if err := unmarshalMapping(mappingRaw, &t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// unmarshalMapping decodes the jsonb mapping bytes into t.Mapping, defaulting
// to an empty (non-nil) map when the column is null/empty so the JSON
// response is `{}` rather than `null`.
func unmarshalMapping(raw []byte, t *ImportTemplate) error {
	if len(raw) == 0 {
		t.Mapping = map[string]any{}
		return nil
	}
	m := map[string]any{}
	if err := json.Unmarshal(raw, &m); err != nil {
		return err
	}
	t.Mapping = m
	return nil
}

// normalizeTemplateName trims surrounding whitespace from a template name.
// The unique index is on the raw stored value, so trimming on the way in
// keeps "  Weekly  " and "Weekly" from creating two rows.
func normalizeTemplateName(s string) string { return strings.TrimSpace(s) }
