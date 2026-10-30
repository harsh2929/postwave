// SPDX-License-Identifier: AGPL-3.0-only
//
// G12 follow-up: organizational tags on campaigns. Free-text labels for
// grouping campaigns in the list view, plus the bulk-tag action. Distinct
// from campaigns.target_tag_ids (which targets subscriber tags for
// audience selection).
//
//	GET    /api/v1/campaigns/{id}/org-tags        (read:campaigns)
//	POST   /api/v1/campaigns/{id}/org-tags        (write:campaigns) {tag}
//	DELETE /api/v1/campaigns/{id}/org-tags/{tag}  (write:campaigns)
//	POST   /api/v1/campaigns/org-tags/bulk        (write:campaigns) {campaign_ids[], tag}

package campaigns

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const orgTagMaxLen = 40

// normalizeOrgTag trims + lowercases + caps length. Empty when invalid.
func normalizeOrgTag(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	if len(s) > orgTagMaxLen {
		s = s[:orgTagMaxLen]
	}
	return s
}

// MountOrgTags wires the campaign org-tag routes.
func MountOrgTags(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/campaigns/{id}/org-tags", d.listOrgTags)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/campaigns/{id}/org-tags", d.addOrgTag)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Delete("/api/v1/campaigns/{id}/org-tags/{tag}", d.removeOrgTag)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/campaigns/org-tags/bulk", d.bulkOrgTag)
}

func (d *Deps) listOrgTags(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	campaignID := chi.URLParam(r, "id")
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(),
		`SELECT tag FROM campaign_org_tags WHERE tenant_id=$1::uuid AND campaign_id=$2::uuid ORDER BY tag`,
		t.ID, campaignID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	tags := []string{}
	for rows.Next() {
		var tag string
		if err := rows.Scan(&tag); err == nil {
			tags = append(tags, tag)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"campaign_id": campaignID, "tags": tags})
}

func (d *Deps) addOrgTag(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	campaignID := chi.URLParam(r, "id")
	var in struct {
		Tag string `json:"tag"`
	}
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	tag := normalizeOrgTag(in.Tag)
	if tag == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_tag", "tag is required"))
		return
	}
	if err := d.insertOrgTag(r, t.ID, campaignID, tag); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tag": tag})
}

func (d *Deps) insertOrgTag(r *http.Request, tenantID, campaignID, tag string) error {
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(), `
INSERT INTO campaign_org_tags (tenant_id, campaign_id, tag)
VALUES ($1::uuid, $2::uuid, $3)
ON CONFLICT (campaign_id, tag) DO NOTHING`, tenantID, campaignID, tag); err != nil {
		return err
	}
	return tx.Commit(r.Context())
}

func (d *Deps) removeOrgTag(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	campaignID := chi.URLParam(r, "id")
	tag := normalizeOrgTag(chi.URLParam(r, "tag"))
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(),
		`DELETE FROM campaign_org_tags WHERE tenant_id=$1::uuid AND campaign_id=$2::uuid AND tag=$3`,
		t.ID, campaignID, tag); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (d *Deps) bulkOrgTag(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in struct {
		CampaignIDs []string `json:"campaign_ids"`
		Tag         string   `json:"tag"`
	}
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	tag := normalizeOrgTag(in.Tag)
	if tag == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_tag", "tag is required"))
		return
	}
	if len(in.CampaignIDs) == 0 || len(in.CampaignIDs) > 500 {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_count", "campaign_ids must contain 1..500 entries"))
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tagged := 0
	for _, cid := range in.CampaignIDs {
		ct, err := tx.Exec(r.Context(), `
INSERT INTO campaign_org_tags (tenant_id, campaign_id, tag)
VALUES ($1::uuid, $2::uuid, $3)
ON CONFLICT (campaign_id, tag) DO NOTHING`, t.ID, cid, tag)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		tagged += int(ct.RowsAffected())
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tag": tag, "tagged": tagged})
}
