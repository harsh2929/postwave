// SPDX-License-Identifier: AGPL-3.0-only
package whatsappsend

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var (
	// ErrNotFound is returned when a whatsapp_message_templates row does not
	// exist for the tenant.
	ErrNotFound = errors.New("whatsappsend: not found")
	// ErrInvalidInput is returned for caller-supplied validation failures.
	ErrInvalidInput = errors.New("whatsappsend: invalid input")
)

var templateCategories = map[string]bool{"utility": true, "marketing": true, "authentication": true}
var templateStatuses = map[string]bool{"pending": true, "approved": true, "rejected": true, "paused": true, "disabled": true}

// Repo is the whatsapp_message_templates data access layer. It satisfies
// TemplateGetter so *Repo can be handed directly to WhatsAppSender.
type Repo struct {
	Pool *db.Pool
}

// FullTemplate is the complete whatsapp_message_templates row, for
// management surfaces (list/create/update). WhatsAppSender only needs the
// narrower Template.
type FullTemplate struct {
	ID                 string
	TenantID           string
	Name               string
	Language           string
	Category           string
	Body               string
	Status             string
	ProviderTemplateID string
	CreatedAt          string
	UpdatedAt          string
}

// GetTemplate implements TemplateGetter: resolve one template by id, scoped
// to the tenant via RLS.
func (r *Repo) GetTemplate(ctx context.Context, tenantID, id string) (*Template, error) {
	id = strings.TrimSpace(id)
	if tenantID == "" || id == "" {
		return nil, ErrInvalidInput
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var t Template
	err = tx.QueryRow(ctx, `
SELECT id::text, name, language, status
FROM whatsapp_message_templates
WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id).Scan(&t.ID, &t.Name, &t.Language, &t.Status)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &t, nil
}

// GetTemplateByName resolves a template by its (name, language) identity —
// the axis Meta approves against — rather than by internal id.
func (r *Repo) GetTemplateByName(ctx context.Context, tenantID, name, language string) (*Template, error) {
	name = strings.TrimSpace(name)
	language = strings.TrimSpace(language)
	if tenantID == "" || name == "" || language == "" {
		return nil, ErrInvalidInput
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var t Template
	err = tx.QueryRow(ctx, `
SELECT id::text, name, language, status
FROM whatsapp_message_templates
WHERE tenant_id = $1::uuid AND name = $2 AND language = $3`, tenantID, name, language).Scan(&t.ID, &t.Name, &t.Language, &t.Status)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &t, nil
}

// ListTemplates returns every WhatsApp template registered for the tenant,
// optionally filtered by status (e.g. "approved").
func (r *Repo) ListTemplates(ctx context.Context, tenantID, status string) ([]FullTemplate, error) {
	if tenantID == "" {
		return nil, ErrInvalidInput
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, name, language, category, body, status,
       COALESCE(provider_template_id, ''), created_at::text, updated_at::text
FROM whatsapp_message_templates
WHERE tenant_id = $1::uuid AND ($2 = '' OR status = $2)
ORDER BY name, language`, tenantID, strings.TrimSpace(status))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FullTemplate{}
	for rows.Next() {
		var t FullTemplate
		if err := rows.Scan(&t.ID, &t.TenantID, &t.Name, &t.Language, &t.Category, &t.Body, &t.Status,
			&t.ProviderTemplateID, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateTemplateInput is the caller-supplied shape for registering a new
// WhatsApp template. New templates always start 'pending' — only Meta's
// review (reflected back via UpdateStatus) can mark one 'approved'.
type CreateTemplateInput struct {
	Name     string
	Language string
	Category string
	Body     string
}

// CreateTemplate registers a new WhatsApp template awaiting Meta approval.
func (r *Repo) CreateTemplate(ctx context.Context, tenantID string, in CreateTemplateInput) (*FullTemplate, error) {
	name := strings.TrimSpace(in.Name)
	language := strings.TrimSpace(in.Language)
	category := strings.TrimSpace(in.Category)
	body := strings.TrimSpace(in.Body)
	if tenantID == "" || name == "" || language == "" || body == "" {
		return nil, ErrInvalidInput
	}
	if category == "" {
		category = "utility"
	}
	if !templateCategories[category] {
		return nil, ErrInvalidInput
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var t FullTemplate
	err = tx.QueryRow(ctx, `
INSERT INTO whatsapp_message_templates (tenant_id, name, language, category, body)
VALUES ($1::uuid, $2, $3, $4, $5)
RETURNING id::text, tenant_id::text, name, language, category, body, status,
          COALESCE(provider_template_id, ''), created_at::text, updated_at::text`,
		tenantID, name, language, category, body).Scan(
		&t.ID, &t.TenantID, &t.Name, &t.Language, &t.Category, &t.Body, &t.Status,
		&t.ProviderTemplateID, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &t, nil
}

// UpdateStatus applies a Meta review decision (or a manual pause/disable) to
// an existing template — the only way status ever leaves 'pending'.
func (r *Repo) UpdateStatus(ctx context.Context, tenantID, id, status, providerTemplateID string) (*FullTemplate, error) {
	id = strings.TrimSpace(id)
	status = strings.TrimSpace(status)
	if tenantID == "" || id == "" || !templateStatuses[status] {
		return nil, ErrInvalidInput
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var t FullTemplate
	err = tx.QueryRow(ctx, `
UPDATE whatsapp_message_templates
SET status = $3,
    provider_template_id = COALESCE(NULLIF($4, ''), provider_template_id)
WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING id::text, tenant_id::text, name, language, category, body, status,
          COALESCE(provider_template_id, ''), created_at::text, updated_at::text`,
		tenantID, id, status, strings.TrimSpace(providerTemplateID)).Scan(
		&t.ID, &t.TenantID, &t.Name, &t.Language, &t.Category, &t.Body, &t.Status,
		&t.ProviderTemplateID, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &t, nil
}
