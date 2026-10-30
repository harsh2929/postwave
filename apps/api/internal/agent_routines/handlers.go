// SPDX-License-Identifier: AGPL-3.0-only
//
// handlers.go — HTTP surface for agent routines:
//
//	GET    /api/v1/agent-routines             → {"items":[Routine…]}
//	POST   /api/v1/agent-routines             → 201 Routine
//	GET    /api/v1/agent-routines/{id}        → Routine
//	PATCH  /api/v1/agent-routines/{id}        → Routine
//	DELETE /api/v1/agent-routines/{id}        → 204
//	POST   /api/v1/agent-routines/{id}/run    → 202 {"run_id": …}
//	GET    /api/v1/agent-routines/{id}/runs   → {"items":[Run…]}
//
// The manual-run endpoint opens the ledger row synchronously (so the
// 202 carries a real run id) and executes the LLM drafting work in a
// detached goroutine bounded by ExecuteTimeout — same shape as the
// voice service's async sequence-generation path.
package agent_routines

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const routinesJSONMaxBodyBytes int64 = 64 << 10

// Deps wires the agent-routines handlers.
type Deps struct {
	Store  Store
	Runner *Runner
	Logger *slog.Logger
}

// MountRoutes registers the per-tenant agent-routines API. Drafting is
// a campaigns-domain capability: reads need read:campaigns, mutations
// (and run-now, which spends LLM quota and writes drafts) need
// write:campaigns — mirroring the voice drafting routes.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Store == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadCampaigns)
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns)
	r.With(read).Get("/api/v1/agent-routines", d.List)
	r.With(write).Post("/api/v1/agent-routines", d.Create)
	r.With(read).Get("/api/v1/agent-routines/{id}", d.Get)
	r.With(write).Patch("/api/v1/agent-routines/{id}", d.Update)
	r.With(write).Delete("/api/v1/agent-routines/{id}", d.Delete)
	r.With(write).Post("/api/v1/agent-routines/{id}/run", d.RunNow)
	r.With(read).Get("/api/v1/agent-routines/{id}/runs", d.ListRuns)
	// Trust back-reference: the Approvals surface resolves a pending
	// approval to the agent run that produced it, to show the reasoning +
	// draft snapshot beside the decision.
	r.With(read).Get("/api/v1/agent-routines/runs/by-approval/{approvalId}", d.RunByApproval)
}

// List GET /api/v1/agent-routines.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	items, err := d.Store.ListRoutines(r.Context(), t.ID)
	if err != nil {
		d.writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// Create POST /api/v1/agent-routines.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, routinesJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := ValidateCreate(&in); err != nil {
		writeRoutineValidationErr(w, err)
		return
	}
	createdBy := ""
	if u, ok := middleware.UserFromContext(r.Context()); ok {
		createdBy = u.Email
	}
	rt, err := d.Store.CreateRoutine(r.Context(), t.ID, in, createdBy)
	if err != nil {
		d.writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, rt)
}

// Get GET /api/v1/agent-routines/{id}.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	rt, err := d.Store.GetRoutine(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, rt)
}

// Update PATCH /api/v1/agent-routines/{id}.
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, routinesJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := ValidateUpdate(&in); err != nil {
		writeRoutineValidationErr(w, err)
		return
	}
	rt, err := d.Store.UpdateRoutine(r.Context(), t.ID, chi.URLParam(r, "id"), in)
	if err != nil {
		d.writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, rt)
}

// Delete DELETE /api/v1/agent-routines/{id}.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if err := d.Store.DeleteRoutine(r.Context(), t.ID, chi.URLParam(r, "id")); err != nil {
		d.writeStoreErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RunNow POST /api/v1/agent-routines/{id}/run → 202 {"run_id": …}.
//
// Manual runs are allowed even on disabled routines (disabling only
// stops the scheduler); the routine must exist. The drafting work runs
// detached so the request returns immediately.
func (d *Deps) RunNow(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if d.Runner == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "routines_unavailable",
			"agent routine execution is not configured")
		return
	}
	routineID := chi.URLParam(r, "id")
	// Start performs the existence check and active-run claim atomically under
	// the routine row lock. A separate preflight read would race another manual
	// request, a scheduler replica, or deletion.
	runID, err := d.Runner.Start(r.Context(), t.ID, routineID)
	if err != nil {
		d.writeStoreErr(w, r, err)
		return
	}
	tenantID := t.ID
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), ExecuteTimeout)
		defer cancel()
		if err := d.Runner.ExecuteSafely(ctx, tenantID, routineID, runID); err != nil && d.Logger != nil {
			d.Logger.Warn("agent_routines: manual run failed",
				"tenant_id", tenantID, "routine_id", routineID, "run_id", runID, "err", err.Error())
		}
	}()
	writeJSON(w, http.StatusAccepted, map[string]any{
		"run_id": runID,
		"status": RunStatusRunning,
	})
}

// ListRuns GET /api/v1/agent-routines/{id}/runs.
func (d *Deps) ListRuns(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	routineID := chi.URLParam(r, "id")
	if _, err := d.Store.GetRoutine(r.Context(), t.ID, routineID); err != nil {
		d.writeStoreErr(w, r, err)
		return
	}
	items, err := d.Store.ListRuns(r.Context(), t.ID, routineID, 50)
	if err != nil {
		d.writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// RunByApproval GET /api/v1/agent-routines/runs/by-approval/{approvalId}.
// Returns the agent run that opened the given approval, so the Approvals
// surface can show the reasoning + draft snapshot beside the decision.
// 404 when no agent run references the approval (e.g. a human-initiated
// approval) — the caller renders its normal approval view in that case.
func (d *Deps) RunByApproval(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	run, err := d.Store.GetRunByApproval(r.Context(), t.ID, chi.URLParam(r, "approvalId"))
	if err != nil {
		d.writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, run)
}

func (d *Deps) writeStoreErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "routine_not_found", "agent routine not found")
	case errors.Is(err, ErrNameTaken):
		httperror.Write(w, http.StatusConflict, "name_taken", "an agent routine with this name already exists")
	case errors.Is(err, ErrRoutineActive):
		httperror.Write(w, http.StatusConflict, "routine_active",
			"this agent routine has an active run; wait for it to finish before retrying")
	case errors.Is(err, ErrInvalidTargetSegment):
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_target_segment",
			"target segment is not available in this workspace")
	case errors.Is(err, ErrUnsupportedTargetList):
		writeRoutineValidationErr(w, err)
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

func writeRoutineValidationErr(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrUnsupportedTargetList) {
		httperror.Write(w, http.StatusUnprocessableEntity, "unsupported_target_list",
			"list targeting is not supported for agent routines; use a canonical segment or leave it empty")
		return
	}
	httperror.Write(w, http.StatusUnprocessableEntity, "invalid_routine", err.Error())
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
