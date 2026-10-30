// SPDX-License-Identifier: AGPL-3.0-only
//
// Repo extensions for the public industry-wide AEO Sensor.
//
// Three groups of methods:
//
//   1. Per-tenant industry opt-in (tenant-scoped, RLS-active)
//        GetTenantIndustry / UpsertTenantIndustry
//
//   2. Worker aggregator (cross-tenant, runs under
//      app.outbox_worker GUC via WithWorkerScope)
//        ListContributingTenantsByIndustry
//        UpsertSensorIndustryRollup
//        AppendSensorChangelog
//
//   3. Public read surface (no tenant scope, RLS off on the rollup
//      and changelog tables)
//        ListIndustries
//        ListSensorIndustryRollups
//        ListSensorChangelog
//
// All cross-tenant writes go through db.WithWorkerScope so the
// `worker_aggregate_read` policy on aeo_tenant_industry fires; public
// reads use a bare pool acquire because the public tables are
// intentionally RLS-off.

package aeo

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrIndustryUnknown is returned when an industry_slug doesn't match
// a row in aeo_sensor_industries.
var ErrIndustryUnknown = errors.New("aeo: unknown industry slug")

// --- 1. Per-tenant opt-in ------------------------------------------------

// GetTenantIndustry returns the tenant's industry opt-in row, or
// ErrNotFound when the tenant has never visited the Sensor settings
// panel.
func (r *Repo) GetTenantIndustry(ctx context.Context, tenantID string) (TenantIndustry, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return TenantIndustry{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var ti TenantIndustry
	ti.TenantID = tenantID
	err = tx.QueryRow(ctx, `
SELECT industry_slug, contribute_to_public, opted_in_at, created_at, updated_at
  FROM aeo_tenant_industry
 WHERE tenant_id = $1::uuid`, tenantID).Scan(
		&ti.IndustrySlug, &ti.ContributeToPublic, &ti.OptedInAt, &ti.CreatedAt, &ti.UpdatedAt,
	)
	if err != nil {
		return TenantIndustry{}, ErrNotFound
	}
	return ti, tx.Commit(ctx)
}

// UpsertTenantIndustry writes the tenant's industry + opt-in flag.
// When ContributeToPublic flips from false→true the row's opted_in_at
// is stamped (so the UI can render the consent moment).
func (r *Repo) UpsertTenantIndustry(ctx context.Context, tenantID string, ti TenantIndustry) (TenantIndustry, error) {
	if tenantID == "" {
		return TenantIndustry{}, errors.New("aeo: tenant_id required")
	}
	if ti.IndustrySlug == "" {
		return TenantIndustry{}, ErrIndustryUnknown
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return TenantIndustry{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var optedAt any
	if ti.ContributeToPublic {
		optedAt = time.Now().UTC()
	}

	var out TenantIndustry
	out.TenantID = tenantID
	err = tx.QueryRow(ctx, `
INSERT INTO aeo_tenant_industry(tenant_id, industry_slug, contribute_to_public, opted_in_at)
VALUES ($1::uuid, $2, $3, $4)
ON CONFLICT (tenant_id) DO UPDATE SET
    industry_slug         = EXCLUDED.industry_slug,
    contribute_to_public  = EXCLUDED.contribute_to_public,
    opted_in_at           = CASE
        WHEN EXCLUDED.contribute_to_public = true AND aeo_tenant_industry.contribute_to_public = false
          THEN EXCLUDED.opted_in_at
        ELSE aeo_tenant_industry.opted_in_at
    END,
    updated_at            = now()
RETURNING industry_slug, contribute_to_public, opted_in_at, created_at, updated_at`,
		tenantID, ti.IndustrySlug, ti.ContributeToPublic, optedAt,
	).Scan(&out.IndustrySlug, &out.ContributeToPublic, &out.OptedInAt, &out.CreatedAt, &out.UpdatedAt)
	if err != nil {
		return TenantIndustry{}, err
	}
	return out, tx.Commit(ctx)
}

// --- 2. Worker aggregator ------------------------------------------------

// ContributingTenant is one row of the cross-tenant scan that feeds
// the publisher. industry_slug + tenant_id is what the publisher
// groups on.
type ContributingTenant struct {
	TenantID     string
	IndustrySlug string
}

// ListContributingTenantsByIndustry returns every tenant currently
// opted into the public Sensor, grouped by industry. Runs under the
// worker GUC so the `worker_aggregate_read` policy on
// aeo_tenant_industry fires. DEFERRED: today this scans the table
// directly; a future change should snapshot the opt-in list into the
// rollup table itself so a tenant who opts out mid-day is excluded
// from the next publish atomically.
func (r *Repo) ListContributingTenantsByIndustry(ctx context.Context) ([]ContributingTenant, error) {
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT tenant_id::text, industry_slug
  FROM aeo_tenant_industry
 WHERE contribute_to_public = true
 ORDER BY industry_slug, tenant_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ContributingTenant{}
	for rows.Next() {
		var ct ContributingTenant
		if err := rows.Scan(&ct.TenantID, &ct.IndustrySlug); err != nil {
			continue
		}
		out = append(out, ct)
	}
	return out, tx.Commit(ctx)
}

// UpsertSensorIndustryRollup writes one anonymized aggregate row.
// Runs under the worker GUC; the rollup table itself is RLS-off, so
// the write only needs the worker scope for transaction housekeeping.
func (r *Repo) UpsertSensorIndustryRollup(ctx context.Context, rollup SensorIndustryRollup) error {
	if rollup.IndustrySlug == "" {
		return ErrIndustryUnknown
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
INSERT INTO aeo_sensor_industry_rollup(
    industry_slug, engine, day, mention_rate, citation_rate,
    volatility_score, contributor_count, sample_size)
VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)
ON CONFLICT (industry_slug, engine, day) DO UPDATE SET
    mention_rate      = EXCLUDED.mention_rate,
    citation_rate     = EXCLUDED.citation_rate,
    volatility_score  = EXCLUDED.volatility_score,
    contributor_count = EXCLUDED.contributor_count,
    sample_size       = EXCLUDED.sample_size,
    computed_at       = now()`,
		rollup.IndustrySlug, string(rollup.Engine), rollup.Day,
		rollup.MentionRate, rollup.CitationRate, rollup.VolatilityScore,
		rollup.ContributorCount, rollup.SampleSize,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// AppendSensorChangelog adds one publish-cycle audit row.
func (r *Repo) AppendSensorChangelog(ctx context.Context, e SensorChangelogEntry) error {
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	summaryJSON, err := json.Marshal(e.Summary)
	if err != nil {
		summaryJSON = []byte("{}")
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO aeo_sensor_changelog(published_for, summary, status, notes)
VALUES ($1::date, $2::jsonb, $3, $4)`,
		e.PublishedFor, string(summaryJSON), e.Status, e.Notes,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// --- 3. Public read surface ---------------------------------------------

// ListIndustries returns the public industry taxonomy. No tenant
// scope; the table is reference data with RLS off.
func (r *Repo) ListIndustries(ctx context.Context) ([]Industry, error) {
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()

	rows, err := conn.Query(ctx, `
SELECT slug, display_name, sort_order, COALESCE(parent_slug, ''), status, created_at, updated_at
  FROM aeo_sensor_industries
 WHERE status = 'active'
 ORDER BY sort_order, display_name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Industry{}
	for rows.Next() {
		var ind Industry
		if err := rows.Scan(&ind.Slug, &ind.DisplayName, &ind.SortOrder, &ind.ParentSlug, &ind.Status, &ind.CreatedAt, &ind.UpdatedAt); err != nil {
			continue
		}
		out = append(out, ind)
	}
	return out, nil
}

// ListSensorIndustryRollups returns the last `days` of public
// rollups, optionally filtered by industry and engine. Caller (HTTP
// layer) is responsible for applying the MinContributors suppression
// before returning to public consumers.
func (r *Repo) ListSensorIndustryRollups(ctx context.Context, industrySlug string, engine Engine, days int) ([]SensorIndustryRollup, error) {
	if days <= 0 || days > 365 {
		days = 30
	}
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()

	rows, err := conn.Query(ctx, `
SELECT industry_slug, engine, day, mention_rate, citation_rate,
       volatility_score, contributor_count, sample_size, computed_at
  FROM aeo_sensor_industry_rollup
 WHERE ($1::text = '' OR industry_slug = $1)
   AND ($2::text = '' OR engine = $2)
   AND day >= (now() AT TIME ZONE 'utc')::date - $3::integer
 ORDER BY day DESC, industry_slug, engine`,
		industrySlug, string(engine), days)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SensorIndustryRollup{}
	for rows.Next() {
		var rl SensorIndustryRollup
		var eng string
		if err := rows.Scan(&rl.IndustrySlug, &eng, &rl.Day, &rl.MentionRate, &rl.CitationRate,
			&rl.VolatilityScore, &rl.ContributorCount, &rl.SampleSize, &rl.ComputedAt); err != nil {
			continue
		}
		rl.Engine = Engine(eng)
		out = append(out, rl)
	}
	return out, nil
}

// ListSensorChangelog returns the most recent publish-cycle audit
// entries (up to `limit`).
func (r *Repo) ListSensorChangelog(ctx context.Context, limit int) ([]SensorChangelogEntry, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()

	rows, err := conn.Query(ctx, `
SELECT id, published_for, summary, status, notes, published_at
  FROM aeo_sensor_changelog
 ORDER BY published_at DESC
 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SensorChangelogEntry{}
	for rows.Next() {
		var e SensorChangelogEntry
		var summaryRaw []byte
		if err := rows.Scan(&e.ID, &e.PublishedFor, &summaryRaw, &e.Status, &e.Notes, &e.PublishedAt); err != nil {
			continue
		}
		_ = json.Unmarshal(summaryRaw, &e.Summary)
		if e.Summary == nil {
			e.Summary = map[string]any{}
		}
		out = append(out, e)
	}
	return out, nil
}
