package zerocopy_triggers

import (
	"testing"
	"time"
)

// The alert thresholds (consecutive failures / lag / fires-per-tick) were
// stored and served over HTTP, but no evaluator ever compared a tick's outcome
// against them — so a zero-copy warehouse trigger could fail forever and no
// alert could fire. This is that evaluator's decision core.
func TestEvaluateAlert(t *testing.T) {
	base := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)
	cfg := AlertConfig{
		ConsecutiveFailuresThreshold: 3,
		LagSecondsThreshold:          600,
		FiresPerTickThreshold:        1000,
		CooldownSeconds:              300,
	}

	t.Run("nothing fires when every metric is under threshold", func(t *testing.T) {
		kind, _ := EvaluateAlert(cfg, TickOutcome{ConsecutiveFailures: 2, LagSeconds: 100, FiresThisTick: 10}, base)
		if kind != AlertKindNone {
			t.Fatalf("kind = %q, want none", kind)
		}
	})

	t.Run("consecutive failures at threshold fires", func(t *testing.T) {
		kind, msg := EvaluateAlert(cfg, TickOutcome{ConsecutiveFailures: 3}, base)
		if kind != AlertKindFailures {
			t.Fatalf("kind = %q, want failures", kind)
		}
		if msg == "" {
			t.Error("a fired alert must carry an operator message")
		}
	})

	t.Run("lag over threshold fires", func(t *testing.T) {
		kind, _ := EvaluateAlert(cfg, TickOutcome{LagSeconds: 601}, base)
		if kind != AlertKindLag {
			t.Fatalf("kind = %q, want lag", kind)
		}
	})

	t.Run("a fires burst fires", func(t *testing.T) {
		kind, _ := EvaluateAlert(cfg, TickOutcome{FiresThisTick: 5000}, base)
		if kind != AlertKindFiresBurst {
			t.Fatalf("kind = %q, want fires_burst", kind)
		}
	})

	t.Run("cooldown suppresses a re-fire", func(t *testing.T) {
		recent := base.Add(-1 * time.Minute) // 60s ago, cooldown is 300s
		c := cfg
		c.LastAlertFiredAt = &recent
		kind, _ := EvaluateAlert(c, TickOutcome{ConsecutiveFailures: 9}, base)
		if kind != AlertKindNone {
			t.Fatalf("within cooldown must stay silent, got %q", kind)
		}
	})

	t.Run("past the cooldown it fires again", func(t *testing.T) {
		old := base.Add(-10 * time.Minute)
		c := cfg
		c.LastAlertFiredAt = &old
		kind, _ := EvaluateAlert(c, TickOutcome{ConsecutiveFailures: 9}, base)
		if kind != AlertKindFailures {
			t.Fatalf("past cooldown must fire, got %q", kind)
		}
	})

	t.Run("a zero threshold disables that metric", func(t *testing.T) {
		c := AlertConfig{ConsecutiveFailuresThreshold: 0, LagSecondsThreshold: 0, FiresPerTickThreshold: 0}
		kind, _ := EvaluateAlert(c, TickOutcome{ConsecutiveFailures: 999, LagSeconds: 99999, FiresThisTick: 99999}, base)
		if kind != AlertKindNone {
			t.Fatalf("all-zero thresholds disable alerting, got %q", kind)
		}
	})
}
