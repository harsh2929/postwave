// SPDX-License-Identifier: AGPL-3.0-only
//
// Campaign performance — the per-campaign rollup table powering the
// "Recommendation lift" widget on the dashboard. Populated by a
// tracker (deferred) that joins nbp_recommendation_audit with the
// inbound click + commerce_orders event tables.
//
// Migration 0347_sto_next_best_product.sql ships the
// nbp_campaign_performance table.
//
// Current scope:
//   - SCAFFOLDED: data structures, repo CRUD surface, a single-row
//                 upsert the tracker can call once per tenant /
//                 campaign / arm / strategy bucket.
//   - DEFERRED:   the tracker worker itself + the join queries
//                 against email_click_events and commerce_orders.
//   - DEFERRED:   the dashboard widget that visualises the lift.

package nbp

import (
	"context"
	"errors"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// CampaignPerformance is one row of nbp_campaign_performance.
type CampaignPerformance struct {
	TenantID       string    `json:"tenant_id,omitempty"`
	CampaignID     string    `json:"campaign_id"`
	ExperimentID   string    `json:"experiment_id,omitempty"`
	Arm            Arm       `json:"arm"`
	Strategy       Strategy  `json:"strategy"`
	Impressions    int64     `json:"impressions"`
	Clicks         int64     `json:"clicks"`
	Conversions    int64     `json:"conversions"`
	RevenueCents   int64     `json:"revenue_cents"`
	ModelVersion   int64     `json:"model_version"`
	LastRolledUpAt time.Time `json:"last_rolled_up_at,omitempty"`
	CreatedAt      time.Time `json:"created_at,omitempty"`
	UpdatedAt      time.Time `json:"updated_at,omitempty"`
}

// PerformanceRepo wraps nbp_campaign_performance.
type PerformanceRepo struct {
	Pool *db.Pool
}

// NewPerformanceRepo returns a ready-to-use repo.
func NewPerformanceRepo(pool *db.Pool) *PerformanceRepo {
	return &PerformanceRepo{Pool: pool}
}

// Upsert writes (or overwrites) the rollup row for the unique
// (tenant, campaign, arm, strategy) key.
func (r *PerformanceRepo) Upsert(ctx context.Context, tenantID string, p CampaignPerformance) error {
	if r == nil || r.Pool == nil {
		return errors.New("nbp: performance repo not initialised")
	}
	if tenantID == "" {
		return errors.New("nbp: tenant_id required")
	}
	if p.CampaignID == "" {
		return errors.New("nbp: campaign_id required")
	}
	if p.Arm == "" {
		p.Arm = ArmControl
	}
	if p.Strategy == "" {
		p.Strategy = StrategyItemItemCF
	}
	if p.ModelVersion == 0 {
		p.ModelVersion = 1
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	experimentArg := nullIfBlank(p.ExperimentID)

	if _, err := tx.Exec(ctx, `
INSERT INTO nbp_campaign_performance(
    tenant_id, campaign_id, experiment_id, arm, strategy,
    impressions, clicks, conversions, revenue_cents, model_version,
    last_rolled_up_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, now())
ON CONFLICT (tenant_id, campaign_id, arm, strategy) DO UPDATE SET
    experiment_id     = EXCLUDED.experiment_id,
    impressions       = EXCLUDED.impressions,
    clicks            = EXCLUDED.clicks,
    conversions       = EXCLUDED.conversions,
    revenue_cents     = EXCLUDED.revenue_cents,
    model_version     = EXCLUDED.model_version,
    last_rolled_up_at = now(),
    updated_at        = now()`,
		tenantID, p.CampaignID, experimentArg, string(p.Arm), string(p.Strategy),
		p.Impressions, p.Clicks, p.Conversions, p.RevenueCents, p.ModelVersion,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ListForCampaign returns every rollup row for a campaign — the
// dashboard widget compares arms side-by-side.
func (r *PerformanceRepo) ListForCampaign(ctx context.Context, tenantID, campaignID string) ([]CampaignPerformance, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("nbp: performance repo not initialised")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT campaign_id::text, COALESCE(experiment_id::text, ''), arm, strategy,
       impressions, clicks, conversions, revenue_cents, model_version,
       last_rolled_up_at, created_at, updated_at
  FROM nbp_campaign_performance
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
 ORDER BY arm, strategy`, tenantID, campaignID)
	if err != nil {
		return nil, nil
	}
	defer rows.Close()
	out := []CampaignPerformance{}
	for rows.Next() {
		var (
			p     CampaignPerformance
			arm   string
			strat string
		)
		p.TenantID = tenantID
		if err := rows.Scan(&p.CampaignID, &p.ExperimentID, &arm, &strat,
			&p.Impressions, &p.Clicks, &p.Conversions, &p.RevenueCents, &p.ModelVersion,
			&p.LastRolledUpAt, &p.CreatedAt, &p.UpdatedAt); err != nil {
			continue
		}
		p.Arm = Arm(arm)
		p.Strategy = Strategy(strat)
		out = append(out, p)
	}
	return out, tx.Commit(ctx)
}
