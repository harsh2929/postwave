// SPDX-License-Identifier: AGPL-3.0-only
//
// rollout.go — auto-rollout of the winning variant to the held-back
// audience. Pairs with scheduler.go's MarkSampleEvaluated stamping:
// once the scheduler has decided a winner AND the test was configured
// with sample_pct < 100, this dispatcher creates a child campaign for
// the remaining (100 - sample_pct)% of the audience and queues it.
//
// The actual campaign-creation work is delegated through a Creator
// interface so this package stays free of the campaigns-package
// import (which would form a cycle: campaigns → abtests via the
// scheduler hook, and abtests → campaigns via the creator). main.go
// wires a real implementation that calls into campaigns.

package abtests

import (
	"context"
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// RolloutCreator is the callback the auto-rollout dispatcher invokes
// to materialise the second-phase send. Implementations live in the
// campaigns package; this package only knows about the input
// envelope.
//
// Returns the id of the newly-created child campaign so the
// dispatcher can stamp it into campaign_ab_settings.winner_rollout_campaign_id
// for forensics / dashboard surfacing.
type RolloutCreator interface {
	CreateRollout(ctx context.Context, in RolloutInput) (string, error)
}

// RolloutInput carries everything CreateRollout needs to construct
// the second-phase child. The implementation pulls subject + body
// from the winning variant; we pass the IDs not the full bodies to
// keep this interface narrow.
type RolloutInput struct {
	TenantID         string
	ParentCampaignID string
	WinningVariantID string
	// SamplePct is the original test's sample_pct; the implementation
	// uses it to derive the held-back audience (deterministically,
	// using the same fnv-1a hash as ApplyABTestSplit so subscribers
	// who already received a variant aren't re-targeted).
	SamplePct float64
}

// RolloutDispatcher drives the auto-rollout sweep. Owned by main.go;
// runs every scheduler tick after the winner-promotion step. Idempotent
// via campaign_ab_settings.winner_dispatched_at (set by MarkWinnerDispatched
// after CreateRollout succeeds).
type RolloutDispatcher struct {
	Pool    *db.Pool
	Repo    *Repo
	Creator RolloutCreator
	Logger  *slog.Logger
}

// dispatchDue picks up tests that have sample_evaluated_at set but
// winner_dispatched_at not, and fires CreateRollout for each. Bounded
// per tick to keep DB pressure predictable.
func (d *RolloutDispatcher) dispatchDue(ctx context.Context) {
	if d == nil || d.Pool == nil || d.Repo == nil || d.Creator == nil {
		return
	}
	const maxPerTick = 32
	rows, err := d.findDue(ctx, maxPerTick)
	if err != nil {
		d.log().Warn("abtests rollout: find due failed", "err", err.Error())
		return
	}
	for _, r := range rows {
		if err := d.dispatchOne(ctx, r); err != nil {
			d.log().Warn("abtests rollout: dispatch failed",
				"tenant", r.TenantID,
				"campaign", r.CampaignID,
				"err", err.Error())
		}
	}
}

type dueRollout struct {
	TenantID         string
	CampaignID       string
	WinningVariantID string
	SamplePct        float64
}

func (d *RolloutDispatcher) findDue(ctx context.Context, limit int) ([]dueRollout, error) {
	tx, err := d.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, err
	}
	// Index `campaign_ab_settings_due_rollout_idx` (migration 0175) is
	// partial-by-the-WHERE-predicate so this scan is O(due rows) not
	// O(total ab settings).
	rows, err := tx.Query(ctx, `
SELECT c.tenant_id::text, c.id::text,
       ab.winning_variant_id::text,
       COALESCE(ab.sample_pct, 100.0)
  FROM campaigns c
  JOIN campaign_ab_settings ab ON ab.campaign_id = c.id
 WHERE ab.sample_evaluated_at IS NOT NULL
   AND ab.winner_dispatched_at IS NULL
   AND ab.winning_variant_id  IS NOT NULL
   AND COALESCE(ab.sample_pct, 100.0) < 100
 ORDER BY ab.sample_evaluated_at ASC
 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]dueRollout, 0, limit)
	for rows.Next() {
		var r dueRollout
		if err := rows.Scan(&r.TenantID, &r.CampaignID, &r.WinningVariantID, &r.SamplePct); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (d *RolloutDispatcher) dispatchOne(ctx context.Context, r dueRollout) error {
	childID, err := d.Creator.CreateRollout(ctx, RolloutInput{
		TenantID:         r.TenantID,
		ParentCampaignID: r.CampaignID,
		WinningVariantID: r.WinningVariantID,
		SamplePct:        r.SamplePct,
	})
	if err != nil {
		// Don't stamp winner_dispatched_at on failure — the next
		// tick will retry. Operators see the warn log; if the
		// failure is permanent (e.g. parent campaign deleted),
		// they can manually mark it dispatched.
		return err
	}
	if err := d.Repo.MarkWinnerDispatched(ctx, r.TenantID, r.CampaignID, childID); err != nil {
		return err
	}
	d.log().Info("abtests rollout: queued winner to held-back audience",
		"tenant", r.TenantID,
		"parent_campaign", r.CampaignID,
		"rollout_campaign", childID,
		"winning_variant", r.WinningVariantID,
		"sample_pct", r.SamplePct)
	return nil
}

func (d *RolloutDispatcher) log() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

// ErrRolloutCreatorNotConfigured is returned by MarkWinnerDispatched
// when called on a row whose dispatcher isn't fully wired. Tests rely
// on this sentinel to assert the precondition is checked.
var ErrRolloutCreatorNotConfigured = errors.New("abtests: rollout creator not configured")
