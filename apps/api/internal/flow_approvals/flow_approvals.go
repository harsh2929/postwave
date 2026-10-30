// SPDX-License-Identifier: AGPL-3.0-only
//
// Package flow_approvals is the operator surface for the in-flow manual_review
// gate. The automation engine's PgxApprovalGate records a per-node approval
// request in automation_message_approvals (transactional_status='requested')
// and parks the flow; these endpoints let an operator list pending reviews and
// approve / reject them. On approve the engine's parked execution resumes on
// its next retry; on reject the node is acked (the branch ends).

package flow_approvals

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

var errNotPending = errors.New("flow_approvals: approval is not in a decidable state")

// Approval is one automation_message_approvals row.
type Approval struct {
	ID                  string     `json:"id"`
	AutomationID        string     `json:"automation_id,omitempty"`
	NodeID              string     `json:"node_id"`
	Channel             string     `json:"channel"`
	MessageRef          string     `json:"message_ref,omitempty"`
	TransactionalStatus string     `json:"transactional_status"`
	RequestedAt         *time.Time `json:"requested_at,omitempty"`
	DecidedAt           *time.Time `json:"decided_at,omitempty"`
	CreatedAt           time.Time  `json:"created_at"`
}

type Repo struct{ Pool *db.Pool }

const cols = `id::text, COALESCE(automation_id::text,''), node_id, channel,
	message_ref, transactional_status, requested_at, decided_at, created_at`

// List returns the tenant's approvals, optionally filtered by transactional
// status (e.g. "requested"); newest first.
func (r *Repo) List(ctx context.Context, tenantID, status string) ([]Approval, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+cols+` FROM automation_message_approvals
 WHERE tenant_id = $1::uuid AND ($2 = '' OR transactional_status = $2)
 ORDER BY COALESCE(requested_at, created_at) DESC`, tenantID, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Approval{}
	for rows.Next() {
		var a Approval
		if err := rows.Scan(&a.ID, &a.AutomationID, &a.NodeID, &a.Channel,
			&a.MessageRef, &a.TransactionalStatus, &a.RequestedAt, &a.DecidedAt, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// Decide flips a pending approval to approved/rejected/revoked, stamping
// decided_at. Only 'requested' (or the initial 'marketing') rows are decidable;
// re-deciding an already-decided row returns errNotPending. Returns the new row.
func (r *Repo) Decide(ctx context.Context, tenantID, id, decision string) (*Approval, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var a Approval
	err = tx.QueryRow(ctx, `
UPDATE automation_message_approvals
   SET transactional_status = $3, decided_at = now(), updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND transactional_status IN ('requested','marketing')
RETURNING `+cols, tenantID, id, decision).Scan(
		&a.ID, &a.AutomationID, &a.NodeID, &a.Channel, &a.MessageRef,
		&a.TransactionalStatus, &a.RequestedAt, &a.DecidedAt, &a.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// Either the row doesn't exist or it's already decided.
		return nil, errNotPending
	}
	if err != nil {
		return nil, err
	}
	return &a, tx.Commit(ctx)
}

// ---------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------

type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

func (d *Deps) MountRoutes(r chi.Router) {
	read := apikeys.RequireScope(apikeys.ScopeReadCampaigns)
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns)
	r.With(read).Get("/api/v1/flow-builder/approvals", d.List)
	r.With(write).Post("/api/v1/flow-builder/approvals/{id}/approve", d.Approve)
	r.With(write).Post("/api/v1/flow-builder/approvals/{id}/reject", d.Reject)
}

func (d *Deps) tenant(w http.ResponseWriter, r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return "", false
	}
	return t.ID, true
}

func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	tid, ok := d.tenant(w, r)
	if !ok {
		return
	}
	out, err := d.Repo.List(r.Context(), tid, r.URL.Query().Get("status"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) Approve(w http.ResponseWriter, r *http.Request) { d.decide(w, r, "approved") }
func (d *Deps) Reject(w http.ResponseWriter, r *http.Request)  { d.decide(w, r, "rejected") }

func (d *Deps) decide(w http.ResponseWriter, r *http.Request, decision string) {
	tid, ok := d.tenant(w, r)
	if !ok {
		return
	}
	a, err := d.Repo.Decide(r.Context(), tid, chi.URLParam(r, "id"), decision)
	if errors.Is(err, errNotPending) {
		httperror.Write(w, http.StatusConflict, "not_pending", "this review has already been decided or does not exist")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tid))
		return
	}
	writeJSON(w, http.StatusOK, a)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
