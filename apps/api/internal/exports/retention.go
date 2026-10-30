// SPDX-License-Identifier: AGPL-3.0-only
//
// Workstream 4 (Mailchimp parity polish) — export retention policy.
//
// Operators see how long Moosewave keeps their export ZIPs + change the
// policy. Backed by export_retention_policy (migration 0225).
//
// Routes:
//
//   GET   /api/v1/exports/retention-policy   read current policy
//   PATCH /api/v1/exports/retention-policy   update retention_days /
//                                            max_per_tenant
//
// The handler always returns a non-empty row — if the policy hasn't
// been initialised yet, the GET upserts the defaults (retention_days=30,
// max_per_tenant=20) and returns those. current_storage_bytes is
// recomputed on each read from live exports (cheap — bounded by the
// max_per_tenant cap).

package exports

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// RetentionPolicy is the JSON projection.
type RetentionPolicy struct {
	RetentionDays       int    `json:"retention_days"`
	MaxPerTenant        int    `json:"max_per_tenant"`
	CurrentStorageBytes int64  `json:"current_storage_bytes"`
	UpdatedAt           string `json:"updated_at,omitempty"`
}

// RetentionInput is the PATCH body. Pointer fields = optional.
type RetentionInput struct {
	RetentionDays *int `json:"retention_days,omitempty"`
	MaxPerTenant  *int `json:"max_per_tenant,omitempty"`
}

const (
	retentionPolicyMaxBody     = 4 * 1024
	DefaultRetentionDays       = 30
	DefaultMaxExportsPerTenant = 20
	MinRetentionDays           = 7
	MaxRetentionDays           = 2555
	MinExportsPerTenant        = 1
	MaxExportsPerTenant        = 500
)

type retentionCapacityConflict struct {
	Active    int
	Requested int
}

func (e *retentionCapacityConflict) Error() string {
	return fmt.Sprintf(
		"cannot lower max_per_tenant to %d while %d export jobs are queued, running, or ready",
		e.Requested,
		e.Active,
	)
}

// MountRetentionRoutes registers the retention-policy endpoints.
func MountRetentionRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Get("/api/v1/exports/retention-policy", d.GetRetentionPolicy)
	r.With(admin).Patch("/api/v1/exports/retention-policy", d.PatchRetentionPolicy)
}

// GetRetentionPolicy GET /api/v1/exports/retention-policy.
func (d *Deps) GetRetentionPolicy(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	policy, err := upsertAndReadRetention(r.Context(), d.Pool, t.ID, nil, nil)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, policy)
}

// PatchRetentionPolicy PATCH /api/v1/exports/retention-policy.
func (d *Deps) PatchRetentionPolicy(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in RetentionInput
	r.Body = http.MaxBytesReader(w, r.Body, retentionPolicyMaxBody)
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if in.RetentionDays != nil {
		if *in.RetentionDays < MinRetentionDays || *in.RetentionDays > MaxRetentionDays {
			writeJSONErr(w, http.StatusBadRequest, "out_of_range",
				"retention_days must be between 7 and 2555")
			return
		}
	}
	if in.MaxPerTenant != nil {
		if *in.MaxPerTenant < MinExportsPerTenant || *in.MaxPerTenant > MaxExportsPerTenant {
			writeJSONErr(w, http.StatusBadRequest, "out_of_range",
				"max_per_tenant must be between 1 and 500")
			return
		}
	}
	policy, err := patchAndReadRetention(r.Context(), d.Pool, t.ID, in.RetentionDays, in.MaxPerTenant)
	if err != nil {
		var conflict *retentionCapacityConflict
		if errors.As(err, &conflict) {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": map[string]any{
					"code":    "export_capacity_conflict",
					"message": conflict.Error(),
					"details": map[string]any{
						"active":        conflict.Active,
						"requested_max": conflict.Requested,
					},
				},
			})
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, policy)
}

// upsertAndReadRetention writes the desired policy (initialising
// defaults if the row doesn't exist), recomputes current_storage_bytes
// from live tenant_exports rows, and returns the projection.
func upsertAndReadRetention(ctx context.Context, pool *db.Pool, tenantID string, days, max *int) (*RetentionPolicy, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// 1. Ensure a row exists. The INSERT … ON CONFLICT … DO NOTHING is
	//    the cheapest idempotent path — we only need the defaults the
	//    table-level CHECKs enforce.
	if err := ensureRetentionPolicyRow(ctx, tx, tenantID); err != nil {
		return nil, err
	}

	// 2. Apply optional updates.
	if days != nil || max != nil {
		// COALESCE keeps the column unchanged when the caller didn't
		// supply that field.
		var dArg, mArg any
		if days != nil {
			dArg = *days
		}
		if max != nil {
			mArg = *max
		}
		if _, err := tx.Exec(ctx, `
UPDATE export_retention_policy
   SET retention_days = COALESCE($2::int, retention_days),
       max_per_tenant = COALESCE($3::int, max_per_tenant),
       updated_at     = now()
 WHERE tenant_id = $1::uuid`, tenantID, dArg, mArg); err != nil {
			return nil, err
		}
	}

	// 3. Recompute current_storage_bytes from live exports. Bound to
	//    rows that haven't expired yet so the storage counter reflects
	//    what's actually still held in object storage.
	if _, err := tx.Exec(ctx, `
UPDATE export_retention_policy p
   SET current_storage_bytes = COALESCE((
         SELECT SUM(bytes_total)
           FROM tenant_exports
          WHERE tenant_id = p.tenant_id
            AND status = 'ready'
            AND (expires_at IS NULL OR expires_at > now())
       ), 0),
       last_recomputed_at = now()
 WHERE p.tenant_id = $1::uuid`, tenantID); err != nil {
		return nil, err
	}

	// 4. Read back.
	var p RetentionPolicy
	if err := tx.QueryRow(ctx, `
SELECT retention_days, max_per_tenant, current_storage_bytes, updated_at::text
  FROM export_retention_policy
 WHERE tenant_id = $1::uuid`, tenantID,
	).Scan(&p.RetentionDays, &p.MaxPerTenant, &p.CurrentStorageBytes, &p.UpdatedAt); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &p, nil
}

// patchAndReadRetention serializes policy mutation with export admission by
// locking the one policy row both paths share. A requested cap is rejected
// while more queued/running/ready jobs exist than that value; persisting a cap
// the canonical lifecycle already violates would make the control lie. A
// retention-only update remains available if legacy state already exceeds the
// unchanged cap.
func patchAndReadRetention(ctx context.Context, pool *db.Pool, tenantID string, days, max *int) (*RetentionPolicy, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureRetentionPolicyRow(ctx, tx, tenantID); err != nil {
		return nil, err
	}

	var currentMax int
	if err := tx.QueryRow(ctx, `
SELECT max_per_tenant
  FROM export_retention_policy
 WHERE tenant_id = $1::uuid
 FOR UPDATE`, tenantID).Scan(&currentMax); err != nil {
		return nil, err
	}
	effectiveMax := currentMax
	if max != nil {
		effectiveMax = *max
	}
	var active int
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM tenant_exports
 WHERE tenant_id = $1::uuid
   AND (
     status IN ('queued', 'running')
     OR (status = 'ready' AND (expires_at IS NULL OR expires_at > now()))
   )`, tenantID).Scan(&active); err != nil {
		return nil, err
	}
	if max != nil && active > effectiveMax {
		return nil, &retentionCapacityConflict{Active: active, Requested: effectiveMax}
	}

	var dArg, mArg any
	if days != nil {
		dArg = *days
	}
	if max != nil {
		mArg = *max
	}
	if _, err := tx.Exec(ctx, `
UPDATE export_retention_policy
   SET retention_days = COALESCE($2::int, retention_days),
       max_per_tenant = COALESCE($3::int, max_per_tenant),
       updated_at     = now()
 WHERE tenant_id = $1::uuid`, tenantID, dArg, mArg); err != nil {
		return nil, err
	}
	if err := recomputeRetentionStorage(ctx, tx, tenantID); err != nil {
		return nil, err
	}
	policy, err := scanRetentionPolicy(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return policy, nil
}

func ensureRetentionPolicyRow(ctx context.Context, tx pgx.Tx, tenantID string) error {
	_, err := tx.Exec(ctx, `
INSERT INTO export_retention_policy (tenant_id, retention_days, max_per_tenant)
VALUES ($1::uuid, $2, $3)
ON CONFLICT (tenant_id) DO NOTHING`, tenantID, DefaultRetentionDays, DefaultMaxExportsPerTenant)
	return err
}

// lockRetentionCapacity serializes create admission with cap changes. The
// count includes queued and running jobs because each is a reservation for one
// future stored bundle; counting ready rows alone lets a burst of queued jobs
// exceed the cap when workers complete them.
func lockRetentionCapacity(ctx context.Context, tx pgx.Tx, tenantID string) (maximum, active int, err error) {
	if err = ensureRetentionPolicyRow(ctx, tx, tenantID); err != nil {
		return 0, 0, err
	}
	if err = tx.QueryRow(ctx, `
SELECT max_per_tenant
  FROM export_retention_policy
 WHERE tenant_id = $1::uuid
 FOR UPDATE`, tenantID).Scan(&maximum); err != nil {
		return 0, 0, err
	}
	if err = tx.QueryRow(ctx, `
SELECT count(*)
  FROM tenant_exports
 WHERE tenant_id = $1::uuid
   AND (
     status IN ('queued', 'running')
     OR (status = 'ready' AND (expires_at IS NULL OR expires_at > now()))
   )`, tenantID).Scan(&active); err != nil {
		return 0, 0, err
	}
	return maximum, active, nil
}

func recomputeRetentionStorage(ctx context.Context, tx pgx.Tx, tenantID string) error {
	_, err := tx.Exec(ctx, `
UPDATE export_retention_policy p
   SET current_storage_bytes = COALESCE((
         SELECT SUM(bytes_total)
           FROM tenant_exports
          WHERE tenant_id = p.tenant_id
            AND status = 'ready'
            AND (expires_at IS NULL OR expires_at > now())
       ), 0),
       last_recomputed_at = now()
 WHERE p.tenant_id = $1::uuid`, tenantID)
	return err
}

func scanRetentionPolicy(ctx context.Context, tx pgx.Tx, tenantID string) (*RetentionPolicy, error) {
	var policy RetentionPolicy
	if err := tx.QueryRow(ctx, `
SELECT retention_days, max_per_tenant, current_storage_bytes, updated_at::text
  FROM export_retention_policy
 WHERE tenant_id = $1::uuid`, tenantID,
	).Scan(
		&policy.RetentionDays,
		&policy.MaxPerTenant,
		&policy.CurrentStorageBytes,
		&policy.UpdatedAt,
	); err != nil {
		return nil, err
	}
	return &policy, nil
}
