// SPDX-License-Identifier: AGPL-3.0-only
//
// SUB-015 — Custom-field soft limits + governance.
//
// This file adds the soft-limit layer on top of the tenant_custom_fields
// registry: a per-tenant cap on the total number of custom fields
// (max_custom_fields) and on how many of them may be searchable
// (max_searchable_fields). The limits live on the tenants row (migration
// 0449) with optional per-tenant overrides in tenant_custom_field_settings
// (migration 0450). Effective limits = override row when present, else the
// tenants-column defaults.
//
// The Create path (customfields.go) calls Repo.checkCreateLimit before
// inserting and returns ErrLimitExceeded → 422 on breach. The admin
// governance surface is GET/PUT /api/v1/settings/custom-fields.
package customfields

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

// ErrLimitExceeded is returned by Repo.Create when adding another custom
// field would push the tenant over its max_custom_fields cap. The handler
// maps it to 422 Unprocessable Entity (the request is well-formed but
// violates a workspace policy, not a transient/auth/shape error).
var ErrLimitExceeded = errors.New("custom field limit exceeded")

// Limits is the resolved governance state for a tenant: the effective caps
// plus the live usage counts that the admin UI renders as "used/max" bars.
type Limits struct {
	MaxCustomFields     int `json:"max_custom_fields"`
	MaxSearchableFields int `json:"max_searchable_fields"`
	// UsedCustomFields is the current count of rows in tenant_custom_fields.
	UsedCustomFields int `json:"used_custom_fields"`
	// UsedSearchableFields is the current count of searchable rows.
	UsedSearchableFields int `json:"used_searchable_fields"`
}

// UpdateLimitsInput is the body of PUT /api/v1/settings/custom-fields.
// Pointer fields distinguish "omitted" (leave unchanged) from an explicit
// new value. At least one must be present.
type UpdateLimitsInput struct {
	MaxCustomFields     *int `json:"max_custom_fields"`
	MaxSearchableFields *int `json:"max_searchable_fields"`
}

// effectiveLimits reads the resolved (override-or-default) caps for a tenant.
// It does NOT count usage — that's done separately so the create-time check
// can do both in one tx. The COALESCE prefers the per-tenant override row
// (0450) over the tenants-column defaults (0449).
func effectiveLimits(ctx context.Context, tx pgx.Tx, tenantID string) (maxFields, maxSearchable int, err error) {
	row := tx.QueryRow(ctx, `
SELECT
    COALESCE(s.max_custom_fields,     t.max_custom_fields),
    COALESCE(s.max_searchable_fields, t.max_searchable_fields)
FROM tenants t
LEFT JOIN tenant_custom_field_settings s ON s.tenant_id = t.id
WHERE t.id = $1::uuid`, tenantID)
	if err := row.Scan(&maxFields, &maxSearchable); err != nil {
		return 0, 0, err
	}
	return maxFields, maxSearchable, nil
}

// countFields returns the current (total, searchable) field counts for the
// tenant within the supplied tx.
func countFields(ctx context.Context, tx pgx.Tx, tenantID string) (total, searchable int, err error) {
	row := tx.QueryRow(ctx, `
SELECT
    count(*),
    count(*) FILTER (WHERE searchable)
FROM tenant_custom_fields
WHERE tenant_id = $1::uuid`, tenantID)
	if err := row.Scan(&total, &searchable); err != nil {
		return 0, 0, err
	}
	return total, searchable, nil
}

// checkCreateLimit verifies that inserting one more field (optionally
// searchable) would not exceed the tenant's caps. Runs inside the same tx as
// the INSERT so the count is consistent with the write. Returns
// ErrLimitExceeded (wrapped with the relevant cap message) on breach.
func checkCreateLimit(ctx context.Context, tx pgx.Tx, tenantID string, searchable bool) error {
	maxFields, maxSearchable, err := effectiveLimits(ctx, tx, tenantID)
	if err != nil {
		return err
	}
	total, usedSearchable, err := countFields(ctx, tx, tenantID)
	if err != nil {
		return err
	}
	if total >= maxFields {
		return errLimitf(total, maxFields)
	}
	if searchable && usedSearchable >= maxSearchable {
		return fmt.Errorf("%w: %d/%d searchable fields used", ErrLimitExceeded, usedSearchable, maxSearchable)
	}
	return nil
}

// errLimitf wraps ErrLimitExceeded with the used/max detail. Kept as a named
// helper so the wrapping contract (errors.Is recoverable + "used/max" in the
// message) is exercised directly by tests without a DB tx.
func errLimitf(used, max int) error {
	return fmt.Errorf("%w: %d/%d custom fields used", ErrLimitExceeded, used, max)
}

// GetLimits returns the resolved limits + live usage for the tenant.
func (r *Repo) GetLimits(ctx context.Context, tenantID string) (*Limits, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	maxFields, maxSearchable, err := effectiveLimits(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}
	total, searchable, err := countFields(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &Limits{
		MaxCustomFields:      maxFields,
		MaxSearchableFields:  maxSearchable,
		UsedCustomFields:     total,
		UsedSearchableFields: searchable,
	}, nil
}

// UpdateLimits upserts the per-tenant override row and returns the resolved
// limits + live usage. Only the supplied (non-nil) caps are changed; an
// omitted cap falls back to the existing override value, or the tenants-column
// default when no override row exists yet.
func (r *Repo) UpdateLimits(ctx context.Context, tenantID string, in UpdateLimitsInput) (*Limits, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Resolve the current effective limits so an omitted field keeps its
	// current value rather than snapping back to a hard-coded default.
	curMax, curSearchable, err := effectiveLimits(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}
	newMax := curMax
	if in.MaxCustomFields != nil {
		newMax = *in.MaxCustomFields
	}
	newSearchable := curSearchable
	if in.MaxSearchableFields != nil {
		newSearchable = *in.MaxSearchableFields
	}

	if _, err := tx.Exec(ctx, `
INSERT INTO tenant_custom_field_settings (tenant_id, max_custom_fields, max_searchable_fields)
VALUES ($1::uuid, $2, $3)
ON CONFLICT (tenant_id) DO UPDATE
    SET max_custom_fields     = EXCLUDED.max_custom_fields,
        max_searchable_fields = EXCLUDED.max_searchable_fields,
        updated_at            = now()`,
		tenantID, newMax, newSearchable); err != nil {
		return nil, err
	}

	total, searchable, err := countFields(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &Limits{
		MaxCustomFields:      newMax,
		MaxSearchableFields:  newSearchable,
		UsedCustomFields:     total,
		UsedSearchableFields: searchable,
	}, nil
}

// GetSettings GET /api/v1/settings/custom-fields — read limits + usage.
func (d *Deps) GetSettings(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	out, err := d.Repo.GetLimits(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// UpdateSettings PUT /api/v1/settings/custom-fields — admin-scoped update.
func (d *Deps) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in UpdateLimitsInput
	if err := httpbody.DecodeJSON(w, r, customFieldJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.MaxCustomFields == nil && in.MaxSearchableFields == nil {
		httperror.Write(w, http.StatusBadRequest, "no_fields",
			"at least one of max_custom_fields or max_searchable_fields is required")
		return
	}
	if in.MaxCustomFields != nil && *in.MaxCustomFields < 0 {
		httperror.Write(w, http.StatusBadRequest, "invalid_limit",
			"max_custom_fields must be non-negative")
		return
	}
	if in.MaxSearchableFields != nil && *in.MaxSearchableFields < 0 {
		httperror.Write(w, http.StatusBadRequest, "invalid_limit",
			"max_searchable_fields must be non-negative")
		return
	}
	out, err := d.Repo.UpdateLimits(r.Context(), t.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// FieldFillRate reports how many subscribers carry a non-empty value for
// one custom field (SETC-043). Rate is filled/total in [0,1]; the handler
// leaves the percentage formatting to the client.
type FieldFillRate struct {
	Key    string  `json:"key"`
	Label  string  `json:"label"`
	Filled int64   `json:"filled"`
	Rate   float64 `json:"rate"`
}

// FieldUsageReport is the fill-rate roll-up for the whole registry: the
// denominator (total subscribers) plus a per-field filled count. Clients
// render this as "X% of subscribers have this field" bars so operators can
// spot dead/under-populated fields.
type FieldUsageReport struct {
	TotalSubscribers int64           `json:"total_subscribers"`
	Fields           []FieldFillRate `json:"fields"`
}

// FieldUsage computes the fill rate of every custom field for the tenant.
//
// "Filled" means the subscriber's custom_fields jsonb both HAS the key and
// its text projection is non-empty — a present-but-"" value is not counted,
// matching how the UI treats a blank field as unset. The LEFT JOIN LATERAL
// runs one counting scan per field; field count is already capped by
// max_custom_fields, so this stays bounded even on large tenants.
func (r *Repo) FieldUsage(ctx context.Context, tenantID string) (*FieldUsageReport, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var total int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM subscribers`).Scan(&total); err != nil {
		return nil, err
	}

	rows, err := tx.Query(ctx, `
SELECT f.key, f.label, COALESCE(u.filled, 0)
FROM tenant_custom_fields f
LEFT JOIN LATERAL (
    SELECT count(*) AS filled
    FROM subscribers s
    WHERE s.custom_fields ? f.key
      AND COALESCE(s.custom_fields->>f.key, '') <> ''
) u ON true
WHERE f.tenant_id = $1::uuid
ORDER BY f.key ASC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []FieldFillRate{}
	for rows.Next() {
		var fr FieldFillRate
		if err := rows.Scan(&fr.Key, &fr.Label, &fr.Filled); err != nil {
			return nil, err
		}
		if total > 0 {
			fr.Rate = float64(fr.Filled) / float64(total)
		}
		out = append(out, fr)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &FieldUsageReport{TotalSubscribers: total, Fields: out}, nil
}

// GetUsage GET /api/v1/settings/custom-fields/usage — per-field fill rate
// across the tenant's subscribers (SETC-043).
func (d *Deps) GetUsage(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	out, err := d.Repo.FieldUsage(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// MountSettingsRoutes wires the custom-field governance surface. Read is
// subscriber-read-scoped (settings inspection); the mutating PUT requires
// the admin scope since it changes a workspace governance policy.
func MountSettingsRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/settings/custom-fields", d.GetSettings)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/settings/custom-fields/usage", d.GetUsage)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Put("/api/v1/settings/custom-fields", d.UpdateSettings)
}
