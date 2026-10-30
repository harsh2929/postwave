// SPDX-License-Identifier: AGPL-3.0-only
//
// trainer.go — the bandit trainer math that fills in the deferred tickStub.
// Per tick it pulls every running optimizer run (cross-tenant, worker scope),
// recomputes each arm's Beta(α,β) posterior from its observed
// (impressions, conversions), Thompson-samples a fresh traffic allocation
// (reusing the tested internal/abtests bandit), and transitions a run from
// exploring → exploiting once every arm has the minimum impressions and a
// clear leader has emerged.

package sto_content_optimizer

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/abtests"
	"github.com/postwave/postwave/apps/api/internal/db"
)

// leaderShareThreshold is the allocation share one arm must hold for the run to
// be considered to have a likely winner (drives exploring → exploiting).
const leaderShareThreshold = 0.65

// armKey emits the canonical "subject=s1;header=h1;..." key (fixed slot order)
// from an arm's component-id map — the inverse of armComponentIDsFromKey and the
// same key cartesianKeys/uniformAllocation use, so allocation weights line up
// with the arms.
func armKey(componentIDs map[string]string) string {
	order := []ComponentName{ComponentSubject, ComponentHeader, ComponentBody, ComponentCTA}
	var sb strings.Builder
	for _, name := range order {
		id := componentIDs[string(name)]
		if id == "" {
			continue
		}
		if sb.Len() > 0 {
			sb.WriteByte(';')
		}
		sb.WriteString(string(name))
		sb.WriteByte('=')
		sb.WriteString(id)
	}
	return sb.String()
}

type armPosterior struct {
	armID string
	alpha float64
	beta  float64
}

type trainingResult struct {
	allocation map[string]float64
	posteriors []armPosterior
	newStatus  Status
}

// computeTraining is the pure trainer math (unit-tested). Beta(1+conv, 1+misses)
// posteriors per arm, a Thompson-sampled allocation, and the phase transition.
func computeTraining(arms []OptimizerArm, exploreFloor float64, minImpressions int, current Status) trainingResult {
	res := trainingResult{allocation: map[string]float64{}, newStatus: current}
	if len(arms) == 0 {
		return res
	}
	stats := make([]abtests.VariantStat, 0, len(arms))
	for _, a := range arms {
		key := armKey(a.ComponentIDs)
		misses := a.Impressions - a.Conversions
		if misses < 0 {
			misses = 0
		}
		stats = append(stats, abtests.VariantStat{
			VariantID: key,
			Successes: int(a.Conversions),
			Trials:    int(a.Impressions),
		})
		res.posteriors = append(res.posteriors, armPosterior{
			armID: a.ID,
			alpha: 1 + float64(a.Conversions),
			beta:  1 + float64(misses),
		})
	}
	// RecomputeWeights returns percentage weights (summing to ~100); the STO
	// traffic_allocation convention is fractions summing to 1 (same as the
	// seeded uniformAllocation), so normalize. This also makes the leader-share
	// threshold a true fraction.
	weights := abtests.RecomputeWeights("thompson", stats, exploreFloor, nil)
	total := 0.0
	for _, w := range weights {
		total += w.Weight
	}
	for _, w := range weights {
		if total > 0 {
			res.allocation[w.VariantID] = w.Weight / total
		} else {
			res.allocation[w.VariantID] = 1.0 / float64(len(weights))
		}
	}
	if current == StatusExploring && minImpressions > 0 &&
		allArmsReachedMin(arms, minImpressions) && clearLeader(res.allocation) {
		res.newStatus = StatusExploiting
	}
	return res
}

func allArmsReachedMin(arms []OptimizerArm, min int) bool {
	for _, a := range arms {
		if int(a.Impressions) < min {
			return false
		}
	}
	return true
}

// clearLeader reports whether one arm holds a dominant allocation share.
func clearLeader(allocation map[string]float64) bool {
	for _, w := range allocation {
		if w >= leaderShareThreshold {
			return true
		}
	}
	return false
}

// runRef is a (tenant, run) pair the trainer iterates over.
type runRef struct {
	tenantID string
	runID    string
}

// trainAll runs one trainer pass over every running optimizer run. Best-effort
// per run: one failing run never aborts the batch.
func (wkr *Worker) trainAll(ctx context.Context) error {
	refs, err := wkr.Repo.ListRunningRuns(ctx)
	if err != nil {
		return err
	}
	for _, ref := range refs {
		if err := wkr.trainRun(ctx, ref.tenantID, ref.runID); err != nil {
			slog.Warn("sto trainer: run failed", "run_id", ref.runID, "err", err.Error())
		}
	}
	return nil
}

func (wkr *Worker) trainRun(ctx context.Context, tenantID, runID string) error {
	run, arms, err := wkr.Repo.GetRunWithArms(ctx, tenantID, runID)
	if err != nil {
		return err
	}
	if run == nil {
		return nil
	}
	plan := computeTraining(arms, run.ExplorationFloor, run.MinImpressionsPerArm, run.Status)
	return wkr.Repo.SaveTraining(ctx, tenantID, runID, plan.allocation, plan.posteriors, plan.newStatus)
}

// ListRunningRuns returns every exploring/exploiting run across tenants. Uses
// the optimizer worker scope (migration 0346 gives the runs table an
// app.outbox_worker RLS escape) so one tick drains all tenants.
func (r *Repo) ListRunningRuns(ctx context.Context) ([]runRef, error) {
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text FROM email_optimizer_runs
 WHERE status IN ('exploring', 'exploiting')
 ORDER BY updated_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []runRef
	for rows.Next() {
		var ref runRef
		if err := rows.Scan(&ref.runID, &ref.tenantID); err != nil {
			return nil, err
		}
		out = append(out, ref)
	}
	return out, rows.Err()
}

// SaveTraining persists a trainer pass: the run's new traffic_allocation +
// status, and each arm's recomputed Beta posterior, in one tenant-scoped tx.
func (r *Repo) SaveTraining(ctx context.Context, tenantID, runID string, allocation map[string]float64, posteriors []armPosterior, status Status) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	allocJSON, err := json.Marshal(allocation)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
UPDATE email_optimizer_runs
   SET traffic_allocation = $3::jsonb, status = $4, updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, runID, string(allocJSON), string(status)); err != nil {
		return err
	}
	for _, p := range posteriors {
		if _, err := tx.Exec(ctx, `
UPDATE email_optimizer_arms
   SET posterior_alpha = $3, posterior_beta = $4
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
			tenantID, p.armID, p.alpha, p.beta); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
