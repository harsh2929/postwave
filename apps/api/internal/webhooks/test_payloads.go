// SPDX-License-Identifier: AGPL-3.0-only
package webhooks

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Typed validation errors returned by CreateTestPayload + SetEnvironment.
// Handlers use errors.Is on these to decide whether the message is safe
// to echo back to the caller (httperror.WriteValidation) vs an
// infrastructure failure that must go through httperror.WriteInternal
// (which slogs the err with tenant + request context and emits a generic
// "internal_error" envelope).
var (
	ErrTestPayloadBodyNotJSON  = errors.New("webhooks: body must be valid JSON")
	ErrTestPayloadNameRequired = errors.New("webhooks: name required")
	ErrInvalidEnvironment      = errors.New("webhooks: environment must be production|staging|development")
)

// TestPayload is one saved test body that admins can fire at a
// webhook from the Test dialog. Refined Webhooks remaining items.
//
// Body is opaque JSON; we only care that it parses (CHECK during
// insert). Direction lets the same table back both inbound + outbound
// without forcing a join.
type TestPayload struct {
	ID        string          `json:"id"`
	WebhookID string          `json:"webhook_id"`
	Direction string          `json:"direction"` // "inbound" | "outbound"
	Name      string          `json:"name"`
	Body      json.RawMessage `json:"body"`
	CreatedAt string          `json:"created_at"`
}

// ListTestPayloads returns the saved payloads for one webhook,
// newest-first. Hard limit 50 — the picker shouldn't scroll forever.
func (r *Repo) ListTestPayloads(ctx context.Context, tenantID, webhookID, direction string) ([]TestPayload, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := `
SELECT id::text, webhook_id::text, direction, name, body_json, created_at::text
FROM webhook_test_payloads
WHERE webhook_id = $1::uuid`
	args := []any{webhookID}
	if direction != "" {
		args = append(args, direction)
		q += " AND direction = $2"
	}
	q += " ORDER BY created_at DESC LIMIT 50"
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TestPayload{}
	for rows.Next() {
		var p TestPayload
		if err := rows.Scan(&p.ID, &p.WebhookID, &p.Direction, &p.Name, &p.Body, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// CreateTestPayload upserts on (tenant, webhook, name) — saving with
// the same name as an existing payload replaces it. Body must be
// valid JSON; we validate via json.Valid before touching the DB.
func (r *Repo) CreateTestPayload(ctx context.Context, tenantID, webhookID, direction, name string, body []byte) (*TestPayload, error) {
	if !json.Valid(body) {
		return nil, ErrTestPayloadBodyNotJSON
	}
	if strings.TrimSpace(name) == "" {
		return nil, ErrTestPayloadNameRequired
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var p TestPayload
	err = tx.QueryRow(ctx, `
INSERT INTO webhook_test_payloads (tenant_id, webhook_id, direction, name, body_json)
VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)
ON CONFLICT (tenant_id, webhook_id, name)
DO UPDATE SET body_json = EXCLUDED.body_json
RETURNING id::text, webhook_id::text, direction, name, body_json, created_at::text`,
		tenantID, webhookID, direction, name, string(body),
	).Scan(&p.ID, &p.WebhookID, &p.Direction, &p.Name, &p.Body, &p.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &p, tx.Commit(ctx)
}

// DeleteTestPayload removes one by id.
func (r *Repo) DeleteTestPayload(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM webhook_test_payloads WHERE id::text = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// ListTestPayloadsHandler GET /api/v1/webhooks/{id}/test-payloads
func (d *Deps) ListTestPayloadsHandler(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d == nil || d.Repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	id := chi.URLParam(r, "id")
	out, err := d.Repo.ListTestPayloads(r.Context(), t.ID, id, r.URL.Query().Get("direction"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// CreateTestPayloadHandler POST /api/v1/webhooks/{id}/test-payloads
// Body: {"name":"…","direction":"inbound|outbound","body":{...}}
func (d *Deps) CreateTestPayloadHandler(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d == nil || d.Repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	var in struct {
		Name      string          `json:"name"`
		Direction string          `json:"direction"`
		Body      json.RawMessage `json:"body"`
	}
	if err := httpbody.DecodeJSON(w, r, 1<<20, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Direction != "inbound" && in.Direction != "outbound" {
		in.Direction = "outbound"
	}
	id := chi.URLParam(r, "id")
	out, err := d.Repo.CreateTestPayload(r.Context(), t.ID, id, in.Direction, in.Name, in.Body)
	if err != nil {
		// Only echo the message for known-safe validation errors.
		// Anything else (db connection, RLS, JSON marshal, ...) is an
		// infrastructure failure that must not leak via the response body.
		if errors.Is(err, ErrTestPayloadBodyNotJSON) || errors.Is(err, ErrTestPayloadNameRequired) {
			httperror.WriteValidation(w, "save_failed", "request could not be processed")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// DeleteTestPayloadHandler DELETE /api/v1/webhooks/test-payloads/{id}
func (d *Deps) DeleteTestPayloadHandler(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d == nil || d.Repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.DeleteTestPayload(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

/* ---------- PR 4 (multi-env, lite): environment field --------- */

// SetEnvironment updates the environment tag on a webhook. The
// field is currently a label — dispatcher routing by env is a
// future PR; today it lets admins organise their webhooks visually.
func (r *Repo) SetEnvironment(ctx context.Context, tenantID, webhookID, env string) error {
	switch env {
	case "production", "staging", "development":
	default:
		return ErrInvalidEnvironment
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE webhooks SET environment = $2, updated_at = now()
WHERE id::text = $1`, webhookID, env)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// SetEnvironmentHandler PATCH /api/v1/webhooks/{id}/environment
// Body: {"environment": "production|staging|development"}
func (d *Deps) SetEnvironmentHandler(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d == nil || d.Repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	var in struct {
		Environment string `json:"environment"`
	}
	if err := httpbody.DecodeJSON(w, r, 1024, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.SetEnvironment(r.Context(), t.ID, id, in.Environment); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		// Echo only the known-safe environment-enum validation error.
		// Anything else (db connection, RLS, ...) routes through WriteInternal
		// so the err lands in the structured log, not the response.
		if errors.Is(err, ErrInvalidEnvironment) {
			httperror.WriteValidation(w, "invalid_env", "request configuration is invalid")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// guard against the unused-import linter when only some code paths use pgx
var _ = pgx.ErrNoRows
