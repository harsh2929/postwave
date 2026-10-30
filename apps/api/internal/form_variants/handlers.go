package form_variants

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps bundles the dependencies the variant handlers need.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

const variantAdminJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

// MountRoutes wires the form display-optimization control plane.
func (d *Deps) MountRoutes(r chi.Router) {
	if d == nil || d.Repo == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	write := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/forms/{id}/variants", d.List)
	r.With(write).Post("/api/v1/forms/{id}/variants", d.Create)
	r.With(write).Patch("/api/v1/forms/{id}/variants/{variantId}", d.Update)
	r.With(write).Delete("/api/v1/forms/{id}/variants/{variantId}", d.Delete)
	r.With(read).Get("/api/v1/forms/{id}/variants/promotions", d.ListPromotions)
	r.With(write).Post("/api/v1/forms/{id}/variants/evaluate", d.Evaluate)
}

// List GET /api/v1/forms/{id}/variants
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	formID := chi.URLParam(r, "id")
	vs, err := d.Repo.List(r.Context(), t.ID, formID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, vs)
}

// Create POST /api/v1/forms/{id}/variants
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	formID := chi.URLParam(r, "id")
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, variantAdminJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Label = strings.TrimSpace(in.Label)
	if in.Label == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_field", "label required")
		return
	}
	if len(in.Label) > 64 {
		httperror.WriteValidation(w, "invalid_input", "label too long (max 64 chars)")
		return
	}
	if in.TrafficPct < 0 || in.TrafficPct > 100 {
		httperror.WriteValidation(w, "invalid_input", "trafficPct must be 0..100")
		return
	}
	v, err := d.Repo.Create(r.Context(), t.ID, formID, in)
	if err != nil {
		if errors.Is(err, ErrLabelConflict) {
			httperror.Write(w, http.StatusConflict, "label_taken", err.Error())
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusCreated, v)
}

// Update PATCH /api/v1/forms/{id}/variants/{variantId}
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	formID := chi.URLParam(r, "id")
	variantID := chi.URLParam(r, "variantId")
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, variantAdminJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	v, err := d.Repo.Update(r.Context(), t.ID, formID, variantID, in)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			httperror.Write(w, http.StatusNotFound, "not_found", "no such variant")
		case errors.Is(err, ErrLabelConflict):
			httperror.Write(w, http.StatusConflict, "label_taken", err.Error())
		default:
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		}
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// Delete DELETE /api/v1/forms/{id}/variants/{variantId}
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	formID := chi.URLParam(r, "id")
	variantID := chi.URLParam(r, "variantId")
	if err := d.Repo.Delete(r.Context(), t.ID, formID, variantID); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "no such variant")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ListPromotions GET /api/v1/forms/{id}/variants/promotions
// Audit feed for the admin UI's "winner history" card.
func (d *Deps) ListPromotions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	formID := chi.URLParam(r, "id")
	ps, err := d.Repo.ListPromotions(r.Context(), t.ID, formID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, ps)
}

// Evaluate POST /api/v1/forms/{id}/variants/evaluate
// Runs one bandit pass on the form's current counters and persists the
// resulting weights + promotion (if any). Returns the Decision so the
// admin UI can show "we just re-weighted" + render an updated confidence
// badge. Idempotent given identical inputs.
//
// This is the manual trigger; a future scheduler can call EvaluateForm
// in-process on a cron without needing a tenant context (it'd iterate
// all forms and use db.WithTenant per form).
func (d *Deps) Evaluate(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	formID := chi.URLParam(r, "id")
	dec, samples, err := EvaluateForm(r.Context(), d.Repo, t.ID, formID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"decision": dec,
		"samples":  samples,
	})
}

// EvaluateForm is the reusable hook the HTTP handler + a future
// scheduler both call: read samples, run Reweight, persist.
func EvaluateForm(ctx context.Context, repo *Repo, tenantID, formID string) (Decision, []Sample, error) {
	samples, err := repo.SamplesForForm(ctx, tenantID, formID)
	if err != nil {
		return Decision{}, nil, err
	}
	if len(samples) == 0 {
		return Decision{Weights: map[string]int{}}, samples, nil
	}
	dec := Reweight(samples)
	if err := repo.ApplyDecision(ctx, tenantID, formID, dec, samples); err != nil {
		return Decision{}, samples, err
	}
	return dec, samples, nil
}

// ---- public helpers ----

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
