// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// FlowUsageRef is a flow (journey) that references this template (FLOW-029).
type FlowUsageRef struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status,omitempty"`
}

// FlowUsage returns the journeys whose current graph references templateID as a
// value anywhere in its nodes/triggers. jsonb_path_exists matches exact values,
// not substrings, so a template id embedded in a send_email node is found while
// unrelated text is not.
func (r *Repo) FlowUsage(ctx context.Context, tenantID, templateID string) ([]FlowUsageRef, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, COALESCE(name, '(flow)'), COALESCE(status, '')
  FROM automation_journeys
 WHERE tenant_id = $1::uuid
   AND (
         jsonb_path_exists(nodes, '$.** ? (@ == $v)', jsonb_build_object('v', $2::text))
      OR jsonb_path_exists(triggers, '$.** ? (@ == $v)', jsonb_build_object('v', $2::text))
   )
 ORDER BY updated_at DESC NULLS LAST
 LIMIT 200`, tenantID, templateID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FlowUsageRef{}
	for rows.Next() {
		var f FlowUsageRef
		if err := rows.Scan(&f.ID, &f.Name, &f.Status); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// FlowUsage GET /api/v1/campaign-templates/{id}/flow-usage — lists the flows
// that reference this template so the template detail page can show a reverse
// "used by flows" panel (FLOW-029).
func (d *Deps) FlowUsage(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	items, err := d.Repo.FlowUsage(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
}
