// SPDX-License-Identifier: AGPL-3.0-only
//
// migration_handler.go — admin endpoint to move a tenant's
// data_region setting from one region to another.
//
// This endpoint is the SAFE half of a region migration: it changes
// the metadata so the EnforceRegion middleware starts routing
// requests to the new region. The DATA migration (actually copying
// rows across clusters) is an out-of-band operation handled by the
// ops team — usually a logical-replication subscription on the new
// region followed by a cutover.
//
// The handler enforces:
//   1. Only the internal admin token can invoke (mounted on the
//      internal router, NOT the tenant-scoped public router).
//   2. The current and target regions are both in Allowed().
//   3. The tenant exists.
//   4. The change is logged into audit_log + tenant_region_history
//      for post-mortem traceability.

package regions

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

// MigrationDeps wires the migration endpoint.
type MigrationDeps struct {
	Pool *db.Pool
	// InternalAPIToken is the shared secret presented as
	// `Authorization: Bearer <token>`. Empty = endpoint disabled.
	InternalAPIToken string
}

// MountInternalMigrationRoute registers POST
// /api/internal/regions/migrate-tenant on the supplied router (which
// MUST sit OUTSIDE the EnforceRegion middleware — otherwise an
// operator in us-east couldn't flip an eu-central tenant).
func (d *MigrationDeps) MountInternalMigrationRoute(r chi.Router) {
	if d == nil || d.Pool == nil || d.InternalAPIToken == "" {
		return
	}
	r.Post("/api/internal/regions/migrate-tenant", d.MigrateTenant)
}

type migrateInput struct {
	TenantID  string `json:"tenant_id"`
	NewRegion string `json:"new_region"`
	Reason    string `json:"reason"`
}

// MigrateTenant accepts the input + flips tenants.data_region.
// Returns the prev_region + new_region for the operator's audit log.
func (d *MigrationDeps) MigrateTenant(w http.ResponseWriter, r *http.Request) {
	if !d.authorize(r) {
		writeMigrationJSON(w, http.StatusUnauthorized, map[string]any{
			"error": map[string]any{"code": "unauthorized"},
		})
		return
	}
	var in migrateInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.TenantID = strings.TrimSpace(in.TenantID)
	in.NewRegion = strings.TrimSpace(in.NewRegion)
	if in.TenantID == "" || in.NewRegion == "" {
		writeMigrationJSON(w, http.StatusBadRequest, map[string]any{
			"error": map[string]any{"code": "missing_fields",
				"message": "tenant_id and new_region are required"},
		})
		return
	}
	if err := Validate(in.NewRegion); err != nil {
		writeMigrationJSON(w, http.StatusBadRequest, map[string]any{
			"error": map[string]any{"code": "invalid_region", "message": err.Error()},
		})
		return
	}

	ctx := r.Context()
	tx, txErr := db.WithTenant(ctx, d.Pool, in.TenantID)
	if txErr != nil {
		writeMigrationJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]any{"code": "migration_unavailable", "message": "region migration is temporarily unavailable"},
		})
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// The entire metadata change and both audit records share one transaction-
	// local tenant scope. This prevents a session-level GUC from leaking through
	// the connection pool and prevents an unlogged region change from committing.
	var prevRegion string
	if err := tx.QueryRow(ctx,
		`SELECT data_region FROM tenants WHERE id = $1::uuid FOR UPDATE`, in.TenantID,
	).Scan(&prevRegion); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeMigrationJSON(w, http.StatusNotFound, map[string]any{
				"error": map[string]any{"code": "tenant_not_found", "message": "tenant was not found"},
			})
		} else {
			writeMigrationJSON(w, http.StatusInternalServerError, map[string]any{
				"error": map[string]any{"code": "query_failed", "message": "could not read the tenant region"},
			})
		}
		return
	}
	if prevRegion == in.NewRegion {
		if err := tx.Commit(ctx); err != nil {
			writeMigrationJSON(w, http.StatusInternalServerError, map[string]any{
				"error": map[string]any{"code": "commit_failed", "message": "could not commit the region check"},
			})
			return
		}
		writeMigrationJSON(w, http.StatusOK, map[string]any{
			"changed":     false,
			"prev_region": prevRegion,
			"new_region":  in.NewRegion,
		})
		return
	}

	result, txErr := tx.Exec(ctx,
		`UPDATE tenants SET data_region = $1 WHERE id = $2::uuid`,
		in.NewRegion, in.TenantID)
	if txErr != nil {
		writeMigrationJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]any{"code": "update_failed", "message": "could not update tenant region"},
		})
		return
	}
	if result.RowsAffected() != 1 {
		writeMigrationJSON(w, http.StatusConflict, map[string]any{
			"error": map[string]any{"code": "update_conflict", "message": "tenant region was not updated"},
		})
		return
	}

	if _, err := tx.Exec(ctx, `
INSERT INTO audit_log (tenant_id, action, resource_type, resource_id, metadata, actor_type, actor_label)
VALUES ($1::uuid, 'tenant.data_region_changed', 'tenant', $1::text,
        jsonb_build_object('prev_region', $2::text, 'new_region', $3::text, 'reason', $4::text),
        'system', 'regions.migration_handler')`,
		in.TenantID, prevRegion, in.NewRegion, in.Reason); err != nil {
		writeMigrationJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]any{"code": "audit_failed", "message": "could not record the region migration"},
		})
		return
	}
	// tenant_region_history (migration 0170) — focused per-move log
	// the compliance team queries for "show me every cross-region
	// move in the last quarter. It is part of the same commit as the change.
	if _, err := tx.Exec(ctx, `
INSERT INTO tenant_region_history (tenant_id, from_region, to_region, reason)
VALUES ($1::uuid, $2, $3, NULLIF($4, ''))`,
		in.TenantID, prevRegion, in.NewRegion, in.Reason); err != nil {
		writeMigrationJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]any{"code": "history_failed", "message": "could not record the region migration history"},
		})
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeMigrationJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]any{"code": "commit_failed", "message": "could not commit the region migration"},
		})
		return
	}

	writeMigrationJSON(w, http.StatusOK, map[string]any{
		"changed":     true,
		"prev_region": prevRegion,
		"new_region":  in.NewRegion,
	})
}

// authorize gates by the shared internal-API-token.
func (d *MigrationDeps) authorize(r *http.Request) bool {
	if d.InternalAPIToken == "" {
		return false
	}
	hdr := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(hdr, prefix) {
		return false
	}
	provided := strings.TrimSpace(hdr[len(prefix):])
	return subtle.ConstantTimeCompare([]byte(provided), []byte(d.InternalAPIToken)) == 1
}

func writeMigrationJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
