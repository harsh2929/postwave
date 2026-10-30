// SPDX-License-Identifier: AGPL-3.0-only
//
// CampaignRescheduler implementation for send-time-optimization. This is the
// piece that closes the loop on POST /api/v1/campaigns/{id}/schedule-by-best-time:
// the handler computes a []send_time_opt.Schedule from per-subscriber
// best_send_hour and hands the slice to RescheduleByBestTime, which persists
// the per-recipient timestamps into campaign_recipient_send_at (the
// materialized table shipped in migration 0319_psto_send_window.sql).
//
// Without this rescheduler the endpoint was a no-op preview: it returned a
// recipient count and a sample, but nothing reached the dispatch loop. The
// desktop toast "Scheduled N recipients" was misleading. With it wired in,
// the per-recipient timestamps are persisted in a single tenant-scoped tx,
// audit-logged, and become consultable by the existing PSTO drain loop
// (campaign_recipient_send_at_due_idx). This matches the persistence model
// used by Klaviyo Personalized Send Time, Braze Intelligent Timing, and
// Iterable STO.
//
// Contract notes:
//   - Implements send_time_opt.CampaignRescheduler — signature kept narrow
//     so the send_time_opt package stays testable without campaigns.
//   - Single tx: ALL inserts succeed or NONE do. Klaviyo-style partial
//     materialization is explicitly NOT desired — a half-written schedule
//     would dispatch the campaign at the wrong times for half the audience.
//   - ON CONFLICT (campaign_id, subscriber_email) DO UPDATE — a re-schedule
//     overrides the previous schedule rather than creating duplicates.
//   - Audit row "campaign.schedule_by_best_time" with the recipient count
//     and the time horizon, so operators can answer "who rescheduled this
//     campaign last week?" from audit_log.
//   - 0-length schedule is a no-op (no rows touched, no audit row) — the
//     handler still returns 200 because the empty audience case is
//     intentional, but we don't want phantom audit rows.

package campaigns

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/send_time_opt"
)

// CampaignsRescheduler implements send_time_opt.CampaignRescheduler. Construct
// with a *db.Pool from main.go and hand to send_time_opt.Deps.Campaigns.
type CampaignsRescheduler struct {
	Pool *db.Pool
}

// rescheduleBatchSize bounds a single VALUES tuple count to keep the
// prepared statement under PG's 65535 bind-parameter ceiling. Each
// row binds 4 params (tenant_id, campaign_id, email, send_at), so
// 8000 rows = 32000 binds — well under the cap with room for the
// CTE binds too. At 4 rows-per-stmt this lets us reschedule the
// CampaignRecipientLoadHardCap (50000) audience in a handful of
// batched INSERTs inside the same tx.
const rescheduleBatchSize = 8000

// ErrCampaignNotFound is returned when the (tenant, campaign) tuple does not
// resolve to a row. Distinct from generic SQL errors so the HTTP handler can
// translate it to 404. The send_time_opt handler funnels everything through
// errEnv("reschedule_failed", ...) — this error is reserved for the case
// where the campaign vanished between the recipient-load and the persist
// (delete race), which is rare but possible.
var ErrCampaignNotFound = errors.New("campaigns: campaign not found")

// RescheduleByBestTime persists each (email, send_at) tuple into
// campaign_recipient_send_at under tenant scope. The schedule slice is
// what send_time_opt.ScheduleByBestTime returned; rows are flushed in
// batches inside a single tx so the dispatch loop never sees a partial
// schedule.
//
// Empty schedule → no-op, returns nil. The caller has already issued the
// 200 response and an empty audience produces no rows.
func (c *CampaignsRescheduler) RescheduleByBestTime(
	ctx context.Context,
	tenantID, campaignID string,
	schedule []send_time_opt.Schedule,
) error {
	if c == nil || c.Pool == nil {
		return errors.New("campaigns: CampaignsRescheduler.Pool is nil")
	}
	if tenantID == "" {
		return errors.New("campaigns: RescheduleByBestTime requires tenant id")
	}
	if campaignID == "" {
		return errors.New("campaigns: RescheduleByBestTime requires campaign id")
	}
	if len(schedule) == 0 {
		return nil
	}

	tx, err := db.WithTenant(ctx, c.Pool, tenantID)
	if err != nil {
		return fmt.Errorf("campaigns: open tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Confirm the campaign exists for this tenant. The send_time_opt
	// handler already validated this before computing the schedule, but
	// between then and now an operator may have deleted the campaign —
	// if we silently INSERT against a non-existent campaign id the FK
	// in 0262 would fail mid-batch and leak a half-written audit row.
	// Tx-internal check closes that window.
	var exists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM campaigns
     WHERE id::text = $1 AND tenant_id = $2::uuid
)`, campaignID, tenantID).Scan(&exists); err != nil {
		return fmt.Errorf("campaigns: probe campaign: %w", err)
	}
	if !exists {
		return ErrCampaignNotFound
	}

	// Flush in batches of rescheduleBatchSize. ON CONFLICT updates the
	// scheduled_send_at so a re-run of /schedule-by-best-time replaces
	// the prior schedule (idempotent from the operator's POV).
	for i := 0; i < len(schedule); i += rescheduleBatchSize {
		end := i + rescheduleBatchSize
		if end > len(schedule) {
			end = len(schedule)
		}
		if err := flushBatch(ctx, tx, tenantID, campaignID, schedule[i:end]); err != nil {
			return err
		}
	}

	// Audit. Resource_id = campaign id so the audit reader can pivot on
	// campaign. Metadata carries the count and a sample window so the
	// row is self-contained.
	first := schedule[0].SendAt
	last := schedule[len(schedule)-1].SendAt
	if last.Before(first) {
		first, last = last, first
	}
	if err := db.Audit(ctx, tx,
		db.AuditMeta{TenantID: tenantID, ActorType: "system", ActorLabel: "sto-rescheduler"},
		"campaign.schedule_by_best_time",
		"campaign", campaignID,
		map[string]any{
			"recipient_count": len(schedule),
			"window_start":    first.UTC().Format(time.RFC3339),
			"window_end":      last.UTC().Format(time.RFC3339),
		},
	); err != nil {
		// Audit failure does not unwind the schedule — same posture as
		// every other call site in the codebase, where db.Audit failures
		// are not load-bearing for the user-facing action. We still log
		// up the chain by returning a wrapped error so the caller can
		// surface 500 if it wants to.
		return fmt.Errorf("campaigns: audit reschedule: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("campaigns: commit reschedule: %w", err)
	}
	return nil
}

// flushBatch inserts up to rescheduleBatchSize (email, send_at) rows in a
// single multi-row INSERT...VALUES with ON CONFLICT DO UPDATE. The same
// tx must already have app.tenant_id set via db.WithTenant.
func flushBatch(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, campaignID string,
	batch []send_time_opt.Schedule,
) error {
	if len(batch) == 0 {
		return nil
	}
	// Build VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz), ($5,..., $8), ...
	var b strings.Builder
	b.WriteString(`
INSERT INTO campaign_recipient_send_at
    (tenant_id, campaign_id, subscriber_email, scheduled_send_at)
VALUES `)
	args := make([]any, 0, len(batch)*4)
	for i, s := range batch {
		if i > 0 {
			b.WriteString(", ")
		}
		base := i * 4
		fmt.Fprintf(&b, "($%d::uuid, $%d::uuid, $%d, $%d::timestamptz)",
			base+1, base+2, base+3, base+4)
		args = append(args, tenantID, campaignID, strings.ToLower(s.Email), s.SendAt.UTC())
	}
	b.WriteString(`
ON CONFLICT (campaign_id, subscriber_email) DO UPDATE
   SET scheduled_send_at = EXCLUDED.scheduled_send_at`)
	if _, err := tx.Exec(ctx, b.String(), args...); err != nil {
		return fmt.Errorf("campaigns: persist schedule batch: %w", err)
	}
	return nil
}
