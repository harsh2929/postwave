// SPDX-License-Identifier: AGPL-3.0-only
//
// bulk.go — Phase 1 cross-cutting `p1-bulk-endpoints` item for the
// inbound-routes surface.
//
// Adds two operator endpoints that the dashboard's multi-select
// toolbar needs:
//
//   POST /api/v1/inbound-routes/bulk-snooze   — disable matching for
//        a window. {ids:[...], until: "RFC3339"}.  `until=null`
//        clears the snooze.
//   POST /api/v1/inbound-routes/bulk-archive  — mark routes
//        archived_at=now() so the matcher skips them but the match
//        history survives. {ids:[...], archive: bool}. archive=false
//        un-archives.
//
// Each call:
//   * caps body bytes (64 KiB);
//   * caps ids at 1000 per request;
//   * runs in a single tenant-scoped tx so RLS clamps the write;
//   * returns the canonical {affected, skipped, failed[]} response.
//
// Backing columns + index live in migration 0338. The matcher in
// routes.go continues to honour `enabled = true` as the primary gate;
// archived/snoozed are additive filters we'll wire into MatchRoutes
// in a follow-up (the table now carries the truth so the dashboard
// can re-render — Phase 1 ships the storage + endpoint; the matcher
// update is Phase 2's job).

package inbound_email

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// BulkRouteMaxIDs caps a single bulk-snooze / bulk-archive call.
// Matches the platform-wide 1000-id ceiling used by the assets /
// suppressions / tags bulk endpoints so the audit + statement-timeout
// budget stays uniform across surfaces.
const BulkRouteMaxIDs = 1000

// bulkRouteJSONMaxBodyBytes — 1k uuids @ ~37 bytes each plus an
// envelope with one RFC3339 timestamp fits in 64 KiB with headroom.
const bulkRouteJSONMaxBodyBytes int64 = 64 << 10

// bulkSnoozeInput is the body for POST /api/v1/inbound-routes/bulk-snooze.
// Until=nil OR an empty string clears the snooze on the supplied ids.
type bulkSnoozeInput struct {
	IDs   []string `json:"ids"`
	Until *string  `json:"until"`
}

// bulkArchiveInput is the body for POST /api/v1/inbound-routes/bulk-archive.
// Archive=true sets archived_at=now(); Archive=false clears it (un-archive).
type bulkArchiveInput struct {
	IDs     []string `json:"ids"`
	Archive bool     `json:"archive"`
}

// BulkRouteFailure is one structured per-id failure in the response.
type BulkRouteFailure struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

// BulkRouteResponse mirrors the canonical wire shape used by the
// dashboard's bulk-action reducer across every platform endpoint.
//
// Affected is the number of rows the UPDATE actually touched; Skipped
// covers ids that resolved to no row for this tenant (already deleted
// or never existed). Failed is reserved for structural per-id errors —
// e.g. an id that fails uuid validation at parse time.
type BulkRouteResponse struct {
	Affected int                `json:"affected"`
	Skipped  int                `json:"skipped"`
	Failed   []BulkRouteFailure `json:"failed"`
}

// MountBulkRouteAdminRoutes registers the two new bulk endpoints.
// Mirrors the gating of the existing CRUD: every destructive route is
// wrapped in apikeys.RequireScope(ScopeAdmin) so a read-only key can't
// snooze the operator's inbox routes.
func (d *Deps) MountBulkRouteAdminRoutes(r chi.Router) {
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Post("/api/v1/inbound-routes/bulk-snooze", d.BulkSnoozeRoutes)
	r.With(admin).Post("/api/v1/inbound-routes/bulk-archive", d.BulkArchiveRoutes)
}

// BulkSnoozeRoutes POST /api/v1/inbound-routes/bulk-snooze.
//
// Body shape: {"ids":[uuid...], "until":"2026-06-15T09:00:00Z" | null}
//
// `until` is RFC3339 in UTC; the matcher will re-arm the rule once
// now() crosses the timestamp. Sending `until: null` (or omitting the
// field) clears the existing snooze on the supplied ids — useful for
// the dashboard "wake up early" path.
func (d *Deps) BulkSnoozeRoutes(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	// Parse + validate the body FIRST so structural errors (missing ids,
	// oversized batch, bad timestamp) surface as the relevant 4xx
	// regardless of whether the repo is wired.
	var in bulkSnoozeInput
	if err := httpbody.DecodeJSON(w, r, bulkRouteJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	ids := dedupeRouteIDs(in.IDs)
	if len(ids) == 0 {
		httperror.WriteValidation(w, "missing_ids", "ids required")
		return
	}
	if len(ids) > BulkRouteMaxIDs {
		httperror.Write(w, http.StatusRequestEntityTooLarge, "too_many_ids", "ids exceeds 1000 per request")
		return
	}
	var until *time.Time
	if in.Until != nil && strings.TrimSpace(*in.Until) != "" {
		parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(*in.Until))
		if err != nil {
			httperror.WriteValidation(w, "bad_until",
				"until must be RFC3339 (e.g. 2026-06-15T09:00:00Z) or null")
			return
		}
		parsed = parsed.UTC()
		until = &parsed
	}
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "repo_unavailable", "inbound routes repo not configured")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	// One UPDATE on the supplied ids. The CASE collapses the clear path
	// (until=nil → NULL) and the set path (until=ts → $3) into one
	// statement so the tx is single-round-trip.
	tag, err := tx.Exec(r.Context(), `
UPDATE inbound_routes
   SET snoozed_until = $3,
       updated_at    = now()
 WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`,
		t.ID, ids, until)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	affected := int(tag.RowsAffected())
	skipped := len(ids) - affected
	if skipped < 0 {
		skipped = 0
	}
	auditRouteChange(r.Context(), d.Repo.Pool, r, t.ID, "inbound_route.bulk_snoozed", "",
		map[string]any{
			"ids_requested": len(ids),
			"affected":      affected,
			"until":         in.Until,
		})
	writeJSON(w, http.StatusOK, BulkRouteResponse{
		Affected: affected,
		Skipped:  skipped,
		Failed:   []BulkRouteFailure{},
	})
}

// BulkArchiveRoutes POST /api/v1/inbound-routes/bulk-archive.
//
// Body shape: {"ids":[uuid...], "archive": true|false}.
//
// archive=true stamps archived_at=now(); archive=false clears it.
// Archived rows are filtered out of the matcher (see migration 0338's
// `idx_inbound_routes_active` partial index) but stay in the table so
// inbound_route_matches history keeps its FK target alive.
func (d *Deps) BulkArchiveRoutes(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	// Parse + validate the body FIRST so structural errors (missing ids,
	// oversized batch) surface as the relevant 4xx regardless of whether
	// the repo is wired.
	var in bulkArchiveInput
	if err := httpbody.DecodeJSON(w, r, bulkRouteJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	ids := dedupeRouteIDs(in.IDs)
	if len(ids) == 0 {
		httperror.WriteValidation(w, "missing_ids", "ids required")
		return
	}
	if len(ids) > BulkRouteMaxIDs {
		httperror.Write(w, http.StatusRequestEntityTooLarge, "too_many_ids", "ids exceeds 1000 per request")
		return
	}
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "repo_unavailable", "inbound routes repo not configured")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	// Single UPDATE — archive=true → now(); archive=false → NULL.
	var sql string
	if in.Archive {
		sql = `
UPDATE inbound_routes
   SET archived_at = now(),
       updated_at  = now()
 WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`
	} else {
		sql = `
UPDATE inbound_routes
   SET archived_at = NULL,
       updated_at  = now()
 WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`
	}
	tag, err := tx.Exec(r.Context(), sql, t.ID, ids)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	affected := int(tag.RowsAffected())
	skipped := len(ids) - affected
	if skipped < 0 {
		skipped = 0
	}
	action := "inbound_route.bulk_archived"
	if !in.Archive {
		action = "inbound_route.bulk_unarchived"
	}
	auditRouteChange(r.Context(), d.Repo.Pool, r, t.ID, action, "",
		map[string]any{
			"ids_requested": len(ids),
			"affected":      affected,
			"archive":       in.Archive,
		})
	writeJSON(w, http.StatusOK, BulkRouteResponse{
		Affected: affected,
		Skipped:  skipped,
		Failed:   []BulkRouteFailure{},
	})
}

// dedupeRouteIDs trims, drops blanks, dedupes while preserving the
// first-seen order. Mirrors the same helper present in the tags
// package — kept local so the inbound_email package doesn't grow a
// cross-package dependency for a 5-line helper.
func dedupeRouteIDs(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}
