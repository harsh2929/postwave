package compat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/mail"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

func (d *Deps) PublicPopup(w http.ResponseWriter, r *http.Request) {
	setPublicPopupCORS(w, r)
	out, err := d.Repo.PublicPopup(r.Context(), chi.URLParam(r, "key"), publicTenantSlug(r))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "popup not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	_ = d.Repo.RecordPopupEvent(r.Context(), popupTenantID(out), out.ID, "view", "", publicRequestMetadata(r))
	out.TenantID = ""
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) PublicPopupConvert(w http.ResponseWriter, r *http.Request) {
	d.publicPopupConversion(w, r, false)
}

func (d *Deps) PublicPopupSubmit(w http.ResponseWriter, r *http.Request) {
	d.publicPopupConversion(w, r, true)
}

func (d *Deps) publicPopupConversion(w http.ResponseWriter, r *http.Request, requireEmail bool) {
	setPublicPopupCORS(w, r)
	out, err := d.Repo.PublicPopup(r.Context(), chi.URLParam(r, "key"), publicTenantSlug(r))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "popup not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	var body PopupSubmitInput
	if !decode(w, r, &body) {
		return
	}
	body.Email = strings.TrimSpace(strings.ToLower(body.Email))
	if requireEmail && body.Email == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "email is required"))
		return
	}
	if body.Email != "" {
		if _, err := mail.ParseAddress(body.Email); err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "email must be valid"))
			return
		}
	}
	metadata := nonNilMap(body.Metadata)
	metadata["user_agent"] = r.UserAgent()
	metadata["referrer"] = r.Header.Get("Referer")
	if err := d.Repo.RecordPopupEvent(r.Context(), popupTenantID(out), out.ID, "conversion", body.Email, metadata); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "popup_id": out.ID})
}

func (r *Repo) PublicPopup(ctx context.Context, key, tenantSlug string) (*PopupForm, error) {
	key = strings.TrimSpace(key)
	tenantSlug = strings.TrimSpace(tenantSlug)
	if tenantSlug != "" {
		return r.publicPopupByTenant(ctx, key, tenantSlug)
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.public_popup_key', $1, true)`, key); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT id::text, COALESCE(to_jsonb(popup_forms)->>'public_key', ''), name, status, trigger, targeting, blocks,
       COALESCE(form_id::text, ''), metrics, created_at, updated_at, tenant_id::text
  FROM popup_forms
 WHERE COALESCE(to_jsonb(popup_forms)->>'public_key', '') = $1 AND status = 'published'
 LIMIT 1`, key)
	p, tenantID, err := scanPopupWithTenant(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	p.TenantID = tenantID
	return p, tx.Commit(ctx)
}

func (r *Repo) publicPopupByTenant(ctx context.Context, key, tenantSlug string) (*PopupForm, error) {
	tenantID, err := r.tenantIDBySlug(ctx, tenantSlug)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, popupSelectSQL+`
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR COALESCE(to_jsonb(popup_forms)->>'public_key', '') = $2)
   AND status = 'published'
 LIMIT 1`, tenantID, key)
	p, err := scanPopup(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return p, tx.Commit(ctx)
}

func (r *Repo) tenantIDBySlug(ctx context.Context, slug string) (string, error) {
	// Public-popup endpoint runs pre-tenant: we need to translate the
	// public slug into a tenants row before we can bind app.tenant_id.
	// Use the resolver tx so migration 0333's narrow SELECT policy
	// fires.
	tx, err := db.WithTenantResolver(ctx, r.Pool)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // read-only tx

	row := tx.QueryRow(ctx, `SELECT id::text FROM tenants WHERE slug = $1`, slug)
	var tenantID string
	if err := row.Scan(&tenantID); err != nil {
		return "", err
	}
	return tenantID, nil
}

func (r *Repo) RecordPopupEvent(ctx context.Context, tenantID, id, eventType, email string, metadata map[string]any) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	raw, _ := json.Marshal(nonNilMap(metadata))
	_, err = tx.Exec(ctx, `
INSERT INTO growth_surface_events (tenant_id, surface_type, surface_id, event_type, email, metadata)
VALUES ($1::uuid, 'popup', $2::uuid, $3, NULLIF($4, ''), $5::jsonb)`,
		tenantID, id, eventType, email, string(raw))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func scanPopupWithTenant(row interface{ Scan(...any) error }) (*PopupForm, string, error) {
	var p PopupForm
	var tenantID string
	var trigger, targeting, blocks, metrics []byte
	if err := row.Scan(&p.ID, &p.PublicKey, &p.Name, &p.Status, &trigger, &targeting, &blocks, &p.FormID, &metrics, &p.CreatedAt, &p.UpdatedAt, &tenantID); err != nil {
		return nil, "", err
	}
	_ = json.Unmarshal(trigger, &p.Trigger)
	_ = json.Unmarshal(targeting, &p.Targeting)
	_ = json.Unmarshal(blocks, &p.Blocks)
	_ = json.Unmarshal(metrics, &p.Metrics)
	if p.Trigger == nil {
		p.Trigger = map[string]any{}
	}
	if p.Targeting == nil {
		p.Targeting = map[string]any{}
	}
	if p.Blocks == nil {
		p.Blocks = []map[string]any{}
	}
	if p.Metrics == nil {
		p.Metrics = map[string]any{}
	}
	return &p, tenantID, nil
}

func popupTenantID(p *PopupForm) string {
	if p == nil {
		return ""
	}
	return p.TenantID
}
