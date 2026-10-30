// SPDX-License-Identifier: AGPL-3.0-only
//
// Package utm_tagging manages UTM auto-tag templates and exposes
// the URL rewriter used by configuration previews. Current campaign delivery
// uses inline tracking_settings; template delivery is not yet connected.
//
// Template precedence:
//   1. per-campaign row (highest)
//   2. tenant-default row (campaign_id IS NULL)
//   3. no row → URLs untouched
//
// Token substitution at apply-time:
//   {{campaign_slug}}  campaigns.archive_slug or the stable campaign id
//   {{campaign_name}}  campaigns.name
//   {{date}}           YYYY-MM-DD UTC of the apply call
//
// Why not "always append all params"? Because some operators
// already encode UTMs in their content URLs and would have
// conflicts. Moosewave's default: append-only-if-missing — never
// overwrite an existing utm_* param the operator placed by hand.
//
// Surfaces:
//
//   GET  /api/v1/utm-templates                 list (default + overrides)
//   POST /api/v1/utm-templates                 upsert default; body has campaign_id=null
//   POST /api/v1/utm-templates/campaign/{id}   upsert per-campaign override
//   DELETE /api/v1/utm-templates/{id}          delete
//   POST /api/v1/utm-templates/preview         body: {url, campaign_id} → rewritten URL

package utm_tagging

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const requestJSONMaxBodyBytes int64 = 8 << 10

const (
	maxUTMTemplateValueRunes = 256
	maxUTMPreviewURLRunes    = 2048
)

// Deps wires the HTTP surface.
type Deps struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal to record server-side
	// detail (tenant_id+request_id+err) without leaking err.Error() to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// Template is the API projection.
type Template struct {
	ID          string    `json:"id"`
	CampaignID  string    `json:"campaign_id,omitempty"`
	IsDefault   bool      `json:"is_default"`
	UTMSource   string    `json:"utm_source,omitempty"`
	UTMMedium   string    `json:"utm_medium,omitempty"`
	UTMCampaign string    `json:"utm_campaign,omitempty"`
	UTMTerm     string    `json:"utm_term,omitempty"`
	UTMContent  string    `json:"utm_content,omitempty"`
	Enabled     bool      `json:"enabled"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type upsertReq struct {
	UTMSource   string `json:"utm_source"`
	UTMMedium   string `json:"utm_medium"`
	UTMCampaign string `json:"utm_campaign"`
	UTMTerm     string `json:"utm_term"`
	UTMContent  string `json:"utm_content"`
}

func (body *upsertReq) normalize() {
	body.UTMSource = strings.TrimSpace(body.UTMSource)
	body.UTMMedium = strings.TrimSpace(body.UTMMedium)
	body.UTMCampaign = strings.TrimSpace(body.UTMCampaign)
	body.UTMTerm = strings.TrimSpace(body.UTMTerm)
	body.UTMContent = strings.TrimSpace(body.UTMContent)
}

func validateUpsert(body upsertReq) error {
	fields := []struct {
		name  string
		value string
	}{
		{name: "utm_source", value: body.UTMSource},
		{name: "utm_medium", value: body.UTMMedium},
		{name: "utm_campaign", value: body.UTMCampaign},
		{name: "utm_term", value: body.UTMTerm},
		{name: "utm_content", value: body.UTMContent},
	}
	hasValue := false
	for _, field := range fields {
		if field.value != "" {
			hasValue = true
		}
		if utf8.RuneCountInString(field.value) > maxUTMTemplateValueRunes {
			return fmt.Errorf("%s must be at most %d characters", field.name, maxUTMTemplateValueRunes)
		}
	}
	if !hasValue {
		return errors.New("at least one UTM parameter is required")
	}
	return nil
}

// MountRoutes registers the admin endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/utm-templates", d.List)
	r.With(admin).Post("/api/v1/utm-templates", d.UpsertDefault)
	r.With(admin).Post("/api/v1/utm-templates/campaign/{id}", d.UpsertCampaign)
	r.With(admin).Delete("/api/v1/utm-templates/{id}", d.Delete)
	r.With(read).Post("/api/v1/utm-templates/preview", d.Preview)
}

// List GET /api/v1/utm-templates.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, COALESCE(campaign_id::text, ''),
       COALESCE(utm_source, ''), COALESCE(utm_medium, ''),
       COALESCE(utm_campaign, ''), COALESCE(utm_term, ''),
       COALESCE(utm_content, ''), enabled, created_at, updated_at
  FROM utm_templates
 WHERE tenant_id = $1::uuid
 ORDER BY campaign_id IS NULL DESC, updated_at DESC`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out, err := scanTemplates(rows)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"templates": out, "count": len(out)})
}

func scanTemplates(rows pgx.Rows) ([]Template, error) {
	out := []Template{}
	for rows.Next() {
		var tm Template
		if err := rows.Scan(&tm.ID, &tm.CampaignID, &tm.UTMSource, &tm.UTMMedium,
			&tm.UTMCampaign, &tm.UTMTerm, &tm.UTMContent, &tm.Enabled,
			&tm.CreatedAt, &tm.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan UTM template: %w", err)
		}
		tm.IsDefault = tm.CampaignID == ""
		out = append(out, tm)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate UTM templates: %w", err)
	}
	return out, nil
}

// UpsertDefault POST /api/v1/utm-templates.
func (d *Deps) UpsertDefault(w http.ResponseWriter, r *http.Request) {
	d.upsert(w, r, "")
}

// UpsertCampaign POST /api/v1/utm-templates/campaign/{id}.
func (d *Deps) UpsertCampaign(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	d.upsert(w, r, id)
}

func (d *Deps) upsert(w http.ResponseWriter, r *http.Request, campaignID string) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var body upsertReq
	if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	body.normalize()
	if err := validateUpsert(body); err != nil {
		httperror.WriteValidation(w, "invalid_utm_template", err.Error())
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var cid any
	conflict := "(tenant_id) WHERE campaign_id IS NULL"
	if campaignID != "" {
		cid = campaignID
		conflict = "(tenant_id, campaign_id) WHERE campaign_id IS NOT NULL"
	}
	var id string
	err = tx.QueryRow(r.Context(), `
INSERT INTO utm_templates
   (tenant_id, campaign_id, utm_source, utm_medium, utm_campaign, utm_term, utm_content)
VALUES ($1::uuid, $2::uuid, NULLIF($3,''), NULLIF($4,''), NULLIF($5,''), NULLIF($6,''), NULLIF($7,''))
ON CONFLICT `+conflict+` DO UPDATE SET
    utm_source   = EXCLUDED.utm_source,
    utm_medium   = EXCLUDED.utm_medium,
    utm_campaign = EXCLUDED.utm_campaign,
    utm_term     = EXCLUDED.utm_term,
    utm_content  = EXCLUDED.utm_content,
    updated_at   = now()
RETURNING id::text`,
		t.ID, cid, body.UTMSource, body.UTMMedium, body.UTMCampaign,
		body.UTMTerm, body.UTMContent).Scan(&id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

// Delete DELETE /api/v1/utm-templates/{id}.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(),
		`DELETE FROM utm_templates WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		httperror.Write(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Preview POST /api/v1/utm-templates/preview body {url, campaign_id}.
func (d *Deps) Preview(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var body struct {
		URL        string `json:"url"`
		CampaignID string `json:"campaign_id"`
	}
	if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	body.URL = strings.TrimSpace(body.URL)
	if err := validatePreviewURL(body.URL); err != nil {
		httperror.WriteValidation(w, "invalid_preview_url", err.Error())
		return
	}
	applyContext := ApplyContext{}
	if body.CampaignID != "" {
		if _, err := uuid.Parse(body.CampaignID); err != nil {
			httperror.WriteValidation(w, "invalid_campaign_id", "A valid campaign id is required.")
			return
		}
		tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		defer func() { _ = tx.Rollback(r.Context()) }()
		err = tx.QueryRow(r.Context(), `SELECT name, COALESCE(NULLIF(archive_slug, ''), id::text)
FROM campaigns WHERE tenant_id = $1::uuid AND id = $2::uuid`, t.ID, body.CampaignID).Scan(
			&applyContext.CampaignName, &applyContext.CampaignSlug)
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "campaign_not_found", "Campaign not found.")
			return
		}
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		// Resolve opens its own tenant transaction; do not hold a connection
		// while acquiring another one from a bounded pool.
		_ = tx.Rollback(r.Context())
	}
	tpl, err := Resolve(r.Context(), d.Pool, t.ID, body.CampaignID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	rewritten := Apply(body.URL, tpl, applyContext)
	writeJSON(w, http.StatusOK, map[string]any{
		"original":  body.URL,
		"rewritten": rewritten,
		"template":  tpl,
	})
}

func validatePreviewURL(raw string) error {
	if raw == "" {
		return errors.New("preview URL is required")
	}
	if utf8.RuneCountInString(raw) > maxUTMPreviewURLRunes {
		return fmt.Errorf("preview URL must be at most %d characters", maxUTMPreviewURLRunes)
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" ||
		(!strings.EqualFold(parsed.Scheme, "http") && !strings.EqualFold(parsed.Scheme, "https")) {
		return errors.New("preview URL must be a valid absolute HTTP(S) URL")
	}
	return nil
}

// --- exported rewriter ---

// ApplyContext carries the dynamic substitutions Apply uses for
// {{campaign_slug}}, {{campaign_name}}, {{date}}.
type ApplyContext struct {
	CampaignSlug string
	CampaignName string
}

// Resolve fetches the applicable template for (tenant, campaign).
// Returns a zero Template (with Enabled=false) when nothing applies.
func Resolve(ctx context.Context, pool *db.Pool, tenantID, campaignID string) (Template, error) {
	out := Template{}
	if pool == nil || tenantID == "" {
		return out, nil
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Prefer per-campaign row when campaign_id is non-empty.
	if campaignID != "" {
		err := tx.QueryRow(ctx, `
SELECT id::text, COALESCE(campaign_id::text, ''),
       COALESCE(utm_source, ''), COALESCE(utm_medium, ''),
       COALESCE(utm_campaign, ''), COALESCE(utm_term, ''),
       COALESCE(utm_content, ''), enabled, created_at, updated_at
  FROM utm_templates
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`, tenantID, campaignID).Scan(
			&out.ID, &out.CampaignID, &out.UTMSource, &out.UTMMedium,
			&out.UTMCampaign, &out.UTMTerm, &out.UTMContent, &out.Enabled,
			&out.CreatedAt, &out.UpdatedAt)
		if err == nil {
			return out, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return out, err
		}
	}
	// Fallback: tenant default.
	err = tx.QueryRow(ctx, `
SELECT id::text, '',
       COALESCE(utm_source, ''), COALESCE(utm_medium, ''),
       COALESCE(utm_campaign, ''), COALESCE(utm_term, ''),
       COALESCE(utm_content, ''), enabled, created_at, updated_at
  FROM utm_templates
 WHERE tenant_id = $1::uuid AND campaign_id IS NULL`, tenantID).Scan(
		&out.ID, &out.CampaignID, &out.UTMSource, &out.UTMMedium,
		&out.UTMCampaign, &out.UTMTerm, &out.UTMContent, &out.Enabled,
		&out.CreatedAt, &out.UpdatedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	return out, nil
}

// Apply rewrites a single URL using the given template. Empty or
// disabled templates pass the URL through unchanged. Existing
// utm_* query params on the URL are NEVER overwritten — append-only.
func Apply(raw string, tpl Template, ctx ApplyContext) string {
	if !tpl.Enabled {
		return raw
	}
	if !strings.HasPrefix(raw, "http://") && !strings.HasPrefix(raw, "https://") {
		// mailto:, tel:, anchors — leave alone.
		return raw
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	q := parsed.Query()
	add := func(key, val string) {
		if val == "" {
			return
		}
		if q.Get(key) != "" {
			return // operator placed by hand
		}
		q.Set(key, substitute(val, ctx))
	}
	add("utm_source", tpl.UTMSource)
	add("utm_medium", tpl.UTMMedium)
	add("utm_campaign", tpl.UTMCampaign)
	add("utm_term", tpl.UTMTerm)
	add("utm_content", tpl.UTMContent)
	parsed.RawQuery = q.Encode()
	return parsed.String()
}

func substitute(v string, ctx ApplyContext) string {
	v = strings.ReplaceAll(v, "{{campaign_slug}}", ctx.CampaignSlug)
	v = strings.ReplaceAll(v, "{{campaign_name}}", ctx.CampaignName)
	v = strings.ReplaceAll(v, "{{date}}", time.Now().UTC().Format("2006-01-02"))
	return v
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
