package zerocopy_triggers

// evaluator.go — the alert evaluator the alerts scaffolding was missing.
//
// external_warehouse_trigger_alerts stored per-trigger thresholds (consecutive
// failures, replication lag, fires-per-tick) and the HTTP handlers let operators
// configure them, but NOTHING ever compared a tick's outcome against them. So a
// zero-copy warehouse trigger could fail on every run indefinitely and no alert
// could ever fire. This closes that: EvaluateAlert is the pure decision, and
// EvaluateAndMaybeAlert wires it to notification + last-fired bookkeeping.

import (
	"context"
	"fmt"
	"time"
)

// TickOutcome is what one RecordTick produced, in the terms the thresholds are
// expressed in.
type TickOutcome struct {
	// ConsecutiveFailures is the current failure streak for this trigger.
	ConsecutiveFailures int
	// LagSeconds is how far behind the source cursor this trigger is.
	LagSeconds int
	// FiresThisTick is how many downstream flow_runs this tick enqueued.
	FiresThisTick int
}

// EvaluateAlert decides whether a tick's outcome should raise an alert, honoring
// the per-metric thresholds and the cooldown. A zero threshold disables that
// metric. Failures take precedence over lag over bursts (most-actionable
// first). Pure and deterministic — the DB/notification live in the caller.
func EvaluateAlert(cfg AlertConfig, tick TickOutcome, now time.Time) (AlertKind, string) {
	// Cooldown: do not re-alert until CooldownSeconds after the last fire.
	if cfg.LastAlertFiredAt != nil && cfg.CooldownSeconds > 0 {
		if now.Sub(*cfg.LastAlertFiredAt) < time.Duration(cfg.CooldownSeconds)*time.Second {
			return AlertKindNone, ""
		}
	}

	if cfg.ConsecutiveFailuresThreshold > 0 && tick.ConsecutiveFailures >= cfg.ConsecutiveFailuresThreshold {
		return AlertKindFailures, fmt.Sprintf(
			"zero-copy trigger has failed %d times in a row (threshold %d)",
			tick.ConsecutiveFailures, cfg.ConsecutiveFailuresThreshold)
	}
	if cfg.LagSecondsThreshold > 0 && tick.LagSeconds >= cfg.LagSecondsThreshold {
		return AlertKindLag, fmt.Sprintf(
			"zero-copy trigger is %ds behind the source cursor (threshold %ds)",
			tick.LagSeconds, cfg.LagSecondsThreshold)
	}
	if cfg.FiresPerTickThreshold > 0 && tick.FiresThisTick >= cfg.FiresPerTickThreshold {
		return AlertKindFiresBurst, fmt.Sprintf(
			"zero-copy trigger enqueued %d flow runs in one tick (threshold %d) — possible runaway",
			tick.FiresThisTick, cfg.FiresPerTickThreshold)
	}
	return AlertKindNone, ""
}

// AlertNotifier dispatches a fired alert. The production implementation posts to
// AlertConfig.NotifyWebhookURL; tests pass a fake.
type AlertNotifier interface {
	Notify(ctx context.Context, webhookURL string, kind AlertKind, message string) error
}

// EvaluateAndMaybeAlert loads the trigger's alert config, evaluates the tick,
// and — when an alert is due — notifies and records the fire (so the cooldown
// and last_alert_* fields advance). No-op when no alert config exists for the
// trigger. Best-effort notification: a webhook failure still records the fire so
// the cooldown holds and we don't hammer a broken endpoint.
func EvaluateAndMaybeAlert(
	ctx context.Context,
	alerts *AlertRepo,
	notifier AlertNotifier,
	tenantID, triggerID string,
	tick TickOutcome,
	now time.Time,
) error {
	if !zeroCopyRuntimeQualified() {
		return ErrZeroCopyRuntimeUnavailable
	}
	if alerts == nil {
		return nil
	}
	cfg, err := alerts.Get(ctx, tenantID, triggerID)
	if err != nil {
		if err == ErrNotFound {
			return nil // no thresholds configured for this trigger
		}
		return err
	}
	kind, msg := EvaluateAlert(*cfg, tick, now)
	if kind == AlertKindNone {
		return nil
	}
	if notifier != nil && cfg.NotifyWebhookURL != "" {
		_ = notifier.Notify(ctx, cfg.NotifyWebhookURL, kind, msg)
	}
	return alerts.RecordFired(ctx, tenantID, triggerID, kind, msg, now)
}
