// SPDX-License-Identifier: AGPL-3.0-only
//
// Package campaign_to_template implements the "save this campaign
// as a reusable template" operator action. The existing
// campaigntemplates package owns the template table; this package
// composes on top — it reads a campaign row and creates a
// matching template via campaigntemplates.Repo.Create.
//
// The standalone wrapper is intentional: the operator-facing
// surface lives at /api/v1/campaigns/{id}/save-as-template,
// alongside the other campaign operations, instead of
// /api/v1/campaign-templates which is the template registry's
// home.
//
// Surface:
//
//   POST /api/v1/campaigns/{id}/save-as-template
//        body: {slug, name?, description?, category?, tags?}

package campaign_to_template

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/campaigntemplates"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const requestJSONMaxBodyBytes int64 = 8 << 10

// errCampaignNotFound is a typed sentinel for the "campaign row missing"
// case so the HTTP layer can distinguish it from raw db/RLS errors that
// must not have their text echoed.
var errCampaignNotFound = errors.New("campaign not found")

// Deps wires the HTTP surface.
type Deps struct {
	Pool         *db.Pool
	TemplateRepo *campaigntemplates.Repo
	Logger       *slog.Logger
}

type saveReq struct {
	Slug        string   `json:"slug"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Category    string   `json:"category"`
	Tags        []string `json:"tags"`
}

// MountRoutes registers the admin endpoint.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil || d.TemplateRepo == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Post("/api/v1/campaigns/{id}/save-as-template", d.Save)
}

// Save POST /api/v1/campaigns/{id}/save-as-template.
func (d *Deps) Save(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_id", "")
		return
	}
	var body saveReq
	if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		// httpbody returns curated, operator-safe codes/messages
		// (bad_json, payload_too_large) — safe to echo verbatim.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	slug := strings.TrimSpace(body.Slug)
	if slug == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_slug", "")
		return
	}

	// Load source campaign fields.
	src, err := loadCampaign(r.Context(), d.Pool, t.ID, id)
	if err != nil {
		if errors.Is(err, errCampaignNotFound) {
			httperror.Write(w, http.StatusNotFound, "campaign_not_found", "")
			return
		}
		// Anything else (raw db/RLS/pgx error) — never echo to client.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	in := campaigntemplates.CreateInput{
		Slug:        slug,
		Name:        firstNonEmpty(strings.TrimSpace(body.Name), src.Name),
		Description: body.Description,
		Category:    body.Category,
		Subject:     src.Subject,
		PreviewText: src.PreviewText,
		BodyHTML:    src.BodyHTML,
		BodyMJML:    src.BodyMJML,
		Tags:        body.Tags,
	}
	tpl, err := d.TemplateRepo.Create(r.Context(), t.ID, in)
	if err != nil {
		// Surface slug conflict as 409 with a static operator-authored
		// message — code is not in the safe-echo allowlist.
		if errors.Is(err, campaigntemplates.ErrSlugConflict) {
			httperror.Write(w, http.StatusConflict, "slug_conflict",
				"Slug already exists. Pass a unique `slug` in the request body.")
			return
		}
		// ErrInvalidSlug is a package-authored, operator-safe sentinel,
		// so its text is safe to echo verbatim via WriteValidation.
		if errors.Is(err, campaigntemplates.ErrInvalidSlug) {
			httperror.WriteValidation(w, "invalid_slug", err.Error())
			return
		}
		// Anything else is unknown / infrastructure — never echo.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, tpl)
}

// --- source campaign loader ---

type sourceFields struct {
	Name        string
	Subject     string
	PreviewText string
	BodyHTML    string
	BodyMJML    string
}

func loadCampaign(ctx context.Context, pool *db.Pool, tenantID, id string) (sourceFields, error) {
	var out sourceFields
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
SELECT name, subject,
       COALESCE(preview_text, ''),
       COALESCE(body_html, ''),
       COALESCE(body_mjml, '')
  FROM campaigns
 WHERE id = $1::uuid AND tenant_id = $2::uuid`,
		id, tenantID).Scan(&out.Name, &out.Subject, &out.PreviewText,
		&out.BodyHTML, &out.BodyMJML)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return out, errCampaignNotFound
		}
		return out, err
	}
	if err := tx.Commit(ctx); err != nil {
		return out, err
	}
	return out, nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
