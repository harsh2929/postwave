// Package lists — growth.go owns the per-list growth-source attribution
// surface (GAP-LS-063). Two halves:
//
//   1. RecordGrowthSource(ctx, tenantID, listUUID, source) — called by
//      every membership-adding path (forms submit, public API,
//      CSV import, integration sync, admin tooling). Increments a JSONB
//      counter on list_metadata.growth_sources and bumps updated_at.
//
//   2. GET /api/v1/lists/{id}/growth-sources — reads the aggregate.
//
// The per-row source column on list_subscribers (0249) is the source of
// truth for "where did this membership come from?" — growth_sources is
// just the rolled-up counter that lets the UI render the source mix
// without a count(*) GROUP BY on a 1M-row table every page load.

package lists

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// MountGrowthRoutes registers the growth-source endpoints. Caller wires
// these alongside MountRoutes; the existing MountRoutes stays narrow.
func (d *Deps) MountGrowthRoutes(r chi.Router) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/lists/{id}/growth-sources", d.GrowthSources)
}

// canonicalGrowthSources matches the list_subscribers.source CHECK enum
// from migration 0249. Any input not in this set is bucketed under
// "other" so a typo in a calling site can't silently drop the count.
var canonicalGrowthSources = map[string]struct{}{
	"form":           {},
	"api":            {},
	"csv":            {},
	"integration":    {},
	"admin":          {},
	"migration":      {},
	"listmonk_event": {},
}

func normaliseSource(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	if s == "" {
		return "other"
	}
	if _, ok := canonicalGrowthSources[s]; ok {
		return s
	}
	return "other"
}

// RecordGrowthSource bumps the counter for (tenantID, listUUID, source)
// in list_metadata.growth_sources. Best-effort by contract: callers
// hold the load-bearing membership write in their own tx and call this
// after-the-fact — an error here MUST NOT fail the membership add.
//
// The atomic counter increment uses jsonb_set + COALESCE so concurrent
// callers don't clobber each other (one numeric is replaced per call).
// The (tenant_id, listmonk_list_id) row in list_metadata is auto-created
// on first call so the caller doesn't have to pre-seed the sidecar.
func (r *Repo) RecordGrowthSource(ctx context.Context, tenantID string, listmonkBigintID int64, source string) error {
	if r == nil || r.Pool == nil {
		return nil
	}
	if tenantID == "" || listmonkBigintID == 0 {
		return nil
	}
	bucket := normaliseSource(source)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Upsert the row with the increment baked in. ON CONFLICT does the
	// real work for repeat calls.
	if _, err := tx.Exec(ctx, `
INSERT INTO list_metadata (tenant_id, listmonk_list_id, growth_sources)
VALUES ($1::uuid, $2, jsonb_build_object($3::text, 1))
ON CONFLICT (tenant_id, listmonk_list_id) DO UPDATE
   SET growth_sources = jsonb_set(
           COALESCE(list_metadata.growth_sources, '{}'::jsonb),
           ARRAY[$3::text],
           to_jsonb(
               COALESCE((list_metadata.growth_sources ->> $3)::int, 0) + 1
           ),
           true
       ),
       updated_at = now()`,
		tenantID, listmonkBigintID, bucket); err != nil {
		return fmt.Errorf("growth source upsert: %w", err)
	}
	return tx.Commit(ctx)
}

// GrowthSources GET /api/v1/lists/{id}/growth-sources
//
// Returns {form: N, api: N, csv: N, integration: N, admin: N,
// migration: N, listmonk_event: N, other: N, total: N}. Initialised
// counters mean the wire shape is stable even on a brand-new list.
func (d *Deps) GrowthSources(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Resolve the bigint id from the uuid so we can read list_metadata
	// (which is keyed on the Listmonk-side bigint). Missing mapping ->
	// empty counter object — the UI handles that case.
	bigintID, err := d.Repo.GetListBigintIDByUUID(r.Context(), tenantID, listUUID)
	if err != nil {
		// Unmapped: fall back to live count(*) over list_subscribers so
		// the page still renders something useful.
		mix, err2 := liveSourceMix(r.Context(), d.Repo.Pool, tenantID, listUUID)
		if err2 != nil {
			httperror.WriteInternal(w, d.Logger, err2, r.Context())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"list_id":  listUUID,
			"sources":  mix,
			"fallback": "live_count",
		})
		return
	}

	var rawJSON []byte
	err = tx.QueryRow(r.Context(), `
SELECT COALESCE(growth_sources, '{}'::jsonb)::text::bytea
  FROM list_metadata
 WHERE tenant_id = $1::uuid AND listmonk_list_id = $2`,
		tenantID, bigintID).Scan(&rawJSON)
	if err != nil {
		// No row yet — return the zeroed shape so the UI can render.
		writeJSON(w, http.StatusOK, map[string]any{
			"list_id": listUUID,
			"sources": zeroedSourceMap(),
		})
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	out := zeroedSourceMap()
	if len(rawJSON) > 0 {
		parsed := map[string]int64{}
		if err := json.Unmarshal(rawJSON, &parsed); err == nil {
			for k, v := range parsed {
				out[normaliseSource(k)] += v
			}
		}
	}
	var total int64
	for _, v := range out {
		total += v
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"list_id": listUUID,
		"sources": out,
		"total":   total,
	})
}

// zeroedSourceMap returns the wire-shape map with every bucket at 0.
// Centralised so the UI gets a stable key set whether the list is new
// or fully populated.
func zeroedSourceMap() map[string]int64 {
	return map[string]int64{
		"form":           0,
		"api":            0,
		"csv":            0,
		"integration":    0,
		"admin":          0,
		"migration":      0,
		"listmonk_event": 0,
		"other":          0,
	}
}

// liveSourceMix is the fallback path when list_metadata has no row for
// the list yet. Computes the source mix from list_subscribers in real
// time. Bounded by the index on (tenant_id, list_id, added_at).
func liveSourceMix(ctx context.Context, pool *db.Pool, tenantID, listUUID string) (map[string]int64, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT source, count(*)::bigint
  FROM list_subscribers
 WHERE tenant_id = $1::uuid AND list_id = $2::uuid AND removed_at IS NULL
 GROUP BY source`, tenantID, listUUID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := zeroedSourceMap()
	for rows.Next() {
		var src string
		var n int64
		if err := rows.Scan(&src, &n); err != nil {
			return nil, err
		}
		out[normaliseSource(src)] = n
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}
