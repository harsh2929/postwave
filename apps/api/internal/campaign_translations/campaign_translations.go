// SPDX-License-Identifier: AGPL-3.0-only
//
// Package campaign_translations implements G19 of the campaigns 2026
// pack — the per-campaign multi-language variant matrix. Each
// (campaign, locale) row carries an operator-authored subject + body.
// Distinct from the smart-translations AI dictionary (internal/
// translations): this is N hand-authored localizations of one campaign.
//
// Surface:
//
//	GET    /api/v1/campaigns/{id}/translations            (read:campaigns)
//	PUT    /api/v1/campaigns/{id}/translations/{locale}    (write:campaigns)
//	DELETE /api/v1/campaigns/{id}/translations/{locale}    (write:campaigns)
//
// Queue-fill routing (select a recipient's locale variant at send) +
// the per-locale aggregated report are G19 follow-ups.

package campaign_translations

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Translation is one authored language variant.
type Translation struct {
	Locale    string    `json:"locale"`
	Subject   string    `json:"subject"`
	BodyHTML  string    `json:"body_html"`
	BodyMJML  string    `json:"body_mjml"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// localeRe is a permissive BCP-47-ish check: language[-Region], 2-8 char
// segments. Keeps junk locales out of the matrix without a full registry.
var localeRe = regexp.MustCompile(`^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})?$`)

// normalizeLocale lowercases the language + uppercases the region so
// "ES-mx" and "es-MX" collapse to one key.
func normalizeLocale(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	parts := strings.SplitN(s, "-", 2)
	out := strings.ToLower(parts[0])
	if len(parts) == 2 {
		out += "-" + strings.ToUpper(parts[1])
	}
	return out
}

func validLocale(raw string) bool {
	return localeRe.MatchString(strings.TrimSpace(raw))
}

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/campaigns/{id}/translations", d.list)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Put("/api/v1/campaigns/{id}/translations/{locale}", d.upsert)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Delete("/api/v1/campaigns/{id}/translations/{locale}", d.remove)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/campaigns/{id}/locale-report", d.localeReport)
}

// ResolveForLocale picks the (subject, body_html) a recipient with the
// given locale should receive: an exact-locale match, else a
// language-only match (es-MX → es), else the campaign default. Pure +
// testable — the send loop calls this per recipient once locale routing
// is wired into the dispatch render. Returns (subject, body, matched).
func ResolveForLocale(translations []Translation, locale, defaultSubject, defaultBody string) (string, string, bool) {
	want := normalizeLocale(locale)
	if want == "" {
		return defaultSubject, defaultBody, false
	}
	lang := want
	if i := strings.IndexByte(want, '-'); i > 0 {
		lang = want[:i]
	}
	var langMatch *Translation
	for i := range translations {
		tl := normalizeLocale(translations[i].Locale)
		if tl == want {
			return pick(translations[i].Subject, defaultSubject),
				pick(translations[i].BodyHTML, defaultBody), true
		}
		if langMatch == nil && tl == lang {
			langMatch = &translations[i]
		}
	}
	if langMatch != nil {
		return pick(langMatch.Subject, defaultSubject),
			pick(langMatch.BodyHTML, defaultBody), true
	}
	return defaultSubject, defaultBody, false
}

func pick(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

// LocaleStat is one locale's engagement row.
type LocaleStat struct {
	Locale string `json:"locale"`
	Sent   int    `json:"sent"`
	Opens  int    `json:"opens"`
	Clicks int    `json:"clicks"`
}

func (d *Deps) localeReport(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	campaignID := chi.URLParam(r, "id")
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT COALESCE(NULLIF(s.locale, ''), 'unknown') AS locale,
       count(*) FILTER (WHERE e.event_type = 'sent')::int    AS sent,
       count(*) FILTER (WHERE e.event_type = 'opened')::int  AS opens,
       count(*) FILTER (WHERE e.event_type = 'clicked')::int AS clicks
  FROM campaign_report_events e
  LEFT JOIN subscribers s
    ON s.tenant_id = e.tenant_id AND s.email = e.subscriber_email
 WHERE e.tenant_id = $1::uuid AND e.campaign_id = $2::uuid
 GROUP BY 1
 ORDER BY sent DESC`, t.ID, campaignID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []LocaleStat{}
	for rows.Next() {
		var s LocaleStat
		if err := rows.Scan(&s.Locale, &s.Sent, &s.Opens, &s.Clicks); err == nil {
			out = append(out, s)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"campaign_id": campaignID, "locales": out})
}

func (d *Deps) list(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	campaignID := chi.URLParam(r, "id")
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT locale, subject, body_html, body_mjml, updated_at
  FROM campaign_translations
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
 ORDER BY locale`, t.ID, campaignID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []Translation{}
	for rows.Next() {
		var tr Translation
		if err := rows.Scan(&tr.Locale, &tr.Subject, &tr.BodyHTML, &tr.BodyMJML, &tr.UpdatedAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		out = append(out, tr)
	}
	writeJSON(w, http.StatusOK, map[string]any{"campaign_id": campaignID, "translations": out})
}

func (d *Deps) upsert(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	campaignID := chi.URLParam(r, "id")
	locale := normalizeLocale(chi.URLParam(r, "locale"))
	if !validLocale(locale) {
		writeErr(w, http.StatusBadRequest, "bad_locale", "locale must look like 'es' or 'fr-CA'")
		return
	}
	var in struct {
		Subject  string `json:"subject"`
		BodyHTML string `json:"body_html"`
		BodyMJML string `json:"body_mjml"`
	}
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var tr Translation
	err = tx.QueryRow(r.Context(), `
INSERT INTO campaign_translations (tenant_id, campaign_id, locale, subject, body_html, body_mjml)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
ON CONFLICT (campaign_id, locale) DO UPDATE
   SET subject = EXCLUDED.subject,
       body_html = EXCLUDED.body_html,
       body_mjml = EXCLUDED.body_mjml,
       updated_at = now()
RETURNING locale, subject, body_html, body_mjml, updated_at`,
		t.ID, campaignID, locale, in.Subject, in.BodyHTML, in.BodyMJML,
	).Scan(&tr.Locale, &tr.Subject, &tr.BodyHTML, &tr.BodyMJML, &tr.UpdatedAt)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, tr)
}

func (d *Deps) remove(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	campaignID := chi.URLParam(r, "id")
	locale := normalizeLocale(chi.URLParam(r, "locale"))
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(),
		`DELETE FROM campaign_translations WHERE tenant_id=$1::uuid AND campaign_id=$2::uuid AND locale=$3`,
		t.ID, campaignID, locale); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "locale": locale})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}
