// SPDX-License-Identifier: AGPL-3.0-only
//
// G20 (campaigns 2026): multi-stage (N-stage) ordered approval chain.
// Additive to the single-gate approvals system: a tenant defines an
// ordered list of roles per resource_type (Editor -> Legal -> CMO);
// each stage must approve before the next is notified; the resource
// unlocks (via OnApproved) only after the FINAL stage approves; any
// stage reject terminates the chain. The single-gate two-person /
// delegation / escalation paths are untouched.

package approvals

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ChainStep is one ordered stage of a resource_type's approval chain.
type ChainStep struct {
	Position int    `json:"position"`
	Role     string `json:"role"`
}

// StageProgress is one stage's state for a specific approval.
type StageProgress struct {
	Position     int     `json:"position"`
	Role         string  `json:"role"`
	Status       string  `json:"status"` // pending|approved|rejected
	DecidedByUID *string `json:"decided_by_user_id,omitempty"`
}

// ChainState is the computed outcome of a chain's progress.
type ChainState string

const (
	ChainPending  ChainState = "pending"
	ChainApproved ChainState = "approved"
	ChainRejected ChainState = "rejected"
)

// evaluateChain reduces ordered stage statuses to an overall state +
// the current (next pending) position. Pure + testable:
//   - any rejected stage  => rejected
//   - all stages approved => approved
//   - otherwise           => pending, current = first non-approved stage
func evaluateChain(stages []StageProgress) (ChainState, int) {
	current := 0
	allApproved := true
	for _, s := range stages {
		if s.Status == "rejected" {
			return ChainRejected, s.Position
		}
		if s.Status != "approved" {
			allApproved = false
			if current == 0 {
				current = s.Position
			}
		}
	}
	if len(stages) > 0 && allApproved {
		return ChainApproved, stages[len(stages)-1].Position
	}
	return ChainPending, current
}

// ChainDeps is the self-contained handler bundle for the chain config +
// per-approval progress. Kept separate from the single-gate Deps.
type ChainDeps struct {
	Pool   *db.Pool
	Logger *slog.Logger
	// OnComplete unlocks the resource when the final stage approves —
	// wire it to the same hook the single gate uses.
	OnComplete ApprovedHook
}

// MountChain wires the chain config + progress routes.
func (d *ChainDeps) MountChain(r chi.Router) {
	if d == nil || d.Pool == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Put("/api/v1/approvals/chain", d.setChain)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/approvals/chain", d.getChain)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/approvals/{id}/chain", d.getProgress)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/approvals/{id}/chain/decide", d.decideStage)
}

func (d *ChainDeps) setChain(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeChainErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in struct {
		ResourceType string   `json:"resource_type"`
		Roles        []string `json:"roles"` // ordered
	}
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.ResourceType = strings.TrimSpace(in.ResourceType)
	if in.ResourceType == "" {
		writeChainErr(w, http.StatusBadRequest, "missing_resource_type", "resource_type required")
		return
	}
	roles := trimRoles(in.Roles)
	if len(roles) == 0 {
		writeChainErr(w, http.StatusBadRequest, "missing_roles", "at least one role required")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(),
		`DELETE FROM approval_chain_steps WHERE tenant_id = $1::uuid AND resource_type = $2`,
		t.ID, in.ResourceType); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	for i, role := range roles {
		if _, err := tx.Exec(r.Context(), `
INSERT INTO approval_chain_steps (tenant_id, resource_type, position, role)
VALUES ($1::uuid, $2, $3, $4)`, t.ID, in.ResourceType, i+1, role); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	steps := make([]ChainStep, len(roles))
	for i, role := range roles {
		steps[i] = ChainStep{Position: i + 1, Role: role}
	}
	writeChainJSON(w, http.StatusOK, map[string]any{"resource_type": in.ResourceType, "steps": steps})
}

func (d *ChainDeps) getChain(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeChainErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	resourceType := strings.TrimSpace(r.URL.Query().Get("resource_type"))
	steps, err := d.loadSteps(r.Context(), t.ID, resourceType)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeChainJSON(w, http.StatusOK, map[string]any{"resource_type": resourceType, "steps": steps})
}

func (d *ChainDeps) loadSteps(ctx context.Context, tenantID, resourceType string) ([]ChainStep, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT position, role FROM approval_chain_steps
 WHERE tenant_id = $1::uuid AND resource_type = $2
 ORDER BY position`, tenantID, resourceType)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ChainStep{}
	for rows.Next() {
		var s ChainStep
		if err := rows.Scan(&s.Position, &s.Role); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (d *ChainDeps) getProgress(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeChainErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	approvalID := chi.URLParam(r, "id")
	stages, err := d.loadProgress(r.Context(), t.ID, approvalID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	state, current := evaluateChain(stages)
	writeChainJSON(w, http.StatusOK, map[string]any{
		"approval_id":      approvalID,
		"stages":           stages,
		"state":            state,
		"current_position": current,
	})
}

func (d *ChainDeps) loadProgress(ctx context.Context, tenantID, approvalID string) ([]StageProgress, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT position, role, status, decided_by_user_id
  FROM approval_chain_progress
 WHERE tenant_id = $1::uuid AND approval_id = $2::uuid
 ORDER BY position`, tenantID, approvalID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []StageProgress{}
	for rows.Next() {
		var s StageProgress
		if err := rows.Scan(&s.Position, &s.Role, &s.Status, &s.DecidedByUID); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (d *ChainDeps) decideStage(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeChainErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	approvalID := chi.URLParam(r, "id")
	var in struct {
		ResourceType string `json:"resource_type"`
		Decision     string `json:"decision"` // approve|reject
	}
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if in.Decision != string(DecisionApprove) && in.Decision != string(DecisionReject) {
		writeChainErr(w, http.StatusBadRequest, "bad_decision", "decision must be approve|reject")
		return
	}
	var userID string
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		userID = u.ID
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Lazily initialize the per-approval progress from the chain steps on
	// first decision.
	var existing int
	_ = tx.QueryRow(r.Context(),
		`SELECT count(*)::int FROM approval_chain_progress WHERE tenant_id=$1::uuid AND approval_id=$2::uuid`,
		t.ID, approvalID).Scan(&existing)
	if existing == 0 {
		steps, err := d.loadSteps(r.Context(), t.ID, strings.TrimSpace(in.ResourceType))
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		if len(steps) == 0 {
			writeChainErr(w, http.StatusBadRequest, "no_chain", "no approval chain defined for this resource type")
			return
		}
		for _, s := range steps {
			if _, err := tx.Exec(r.Context(), `
INSERT INTO approval_chain_progress (tenant_id, approval_id, position, role)
VALUES ($1::uuid, $2::uuid, $3, $4)
ON CONFLICT (tenant_id, approval_id, position) DO NOTHING`,
				t.ID, approvalID, s.Position, s.Role); err != nil {
				httperror.WriteInternal(w, d.Logger, err, r.Context())
				return
			}
		}
	}

	// Find the current pending stage and decide it.
	var curPos int
	var curRole string
	err = tx.QueryRow(r.Context(), `
SELECT position, role FROM approval_chain_progress
 WHERE tenant_id=$1::uuid AND approval_id=$2::uuid AND status='pending'
 ORDER BY position LIMIT 1`, t.ID, approvalID).Scan(&curPos, &curRole)
	if err != nil {
		writeChainErr(w, http.StatusConflict, "chain_settled", "no pending stage — chain already complete or rejected")
		return
	}
	newStatus := "approved"
	if in.Decision == string(DecisionReject) {
		newStatus = "rejected"
	}
	if _, err := tx.Exec(r.Context(), `
UPDATE approval_chain_progress
   SET status=$4, decided_by_user_id=NULLIF($5,''), decided_at=now()
 WHERE tenant_id=$1::uuid AND approval_id=$2::uuid AND position=$3`,
		t.ID, approvalID, curPos, newStatus, userID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Per-stage audit trail.
	_ = db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r),
		"approval.chain.stage_decided", "approval", approvalID, map[string]any{
			"position": curPos, "role": curRole, "decision": in.Decision,
		})
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	stages, err := d.loadProgress(r.Context(), t.ID, approvalID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	state, current := evaluateChain(stages)
	// Final stage approved → unlock the resource.
	if state == ChainApproved && d.OnComplete != nil {
		if err := d.OnComplete(r.Context(), t.ID, ResourceType(in.ResourceType), approvalID); err != nil {
			d.Logger.Warn("approval chain OnComplete failed", "err", err.Error())
		}
	}
	writeChainJSON(w, http.StatusOK, map[string]any{
		"approval_id":      approvalID,
		"stages":           stages,
		"state":            state,
		"current_position": current,
	})
}

func trimRoles(in []string) []string {
	out := make([]string, 0, len(in))
	for _, v := range in {
		if v = strings.TrimSpace(strings.ToLower(v)); v != "" {
			out = append(out, v)
		}
	}
	return out
}

func writeChainJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeChainErr(w http.ResponseWriter, status int, code, msg string) {
	writeChainJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}
