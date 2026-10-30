// SPDX-License-Identifier: AGPL-3.0-only
//
// Package abtests scheduler — auto-promotes A/B test winners after the
// evaluation window has elapsed.
//
// Background: Evaluate (POST /api/v1/campaigns/{id}/ab/evaluate) is a
// manual operator action. In V1 the winner only got chosen when someone
// remembered to click a button. The Scheduler closes that gap: it polls
// campaign_ab_settings for tests where (a) winner_decided_at is null,
// (b) the campaign is sent, and (c) the configured evaluation window
// has elapsed since the send. For each match, it pulls the variant
// results, runs EvaluateWinner, and persists the winner via MarkWinner.
//
// The same auto-promote loop also handles the "send the winner to the
// remaining audience" case in V2 (gated on winner_recipients_pct < 100),
// but V1 just records the winner — actually re-sending to the remaining
// pct happens through the campaign send path explicitly.

package abtests

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Scheduler runs the auto-promote loop. Constructed from main.go.
type Scheduler struct {
	Pool   *db.Pool
	Repo   *Repo
	Logger *slog.Logger

	// Interval between polls. Defaults to 5 minutes — winner decisions
	// are not latency-sensitive, and the per-tick query is cheap.
	Interval time.Duration

	// WinnerDeps wires real reply counts into the auto-promote path.
	// When nil, the scheduler uses the legacy engagement_proxy
	// fallback for reply_rate decisions.
	WinnerDeps *WinnerDeps

	// Rollout, when non-nil, runs the second-phase auto-rollout on
	// every tick after the winner-promotion pass. Nil disables
	// auto-rollout (winners still get marked; the operator must
	// manually queue the held-back send). main.go injects this with
	// the campaigns-package RolloutCreator wired up.
	Rollout *RolloutDispatcher
}

// Run blocks until ctx is cancelled. Tick errors are logged but the
// loop continues — a poisonous campaign shouldn't take down the
// scheduler.
func (s *Scheduler) Run(ctx context.Context) {
	if s == nil || s.Pool == nil || s.Repo == nil {
		return
	}
	interval := s.Interval
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			s.tickOnce(ctx)
		}
	}
}

// tickOnce drains up to N due tests. Bounded so a backlog can't
// monopolise the scheduler tick.
func (s *Scheduler) tickOnce(ctx context.Context) {
	const maxPerTick = 32
	due, err := s.findDue(ctx, maxPerTick)
	if err != nil {
		s.log().Warn("abtests scheduler: find due failed", "err", err.Error())
		return
	}
	for _, d := range due {
		if err := s.promote(ctx, d.TenantID, d.CampaignID); err != nil {
			s.log().Warn("abtests scheduler: promote failed",
				"tenant", d.TenantID,
				"campaign", d.CampaignID,
				"err", err.Error())
		}
	}
	// Second pass: dispatch any tests whose sample phase concluded
	// but whose winner hasn't been queued to the held-back audience
	// yet. Runs after the promote loop so a winner decided THIS
	// tick can be rolled out in the same tick (no 5-minute lag).
	if s.Rollout != nil {
		s.Rollout.dispatchDue(ctx)
	}

	// G4: bandit pass — recompute variant weights for non-fixed tests
	// still in their variant phase whose recompute interval has elapsed.
	// Updating campaign_variants.weight re-allocates the remaining
	// audience at the next queue-fill (AssignVariant buckets by weight).
	banditDue, err := s.findBanditDue(ctx, maxPerTick)
	if err != nil {
		s.log().Warn("abtests scheduler: find bandit due failed", "err", err.Error())
		return
	}
	for _, d := range banditDue {
		if err := s.Repo.RecomputeBanditWeights(ctx, d.TenantID, d.CampaignID); err != nil {
			s.log().Warn("abtests scheduler: bandit recompute failed",
				"tenant", d.TenantID, "campaign", d.CampaignID, "err", err.Error())
		}
	}
}

// findBanditDue returns non-fixed A/B tests still in their variant phase
// (no winner decided) whose last bandit recompute is older than their
// configured interval.
func (s *Scheduler) findBanditDue(ctx context.Context, limit int) ([]dueTest, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT c.tenant_id::text, c.id::text
  FROM campaigns c
  JOIN campaign_ab_settings ab ON ab.campaign_id = c.id
 WHERE c.status IN ('sent','sending','running')
   AND ab.winner_decided_at IS NULL
   AND ab.bandit_strategy IS NOT NULL
   AND ab.bandit_strategy <> 'fixed'
   AND (ab.last_recomputed_at IS NULL
        OR ab.last_recomputed_at + (COALESCE(ab.recompute_interval_minutes,30) * interval '1 minute') <= now())
 ORDER BY ab.last_recomputed_at ASC NULLS FIRST
 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]dueTest, 0, limit)
	for rows.Next() {
		var d dueTest
		if err := rows.Scan(&d.TenantID, &d.CampaignID); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// dueTest is the (tenant, campaign) pair the scheduler picked up.
type dueTest struct {
	TenantID   string
	CampaignID string
}

// findDue queries platform-wide for tests that need promoting. Uses
// the outbox-worker permissive policy on campaigns + a lateral join
// on campaign_ab_settings to scope by tenant. campaign_ab_settings
// itself is RLS-only, but we don't need cross-tenant SELECT on it
// because the JOIN walks back to campaigns under the worker bypass.
//
// Window math: campaigns.updated_at on a 'sent' campaign is the
// send-completion time (the scheduler's own dispatchOne flips status
// to 'sending' at dispatch, then listmonk-events flips to 'sent' on
// completion). evaluation_window_hours is added to that to derive
// "auto-promote at this time".
func (s *Scheduler) findDue(ctx context.Context, limit int) ([]dueTest, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT c.tenant_id::text, c.id::text
  FROM campaigns c
  JOIN campaign_ab_settings ab ON ab.campaign_id = c.id
 WHERE c.status = 'sent'
   AND ab.winner_decided_at IS NULL
   AND c.updated_at + (ab.evaluation_window_hours * interval '1 hour') <= now()
 ORDER BY c.updated_at ASC
 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]dueTest, 0, limit)
	for rows.Next() {
		var d dueTest
		if err := rows.Scan(&d.TenantID, &d.CampaignID); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// promote runs EvaluateWinner against the campaign's results and marks
// the winner if one is decided. Idempotent: a campaign that's been
// promoted between findDue and promote (race with manual Evaluate)
// returns ErrAlreadyDecided harmlessly.
func (s *Scheduler) promote(ctx context.Context, tenantID, campaignID string) error {
	settings, err := s.Repo.GetSettings(ctx, tenantID, campaignID)
	if err != nil {
		return err
	}
	if settings.WinnerDecidedAt != nil {
		return nil // raced with a manual Evaluate; nothing to do.
	}
	results, err := s.Repo.ListResults(ctx, tenantID, campaignID)
	if err != nil {
		return err
	}
	// Spend a look BEFORE testing. Ordering matters: incrementing afterwards
	// means a crash between the test and the write gives the look back, and a
	// worker that crashes on a schedule would peek without limit while the
	// counter stayed put.
	taken, err := s.Repo.RecordWinnerLook(ctx, tenantID, campaignID)
	if err != nil {
		return err
	}
	budget := settings.LookBudget()
	budget.Taken = taken
	winnerID, decided := EvaluateWinnerWithDeps(ctx, s.WinnerDeps, campaignID, settings.WinnerMetric, results, budget)
	// The fallback here used to be `results[0]`, which ListResults orders by
	// variant_label — so every inconclusive test promoted variant A and recorded
	// it as a decided winner. See auto_promotion.go for why that is two separate
	// defects: an alphabetical bias in the CHOICE, and a false claim in the
	// RECORD.
	choice := chooseAutoPromotion(results, winnerID, decided)
	if choice.VariantID == "" {
		return errors.New("no variants to evaluate")
	}
	winnerID = choice.VariantID
	if err := s.Repo.MarkWinner(ctx, tenantID, campaignID, winnerID); err != nil {
		return err
	}
	if !choice.Conclusive {
		// The send proceeds — the operator asked for auto-promotion and a
		// held-back audience that never receives anything is its own failure —
		// but nothing downstream may present this as a result.
		if err := s.Repo.MarkWinnerInconclusive(ctx, tenantID, campaignID, choice.Reason); err != nil {
			return err
		}
		s.log().Warn("abtests: auto-promoted an INCONCLUSIVE test",
			"tenant", tenantID,
			"campaign", campaignID,
			"variant", winnerID,
			"reason", choice.Reason)
	}
	s.log().Info("abtests: auto-promoted winner",
		"tenant", tenantID,
		"campaign", campaignID,
		"winner_variant", winnerID,
		"metric", settings.WinnerMetric)

	// Second-phase auto-promotion: when sample_pct < 100, the
	// remaining (100 - sample_pct)% of the audience should now
	// receive the winning variant. We stamp sample_evaluated_at to
	// mark "the scheduler decided" + record a clear log entry the
	// dispatcher can pick up.
	//
	// The actual cross-audience send is the dispatcher's job (it
	// reads sample_evaluated_at + sample_pct to compute the
	// remaining slice + creates a child campaign send job).
	if settings.SamplePct < 100 && settings.SampleEvaluatedAt == nil {
		if err := s.Repo.MarkSampleEvaluated(ctx, tenantID, campaignID); err != nil {
			s.log().Warn("abtests: failed to stamp sample_evaluated_at",
				"tenant", tenantID, "campaign", campaignID,
				"err", err.Error())
		} else {
			s.log().Info("abtests: sample phase concluded; winner queued for remaining audience",
				"tenant", tenantID, "campaign", campaignID,
				"sample_pct", settings.SamplePct,
				"remaining_pct", 100-settings.SamplePct,
				"winner_variant", winnerID)
		}
	}
	return nil
}

func (s *Scheduler) log() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}
