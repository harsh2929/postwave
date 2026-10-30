package commerce

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

type Worker struct {
	Repo     *Repo
	Logger   *slog.Logger
	Interval time.Duration
	Now      func() time.Time
	Limit    int
	// Events, when set, turns eligible back-in-stock / price-drop subscriptions
	// into per-subscriber product_events that drive automation flows. Without it
	// the worker still evaluates eligibility but no one is notified (the prior
	// behaviour). Inject a track.Repo (with FlowRuns) here.
	Events LifecycleEventEmitter
}

func (w *Worker) Run(ctx context.Context) error {
	if w == nil || w.Repo == nil {
		return errors.New("commerce lifecycle worker: missing repo")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	if w.Logger != nil {
		w.Logger.Info("commerce lifecycle worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("commerce lifecycle tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.BackInStockEligible > 0 || summary.PriceDropEligible > 0 || summary.Notified > 0) {
			w.Logger.Info("commerce lifecycle tick complete",
				"targets", summary.Targets,
				"back_in_stock_eligible", summary.BackInStockEligible,
				"price_drop_eligible", summary.PriceDropEligible,
				"notified", summary.Notified)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

type lifecycleWorkerSummary struct {
	Targets             int
	BackInStockEligible int
	PriceDropEligible   int
	Notified            int
}

func (w *Worker) tick(ctx context.Context) (lifecycleWorkerSummary, error) {
	targets, err := w.Repo.ListLifecycleEvaluationTargets(ctx, w.Limit)
	if err != nil {
		return lifecycleWorkerSummary{}, err
	}
	summary := lifecycleWorkerSummary{Targets: len(targets)}
	now := time.Now().UTC()
	if w.Now != nil {
		now = w.Now().UTC()
	}
	for _, target := range targets {
		out, err := w.Repo.EvaluateLifecycleTriggers(ctx, target.TenantID, target.IntegrationID, now)
		if err != nil {
			if w.Logger != nil {
				w.Logger.Warn("commerce lifecycle evaluation failed",
					"tenant", target.TenantID,
					"integration", target.IntegrationID,
					"err", err.Error())
			}
			continue
		}
		summary.BackInStockEligible += out.BackInStockEligible
		summary.PriceDropEligible += out.PriceDropEligible
		summary.Notified += w.notifyEligible(ctx, target, now)
	}
	return summary, nil
}

// notifyEligible claims newly-eligible subscriptions and emits a product_event
// per subscriber so the matching automation flow fires. No-op without an emitter.
func (w *Worker) notifyEligible(ctx context.Context, target LifecycleEvaluationTarget, now time.Time) int {
	if w.Events == nil {
		return 0
	}
	claimed, err := w.Repo.ClaimEligibleLifecycleNotifications(ctx, target.TenantID, target.IntegrationID, now, w.Limit)
	if err != nil {
		if w.Logger != nil {
			w.Logger.Warn("commerce lifecycle notify claim failed",
				"tenant", target.TenantID, "integration", target.IntegrationID, "err", err.Error())
		}
		return 0
	}
	emitted, emitErr := emitLifecycleNotifications(ctx, w.Events, target.TenantID, now, claimed)
	if emitErr != nil && w.Logger != nil {
		w.Logger.Warn("commerce lifecycle notify emit partial",
			"tenant", target.TenantID, "integration", target.IntegrationID,
			"claimed", len(claimed), "emitted", emitted, "err", emitErr.Error())
	}
	return emitted
}
