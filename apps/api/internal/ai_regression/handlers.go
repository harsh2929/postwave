// SPDX-License-Identifier: AGPL-3.0-only
//
// handlers.go — HTTP surface for the AI-output regression harness:
//
//	POST   /api/v1/ai-regression/golden-examples       → CaptureGolden (admin)
//	GET    /api/v1/ai-regression/golden-examples       → ListGolden     (read:reports)
//	DELETE /api/v1/ai-regression/golden-examples/{id}  → ArchiveGolden  (admin)
//	POST   /api/v1/ai-regression/runs                  → TriggerRun     (admin)
//	GET    /api/v1/ai-regression/runs                  → ListRuns       (read:reports)
//	GET    /api/v1/ai-regression/runs/latest           → GetLatestRun   (read:reports)
//	GET    /api/v1/ai-regression/runs/{id}             → GetRun         (read:reports)
//	GET    /api/v1/ai-regression/runs/{id}/results     → GetRunResults  (read:reports)
//	GET    /api/v1/ai-regression/settings              → GetSettings    (admin)
//	PUT    /api/v1/ai-regression/settings              → UpdateSettings (admin)
//
// Scopes mirror agent_routines (drafting-domain): reads need read:reports,
// golden mutations, run-trigger and settings are admin because they alter
// the evidence corpus or its policy. Read-only evidence remains available to
// read:reports consumers.
//
// TriggerRun opens a pending run row synchronously (so the 202 carries a
// real run id); the actual LLM replay runs in the voice service. This
// handler validates input, enforces the gate-eligibility rules, and refuses
// a trigger when the tenant has zero golden examples (honest-UI: never a
// fabricated pass on no data).
package ai_regression

import (
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const regressionJSONMaxBodyBytes int64 = 64 << 10

// Deps wires the regression handlers. Store is required; Logger optional.
type Deps struct {
	Store          Store
	Logger         *slog.Logger
	Runtime        VoiceRuntimeIdentity
	ExecutionReady bool
}

// MountRoutes registers the per-tenant regression API.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Store == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	sensitive := regressionEvidenceNoStore

	r.With(sensitive, admin).Post("/api/v1/ai-regression/golden-examples", d.CaptureGolden)
	r.With(sensitive, read).Get("/api/v1/ai-regression/golden-examples", d.ListGolden)
	r.With(sensitive, admin).Delete("/api/v1/ai-regression/golden-examples/{id}", d.ArchiveGolden)

	r.With(sensitive, admin).Post("/api/v1/ai-regression/runs", d.TriggerRun)
	r.With(sensitive, read).Get("/api/v1/ai-regression/runs", d.ListRuns)
	r.With(sensitive, read).Get("/api/v1/ai-regression/runs/latest", d.GetLatestRun)
	r.With(sensitive, read).Get("/api/v1/ai-regression/runs/{id}", d.GetRun)
	r.With(sensitive, read).Get("/api/v1/ai-regression/runs/{id}/results", d.GetRunResults)

	r.With(sensitive, admin).Get("/api/v1/ai-regression/settings", d.GetSettings)
	r.With(sensitive, admin).Put("/api/v1/ai-regression/settings", d.UpdateSettings)
}

func regressionEvidenceNoStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store")
		next.ServeHTTP(w, r)
	})
}

// CaptureGolden POST /api/v1/ai-regression/golden-examples.
func (d *Deps) CaptureGolden(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in CaptureGoldenInput
	if err := httpbody.DecodeJSON(w, r, regressionJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	// Manual references are deliberately provenance-neutral. Public callers
	// cannot assert approval/run/profile/model lineage; trusted automatic
	// capture derives those fields through GoldenAdapter instead.
	in.Brief = strings.TrimSpace(in.Brief)
	in.ApprovedOutput = normalizeGoldenOutput(in.ApprovedOutput)
	in.RequestID = strings.TrimSpace(in.RequestID)
	if parsed, err := uuid.Parse(in.RequestID); err != nil || parsed.String() != in.RequestID {
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_golden_request_id",
			"request_id must be a lowercase UUID")
		return
	}
	in.ModelID = "manual_reference"
	in.ApprovalID = ""
	in.AgentRunID = ""
	in.VoiceProfileVersion = ""
	if msg := validateCapture(&in); msg != "" {
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_golden_example", msg)
		return
	}
	g, err := d.Store.InsertGolden(r.Context(), t.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, g)
}

// ListGolden GET /api/v1/ai-regression/golden-examples?surface_kind=&limit=.
func (d *Deps) ListGolden(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	surface := r.URL.Query().Get("surface_kind")
	if surface != "" && !IsValidSurfaceKind(surface) {
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_surface_kind", "unknown surface_kind")
		return
	}
	items, err := d.Store.ListGolden(r.Context(), t.ID, surface, parseLimit(r))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// ArchiveGolden DELETE /api/v1/ai-regression/golden-examples/{id}.
func (d *Deps) ArchiveGolden(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if err := d.Store.ArchiveGolden(r.Context(), t.ID, chi.URLParam(r, "id")); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "golden_example_not_found", "golden example not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// TriggerRun POST /api/v1/ai-regression/runs → 202 {"run_id": …}.
//
// Refuses (422) when the tenant has zero golden examples — there is nothing
// to replay, and an empty run would be a fabricated result. 409 when a run
// is already in flight for the tenant.
func (d *Deps) TriggerRun(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in TriggerRunInput
	if err := httpbody.DecodeJSON(w, r, regressionJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.ModelVersionTag = strings.TrimSpace(in.ModelVersionTag)
	if !validBoundedText(in.ModelVersionTag, 160) {
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_run", "model_version_tag is required")
		return
	}
	if !d.ExecutionReady || !validVoiceRuntime(d.Runtime) {
		httperror.Write(w, http.StatusServiceUnavailable, "regression_executor_unavailable",
			"the regression executor is not configured")
		return
	}
	// The public label is operator-authored. Every execution-relevant identity
	// and policy field is server-authored and frozen atomically by CreateRun.
	in.RuntimeProvider = d.Runtime.Provider
	in.ModelID = d.Runtime.ModelID
	in.PromptVersionTag = d.Runtime.PromptPolicyVersion
	run, err := d.Store.CreateRun(r.Context(), t.ID, in)
	if err != nil {
		if errors.Is(err, ErrNoGoldenExamples) {
			httperror.Write(w, http.StatusUnprocessableEntity, "no_golden_examples",
				"no golden examples captured yet — approve AI outputs to build your regression set")
			return
		}
		if errors.Is(err, ErrRunInFlight) {
			httperror.Write(w, http.StatusConflict, "run_in_flight",
				"a regression run is already in progress for this tenant")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"run_id":  run.ID,
		"status":  run.Status,
		"runtime": d.Runtime,
	})
}

// ListRuns GET /api/v1/ai-regression/runs.
func (d *Deps) ListRuns(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	items, err := d.Store.ListRuns(r.Context(), t.ID, parseLimit(r))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// GetLatestRun GET /api/v1/ai-regression/runs/latest → {"run": RegressionRun|null}.
// A tenant with no runs gets {"run": null} (200), never a 404 — honest empty
// state for the badge.
func (d *Deps) GetLatestRun(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	run, err := d.Store.LatestRun(r.Context(), t.ID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusOK, map[string]any{"run": nil})
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"run": run})
}

// GetRun GET /api/v1/ai-regression/runs/{id}.
func (d *Deps) GetRun(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	run, err := d.Store.GetRun(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "run_not_found", "regression run not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, run)
}

// GetRunResults GET /api/v1/ai-regression/runs/{id}/results.
func (d *Deps) GetRunResults(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	runID := chi.URLParam(r, "id")
	// Existence check so an unknown run is a clean 404 rather than {items:[]}.
	if _, err := d.Store.GetRun(r.Context(), t.ID, runID); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "run_not_found", "regression run not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	items, err := d.Store.ListResults(r.Context(), t.ID, runID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// GetSettings GET /api/v1/ai-regression/settings.
func (d *Deps) GetSettings(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	s, err := d.Store.GetSettings(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// UpdateSettings PUT /api/v1/ai-regression/settings.
func (d *Deps) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in RegressionSettings
	if err := httpbody.DecodeJSON(w, r, regressionJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if msg := validateSettings(&in); msg != "" {
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_settings", msg)
		return
	}
	s, err := d.Store.PutSettings(r.Context(), t.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// ----- validation (pure) ---------------------------------------------------

// validateCapture returns "" when valid, else a human-readable reason.
func validateCapture(in *CaptureGoldenInput) string {
	if !IsValidSurfaceKind(in.SurfaceKind) {
		return "surface_kind must be one of campaign_draft, subject_line, sequence_draft, campaign_summary, reply_intent"
	}
	if !utf8.ValidString(in.Brief) {
		return "brief must be valid UTF-8"
	}
	if l := utf8.RuneCountInString(in.Brief); l < 1 || l > maxBriefLen {
		return "brief must be between 1 and 8000 characters"
	}
	if !utf8.ValidString(in.ApprovedOutput) {
		return "approved_output must be valid UTF-8"
	}
	if l := utf8.RuneCountInString(in.ApprovedOutput); l < 1 || l > maxOutputLen {
		return "approved_output must be between 1 and 32000 characters"
	}
	return ""
}

// validateSettings returns "" when valid, else a reason. Thresholds are
// 0..100; min_examples_for_gate must match the public contract and fit the
// PostgreSQL integer column.
func validateSettings(in *RegressionSettings) string {
	if in.WarnThreshold < 0 || in.WarnThreshold > 100 {
		return "warn_threshold must be between 0 and 100"
	}
	if in.HardGateThreshold < 0 || in.HardGateThreshold > 100 {
		return "hard_gate_threshold must be between 0 and 100"
	}
	if in.MinExamplesForGate < 1 || in.MinExamplesForGate > math.MaxInt32 {
		return "min_examples_for_gate must be between 1 and 2147483647"
	}
	return ""
}

func parseLimit(r *http.Request) int {
	q := r.URL.Query().Get("limit")
	if q == "" {
		return 0
	}
	n := 0
	for _, c := range q {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
		if n > 100000 {
			break
		}
	}
	return n
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
