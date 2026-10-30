// SPDX-License-Identifier: AGPL-3.0-only
//
// Package nql translates lightweight newsletter query language strings into a
// normalized predicate plan and can persist that plan on a campaign's delivery
// settings for segmented newsletter send modes.
package nql

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const nqlJSONMaxBodyBytes int64 = 64 << 10

type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

type Input struct {
	Query string `json:"query"`
	Mode  string `json:"mode,omitempty"`
}

type Predicate struct {
	Field    string `json:"field"`
	Operator string `json:"operator"`
	Value    string `json:"value"`
}

type Plan struct {
	Query      string      `json:"query"`
	Mode       string      `json:"mode"`
	Predicates []Predicate `json:"predicates"`
	Warnings   []string    `json:"warnings,omitempty"`
	CompiledAt time.Time   `json:"compiled_at"`
}

type PreviewResponse struct {
	CampaignID      string `json:"campaign_id,omitempty"`
	Plan            Plan   `json:"plan"`
	EstimatedCount  *int64 `json:"estimated_count,omitempty"`
	CountConfidence string `json:"count_confidence"`
}

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadSubscribers, apikeys.ScopeReadCampaigns)
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns, apikeys.ScopeAdmin)
	r.With(read).Post("/api/v1/nql/preview", d.previewGlobal)
	r.With(read).Post("/api/v1/campaigns/{id}/nql-preview", d.previewCampaign)
	r.With(write).Post("/api/v1/campaigns/{id}/nql-send-mode", d.applyCampaign)
}

func (d *Deps) previewGlobal(w http.ResponseWriter, r *http.Request) {
	d.preview(w, r, "")
}

func (d *Deps) previewCampaign(w http.ResponseWriter, r *http.Request) {
	d.preview(w, r, chi.URLParam(r, "id"))
}

func (d *Deps) preview(w http.ResponseWriter, r *http.Request, campaignID string) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in Input
	if err := httpbody.DecodeJSON(w, r, nqlJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	plan := Compile(in.Query, in.Mode)
	count, confident := d.estimate(r, t.ID, plan)
	out := PreviewResponse{
		CampaignID:      campaignID,
		Plan:            plan,
		EstimatedCount:  count,
		CountConfidence: "partial",
	}
	if confident {
		out.CountConfidence = "high"
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) applyCampaign(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in Input
	if err := httpbody.DecodeJSON(w, r, nqlJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	plan := Compile(in.Query, in.Mode)
	raw, _ := json.Marshal(map[string]any{
		"nql_send": plan,
	})
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var updated string
	err = tx.QueryRow(r.Context(), `
UPDATE campaigns
   SET delivery_settings = COALESCE(delivery_settings, '{}'::jsonb) || $3::jsonb,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
RETURNING id::text`, t.ID, chi.URLParam(r, "id"), string(raw)).Scan(&updated)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errEnv("campaign_not_found", "campaign not found"))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, PreviewResponse{CampaignID: updated, Plan: plan, CountConfidence: "not_recomputed"})
}

func Compile(query, mode string) Plan {
	query = strings.TrimSpace(query)
	mode = normalizeMode(mode)
	out := Plan{
		Query:      query,
		Mode:       mode,
		CompiledAt: time.Now().UTC(),
	}
	if query == "" {
		out.Warnings = append(out.Warnings, "empty query matches the campaign's existing audience")
		return out
	}
	tokens := strings.Fields(query)
	for _, tok := range tokens {
		lower := strings.ToLower(strings.TrimSpace(tok))
		if lower == "and" || lower == "or" || lower == "(" || lower == ")" {
			continue
		}
		field, value, ok := strings.Cut(lower, ":")
		if !ok || strings.TrimSpace(value) == "" {
			out.Warnings = append(out.Warnings, "ignored token "+tok)
			continue
		}
		field = normalizeField(field)
		if field == "" {
			out.Warnings = append(out.Warnings, "unsupported field "+tok)
			continue
		}
		out.Predicates = append(out.Predicates, Predicate{
			Field:    field,
			Operator: "equals",
			Value:    strings.Trim(value, `"'`),
		})
	}
	return out
}

func normalizeMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "include", "include_only", "target":
		return "include"
	case "exclude", "suppress":
		return "exclude"
	case "split":
		return "split"
	default:
		return "include"
	}
}

func normalizeField(field string) string {
	switch strings.ToLower(strings.TrimSpace(field)) {
	case "status", "domain", "tag", "segment", "list", "newsletter", "tier":
		return strings.ToLower(strings.TrimSpace(field))
	default:
		return ""
	}
}

// buildEstimateClauses turns predicates into a subscribers WHERE clause. The
// last return value is `exact`: true ONLY when EVERY predicate was translated.
//
// This is the fix for the superset bug. The old loop translated status/domain
// and silently DROPPED tag/segment/list/newsletter/tier from the WHERE while
// still returning a count — so "status:enabled tag:vip" counted every enabled
// subscriber. Now an untranslatable predicate makes exact=false and the caller
// returns no count at all: a wrong number is worse than an honest "not
// estimated".
func buildEstimateClauses(tenantID string, predicates []Predicate) (clauses []string, args []any, exact bool) {
	if len(predicates) == 0 {
		return nil, nil, false
	}
	clauses = []string{"tenant_id = $1::uuid"}
	args = []any{tenantID}
	exact = true
	for _, pred := range predicates {
		switch pred.Field {
		case "status":
			args = append(args, pred.Value)
			clauses = append(clauses, "status = $"+strconv.Itoa(len(args)))
		case "domain":
			args = append(args, pred.Value)
			clauses = append(clauses, "split_part(lower(email::text), '@', 2) = $"+strconv.Itoa(len(args)))
		case "tag":
			// tags is text[] with a GIN index (migration 0003). @> is the
			// index-friendly contains test.
			args = append(args, pred.Value)
			clauses = append(clauses, "tags @> ARRAY[$"+strconv.Itoa(len(args))+"]::text[]")
		default:
			// segment / list / newsletter / tier need joins we don't build
			// here. Refuse to report an exact count rather than drop them.
			exact = false
		}
	}
	if len(clauses) == 1 {
		exact = false
	}
	return clauses, args, exact
}

func (d *Deps) estimate(r *http.Request, tenantID string, plan Plan) (*int64, bool) {
	clauses, args, exact := buildEstimateClauses(tenantID, plan.Predicates)
	// Never return a superset: if any predicate could not be translated, the
	// count would over-report, so return "no estimate" instead.
	if !exact {
		return nil, false
	}
	confident := true
	tx, err := db.WithTenant(r.Context(), d.Pool, tenantID)
	if err != nil {
		return nil, false
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var count int64
	err = tx.QueryRow(r.Context(), "SELECT count(*) FROM subscribers WHERE "+strings.Join(clauses, " AND "), args...).Scan(&count)
	if err != nil {
		return nil, false
	}
	_ = tx.Commit(r.Context())
	return &count, confident
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
