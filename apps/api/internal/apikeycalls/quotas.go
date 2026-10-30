// SPDX-License-Identifier: AGPL-3.0-only
//
// quotas.go — provisional per-tool usage thresholds. The current counts are
// asynchronous and the REST proxy's tool label is caller-asserted, so this
// surface is telemetry/advisory only and MUST NOT be represented as a durable
// cost or authorization control.

package apikeycalls

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const QuotaMutationReleaseHoldCode = "mcp_quota_enforcement_release_held"

// ListQuotas returns every per-tool quota the tenant has configured,
// joined with today's usage count so the dashboard can render
// progress bars in one round-trip.
func (r *Repo) ListQuotas(ctx context.Context, tenantID string) ([]ToolQuota, error) {
	if tenantID == "" {
		return nil, errors.New("apikeycalls: tenant id required")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Day boundary in tenant time isn't tracked here — we use UTC
	// because the dashboard renders timestamps in browser-local time
	// and a single source of truth (UTC midnight) is what billing
	// systems are typically reconciled against.
	dayStart := time.Now().UTC().Truncate(24 * time.Hour)
	rows, err := tx.Query(ctx, `
SELECT q.tool_name,
       q.daily_limit,
       COALESCE(q.estimated_cost_micros, 0),
       COALESCE(usage.cnt, 0) AS used_today
  FROM mcp_tool_quotas q
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS cnt
      FROM api_key_calls
     WHERE tenant_id = q.tenant_id
       AND tool_name = q.tool_name
       AND called_at >= $2
  ) usage ON true
 WHERE q.tenant_id = $1::uuid
   AND q.tool_name ~ '^[A-Za-z][A-Za-z0-9._:-]{0,95}$'
   AND q.tool_name !~* '^[0-9a-f]{8}-[0-9a-f-]{27,}$'
   AND length(regexp_replace(q.tool_name, '[^0-9]', '', 'g')) <= length(q.tool_name) / 2
 ORDER BY q.tool_name`, tenantID, dayStart)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ToolQuota{}
	for rows.Next() {
		var q ToolQuota
		var daily *int
		if err := rows.Scan(&q.ToolName, &daily, &q.EstimatedCostMicros, &q.UsedToday); err != nil {
			return nil, err
		}
		q.DailyLimit = daily
		if safeToolLabel(q.ToolName) == q.ToolName {
			out = append(out, q)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// UpsertQuota writes a single per-tool quota row. `dailyLimit` may be
// nil — explicit "unlimited" — or a positive int. Zero is rejected
// (use Delete instead).
func (r *Repo) UpsertQuota(ctx context.Context, tenantID string, q ToolQuota) error {
	if tenantID == "" || q.ToolName == "" {
		return errors.New("apikeycalls: tenant + tool name required")
	}
	if q.DailyLimit != nil && *q.DailyLimit <= 0 {
		return errors.New("apikeycalls: daily_limit must be >0 or nil")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var limitArg any
	if q.DailyLimit != nil {
		limitArg = *q.DailyLimit
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO mcp_tool_quotas (tenant_id, tool_name, daily_limit, estimated_cost_micros, updated_at)
VALUES ($1::uuid, $2, $3, $4, now())
ON CONFLICT (tenant_id, tool_name)
DO UPDATE SET daily_limit          = EXCLUDED.daily_limit,
              estimated_cost_micros = EXCLUDED.estimated_cost_micros,
              updated_at           = now()`,
		tenantID, q.ToolName, limitArg, q.EstimatedCostMicros); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// DeleteQuota removes a per-tool quota row. Idempotent.
func (r *Repo) DeleteQuota(ctx context.Context, tenantID, toolName string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`DELETE FROM mcp_tool_quotas WHERE tenant_id = $1::uuid AND tool_name = $2`,
		tenantID, toolName); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// CheckQuota returns (exceeded=true, dailyLimit, usedToday) when the
// tenant has hit the configured daily cap for the named tool. Used
// by the recorder middleware as a pre-flight gate.
//
// Returns (false, ...) when:
//   - no quota row exists for (tenant, tool)
//   - daily_limit is nil (explicit unlimited)
//   - usage so far today < daily_limit
//
// Designed to be cheap (one tiny indexed query per request); we
// tolerate a small race window where concurrent calls both pass.
func (r *Repo) CheckQuota(ctx context.Context, tenantID, toolName string) (exceeded bool, dailyLimit, usedToday int, err error) {
	if tenantID == "" || toolName == "" {
		return false, 0, 0, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, 0, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	dayStart := time.Now().UTC().Truncate(24 * time.Hour)
	var limit *int
	if err := tx.QueryRow(ctx, `
SELECT daily_limit FROM mcp_tool_quotas
 WHERE tenant_id = $1::uuid AND tool_name = $2`,
		tenantID, toolName).Scan(&limit); err != nil {
		// No row = no quota = allow.
		if errors.Is(err, pgx.ErrNoRows) {
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return false, 0, 0, commitErr
			}
			return false, 0, 0, nil
		}
		return false, 0, 0, err
	}
	if limit == nil {
		if err := tx.Commit(ctx); err != nil {
			return false, 0, 0, err
		}
		return false, 0, 0, nil
	}
	var cnt int
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*) FROM api_key_calls
 WHERE tenant_id = $1::uuid AND tool_name = $2 AND called_at >= $3`,
		tenantID, toolName, dayStart).Scan(&cnt); err != nil {
		return false, 0, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, 0, 0, err
	}
	return cnt >= *limit, *limit, cnt, nil
}

// ---------------------------------------------------------------------
// HTTP handlers — operator CRUD for quotas
// ---------------------------------------------------------------------

// ListQuotasHandler handles GET /api/v1/mcp/quotas. Returns every
// configured per-tool quota for the tenant + today's usage.
func (d *Deps) ListQuotasHandler(w http.ResponseWriter, r *http.Request) {
	setPrivateNoStore(w)
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "missing_tenant", "")
		return
	}
	quotas, err := d.Repo.ListQuotas(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, QuotaResponse{
		TenantID:        tenant.ID,
		Quotas:          quotas,
		EnforcementMode: "advisory_unverified",
		Authoritative:   false,
		ReleaseHold:     QuotaMutationReleaseHoldCode,
	})
}

// UpsertQuotaHandler handles PUT /api/v1/mcp/quotas. Body: ToolQuota.
func (d *Deps) UpsertQuotaHandler(w http.ResponseWriter, r *http.Request) {
	setPrivateNoStore(w)
	_, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "missing_tenant", "")
		return
	}
	writeErr(w, http.StatusServiceUnavailable, QuotaMutationReleaseHoldCode,
		"per-tool quota mutation is release-held until server-attributed atomic reservations are available")
}

// DeleteQuotaHandler handles DELETE /api/v1/mcp/quotas/{tool}.
func (d *Deps) DeleteQuotaHandler(w http.ResponseWriter, r *http.Request) {
	setPrivateNoStore(w)
	_, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "missing_tenant", "")
		return
	}
	writeErr(w, http.StatusServiceUnavailable, QuotaMutationReleaseHoldCode,
		"per-tool quota mutation is release-held until server-attributed atomic reservations are available")
}
