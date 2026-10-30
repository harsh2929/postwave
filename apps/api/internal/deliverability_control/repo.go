package deliverability_control

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func (r *Repo) ListDomainSetups(ctx context.Context, tenantID string) ([]DomainSetup, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, domain, setup_mode, status, dns_records,
       health_checks, rollback_guidance, ssl_status, routing_status, created_at, updated_at
FROM deliverability_domain_setups
WHERE tenant_id = $1::uuid
ORDER BY updated_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DomainSetup{}
	for rows.Next() {
		item, err := scanDomainSetup(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) UpsertDomainSetup(ctx context.Context, tenantID string, in DomainSetup) (*DomainSetup, error) {
	normalizeSetup(&in)
	records, _ := json.Marshal(in.DNSRecords)
	health, _ := json.Marshal(in.HealthChecks)
	rollback, _ := json.Marshal(in.RollbackGuidance)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO deliverability_domain_setups
    (tenant_id, domain, setup_mode, status, dns_records, health_checks,
     rollback_guidance, ssl_status, routing_status)
VALUES
    ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
ON CONFLICT (tenant_id, domain) DO UPDATE SET
    setup_mode = EXCLUDED.setup_mode,
    status = EXCLUDED.status,
    dns_records = EXCLUDED.dns_records,
    health_checks = EXCLUDED.health_checks,
    rollback_guidance = EXCLUDED.rollback_guidance,
    ssl_status = EXCLUDED.ssl_status,
    routing_status = EXCLUDED.routing_status,
    updated_at = now()
RETURNING id::text, tenant_id::text, domain, setup_mode, status, dns_records,
       health_checks, rollback_guidance, ssl_status, routing_status, created_at, updated_at`,
		tenantID, in.Domain, in.SetupMode, in.Status, string(records),
		string(health), string(rollback), in.SSLStatus, in.RoutingStatus)
	out, err := scanDomainSetup(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) GetClickTracking(ctx context.Context, tenantID string) (*ClickTrackingPolicy, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT tenant_id::text, tracking_domain, status, ssl_status, caa_guidance,
       disable_syntax, last_untracked_report, settings, created_at, updated_at
FROM click_tracking_policies
WHERE tenant_id = $1::uuid`, tenantID)
	out, err := scanClickPolicy(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) UpsertClickTracking(ctx context.Context, tenantID string, in ClickTrackingPolicy) (*ClickTrackingPolicy, error) {
	if err := normalizeClickPolicy(&in); err != nil {
		return nil, err
	}
	caa, _ := json.Marshal(in.CAAGuidance)
	report, _ := json.Marshal(in.LastUntrackedReport)
	settings, _ := json.Marshal(in.Settings)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO click_tracking_policies
    (tenant_id, tracking_domain, status, ssl_status, caa_guidance,
     disable_syntax, last_untracked_report, settings)
VALUES
    ($1::uuid, $2, $3, $4, $5::jsonb, $6::text[], $7::jsonb, $8::jsonb)
ON CONFLICT (tenant_id) DO UPDATE SET
    tracking_domain = EXCLUDED.tracking_domain,
    status = EXCLUDED.status,
    ssl_status = EXCLUDED.ssl_status,
    caa_guidance = EXCLUDED.caa_guidance,
    disable_syntax = EXCLUDED.disable_syntax,
    last_untracked_report = EXCLUDED.last_untracked_report,
    settings = EXCLUDED.settings,
    updated_at = now()
RETURNING tenant_id::text, tracking_domain, status, ssl_status, caa_guidance,
       disable_syntax, last_untracked_report, settings, created_at, updated_at`,
		tenantID, in.TrackingDomain, in.Status, in.SSLStatus, string(caa),
		in.DisableSyntax, string(report), string(settings))
	out, err := scanClickPolicy(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) GetRoutingPolicy(ctx context.Context, tenantID string) (*RoutingPolicy, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT tenant_id::text, status, strategy, dedicated_pool, shared_pool,
       dedicated_percentage_bp, max_dedicated_percentage_bp, warmup_rules,
       last_evaluated_at, created_at, updated_at
FROM ip_warmup_routing_policies
WHERE tenant_id = $1::uuid`, tenantID)
	out, err := scanRoutingPolicy(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) UpsertRoutingPolicy(ctx context.Context, tenantID string, in RoutingPolicy) (*RoutingPolicy, error) {
	if err := normalizeRouting(&in); err != nil {
		return nil, err
	}
	rules, _ := json.Marshal(in.WarmupRules)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO ip_warmup_routing_policies
    (tenant_id, status, strategy, dedicated_pool, shared_pool,
     dedicated_percentage_bp, max_dedicated_percentage_bp, warmup_rules,
     last_evaluated_at)
VALUES
    ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
ON CONFLICT (tenant_id) DO UPDATE SET
    status = EXCLUDED.status,
    strategy = EXCLUDED.strategy,
    dedicated_pool = EXCLUDED.dedicated_pool,
    shared_pool = EXCLUDED.shared_pool,
    dedicated_percentage_bp = EXCLUDED.dedicated_percentage_bp,
    max_dedicated_percentage_bp = EXCLUDED.max_dedicated_percentage_bp,
    warmup_rules = EXCLUDED.warmup_rules,
    last_evaluated_at = now(),
    updated_at = now()
RETURNING tenant_id::text, status, strategy, dedicated_pool, shared_pool,
       dedicated_percentage_bp, max_dedicated_percentage_bp, warmup_rules,
       last_evaluated_at, created_at, updated_at`,
		tenantID, in.Status, in.Strategy, in.DedicatedPool, in.SharedPool,
		in.DedicatedPercentageBP, in.MaxDedicatedPercentageBP, string(rules))
	out, err := scanRoutingPolicy(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) GetEntitlement(ctx context.Context, tenantID string) (*Entitlement, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureCanonicalEntitlement(ctx, tx, tenantID); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT tenant_id::text, period_start::text, plan_tier, inbox_tests_monthly,
       render_previews_monthly, inbox_tests_used, render_previews_used,
       overage_policy, account_controls, created_at, updated_at
FROM deliverability_entitlements
WHERE tenant_id = $1::uuid AND period_start = date_trunc('month', now())::date`, tenantID)
	out, err := scanEntitlement(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func scanDomainSetup(row pgx.Row) (*DomainSetup, error) {
	var out DomainSetup
	var records, health, rollback []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.Domain, &out.SetupMode,
		&out.Status, &records, &health, &rollback, &out.SSLStatus,
		&out.RoutingStatus, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(records, &out.DNSRecords)
	out.HealthChecks = decodeMap(health)
	out.RollbackGuidance = decodeMap(rollback)
	return &out, nil
}

func scanClickPolicy(row pgx.Row) (*ClickTrackingPolicy, error) {
	var out ClickTrackingPolicy
	var caa, report, settings []byte
	if err := row.Scan(&out.TenantID, &out.TrackingDomain, &out.Status,
		&out.SSLStatus, &caa, &out.DisableSyntax, &report, &settings,
		&out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	out.CAAGuidance = decodeMap(caa)
	out.LastUntrackedReport = decodeMap(report)
	out.Settings = decodeMap(settings)
	return &out, nil
}

func scanRoutingPolicy(row pgx.Row) (*RoutingPolicy, error) {
	var out RoutingPolicy
	var rules []byte
	if err := row.Scan(&out.TenantID, &out.Status, &out.Strategy,
		&out.DedicatedPool, &out.SharedPool, &out.DedicatedPercentageBP,
		&out.MaxDedicatedPercentageBP, &rules, &out.LastEvaluatedAt,
		&out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	out.WarmupRules = decodeMap(rules)
	return &out, nil
}

func scanEntitlement(row pgx.Row) (*Entitlement, error) {
	var out Entitlement
	var controls []byte
	if err := row.Scan(&out.TenantID, &out.PeriodStart, &out.PlanTier,
		&out.InboxTestsMonthly, &out.RenderPreviewsMonthly,
		&out.InboxTestsUsed, &out.RenderPreviewsUsed, &out.OveragePolicy,
		&controls, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	out.AccountControls = decodeMap(controls)
	return &out, nil
}

func decodeMap(raw []byte) map[string]any {
	out := map[string]any{}
	if len(raw) == 0 {
		return out
	}
	_ = json.Unmarshal(raw, &out)
	return out
}
