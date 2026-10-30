// SPDX-License-Identifier: AGPL-3.0-only
//
// templates.go is CRUD for omni_message_templates. Omnichannel campaign paths
// carry a message_template_id (FK to this table), but there was no way to
// create or manage the templates — the table was schema-only. This exposes
// list / upsert / delete so operators can author reusable per-channel message
// templates and bind them to paths.
package omnichannel

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/postwave/postwave/apps/api/internal/db"
)

var (
	templateChannels = []string{"email", "sms", "whatsapp", "rcs", "push"}
	templateStatuses = []string{"draft", "ready", "approval_required", "pending_approval", "approved", "rejected", "archived"}
	approvalStatuses = []string{"not_required", "required", "pending", "approved", "rejected", "revoked"}
)

func (r *Repo) ListTemplates(ctx context.Context, tenantID, channel string) ([]MessageTemplate, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, channel, name, status, subject, body_text, body_html,
       media, variables, provider_template_id, approval_status, created_at, updated_at
FROM omni_message_templates
WHERE tenant_id = $1::uuid AND ($2 = '' OR channel = $2)
ORDER BY channel, name`, tenantID, channel)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MessageTemplate{}
	for rows.Next() {
		t, err := scanTemplate(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

// GetTemplate loads one message template by id (tenant-scoped). Returns
// (nil, nil) when the id does not exist. Used by the live channel senders to
// resolve a path's content at dispatch time.
func (r *Repo) GetTemplate(ctx context.Context, tenantID, id string) (*MessageTemplate, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, channel, name, status, subject, body_text, body_html,
       media, variables, provider_template_id, approval_status, created_at, updated_at
FROM omni_message_templates
WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	return scanTemplate(rows)
}

// UpsertTemplate creates or updates a template keyed by (channel, name).
func (r *Repo) UpsertTemplate(ctx context.Context, tenantID string, in MessageTemplate) (*MessageTemplate, error) {
	if in.Name == "" {
		return nil, errInvalid("name")
	}
	if !allowedString(in.Channel, templateChannels) {
		return nil, errInvalid("channel")
	}
	in.Status = defaulted(in.Status, "draft")
	if !allowedString(in.Status, templateStatuses) {
		return nil, errInvalid("status")
	}
	in.ApprovalStatus = defaulted(in.ApprovalStatus, "not_required")
	if !allowedString(in.ApprovalStatus, approvalStatuses) {
		return nil, errInvalid("approval_status")
	}
	media, _ := json.Marshal(orEmpty(in.Media))
	if in.Variables == nil {
		in.Variables = []string{}
	}
	variables, _ := json.Marshal(in.Variables)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	return upsertTemplateInTx(ctx, tx, tenantID, in, media, variables)
}

// templateTx is the narrow transaction surface needed by UpsertTemplate. The
// interface keeps the commit/rollback contract directly unit-testable while a
// pgx.Tx remains the production implementation.
type templateTx interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

func upsertTemplateInTx(
	ctx context.Context,
	tx templateTx,
	tenantID string,
	in MessageTemplate,
	media, variables []byte,
) (*MessageTemplate, error) {
	// Rollback is a safe no-op after Commit. Keeping it deferred guarantees that
	// a scan error, commit error, or future early return never leaks an open
	// transaction or leaves an uncommitted write visible on the connection.
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO omni_message_templates
    (tenant_id, channel, name, status, subject, body_text, body_html, media,
     variables, provider_template_id, approval_status)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)
ON CONFLICT (tenant_id, channel, name) DO UPDATE SET
    status = EXCLUDED.status, subject = EXCLUDED.subject,
    body_text = EXCLUDED.body_text, body_html = EXCLUDED.body_html,
    media = EXCLUDED.media, variables = EXCLUDED.variables,
    provider_template_id = EXCLUDED.provider_template_id,
    approval_status = EXCLUDED.approval_status, updated_at = now()
RETURNING id::text, tenant_id::text, channel, name, status, subject, body_text, body_html,
       media, variables, provider_template_id, approval_status, created_at, updated_at`,
		tenantID, in.Channel, in.Name, in.Status, in.Subject, in.BodyText, in.BodyHTML,
		string(media), string(variables), in.ProviderTemplateID, in.ApprovalStatus)
	out, err := scanTemplate(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit message template: %w", err)
	}
	return out, nil
}

func (r *Repo) DeleteTemplate(ctx context.Context, tenantID, id string) error {
	return r.deleteByID(ctx, tenantID, "omni_message_templates", id)
}

func scanTemplate(row interface{ Scan(...any) error }) (*MessageTemplate, error) {
	var t MessageTemplate
	var media, variables []byte
	if err := row.Scan(&t.ID, &t.TenantID, &t.Channel, &t.Name, &t.Status, &t.Subject,
		&t.BodyText, &t.BodyHTML, &media, &variables, &t.ProviderTemplateID,
		&t.ApprovalStatus, &t.CreatedAt, &t.UpdatedAt); err != nil {
		return nil, err
	}
	t.Media = decodeMap(media)
	t.Variables = decodeStringSlice(variables)
	return &t, nil
}

func decodeStringSlice(raw []byte) []string {
	out := []string{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	return out
}
