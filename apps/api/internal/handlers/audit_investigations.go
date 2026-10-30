// SPDX-License-Identifier: AGPL-3.0-only
//
// HTTP handlers for ai-investigation-agent (audit-2026 AI/Anomaly P1).
//
// Endpoints:
//
//	POST  /api/v1/audit/{id}/investigate
//	GET   /api/v1/audit/investigations
//	GET   /api/v1/audit/investigations/{id}
//	POST  /api/v1/audit/investigations/{id}/approve
//	POST  /api/v1/audit/investigations/{id}/reject
//	GET   /api/v1/audit/investigations/{id}/stream  (SSE)
//
// Tenant scoping: every endpoint reads TenantFromContext + opens its
// tx via the Store, which sets app.tenant_id. The audit_investigations
// RLS policy gates row visibility.
package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/audit/agent"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sse"
)

// AuditInvestigationHandlers wires the investigator agent + its
// persistence into HTTP. All fields are nil-safe; missing
// deps degrade individual endpoints to 503 rather than panicking.
type AuditInvestigationHandlers struct {
	Investigator *agent.Investigator
	Store        *agent.Store

	// Logger is used by httperror.WriteInternal for structured server-side
	// logging of unexpected failures. nil-safe — when nil, internal errors
	// are still returned to the client as the generic envelope but no log
	// line is emitted. main.go wires the process-wide *slog.Logger here.
	Logger *slog.Logger

	// streamMu + streams: pub-sub channel set keyed by investigation id.
	// SSE consumers subscribe; the trigger flow publishes status
	// transitions. In-process only — multi-replica deploys would need
	// a Redis backplane.
	streamMu sync.Mutex
	streams  map[string][]chan investigationStreamEvent
}

type investigationStreamEvent struct {
	Type      string    `json:"type"` // "status" | "complete" | "finding"
	Status    string    `json:"status,omitempty"`
	Message   string    `json:"message,omitempty"`
	Timestamp time.Time `json:"ts"`
}

// Trigger POST /api/v1/audit/{id}/investigate
//
// Spins the investigator agent against the requested audit row. On
// success returns the investigation id; the caller polls GET
// /api/v1/audit/investigations/{id} (or subscribes to the SSE
// stream) to fetch the findings as they land.
func (h *AuditInvestigationHandlers) Trigger(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if h == nil || h.Investigator == nil || h.Store == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "agent_unavailable", "investigation agent not configured")
		return
	}
	idStr := chi.URLParam(r, "id")
	seedID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || seedID <= 0 {
		writeJSONErr(w, http.StatusBadRequest, "bad_id", "id must be a positive integer")
		return
	}

	// Optional context_window_minutes override.
	if v := r.URL.Query().Get("context_window_minutes"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 24*60 {
			h.Investigator.ContextWindow = time.Duration(n) * time.Minute
		}
	}

	res, err := h.Investigator.Investigate(r.Context(), t.ID, seedID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := res.Validate(); err != nil {
		// Hard rule: every finding must cite at least one audit_log id.
		// 422 lets the caller distinguish from a 5xx transient failure.
		// The validator emits operator-authored text describing which
		// finding is missing its cited audit_log id — safe to echo.
		httperror.Write(w, http.StatusUnprocessableEntity, "must_cite_evidence", err.Error())
		return
	}
	invID, err := h.Store.Insert(r.Context(), t.ID, res)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	h.publish(invID, investigationStreamEvent{
		Type:      "complete",
		Status:    "draft",
		Message:   fmt.Sprintf("Investigation produced %d findings and %d proposed actions.", len(res.Findings), len(res.ProposedActions)),
		Timestamp: time.Now().UTC(),
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"id":             invID,
		"seed_audit_id":  res.SeedAuditID,
		"findings_count": len(res.Findings),
		"actions_count":  len(res.ProposedActions),
		"confidence":     res.Confidence,
		"mitre":          res.MitreTechniques,
		"status":         "draft",
	})
}

// List GET /api/v1/audit/investigations
func (h *AuditInvestigationHandlers) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if h == nil || h.Store == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "agent_unavailable", "")
		return
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	status := r.URL.Query().Get("status")
	switch status {
	case "", "draft", "approved", "rejected", "executed":
	default:
		writeJSONErr(w, http.StatusBadRequest, "bad_status", "status must be one of draft|approved|rejected|executed")
		return
	}
	items, err := h.Store.List(r.Context(), t.ID, agent.ListFilter{Status: status, Limit: limit})
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"investigations": items})
}

// Get GET /api/v1/audit/investigations/{id}
func (h *AuditInvestigationHandlers) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if h == nil || h.Store == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "agent_unavailable", "")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSONErr(w, http.StatusBadRequest, "bad_id", "")
		return
	}
	inv, err := h.Store.Get(r.Context(), t.ID, id)
	if err != nil {
		// Store.Get returns a generic sql.ErrNoRows / pgx-wrapped error
		// when the row is absent or hidden by RLS — never echo that text.
		if h.Logger != nil {
			h.Logger.Warn("audit_investigation.get_not_found", slog.String("err", err.Error()), slog.String("id", id))
		}
		httperror.Write(w, http.StatusNotFound, "not_found", "investigation not found")
		return
	}
	writeJSON(w, http.StatusOK, inv)
}

// Approve POST /api/v1/audit/investigations/{id}/approve
//
// Body: {"notes": "..."}
//
// Flips status draft→approved. Approval records a human review decision;
// it does not apply the proposed identity, key, token, MFA, or IP changes.
// Those remediations require a separately integrated external workflow.
func (h *AuditInvestigationHandlers) Approve(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if h == nil || h.Store == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "agent_unavailable", "")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSONErr(w, http.StatusBadRequest, "bad_id", "")
		return
	}
	var body struct {
		ActionIDs []string `json:"action_ids"`
		Notes     string   `json:"notes"`
	}
	if r.ContentLength > 0 {
		if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &body); err != nil {
			httpbody.
				// json.Decode errors are operator-safe (they describe the
				// shape mismatch, not internal state).
				WriteError(w, err)
			return

		}
	}
	if len(body.ActionIDs) > 0 {
		httperror.WriteValidation(w, "partial_approval_unsupported", "individual action approval is not supported; approve or reject the complete remediation plan")
		return
	}
	approver := ""
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		approver = u.ID
	}
	if err := h.Store.Approve(r.Context(), t.ID, id, approver); err != nil {
		// Approve can fail for conflict reasons (already approved/rejected)
		// or for raw DB reasons. The text isn't operator-curated, so log
		// it server-side and surface a static conflict message.
		if h.Logger != nil {
			h.Logger.Warn("audit_investigation.approve_conflict", slog.String("err", err.Error()), slog.String("id", id))
		}
		httperror.Write(w, http.StatusConflict, "approve_failed", "investigation could not be approved in its current state")
		return
	}

	h.publish(id, investigationStreamEvent{
		Type:      "status",
		Status:    "approved",
		Message:   "Remediation plan approved for manual or external execution. Moosewave did not apply account changes.",
		Timestamp: time.Now().UTC(),
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"id":              id,
		"status":          "approved",
		"execution_state": "not_executed",
		"approval_notes":  body.Notes,
		"message":         "Remediation plan approved for manual or external execution; Moosewave did not apply account changes.",
	})
}

// Reject POST /api/v1/audit/investigations/{id}/reject
//
// Body: {"reason": "..."}
func (h *AuditInvestigationHandlers) Reject(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if h == nil || h.Store == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "agent_unavailable", "")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSONErr(w, http.StatusBadRequest, "bad_id", "")
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &body); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if body.Reason == "" {
		writeJSONErr(w, http.StatusBadRequest, "reason_required", "rejection reason is required")
		return
	}
	if err := h.Store.Reject(r.Context(), t.ID, id, body.Reason); err != nil {
		// Reject can fail for conflict reasons (already approved/rejected)
		// or for raw DB reasons. Same treatment as Approve.
		if h.Logger != nil {
			h.Logger.Warn("audit_investigation.reject_conflict", slog.String("err", err.Error()), slog.String("id", id))
		}
		httperror.Write(w, http.StatusConflict, "reject_failed", "investigation could not be rejected in its current state")
		return
	}
	h.publish(id, investigationStreamEvent{
		Type:      "status",
		Status:    "rejected",
		Message:   "Investigation rejected: " + body.Reason,
		Timestamp: time.Now().UTC(),
	})
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": "rejected"})
}

// Stream GET /api/v1/audit/investigations/{id}/stream — Server-Sent
// Events feed of status transitions.
func (h *AuditInvestigationHandlers) Stream(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if h == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "agent_unavailable", "")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSONErr(w, http.StatusBadRequest, "bad_id", "")
		return
	}
	// Tenant-scope guard: ensure the investigation exists for this
	// tenant before opening the stream, so a cross-tenant subscriber
	// can't peek at status transitions.
	if h.Store != nil {
		if _, err := h.Store.Get(r.Context(), t.ID, id); err != nil {
			// Same rationale as Get — never echo the raw DB error text
			// across a tenant boundary check.
			if h.Logger != nil {
				h.Logger.Warn("audit_investigation.stream_not_found", slog.String("err", err.Error()), slog.String("id", id))
			}
			httperror.Write(w, http.StatusNotFound, "not_found", "investigation not found")
			return
		}
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	stream, ok := sse.Open(w)
	if !ok {
		writeJSONErr(w, http.StatusInternalServerError, "no_flush", "streaming not supported")
		return
	}
	ch := h.subscribe(id)
	defer h.unsubscribe(id, ch)

	// Initial hello so the SSE consumer knows the stream opened.
	if stream.Sendf("event: hello\ndata: {\"id\":%q}\n\n", id) != nil {
		return
	}

	keepalive := time.NewTicker(20 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			js, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			if stream.Sendf("event: %s\ndata: %s\n\n", ev.Type, js) != nil {
				return
			}
		case <-keepalive.C:
			// A failed write means the client is gone.
			if stream.Sendf(": keepalive\n\n") != nil {
				return
			}
		}
	}
}

func (h *AuditInvestigationHandlers) subscribe(id string) chan investigationStreamEvent {
	h.streamMu.Lock()
	defer h.streamMu.Unlock()
	if h.streams == nil {
		h.streams = map[string][]chan investigationStreamEvent{}
	}
	ch := make(chan investigationStreamEvent, 8)
	h.streams[id] = append(h.streams[id], ch)
	return ch
}

func (h *AuditInvestigationHandlers) unsubscribe(id string, ch chan investigationStreamEvent) {
	h.streamMu.Lock()
	defer h.streamMu.Unlock()
	list := h.streams[id]
	out := list[:0]
	for _, c := range list {
		if c != ch {
			out = append(out, c)
		}
	}
	if len(out) == 0 {
		delete(h.streams, id)
	} else {
		h.streams[id] = out
	}
	// Close last to wake any blocked send.
	defer func() { _ = recover() }()
	close(ch)
}

func (h *AuditInvestigationHandlers) publish(id string, ev investigationStreamEvent) {
	h.streamMu.Lock()
	subs := append([]chan investigationStreamEvent(nil), h.streams[id]...)
	h.streamMu.Unlock()
	for _, c := range subs {
		// Non-blocking send: a slow consumer drops events rather than
		// stalling the trigger flow.
		select {
		case c <- ev:
		default:
		}
	}
}

// AssertInvestigationHandlersBuildable is a compile-time sanity check
// that the package compiles against the package-level error types we
// reference. Keeps a stable import for errors so go vet does not
// drop it during future edits.
var _ = errors.New
