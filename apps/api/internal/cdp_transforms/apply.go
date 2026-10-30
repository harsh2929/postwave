// SPDX-License-Identifier: AGPL-3.0-only
//
// apply.go — the DB-backed bulk side of the transform engine. The pure engine
// (engine.go) only previews ops against an ad-hoc map; this applies a transform
// across real subscribers' custom_fields, writing the result back and recording
// an audit run. Kept in its own file so engine.go stays IO-free.
//
//	POST /api/v1/cdp/transforms/apply
//	  { "ops": [...], "subscriber_ids": ["uuid", ...], "dry_run": true }
//
// dry_run (the default) computes + audits the changes without writing.

package cdp_transforms

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// maxApplySubscribers caps how many subscribers one apply call may touch, so a
// single request can't mutate an unbounded slice of the audience.
const maxApplySubscribers = 5000

// Deps carries the DB pool the apply handler needs. The preview/ops handlers
// stay pool-free (pure engine), so this is wired separately.
type Deps struct {
	Pool *db.Pool
}

// MountApplyRoutes registers the DB-backed apply endpoint. Wired alongside the
// pure MountRoutes in main.go.
func (d *Deps) MountApplyRoutes(r chi.Router) {
	r.Post("/api/v1/cdp/transforms/apply", d.applyHandler)
}

type applyRequest struct {
	Ops           []Op     `json:"ops"`
	SubscriberIDs []string `json:"subscriber_ids"`
	DryRun        bool     `json:"dry_run"`
}

type applySample struct {
	SubscriberID string         `json:"subscriber_id"`
	Changed      bool           `json:"changed"`
	Results      []Result       `json:"results"`
	After        map[string]any `json:"after,omitempty"`
}

type applyResponse struct {
	RunID   string        `json:"run_id"`
	Total   int           `json:"total"`
	Changed int           `json:"changed"`
	Failed  int           `json:"failed"`
	DryRun  bool          `json:"dry_run"`
	Samples []applySample `json:"samples"`
}

func (d *Deps) applyHandler(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errBody("no_tenant", "tenant required"))
		return
	}
	var req applyRequest
	if err := httpbody.DecodeJSON(w, r, maxPreviewBytes, &req); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if len(req.Ops) == 0 {
		writeJSON(w, http.StatusUnprocessableEntity, errBody("no_ops", "at least one op is required"))
		return
	}
	if len(req.SubscriberIDs) == 0 {
		writeJSON(w, http.StatusUnprocessableEntity, errBody("no_subscribers", "subscriber_ids is required"))
		return
	}
	if len(req.SubscriberIDs) > maxApplySubscribers {
		writeJSON(w, http.StatusUnprocessableEntity,
			errBody("too_many_subscribers", "subscriber_ids exceeds the per-run cap"))
		return
	}

	resp, err := d.runApply(r.Context(), tenant.ID, req)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errBody("apply_failed", "an internal error occurred"))
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// runApply loads the targeted subscribers, applies the ops to each, writes the
// changed ones back (unless dry_run), and records one audit run — all inside a
// single tenant transaction so a partial failure rolls everything back.
func (d *Deps) runApply(ctx context.Context, tenantID string, req applyRequest) (applyResponse, error) {
	if d.Pool == nil {
		return applyResponse{}, errors.New("cdp_transforms: nil pool")
	}
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return applyResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
		SELECT id::text, COALESCE(custom_fields, '{}'::jsonb)
		  FROM subscribers
		 WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`,
		tenantID, req.SubscriberIDs)
	if err != nil {
		return applyResponse{}, err
	}

	type loaded struct {
		id    string
		props map[string]any
	}
	var subs []loaded
	for rows.Next() {
		var id string
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return applyResponse{}, err
		}
		props := map[string]any{}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &props)
		}
		subs = append(subs, loaded{id: id, props: props})
	}
	if err := rows.Err(); err != nil {
		return applyResponse{}, err
	}
	rows.Close()

	resp := applyResponse{DryRun: req.DryRun, Total: len(subs), Samples: []applySample{}}
	for _, s := range subs {
		out := Apply(s.props, req.Ops)
		subChanged := false
		for _, r := range out.Results {
			if r.Changed {
				subChanged = true
				break
			}
		}
		if out.Failed > 0 {
			resp.Failed++
		}
		if subChanged {
			resp.Changed++
			if !req.DryRun {
				encoded, mErr := json.Marshal(out.Properties)
				if mErr != nil {
					return applyResponse{}, mErr
				}
				if _, wErr := tx.Exec(ctx, `
					UPDATE subscribers SET custom_fields = $3::jsonb, updated_at = now()
					 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
					tenantID, s.id, string(encoded)); wErr != nil {
					return applyResponse{}, wErr
				}
			}
		}
		if len(resp.Samples) < 10 {
			resp.Samples = append(resp.Samples, applySample{
				SubscriberID: s.id,
				Changed:      subChanged,
				Results:      out.Results,
				After:        out.Properties,
			})
		}
	}

	opsJSON, err := json.Marshal(req.Ops)
	if err != nil {
		return applyResponse{}, err
	}
	var runID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO cdp_transform_runs
			(tenant_id, ops, subscriber_ids, total, changed, failed, dry_run)
		VALUES ($1::uuid, $2::jsonb, $3::uuid[], $4, $5, $6, $7)
		RETURNING id::text`,
		tenantID, string(opsJSON), req.SubscriberIDs,
		resp.Total, resp.Changed, resp.Failed, req.DryRun).Scan(&runID); err != nil {
		return applyResponse{}, err
	}
	resp.RunID = runID

	if err := tx.Commit(ctx); err != nil {
		return applyResponse{}, err
	}
	return resp, nil
}

func errBody(code, message string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": message}}
}
