// SPDX-License-Identifier: AGPL-3.0-only
//
// Package flowsteps reads what happened to each node on ONE flow run.
//
// The blueprint asks for a run inspector with per-node attempts. The data for
// it has existed longer than anyone noticed: `flow_step_metrics` has carried a
// `run_id` column and a matching index — `(tenant_id, run_id, occurred_at DESC)
// WHERE run_id IS NOT NULL` — since migration 1627, and that index matched zero
// rows the entire time, because the writer never supplied the field. It does
// now. This is the read half.
//
// SEPARATE FROM `internal/flowbuilder` on purpose. That package is behind
// `flowRuntimeQualified = false`, which gates promote/publish/activate and the
// four run paths. Reading what a run already did is not execution, and putting
// this there would make an inspector unavailable exactly while the runtime it
// inspects is being qualified — the period when somebody most wants to look.
//
// READ-ONLY, and tenant-scoped through RLS rather than a WHERE clause alone:
// `flow_step_metrics` has `tenant_isolation`, so the binding is what keeps one
// tenant's run out of another's inspector even if a predicate is dropped later.
package flowsteps

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Attempt is one node's outcome on one run.
//
// The counters are kept as three numbers rather than collapsed into a single
// status because a node can be attempted more than once within a run — a retry
// after a transient failure is `failed: 1` then `applied: 1`, and folding that
// into "applied" would hide the retry, which is the thing an inspector is
// opened to find.
type Attempt struct {
	NodeID     string    `json:"node_id"`
	ActionKind string    `json:"action_kind"`
	Applied    int       `json:"applied"`
	Skipped    int       `json:"skipped"`
	Failed     int       `json:"failed"`
	Error      string    `json:"error,omitempty"`
	OccurredAt time.Time `json:"occurred_at"`
}

type Repo struct{ Pool *db.Pool }

// ForRun returns every recorded attempt on one run, oldest first.
//
// Oldest-first because an inspector is read as a sequence: the question is
// "what happened, in what order, and where did it stop", and newest-first makes
// a reader reconstruct the order themselves.
func (r *Repo) ForRun(ctx context.Context, tenantID, runID string) ([]Attempt, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT node_id, action_kind, applied, skipped, failed,
       COALESCE(error, ''), occurred_at
  FROM flow_step_metrics
 WHERE tenant_id = $1::uuid
   AND run_id = $2::uuid
 ORDER BY occurred_at ASC, node_id ASC`, tenantID, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Non-nil so an empty result serialises as [] rather than null: a client
	// distinguishing "no attempts recorded" from "field absent" should not have
	// to.
	out := []Attempt{}
	for rows.Next() {
		var a Attempt
		if err := rows.Scan(&a.NodeID, &a.ActionKind, &a.Applied, &a.Skipped,
			&a.Failed, &a.Error, &a.OccurredAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

// MountRoutes registers the inspector read.
func (d *Deps) MountRoutes(r chi.Router) {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		return
	}
	// read:reports rather than an admin scope: this is observability about work
	// the tenant already ran, and gating it behind admin would put the answer to
	// "why did this subscriber not get the email" out of reach of the person
	// most likely to be asking.
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/flow-runs/{run_id}/steps", d.List)
}

func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	runID := strings.TrimSpace(chi.URLParam(r, "run_id"))
	if runID == "" {
		httperror.WriteValidation(w, "missing_run_id", "run_id required")
		return
	}
	attempts, err := d.Repo.ForRun(r.Context(), t.ID, runID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"run_id": runID, "attempts": attempts})
}
