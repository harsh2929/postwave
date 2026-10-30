// SPDX-License-Identifier: AGPL-3.0-only

package sto_content_optimizer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrNotFound is returned when a run lookup misses.
var ErrNotFound = errors.New("sto_content_optimizer: not found")

// ErrBadTransition is returned when a status transition is attempted
// from a state that doesn't permit it.
var ErrBadTransition = errors.New("sto_content_optimizer: bad status transition")

// Repo owns SQL access to the three optimizer tables. Every method
// opens a db.WithTenant transaction so RLS fires under the project
// idiom.
type Repo struct {
	Pool *db.Pool
}

// CreateRun inserts the OptimizerRun + the cartesian arms in a single
// tenant-scoped transaction. The arms are materialised from the
// component manifest using cartesianKeys.
func (r *Repo) CreateRun(ctx context.Context, run *OptimizerRun) (*OptimizerRun, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("sto_content_optimizer: repo not configured")
	}
	if run == nil || run.TenantID == "" || run.CampaignID == "" {
		return nil, errors.New("sto_content_optimizer: tenant_id + campaign_id required")
	}

	componentsJSON, err := json.Marshal(run.Components)
	if err != nil {
		return nil, fmt.Errorf("marshal components: %w", err)
	}
	allocationJSON, err := json.Marshal(run.TrafficAllocation)
	if err != nil {
		return nil, fmt.Errorf("marshal traffic_allocation: %w", err)
	}
	// model_state starts empty — the trainer populates it after the
	// first tick that sees impressions.
	modelStateJSON := []byte(`{}`)

	tx, err := db.WithTenant(ctx, r.Pool, run.TenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const insertRun = `
INSERT INTO email_optimizer_runs
    (tenant_id, campaign_id, name, objective, status, components,
     traffic_allocation, model_state, min_impressions_per_arm,
     exploration_floor)
VALUES
    ($1::uuid, $2::uuid, NULLIF($3,''), $4, $5, $6::jsonb, $7::jsonb,
     $8::jsonb, $9, $10)
RETURNING id::text, COALESCE(name,''), created_at, updated_at, completed_at`

	var savedID string
	var savedName string
	if err := tx.QueryRow(ctx, insertRun,
		run.TenantID, run.CampaignID, run.Name,
		string(run.Objective), string(run.Status),
		componentsJSON, allocationJSON, modelStateJSON,
		run.MinImpressionsPerArm, run.ExplorationFloor,
	).Scan(&savedID, &savedName, &run.CreatedAt, &run.UpdatedAt, &run.CompletedAt); err != nil {
		return nil, fmt.Errorf("insert run: %w", err)
	}
	run.ID = savedID
	run.Name = savedName

	// Materialise the arms. We seed each at Beta(1,1) — uniform prior.
	const insertArm = `
INSERT INTO email_optimizer_arms
    (run_id, tenant_id, component_ids, posterior_alpha, posterior_beta)
VALUES ($1::uuid, $2::uuid, $3::jsonb, 1.0, 1.0)`

	for _, key := range cartesianKeys(run.Components) {
		comp := armComponentIDsFromKey(key)
		armJSON, mErr := json.Marshal(comp)
		if mErr != nil {
			return nil, fmt.Errorf("marshal arm components: %w", mErr)
		}
		if _, err := tx.Exec(ctx, insertArm, savedID, run.TenantID, armJSON); err != nil {
			return nil, fmt.Errorf("insert arm: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return run, nil
}

// ListRunsForCampaign returns the optimizer runs anchored at the given
// campaign, newest first.
func (r *Repo) ListRunsForCampaign(ctx context.Context, tenantID, campaignID string) ([]OptimizerRun, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("sto_content_optimizer: repo not configured")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const q = `
SELECT id::text, tenant_id::text, campaign_id::text,
       COALESCE(name,''), objective, status,
       components::text, traffic_allocation::text, model_state::text,
       min_impressions_per_arm, exploration_floor,
       created_at, updated_at, completed_at
FROM email_optimizer_runs
WHERE campaign_id = $1::uuid
ORDER BY created_at DESC`

	rows, err := tx.Query(ctx, q, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []OptimizerRun{}
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *run)
	}
	return out, rows.Err()
}

// GetRunWithArms returns one run + its materialised arms.
func (r *Repo) GetRunWithArms(ctx context.Context, tenantID, runID string) (*OptimizerRun, []OptimizerArm, error) {
	if r == nil || r.Pool == nil {
		return nil, nil, errors.New("sto_content_optimizer: repo not configured")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const runQ = `
SELECT id::text, tenant_id::text, campaign_id::text,
       COALESCE(name,''), objective, status,
       components::text, traffic_allocation::text, model_state::text,
       min_impressions_per_arm, exploration_floor,
       created_at, updated_at, completed_at
FROM email_optimizer_runs
WHERE id = $1::uuid`

	row := tx.QueryRow(ctx, runQ, runID)
	run, err := scanRun(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, ErrNotFound
		}
		return nil, nil, err
	}

	const armsQ = `
SELECT id::text, run_id::text, tenant_id::text,
       component_ids::text, impressions, conversions,
       posterior_alpha, posterior_beta, last_assigned_at, created_at
FROM email_optimizer_arms
WHERE run_id = $1::uuid
ORDER BY created_at`

	rows, err := tx.Query(ctx, armsQ, runID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	arms := []OptimizerArm{}
	for rows.Next() {
		var a OptimizerArm
		var componentIDsJSON string
		if err := rows.Scan(&a.ID, &a.RunID, &a.TenantID,
			&componentIDsJSON, &a.Impressions, &a.Conversions,
			&a.PosteriorAlpha, &a.PosteriorBeta,
			&a.LastAssignedAt, &a.CreatedAt); err != nil {
			return nil, nil, err
		}
		_ = json.Unmarshal([]byte(componentIDsJSON), &a.ComponentIDs)
		arms = append(arms, a)
	}
	return run, arms, rows.Err()
}

// UpdateStatus transitions the run from `from` to `to`. Returns
// ErrBadTransition if the current persisted status is not `from`.
func (r *Repo) UpdateStatus(ctx context.Context, tenantID, runID string, from, to Status) (*OptimizerRun, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("sto_content_optimizer: repo not configured")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const q = `
UPDATE email_optimizer_runs
SET status = $3, updated_at = now()
WHERE id = $1::uuid AND status = $2
RETURNING id::text, tenant_id::text, campaign_id::text,
          COALESCE(name,''), objective, status,
          components::text, traffic_allocation::text, model_state::text,
          min_impressions_per_arm, exploration_floor,
          created_at, updated_at, completed_at`

	row := tx.QueryRow(ctx, q, runID, string(from), string(to))
	run, err := scanRun(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Could be missing OR in the wrong state — distinguish.
			var st string
			st, qErr := r.statusOf(ctx, tx, runID)
			if qErr != nil {
				return nil, ErrNotFound
			}
			if st == "" {
				return nil, ErrNotFound
			}
			return nil, ErrBadTransition
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return run, nil
}

// MarkCompleted is the terminal transition — accepted from any
// non-completed state for now (the deferred work tightens this once
// the trainer can verify the bandit has converged).
func (r *Repo) MarkCompleted(ctx context.Context, tenantID, runID string) (*OptimizerRun, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("sto_content_optimizer: repo not configured")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const q = `
UPDATE email_optimizer_runs
SET status       = 'completed',
    completed_at = now(),
    updated_at   = now()
WHERE id = $1::uuid AND status <> 'completed'
RETURNING id::text, tenant_id::text, campaign_id::text,
          COALESCE(name,''), objective, status,
          components::text, traffic_allocation::text, model_state::text,
          min_impressions_per_arm, exploration_floor,
          created_at, updated_at, completed_at`

	row := tx.QueryRow(ctx, q, runID)
	run, err := scanRun(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return run, nil
}

// statusOf returns the persisted status string for a run (or ""), used
// by UpdateStatus to distinguish "missing" from "wrong state".
func (r *Repo) statusOf(ctx context.Context, tx pgx.Tx, runID string) (string, error) {
	var st string
	err := tx.QueryRow(ctx,
		`SELECT status FROM email_optimizer_runs WHERE id = $1::uuid`, runID,
	).Scan(&st)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	return st, nil
}

// rowScanner is the common surface of pgx.Row and pgx.Rows for Scan —
// lets scanRun work for both QueryRow and Query loops.
type rowScanner interface {
	Scan(dest ...any) error
}

// scanRun decodes one row into OptimizerRun. The jsonb columns come
// back as text so we can json.Unmarshal them — saves us a dependency on
// pgx jsonb scanning quirks.
func scanRun(row rowScanner) (*OptimizerRun, error) {
	var run OptimizerRun
	var componentsText, allocationText, modelStateText string
	var objective, status string
	if err := row.Scan(
		&run.ID, &run.TenantID, &run.CampaignID,
		&run.Name, &objective, &status,
		&componentsText, &allocationText, &modelStateText,
		&run.MinImpressionsPerArm, &run.ExplorationFloor,
		&run.CreatedAt, &run.UpdatedAt, &run.CompletedAt,
	); err != nil {
		return nil, err
	}
	run.Objective = Objective(objective)
	run.Status = Status(status)
	_ = json.Unmarshal([]byte(componentsText), &run.Components)
	_ = json.Unmarshal([]byte(allocationText), &run.TrafficAllocation)
	run.ModelState = json.RawMessage(modelStateText)
	return &run, nil
}
