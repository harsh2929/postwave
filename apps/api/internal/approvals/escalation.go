// SPDX-License-Identifier: AGPL-3.0-only
//
// escalation.go — background sweeper that watches for pending
// approvals that have been sitting longer than the tenant's
// configured `escalate_after_hours` and:
//
//   1. Stamps approvals.escalated_at so subsequent ticks skip the row.
//   2. Emits "approval.escalated" on the event bus so downstream
//      subscribers (notifier → email/Slack to owner role) fire.
//
// Cadence: every 2 min. Cheap — single indexed query per tick
// against approvals_pending_escalation_idx (partial).

package approvals

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// EscalationSweeper runs the escalation tick. Wired in main.go.
type EscalationSweeper struct {
	Pool    *db.Pool
	Emitter EventEmitter // reuses approvals' existing emitter interface
	Logger  *slog.Logger
	// Interval defaults to 2 min when zero.
	Interval time.Duration
	// Notifier delivers each escalation to the people who can act on it.
	// Optional: nil means the column is still stamped and the bus event still
	// emitted, which is the pre-existing behaviour.
	Notifier EscalationNotifier
}

// Run blocks until ctx is cancelled. Each tick is best-effort.
func (s *EscalationSweeper) Run(ctx context.Context) {
	if s == nil || s.Pool == nil {
		return
	}
	interval := s.Interval
	if interval <= 0 {
		interval = 2 * time.Minute
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tick(ctx)
		}
	}
}

// tick — single pass. Stamps + emits for any matching rows. The
// SQL uses RETURNING so we get the (tenant_id, id) pairs without a
// follow-up SELECT.
func (s *EscalationSweeper) tick(ctx context.Context) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		s.log().Warn("approvals escalation: begin tx failed", "err", err.Error())
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		s.log().Warn("approvals escalation: set worker bypass failed", "err", err.Error())
		return
	}
	rows, err := tx.Query(ctx, `
UPDATE approvals a
   SET escalated_at = now()
  FROM approval_escalation_policies p
 WHERE a.tenant_id = p.tenant_id
   AND p.escalate_after_hours IS NOT NULL
   AND a.status = 'pending'
   AND a.escalated_at IS NULL
   AND a.requested_at + (p.escalate_after_hours * interval '1 hour') <= now()
RETURNING a.tenant_id::text, a.id::text, COALESCE(p.notify_owners, true)`)
	if err != nil {
		s.log().Warn("approvals escalation: query failed", "err", err.Error())
		return
	}
	var escalated []escalatedApproval
	for rows.Next() {
		var e escalatedApproval
		if err := rows.Scan(&e.TenantID, &e.ID, &e.NotifyOwners); err != nil {
			rows.Close()
			s.log().Warn("approvals escalation: scan failed", "err", err.Error())
			return
		}
		escalated = append(escalated, e)
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		s.log().Warn("approvals escalation: commit failed", "err", err.Error())
		return
	}
	s.announce(ctx, escalated)
}

func (s *EscalationSweeper) log() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

// escalatedApproval is one approval the sweeper just stamped.
type escalatedApproval struct {
	TenantID, ID string
	NotifyOwners bool
}

// EscalationNotice is what a delivery consumer needs to reach the people who
// should act.
type EscalationNotice struct {
	TenantID   string
	ApprovalID string
}

// EscalationNotifier delivers an escalation to the humans who can resolve it.
//
// Introduced because there was no such consumer. The sweeper emitted
// "approval.escalated" on the event bus and a repo-wide grep found the emitter,
// a doc comment and one comment in main.go — nothing subscribed. An escalation
// policy an operator configured ("chase this after 8 hours") fired, updated a
// column, and reached nobody: the approval sat exactly as unattended as before
// while the record said it had been escalated.
type EscalationNotifier interface {
	NotifyEscalated(ctx context.Context, n EscalationNotice)
}

// announce delivers the escalations this tick produced.
//
// Separated from the sweep so the delivery decision is testable without a
// database — the sweep's own correctness is a DB concern, and whether an
// escalation reaches anyone is not.
//
// `notify_owners` is honoured here. It is a real column on
// `approval_escalation_policies` that the sweeper already read and used for
// nothing but a log line, so a tenant who turned it off must not start
// receiving pushes because a consumer finally exists.
func (s *EscalationSweeper) announce(ctx context.Context, escalated []escalatedApproval) {
	for _, e := range escalated {
		s.log().Info("approval escalated",
			"tenant_id", e.TenantID, "approval_id", e.ID,
			"notify_owners", e.NotifyOwners)
		if s.Emitter != nil {
			s.Emitter.Emit(e.TenantID, "approval.escalated", map[string]any{
				"id":            e.ID,
				"notify_owners": e.NotifyOwners,
			})
		}
		if !e.NotifyOwners || s.Notifier == nil {
			continue
		}
		s.Notifier.NotifyEscalated(ctx, EscalationNotice{TenantID: e.TenantID, ApprovalID: e.ID})
	}
}
