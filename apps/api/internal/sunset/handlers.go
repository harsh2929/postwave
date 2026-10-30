// SPDX-License-Identifier: AGPL-3.0-only
//
// handlers.go — HTTP surface.
//
//	GET    /api/v1/sunset/policies              list
//	POST   /api/v1/sunset/policies              create
//	GET    /api/v1/sunset/policies/{id}         read
//	PUT    /api/v1/sunset/policies/{id}         update
//	DELETE /api/v1/sunset/policies/{id}         delete
//	POST   /api/v1/sunset/policies/{id}/run     trigger detector
//	GET    /api/v1/sunset/policies/{id}/executions  audit log
//	POST   /api/v1/sunset/reengagement/preview  preview template

package sunset

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const maxRequestBytes = 1 << 20

const (
	maxPreviewBrandRunes     = 160
	maxPreviewBrandBytes     = 512
	maxPreviewURLBytes       = 2048
	maxPreviewCandidateCount = 10_000_000
)

// Deps bundles the handler deps.
type Deps struct {
	Engine   *Engine
	Policies PolicyStore
	// Logger is used by httperror.WriteInternal to record server-side
	// detail (tenant_id+request_id+err) without leaking err.Error() to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// MountRoutes mounts the sunset CRUD + run endpoints on r.
func (d *Deps) MountRoutes(r chi.Router) {
	r.Get("/api/v1/sunset/policies", d.ListPolicies)
	r.Post("/api/v1/sunset/policies", d.CreatePolicy)
	r.Get("/api/v1/sunset/policies/{id}", d.GetPolicy)
	r.Put("/api/v1/sunset/policies/{id}", d.UpdatePolicy)
	r.Delete("/api/v1/sunset/policies/{id}", d.DeletePolicy)
	r.Post("/api/v1/sunset/policies/{id}/run", d.RunPolicy)
	r.Get("/api/v1/sunset/policies/{id}/executions", d.ListExecutions)
	r.Post("/api/v1/sunset/reengagement/preview", d.PreviewReengagement)
}

// ListPolicies GET /api/v1/sunset/policies?enabled=true
func (d *Deps) ListPolicies(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	enabledOnly := r.URL.Query().Get("enabled") == "true"
	out, err := d.Policies.ListPolicies(r.Context(), t.ID, enabledOnly)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// CreatePolicy POST /api/v1/sunset/policies
func (d *Deps) CreatePolicy(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var p Policy
	if err := httpbody.DecodeJSON(w, r, maxRequestBytes, &p); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if reason := validatePolicy(p); reason != "" {
		httperror.WriteValidation(w, "validation_failed", reason)
		return
	}
	out, err := d.Policies.CreatePolicy(r.Context(), t.ID, p)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// GetPolicy GET /api/v1/sunset/policies/{id}
func (d *Deps) GetPolicy(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	out, err := d.Policies.GetPolicy(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeErr(w, http.StatusNotFound, "policy_not_found", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// UpdatePolicy PUT /api/v1/sunset/policies/{id}
func (d *Deps) UpdatePolicy(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	var p Policy
	if err := httpbody.DecodeJSON(w, r, maxRequestBytes, &p); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	p.ID = id
	if reason := validatePolicy(p); reason != "" {
		httperror.WriteValidation(w, "validation_failed", reason)
		return
	}
	out, err := d.Policies.UpdatePolicy(r.Context(), t.ID, p)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeErr(w, http.StatusNotFound, "policy_not_found", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// DeletePolicy DELETE /api/v1/sunset/policies/{id}
func (d *Deps) DeletePolicy(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Policies.DeletePolicy(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeErr(w, http.StatusNotFound, "policy_not_found", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RunPolicy POST /api/v1/sunset/policies/{id}/run — triggers the
// detector synchronously and returns the RunSummary. Heavy run loops
// (>10k candidates) should hit the cron path; this endpoint exists for
// dashboard "preview what would happen" and ops debugging.
func (d *Deps) RunPolicy(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if d.Engine == nil {
		writeErr(w, http.StatusServiceUnavailable, "engine_unavailable", "")
		return
	}
	summary, err := d.Engine.Run(r.Context(), t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

// ListExecutions GET /api/v1/sunset/policies/{id}/executions?limit=
func (d *Deps) ListExecutions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	limit := atoiDefault(r.URL.Query().Get("limit"), 100)
	if limit > 500 {
		limit = 500
	}
	out, err := d.Policies.ListExecutions(r.Context(), t.ID, id, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// previewReengagementRequest is the body shape for the preview endpoint.
type previewReengagementRequest struct {
	Brand          BrandSnapshot `json:"brand"`
	CandidateCount int           `json:"candidateCount"`
	Variant        string        `json:"variant"`
}

// PreviewReengagement POST /api/v1/sunset/reengagement/preview —
// stateless; returns a rendered Template the dashboard can show or
// pipe into the campaign editor.
func (d *Deps) PreviewReengagement(w http.ResponseWriter, r *http.Request) {
	if _, ok := middleware.TenantFromContext(r.Context()); !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in previewReengagementRequest
	if err := httpbody.DecodeJSON(w, r, maxRequestBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if reason := normalizeAndValidatePreview(&in); reason != "" {
		httperror.WriteValidation(w, "validation_failed", reason)
		return
	}
	out := GenerateTemplate(in.Brand, in.CandidateCount, TemplateOptions{Variant: in.Variant})
	writeJSON(w, http.StatusOK, out)
}

// normalizeAndValidatePreview bounds every customer-controlled value before it
// is interpolated into campaign copy. URLs are not fetched by this endpoint,
// but they become clickable links in generated HTML and therefore still need a
// strict, phishing-resistant scheme/host contract.
func normalizeAndValidatePreview(in *previewReengagementRequest) string {
	if in == nil {
		return "preview request is required"
	}
	if in.CandidateCount < 0 || in.CandidateCount > maxPreviewCandidateCount {
		return "candidateCount must be between 0 and 10000000"
	}
	in.Variant = strings.TrimSpace(in.Variant)
	if in.Variant == "" {
		in.Variant = "soft"
	}
	switch in.Variant {
	case "soft", "direct", "last_chance":
	default:
		return "variant must be one of soft|direct|last_chance"
	}

	textFields := []struct {
		label string
		value *string
	}{
		{label: "brand.WorkspaceName", value: &in.Brand.WorkspaceName},
		{label: "brand.SenderName", value: &in.Brand.SenderName},
		{label: "brand.ProductName", value: &in.Brand.ProductName},
	}
	for _, field := range textFields {
		*field.value = strings.TrimSpace(*field.value)
		if reason := validatePreviewText(field.label, *field.value); reason != "" {
			return reason
		}
	}

	in.Brand.Tone = strings.TrimSpace(in.Brand.Tone)
	if in.Brand.Tone == "" {
		in.Brand.Tone = "casual"
	}
	switch in.Brand.Tone {
	case "casual", "formal", "professional":
	default:
		return "brand.Tone must be one of casual|formal|professional"
	}

	urls := []struct {
		label string
		value *string
	}{
		{label: "brand.HomepageURL", value: &in.Brand.HomepageURL},
		{label: "brand.UnsubscribeURL", value: &in.Brand.UnsubscribeURL},
	}
	for _, field := range urls {
		*field.value = strings.TrimSpace(*field.value)
		if reason := validatePreviewURL(field.label, *field.value); reason != "" {
			return reason
		}
	}
	return ""
}

func validatePreviewText(label, value string) string {
	if !utf8.ValidString(value) {
		return label + " must be valid UTF-8"
	}
	if len(value) > maxPreviewBrandBytes || utf8.RuneCountInString(value) > maxPreviewBrandRunes {
		return label + " must be at most 160 characters"
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return label + " must not contain control characters"
		}
	}
	return ""
}

func validatePreviewURL(label, raw string) string {
	if raw == "" {
		return ""
	}
	if len(raw) > maxPreviewURLBytes || !utf8.ValidString(raw) {
		return label + " must be a valid HTTPS URL no longer than 2048 bytes"
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Opaque != "" {
		return label + " must be an absolute HTTPS URL without credentials"
	}
	for _, r := range raw {
		if unicode.IsControl(r) {
			return label + " must not contain control characters"
		}
	}
	return ""
}

// validatePolicy returns "" when the policy passes, or a short
// human-readable reason on failure.
func validatePolicy(p Policy) string {
	if p.Name == "" {
		return "name is required"
	}
	if p.InactiveDays < 30 || p.InactiveDays > 730 {
		return "inactive_days must be between 30 and 730"
	}
	if !p.Action.IsValid() {
		return "action must be one of suppress|tag|winback"
	}
	return ""
}

// --- helpers ---

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return def
	}
	return n
}
