// SPDX-License-Identifier: AGPL-3.0-only
//
// deletion_worker.go — async fulfillment worker for account_deletion
// privacy requests. The intake handler only writes status='queued';
// this worker is what flips eligible rows to status='fulfilled' after:
//
//   1. identity verification has happened (verified_at IS NOT NULL),
//   2. no legal hold is active (legal_hold = false), and
//   3. every recorded subprocessor ack row for the request is either
//      'acknowledged' or 'not_applicable' (none 'pending' or 'failed').
//
// The worker is cross-tenant on purpose (uses the app.outbox_worker
// GUC bypass already established by OverdueWorker). Each tick is
// idempotent: an eligible row is updated to fulfilled in a single
// UPDATE...RETURNING and audit_log gets a privacy.deletion_fulfilled
// row written from the audit-trimmer path (system actor).
//
// For subject-scoped erasure (subject_type IN ('subscriber','consumer')
// AND subject_email IS NOT NULL) the worker now ALSO runs the
// anonymization SQL (see erasure.go) inside the same transaction so
// the privacy_requests status update and the PII erasure commit or
// roll back together. While erasureHistoryCoverageComplete is false,
// that call returns ErrErasureCoverageIncomplete before any write and the
// worker leaves the request unfulfilled for a later compliant retry. For
// tenant-admin requests without a subject_email
// the worker keeps writing the "ready_to_purge" marker; full-tenant
// deletion is still operator-driven because its blast radius spans
// every subscriber row.

package privacy

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// buildFulfillmentJSON returns the JSONB blob merged into
// privacy_requests.fulfillment and audit_log.metadata for the row.
// erasureRan=false → ready_to_purge marker the operator script
// reconciles; erasureRan=true → counts of rows the worker erased.
func buildFulfillmentJSON(now time.Time, erasureRan bool, stats eraseStats) []byte {
	payload := map[string]any{
		"mode":         "async_worker",
		"fulfilled_at": now.UTC().Format("2006-01-02T15:04:05Z"),
	}
	if erasureRan {
		payload["erasure"] = map[string]any{
			"subscribers_anonymized":               stats.SubscribersAnonymized,
			"subscriber_events_anonymized":         stats.SubscriberEventsAnonymized,
			"consent_receipts_anonymized":          stats.ConsentReceiptsAnonymized,
			"sequence_funnel_events_anonymized":    stats.SequenceFunnelAnonymized,
			"sequence_enrollments_anonymized":      stats.SequenceEnrollmentsAnonymized,
			"frequency_cap_events_deleted":         stats.FrequencyCapEventsDeleted,
			"subscriber_send_log_deleted":          stats.SubscriberSendLogDeleted,
			"intelligent_retry_events_deleted":     stats.IntelligentRetryEventsDeleted,
			"subscriber_notes_deleted":             stats.SubscriberNotesDeleted,
			"suppressions_affected":                stats.SuppressionsAffected,
			"webhook_simulator_receipts_shredded":  stats.PlaygroundReceiptsShredded,
			"conversion_identity_receipt_id":       stats.ConversionIdentityReceiptID,
			"conversions_identity_redacted":        stats.ConversionsIdentityRedacted,
			"conversion_identity_touches_shredded": stats.ConversionIdentityTouches,
			"conversion_campaign_links_severed":    stats.ConversionCampaignLinks,
			"conversion_click_bindings_deleted":    stats.ConversionClickBindings,
			"total_rows":                           stats.total(),
		}
		payload["ready_to_purge"] = false
	} else {
		payload["ready_to_purge"] = true
	}
	out, _ := json.Marshal(payload)
	return out
}

// DeletionFulfillmentWorker periodically promotes eligible
// account_deletion privacy_requests rows to status='fulfilled'.
type DeletionFulfillmentWorker struct {
	Pool       *db.Pool
	Interval   time.Duration
	Logger     *slog.Logger
	Now        func() time.Time
	TagHistory TagHistoryRedactor
}

// TagHistoryRedactor records subject-erasure redaction rows for tag
// history in the same transaction as the privacy fulfillment.
type TagHistoryRedactor interface {
	EmitErasureRedaction(ctx context.Context, tx pgx.Tx, tenantID, subjectEmail string) error
}

// Run blocks until ctx is cancelled.
func (w *DeletionFulfillmentWorker) Run(ctx context.Context) {
	if w == nil || w.Pool == nil {
		return
	}
	if w.Interval <= 0 {
		w.Interval = 1 * time.Minute
	}
	w.tick(ctx)
	t := time.NewTicker(w.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			w.tick(ctx)
		}
	}
}

func (w *DeletionFulfillmentWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	return time.Now().UTC()
}

// bindDeletionTenant re-establishes the tenant GUC before touching any
// subject-scoped table. The worker discovers requests cross-tenant, but the
// subscriber and sequence tables deliberately do not grant cross-tenant
// worker writes; each erasure must therefore execute under the row's tenant
// boundary even though it remains in the worker's outer transaction.
func bindDeletionTenant(ctx context.Context, tx erasureExecutor, tenantID string) error {
	_, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID)
	return err
}

func (w *DeletionFulfillmentWorker) tick(ctx context.Context) {
	tx, err := w.Pool.Begin(ctx)
	if err != nil {
		w.warn("begin", err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		w.warn("set_config", err)
		return
	}
	now := w.now()
	// Eligibility: account_deletion in_progress + verified + no hold +
	// no pending/failed subprocessor ack rows. The
	// "NOT EXISTS pending/failed" subquery matches the spec: at least
	// one explicit ack must be present, otherwise the request stays
	// in_progress for the operator to record acks before fulfillment.
	//
	// We SELECT eligible rows (with subject_type + subject_email so
	// the erasure step can scope itself) rather than UPDATE-RETURNING
	// in one shot — the per-row erasure runs inside the same tx but
	// has to mutate other tables, so it sequences naturally as
	// SELECT → erase → UPDATE-marker per row.
	rows, err := tx.Query(ctx, `
SELECT pr.id,
       pr.tenant_id::text,
       COALESCE(pr.subject_type, ''),
       COALESCE(pr.subject_email::text, '')
  FROM privacy_requests pr
 WHERE pr.request_type = 'account_deletion'
   AND pr.subject_type <> 'account_user'
   AND pr.status = 'in_progress'
   AND pr.legal_hold = false
   AND pr.verified_at IS NOT NULL
   AND EXISTS (
       SELECT 1 FROM privacy_request_subprocessor_acks acks
        WHERE acks.tenant_id = pr.tenant_id
          AND acks.request_id = pr.id
   )
   AND NOT EXISTS (
       SELECT 1 FROM privacy_request_subprocessor_acks acks
        WHERE acks.tenant_id = pr.tenant_id
          AND acks.request_id = pr.id
          AND acks.status IN ('pending', 'failed')
   )`,
	)
	if err != nil {
		w.warn("select_eligible", err)
		return
	}
	type eligibleRow struct {
		id, tenantID, subjectType, subjectEmail string
	}
	var queue []eligibleRow
	for rows.Next() {
		var e eligibleRow
		if err := rows.Scan(&e.id, &e.tenantID, &e.subjectType, &e.subjectEmail); err != nil {
			rows.Close()
			w.warn("scan_eligible", err)
			return
		}
		queue = append(queue, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		w.warn("rows_eligible", err)
		return
	}

	fulfilled := 0
	for _, e := range queue {
		if err := bindDeletionTenant(ctx, tx, e.tenantID); err != nil {
			w.warn("bind_tenant", err)
			return
		}
		// Subject-scoped erasure: only run for subscriber/consumer. The erasure
		// entry point is deliberately fail-closed while retained-history coverage
		// is incomplete, so an error here prevents both the marker and audit row.
		// requests with a known subject_email. Tenant-admin requests
		// without a subject_email are marked fulfilled+ready_to_purge
		// so the operator script picks them up (their blast radius
		// is the entire tenant subscriber set; out of scope here).
		var stats eraseStats
		shouldErase := e.subjectEmail != "" && (e.subjectType == "subscriber" || e.subjectType == "consumer")
		if shouldErase {
			s, err := eraseSubscriberData(ctx, tx, e.tenantID, e.subjectEmail)
			if err != nil {
				w.warn("erase", err)
				return
			}
			if w.TagHistory != nil {
				if err := w.TagHistory.EmitErasureRedaction(ctx, tx, e.tenantID, e.subjectEmail); err != nil {
					w.warn("tag_history_redaction", err)
					return
				}
			}
			stats = s
		}

		fulfillment := buildFulfillmentJSON(now, shouldErase, stats)
		if _, err := tx.Exec(ctx, `
UPDATE privacy_requests
   SET status = 'fulfilled',
       completed_at = $1,
       fulfillment = COALESCE(fulfillment, '{}'::jsonb) || $2::jsonb,
       updated_at = now()
 WHERE id = $3 AND tenant_id = $4::uuid`,
			now, fulfillment, e.id, e.tenantID,
		); err != nil {
			w.warn("update_marker", err)
			return
		}
		// Audit per-row inside the same tx; the tenant_id GUC isn't
		// set in this cross-tenant tx, so we write the audit row via
		// a direct INSERT that respects the audit_log policies set up
		// for system actors.
		if _, err := tx.Exec(ctx, `
INSERT INTO audit_log (tenant_id, actor_type, action, resource_type, resource_id, metadata)
VALUES ($1::uuid, 'system', 'privacy.deletion_fulfilled', 'privacy_request', $2, $3::jsonb)`,
			e.tenantID, e.id, fulfillment,
		); err != nil {
			w.warn("audit_insert", err)
			return
		}
		fulfilled++
	}
	if err := tx.Commit(ctx); err != nil {
		w.warn("commit", err)
		return
	}
	if fulfilled > 0 && w.Logger != nil {
		w.Logger.Info("privacy deletion fulfillment", "fulfilled", fulfilled)
	}
}

func (w *DeletionFulfillmentWorker) warn(stage string, err error) {
	if w.Logger != nil {
		w.Logger.Warn("privacy deletion worker", "stage", stage, "err", err.Error())
	}
}
