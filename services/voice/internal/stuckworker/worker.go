// Package stuckworker is the periodic stuck-participant scanner
// (FEATURE-ROADMAP-2026-06 "stuck-participant alerts").
//
// Each tick it enumerates sequences with stuck detection enabled
// (voice_sequences.stuck_after_days >= 1, migration 0395) across all
// tenants under db.WithWorkerScope — the same app.outbox_worker GUC +
// permissive worker-select RLS policy pattern the feed-ingest scheduler
// uses. Every per-tenant read after enumeration re-binds app.tenant_id
// (SequenceGetter / ActivityLister are the same tenant-scoped stores
// the HTTP handlers use), so RLS stays in force for all data access.
//
// When a sequence has stuck participants, the worker emits ONE
// `sequence.participants.stuck` webhook.fanout outbox row for the
// tenant. That is a real notification channel: apps/api's gateway
// worker already expands webhook.fanout outbox rows into per-
// subscription webhook deliveries (Slack/desktop/etc. subscribe there).
// The alert payload carries the same item shape as
// GET /v1/voice/sequences/{id}/stuck, capped to the worst offenders.
//
// Re-alerting: the worker is stateless — a sequence with a non-empty
// stuck set re-alerts every scan (default interval 24h, override via
// POSTWAVE_VOICE_STUCK_SCAN_INTERVAL). Webhook consumers that need
// once-per-participant semantics should de-dup on (sequence_id,
// subscriber_id); an alert-state table was deliberately not added.
package stuckworker

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	runtimedb "github.com/postwave/postwave/packages/runtime/db"
	"github.com/postwave/postwave/services/voice/internal/generation"
	"github.com/postwave/postwave/services/voice/internal/handlers"
)

// EventType is the webhook.fanout event_type the scanner emits.
const EventType = "sequence.participants.stuck"

// alertMaxItems caps the per-sequence items embedded in one alert so a
// huge cohort can't produce a megabyte outbox payload. The full list
// stays available via GET /sequences/{id}/stuck (capped at 500 there).
const alertMaxItems = 20

// DefaultInterval is the scan cadence when Worker.Interval is unset.
// Thresholds are whole days, so a daily sweep loses no fidelity.
const DefaultInterval = 24 * time.Hour

// SequenceGetter is the narrow slice of handlers.SequenceStore the
// scanner needs (tenant-scoped read of one sequence).
type SequenceGetter interface {
	Get(ctx context.Context, tenantID, id string) (generation.Sequence, error)
}

// Worker scans for stuck participants and emits fanout alerts.
type Worker struct {
	// Pool is used ONLY for the cross-tenant enumeration tick (worker
	// scope). All per-sequence reads go through Sequences / Activity.
	Pool      *pgxpool.Pool
	Sequences SequenceGetter
	Activity  handlers.SequenceActivityStore
	Emitter   handlers.FanoutEmitter
	Logger    *slog.Logger
	// Interval between scans; DefaultInterval when <= 0.
	Interval time.Duration
	// Now is injectable for tests; time.Now when nil.
	Now func() time.Time
}

// Run scans once immediately, then on every interval tick until ctx is
// cancelled. Returns ctx.Err() on cancellation; scan errors are logged
// and never abort the loop.
func (w *Worker) Run(ctx context.Context) error {
	interval := w.Interval
	if interval <= 0 {
		interval = DefaultInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		w.scan(ctx)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// scan runs one full sweep: enumerate enabled sequences cross-tenant,
// then evaluate + alert per sequence. Per-sequence failures are logged
// and skipped so one bad tenant can't starve the rest of the sweep.
func (w *Worker) scan(ctx context.Context) {
	refs, err := w.enumerate(ctx)
	if err != nil {
		w.logger().Warn("stuckworker: enumerate sequences", "err", err.Error())
		return
	}
	alerts := 0
	for _, ref := range refs {
		if ctx.Err() != nil {
			return
		}
		alerted, err := w.ScanSequence(ctx, ref.tenantID, ref.sequenceID)
		if err != nil {
			w.logger().Warn("stuckworker: scan sequence",
				"tenant_id", ref.tenantID, "sequence_id", ref.sequenceID, "err", err.Error())
			continue
		}
		if alerted {
			alerts++
		}
	}
	w.logger().Info("stuckworker: sweep complete", "sequences", len(refs), "alerts", alerts)
}

type sequenceRef struct {
	tenantID   string
	sequenceID string
}

// enumerate lists (tenant, sequence) pairs with stuck detection enabled
// under worker scope. Archived sequences are skipped — they no longer
// send, so "stuck" is meaningless noise for them.
func (w *Worker) enumerate(ctx context.Context) ([]sequenceRef, error) {
	if w.Pool == nil {
		return nil, fmt.Errorf("stuckworker: nil pool")
	}
	tx, err := runtimedb.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT tenant_id::text, id::text
		  FROM voice_sequences
		 WHERE stuck_after_days >= 1
		   AND status <> 'archived'
		 ORDER BY tenant_id, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []sequenceRef{}
	for rows.Next() {
		var ref sequenceRef
		if err := rows.Scan(&ref.tenantID, &ref.sequenceID); err != nil {
			return nil, err
		}
		out = append(out, ref)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Read-only tick: rollback is fine, but commit keeps pgbouncer
	// bookkeeping tidy and mirrors the feed-ingest scheduler.
	return out, tx.Commit(ctx)
}

// ScanSequence evaluates one sequence and emits an alert when it has
// stuck participants. Exported (and Pool-free) so tests exercise the
// evaluation + alert shape with fake stores. Returns whether an alert
// was emitted.
func (w *Worker) ScanSequence(ctx context.Context, tenantID, sequenceID string) (bool, error) {
	if w.Sequences == nil || w.Activity == nil || w.Emitter == nil {
		return false, fmt.Errorf("stuckworker: sequences/activity/emitter not wired")
	}
	seq, err := w.Sequences.Get(ctx, tenantID, sequenceID)
	if err != nil {
		return false, fmt.Errorf("get sequence: %w", err)
	}
	if seq.StuckAfterDays < 1 {
		return false, nil // disabled between enumeration and scan
	}
	rows, err := w.Activity.ListActivity(ctx, tenantID, sequenceID)
	if err != nil {
		return false, fmt.Errorf("list activity: %w", err)
	}
	now := time.Now().UTC()
	if w.Now != nil {
		now = w.Now()
	}
	items := handlers.EvaluateStuck(rows, seq.StuckAfterDays, handlers.SequenceEmailStepCount(seq), seq.Goal, now)
	if len(items) == 0 {
		return false, nil
	}
	body := map[string]any{
		"sequence_id":    seq.ID,
		"sequence_name":  seq.Name,
		"threshold_days": seq.StuckAfterDays,
		"stuck_count":    len(items),
		// items is sorted most-idle first by EvaluateStuck; the alert
		// carries the worst offenders only.
		"items": items[:min(len(items), alertMaxItems)],
	}
	if err := w.Emitter.Emit(ctx, tenantID, EventType, body); err != nil {
		return false, fmt.Errorf("emit alert: %w", err)
	}
	return true, nil
}

func (w *Worker) logger() *slog.Logger {
	if w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}
