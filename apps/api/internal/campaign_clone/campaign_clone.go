// SPDX-License-Identifier: AGPL-3.0-only
//
// Package campaign_clone provides a single-shot "duplicate this
// campaign" operation — a near-universal ESP affordance the main
// campaigns package historically lacked.
//
// Behavior: every column of the source row is copied into a new
// row, EXCEPT:
//
//   * id              new uuid
//   * status          reset to 'draft'
//   * scheduled_at    NULL  (operator must explicitly re-schedule)
//   * sent_at         NULL
//   * finished_at     NULL  (best-effort; not all deployments have it)
//   * created_at/updated_at  now()
//   * archive_*       reset (don't share an archive slug)
//   * name            "Copy of <original_name>" or operator override
//
// The INSERT enumerates columns at runtime (information_schema)
// so a new campaigns column is auto-cloned without code change.
//
// Surface:
//
//   POST /api/v1/campaigns/{id}/clone   body: {name?}

package campaign_clone

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const requestJSONMaxBodyBytes int64 = 4 << 10

// Deps wires the HTTP surface.
type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

type cloneReq struct {
	Name string `json:"name"`
}

// Columns the clone must NOT carry over from its source, either because the
// INSERT sets them explicitly or because they are facts about the SOURCE's
// dispatch that a brand-new draft has no claim to.
//
// started_at and finished_at are the second kind. Campaigns.Repo.Update freezes
// delivered content once started_at is set — a clone that inherited its parent's
// start instant would be born un-editable, so "duplicate this and fix the typo"
// would produce a campaign that refuses the fix. Excluding them here leaves the
// columns at their NULL default, which is also simply true: this campaign has
// not started.
var explicitlySetColumns = map[string]struct{}{
	"id":           {},
	"tenant_id":    {},
	"name":         {},
	"status":       {},
	"scheduled_at": {},
	"sent_at":      {},
	"created_at":   {},
	"updated_at":   {},
	"started_at":   {},
	"finished_at":  {},
}

// MountRoutes registers the single endpoint.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Post("/api/v1/campaigns/{id}/clone", d.Clone)
}

// Clone POST /api/v1/campaigns/{id}/clone.
func (d *Deps) Clone(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant not found in request context")
		return
	}
	srcID := chi.URLParam(r, "id")
	if srcID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_id", "campaign id is required")
		return
	}
	var body cloneReq
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
			code := httpbody.ErrorCode(err)
			if httperror.IsValidationCode(code) {
				httperror.Write(w, httpbody.StatusCode(err), code, httpbody.PublicMessage(err))
			} else {
				httperror.Write(w, httpbody.StatusCode(err), code, "request body could not be decoded")
			}
			return
		}
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var srcName string
	err = tx.QueryRow(r.Context(),
		`SELECT name FROM campaigns WHERE id = $1::uuid AND tenant_id = $2::uuid`,
		srcID, t.ID).Scan(&srcName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "not_found", "campaign not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	newName := strings.TrimSpace(body.Name)
	if newName == "" {
		newName = "Copy of " + srcName
	}

	cols, err := cloneableColumns(r.Context(), tx)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if len(cols) == 0 {
		httperror.WriteInternal(w, d.Logger, errors.New("no cloneable columns discovered"), r.Context())
		return
	}

	// Quote identifiers — every column came from information_schema
	// so they're already safe identifiers, but we double-quote to
	// guard against future reserved-word collisions.
	quoted := make([]string, 0, len(cols))
	for _, c := range cols {
		quoted = append(quoted, `"`+c+`"`)
	}
	colList := strings.Join(quoted, ", ")

	sqlQ := `
INSERT INTO campaigns (
  id, tenant_id, name, status, scheduled_at, sent_at,
  created_at, updated_at,
  ` + colList + `
)
SELECT gen_random_uuid(), tenant_id, $3, 'draft', NULL, NULL,
       now(), now(),
       ` + colList + `
  FROM campaigns WHERE id = $1::uuid AND tenant_id = $2::uuid
RETURNING id::text`

	var newID string
	if err := tx.QueryRow(r.Context(), sqlQ, srcID, t.ID, newName).Scan(&newID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// Reset columns whose existence is not guaranteed across
	// deployments. Best-effort — errors swallowed because old
	// deploys without these columns should still get the clone.
	_, _ = tx.Exec(r.Context(),
		`UPDATE campaigns
		    SET archive_public = false,
		        archive_slug = NULL,
		        archive_excerpt = NULL
		  WHERE id = $1::uuid`, newID)
	// finished_at and started_at are handled by exclusion from the carry-over
	// column list, not by a follow-up UPDATE: that UPDATE swallowed its error,
	// so the invariant was conditional on a query that could silently fail.

	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":   newID,
		"name": newName,
	})
}

// cloneableColumns returns every column on `campaigns` MINUS the
// ones the INSERT sets explicitly. The information_schema lookup
// keeps this future-proof against new columns.
func cloneableColumns(ctx context.Context, tx pgx.Tx) ([]string, error) {
	rows, err := tx.Query(ctx, `
SELECT column_name
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'campaigns'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			continue
		}
		if _, skip := explicitlySetColumns[c]; skip {
			continue
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
