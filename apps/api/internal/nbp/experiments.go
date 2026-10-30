// SPDX-License-Identifier: AGPL-3.0-only
//
// Strategy experiments — the multi-week A/B framework for the
// Next Best Product recommender. Scaffolds the data shape, the
// repo surface, and a happy-path lookup that the recommender's
// future variant-routing path will call into.
//
// Migration 0347_sto_next_best_product.sql ships the
// nbp_strategy_experiments table.
//
// Architecture:
//
//   1. An operator creates a row in nbp_strategy_experiments —
//      control_strategy, variant_strategy, traffic_pct — via the
//      Settings > Personalization > Experiments panel.
//   2. The recommender consults ActiveExperiment() per render and
//      routes the subscriber by HashAssign() — a deterministic FNV
//      hash over (subscriber_id, experiment_id) so the same
//      subscriber always lands in the same arm across sends.
//   3. The campaign performance tracker (separate worker, deferred)
//      rolls clicks + conversions per (experiment_id, arm) into
//      nbp_campaign_performance.
//
// Current scope:
//   - SCAFFOLDED: data structures, repo CRUD surface, hash-routing
//                 helper, experiment lookup with a 60s in-process
//                 cache so we don't hammer Postgres per render.
//   - DEFERRED:   wiring the recommender to actually dispatch to the
//                 variant arm; the tracker that rolls up
//                 nbp_campaign_performance.

package nbp

import (
	"context"
	"errors"
	"hash/fnv"
	"strings"
	"sync"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ExperimentStatus mirrors the CHECK constraint on
// nbp_strategy_experiments.status.
type ExperimentStatus string

const (
	ExperimentStatusDraft     ExperimentStatus = "draft"
	ExperimentStatusRunning   ExperimentStatus = "running"
	ExperimentStatusPaused    ExperimentStatus = "paused"
	ExperimentStatusConcluded ExperimentStatus = "concluded"
)

// Arm identifies which side of an experiment a render fell into.
type Arm string

const (
	ArmControl Arm = "control"
	ArmVariant Arm = "variant"
)

// Experiment is one row of nbp_strategy_experiments.
type Experiment struct {
	ID              string           `json:"id"`
	TenantID        string           `json:"tenant_id,omitempty"`
	Name            string           `json:"name"`
	ControlStrategy Strategy         `json:"control_strategy"`
	VariantStrategy Strategy         `json:"variant_strategy"`
	TrafficPct      int              `json:"traffic_pct"`
	Status          ExperimentStatus `json:"status"`
	TopNOverride    *int             `json:"top_n_override,omitempty"`
	Notes           string           `json:"notes,omitempty"`
	StartedAt       *time.Time       `json:"started_at,omitempty"`
	ConcludedAt     *time.Time       `json:"concluded_at,omitempty"`
	CreatedAt       time.Time        `json:"created_at,omitempty"`
	UpdatedAt       time.Time        `json:"updated_at,omitempty"`
}

// HashAssign deterministically assigns a subscriber to control or
// variant based on the experiment's traffic_pct. The same
// (subscriberID, experimentID) pair always returns the same arm so
// a subscriber sees consistent recommendations across sends.
//
// trafficPct=0 -> always control. trafficPct=100 -> always variant.
// In between, we hash to a [0, 99] bucket and compare.
func HashAssign(subscriberID, experimentID string, trafficPct int) Arm {
	if trafficPct <= 0 {
		return ArmControl
	}
	if trafficPct >= 100 {
		return ArmVariant
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(subscriberID))
	_, _ = h.Write([]byte{0x1f}) // unit separator — prevents collision across pairs
	_, _ = h.Write([]byte(experimentID))
	bucket := int(h.Sum32() % 100)
	if bucket < trafficPct {
		return ArmVariant
	}
	return ArmControl
}

// ResolveStrategy returns the strategy the recommender should run for
// this subscriber given the experiment. The recommender's future
// dispatcher will call this in place of reading
// Settings.RefresherStrategy directly when an experiment is active.
func (e Experiment) ResolveStrategy(subscriberID string) (Strategy, Arm) {
	arm := HashAssign(subscriberID, e.ID, e.TrafficPct)
	if arm == ArmVariant {
		return e.VariantStrategy, ArmVariant
	}
	return e.ControlStrategy, ArmControl
}

// experimentCacheEntry is the in-process cache value.
type experimentCacheEntry struct {
	experiments []Experiment
	fetchedAt   time.Time
}

// ExperimentRepo wraps nbp_strategy_experiments + a small per-tenant
// in-process cache. The cache TTL is short (60s) so an operator who
// toggles status='running' in the UI sees the change quickly.
type ExperimentRepo struct {
	Pool *db.Pool

	mu    sync.RWMutex
	cache map[string]experimentCacheEntry // key: tenantID
}

// NewExperimentRepo returns a ready-to-use repo.
func NewExperimentRepo(pool *db.Pool) *ExperimentRepo {
	return &ExperimentRepo{Pool: pool, cache: map[string]experimentCacheEntry{}}
}

// experimentCacheTTL is the per-tenant cache lifetime. Short enough
// that operators see UI changes quickly; long enough to absorb the
// per-render lookup pressure on a popular newsletter (one row read
// per tenant per minute).
const experimentCacheTTL = 60 * time.Second

// ListActive returns all running experiments for a tenant. Caches
// for 60s. The recommender consults this list per render so we
// keep it tight: read-only, no scan if cached.
func (r *ExperimentRepo) ListActive(ctx context.Context, tenantID string) ([]Experiment, error) {
	if r == nil {
		return nil, nil
	}
	now := time.Now()
	r.mu.RLock()
	if entry, ok := r.cache[tenantID]; ok && now.Sub(entry.fetchedAt) < experimentCacheTTL {
		r.mu.RUnlock()
		return entry.experiments, nil
	}
	r.mu.RUnlock()

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT id::text, name, control_strategy, variant_strategy, traffic_pct,
       status, top_n_override, notes, started_at, concluded_at,
       created_at, updated_at
  FROM nbp_strategy_experiments
 WHERE tenant_id = $1::uuid AND status = 'running'
 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		// Table missing or query failed — return empty so the
		// recommender just uses the static strategy from settings.
		return nil, nil
	}
	defer rows.Close()

	out := []Experiment{}
	for rows.Next() {
		var (
			e        Experiment
			ctrl     string
			variant  string
			status   string
			override *int
		)
		e.TenantID = tenantID
		if err := rows.Scan(&e.ID, &e.Name, &ctrl, &variant, &e.TrafficPct,
			&status, &override, &e.Notes, &e.StartedAt, &e.ConcludedAt,
			&e.CreatedAt, &e.UpdatedAt); err != nil {
			continue
		}
		e.ControlStrategy = Strategy(ctrl)
		e.VariantStrategy = Strategy(variant)
		e.Status = ExperimentStatus(status)
		e.TopNOverride = override
		out = append(out, e)
	}
	if err := tx.Commit(ctx); err != nil {
		return out, err
	}

	r.mu.Lock()
	r.cache[tenantID] = experimentCacheEntry{experiments: out, fetchedAt: now}
	r.mu.Unlock()
	return out, nil
}

// Upsert inserts or updates an experiment row. The id field on input
// may be empty for create; the returned Experiment has the assigned id.
func (r *ExperimentRepo) Upsert(ctx context.Context, tenantID string, e Experiment) (Experiment, error) {
	if r == nil || r.Pool == nil {
		return Experiment{}, errors.New("nbp: experiment repo not initialised")
	}
	if tenantID == "" {
		return Experiment{}, errors.New("nbp: tenant_id required")
	}
	if strings.TrimSpace(e.Name) == "" {
		return Experiment{}, errors.New("nbp: experiment name required")
	}
	// Clamp traffic_pct to the CHECK range so a malformed UI POST
	// can't blow up at the SQL layer.
	if e.TrafficPct < 0 {
		e.TrafficPct = 0
	}
	if e.TrafficPct > 100 {
		e.TrafficPct = 100
	}
	if e.Status == "" {
		e.Status = ExperimentStatusDraft
	}
	if e.ControlStrategy == "" {
		e.ControlStrategy = StrategyItemItemCF
	}
	if e.VariantStrategy == "" {
		e.VariantStrategy = StrategyPopularity
	}
	if !selectableStrategy(e.ControlStrategy) || !selectableStrategy(e.VariantStrategy) {
		return Experiment{}, ErrUnsupportedStrategy
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return e, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		out      Experiment
		ctrl     string
		variant  string
		status   string
		override *int
	)
	out.TenantID = tenantID
	err = tx.QueryRow(ctx, `
INSERT INTO nbp_strategy_experiments(
    tenant_id, name, control_strategy, variant_strategy, traffic_pct,
    status, top_n_override, notes)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (tenant_id, name) DO UPDATE SET
    control_strategy = EXCLUDED.control_strategy,
    variant_strategy = EXCLUDED.variant_strategy,
    traffic_pct      = EXCLUDED.traffic_pct,
    status           = EXCLUDED.status,
    top_n_override   = EXCLUDED.top_n_override,
    notes            = EXCLUDED.notes,
    updated_at       = now()
RETURNING id::text, name, control_strategy, variant_strategy, traffic_pct,
          status, top_n_override, notes, started_at, concluded_at,
          created_at, updated_at`,
		tenantID, e.Name, string(e.ControlStrategy), string(e.VariantStrategy),
		e.TrafficPct, string(e.Status), e.TopNOverride, e.Notes,
	).Scan(&out.ID, &out.Name, &ctrl, &variant, &out.TrafficPct,
		&status, &override, &out.Notes, &out.StartedAt, &out.ConcludedAt,
		&out.CreatedAt, &out.UpdatedAt)
	if err != nil {
		return e, err
	}
	out.ControlStrategy = Strategy(ctrl)
	out.VariantStrategy = Strategy(variant)
	out.Status = ExperimentStatus(status)
	out.TopNOverride = override
	if err := tx.Commit(ctx); err != nil {
		return out, err
	}
	// Invalidate the cache so the next render picks up the new state.
	r.mu.Lock()
	delete(r.cache, tenantID)
	r.mu.Unlock()
	return out, nil
}

// List returns all experiments for a tenant regardless of status —
// powers the admin UI.
func (r *ExperimentRepo) List(ctx context.Context, tenantID string) ([]Experiment, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("nbp: experiment repo not initialised")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, name, control_strategy, variant_strategy, traffic_pct,
       status, top_n_override, notes, started_at, concluded_at,
       created_at, updated_at
  FROM nbp_strategy_experiments
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, nil
	}
	defer rows.Close()
	out := []Experiment{}
	for rows.Next() {
		var (
			e        Experiment
			ctrl     string
			variant  string
			status   string
			override *int
		)
		e.TenantID = tenantID
		if err := rows.Scan(&e.ID, &e.Name, &ctrl, &variant, &e.TrafficPct,
			&status, &override, &e.Notes, &e.StartedAt, &e.ConcludedAt,
			&e.CreatedAt, &e.UpdatedAt); err != nil {
			continue
		}
		e.ControlStrategy = Strategy(ctrl)
		e.VariantStrategy = Strategy(variant)
		e.Status = ExperimentStatus(status)
		e.TopNOverride = override
		out = append(out, e)
	}
	return out, tx.Commit(ctx)
}
