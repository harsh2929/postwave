// SPDX-License-Identifier: AGPL-3.0-only
//
// worker.go materializes each recurring occurrence into a durable run before
// any report rendering or network delivery begins. A committed per-recipient
// `sending` receipt is the irreversible boundary: if a process dies after
// crossing it, recovery records `unknown` and never blindly sends again.

package scheduled_reports

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// MailSender is intentionally narrow for compatibility with the platform
// mailer. A nil error means the provider adapter confirmed acceptance. A
// RejectedError proves non-acceptance. Every other error is ambiguous.
type MailSender interface {
	Send(ctx context.Context, to, subject, body string) error
}

// Worker is safe to run concurrently in every API replica.
type Worker struct {
	Pool     *db.Pool
	Logger   *slog.Logger
	Interval time.Duration
	Mailer   MailSender

	OwnerID    string
	LeaseTTL   time.Duration
	BatchSize  int
	SendWindow time.Duration

	// tenantFilter is used only by isolated database tests/maintenance. The
	// production worker leaves it empty and discovers all tenants under the
	// explicit outbox-worker RLS policy.
	tenantFilter string
}

type runSnapshot struct {
	ID                string
	TenantID          string
	ScheduledReportID *string
	RunKind           string
	OccurrenceAt      time.Time
	Name              string
	Template          string
	Schedule          string
	Timezone          string
	Subject           *string
	Body              *string
}

type deliverySnapshot struct {
	ID        string
	Recipient string
}

type ReportMetrics struct {
	Sent         int64 `json:"sent"`
	Opened       int64 `json:"opened"`
	Clicked      int64 `json:"clicked"`
	Bounced      int64 `json:"bounced"`
	Unsubscribed int64 `json:"unsubscribed"`
	NewSubs      int64 `json:"new_subscribers"`
}

type RenderedReport struct {
	PeriodStart time.Time
	PeriodEnd   time.Time
	Metrics     ReportMetrics
	Subject     string
	Body        string
}

func (w *Worker) defaults() {
	if strings.TrimSpace(w.OwnerID) == "" {
		w.OwnerID = uuid.NewString()
	}
	if w.LeaseTTL <= 0 {
		w.LeaseTTL = defaultRunLeaseTTL
	}
	if w.BatchSize <= 0 {
		w.BatchSize = defaultWorkerBatchSize
	}
	if w.BatchSize > 128 {
		w.BatchSize = 128
	}
	if w.SendWindow <= 0 {
		w.SendWindow = defaultDeliverySendWindow
	}
	// A delivery call must finish comfortably before its lease can expire.
	if w.SendWindow >= w.LeaseTTL {
		w.SendWindow = w.LeaseTTL / 2
	}
	if w.SendWindow <= 0 {
		w.SendWindow = time.Second
	}
}

// Run blocks until ctx is canceled.
func (w *Worker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return errors.New("scheduled_reports worker: missing pool")
	}
	w.defaults()
	interval := w.Interval
	if interval <= 0 {
		interval = 60 * time.Second
	}
	if w.Logger != nil {
		w.Logger.Info("scheduled_reports worker starting",
			"interval", interval.String())
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := w.tick(ctx); err != nil && !errors.Is(err, context.Canceled) &&
			w.Logger != nil {
			// Raw database/provider errors may contain customer data. The
			// durable run/receipt stores bounded operator-safe diagnostics.
			w.Logger.Warn("scheduled_reports tick failed", "code", "tick_failed")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// tick performs only bounded work. More backlog is picked up immediately on
// the next configured tick; occurrence uniqueness makes duplicate scans safe.
func (w *Worker) tick(ctx context.Context) error {
	w.defaults()
	if _, err := w.recoverAmbiguousDeliveries(ctx); err != nil {
		return err
	}
	if _, err := w.purgeExpiredRuns(ctx); err != nil {
		return err
	}
	if _, err := w.materializeDue(ctx); err != nil {
		return err
	}
	// Claim each run immediately before processing it. Claiming a whole
	// sequential batch would let later leases age while earlier reports wait
	// on provider calls, causing avoidable takeovers and duplicate rendering.
	for processed := 0; processed < w.BatchSize; processed++ {
		runs, err := w.claimRunsLimit(ctx, 1)
		if err != nil {
			return err
		}
		if len(runs) == 0 {
			break
		}
		run := runs[0]
		if err := w.processRun(ctx, run); err != nil && w.Logger != nil {
			w.Logger.Warn("scheduled report run processing failed",
				"run_id", run.ID,
				"code", "run_processing_failed")
		}
	}
	return nil
}

type dueSchedule struct {
	ID         string
	TenantID   string
	Name       string
	Template   string
	Schedule   string
	Timezone   string
	Recipients []string
	DueAt      time.Time
}

// materializeDue atomically creates occurrence snapshots and moves each
// recurring cursor from the prior scheduled instant—not from worker wall
// clock—so polling jitter and replica timing cannot drift the cadence.
func (w *Worker) materializeDue(ctx context.Context) (int, error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT
    id::text,
    tenant_id::text,
    name,
    template,
    schedule,
    timezone,
    recipients,
    delivery_next_due_at
  FROM scheduled_reports
 WHERE enabled = true
   AND delivery_next_due_at IS NOT NULL
   AND delivery_next_due_at <= now()
   AND ($2 = '' OR tenant_id::text = $2)
 ORDER BY delivery_next_due_at, tenant_id, id
 LIMIT $1
 FOR UPDATE SKIP LOCKED`, w.BatchSize, w.tenantFilter)
	if err != nil {
		return 0, err
	}
	due := make([]dueSchedule, 0, w.BatchSize)
	for rows.Next() {
		var item dueSchedule
		if err := rows.Scan(
			&item.ID,
			&item.TenantID,
			&item.Name,
			&item.Template,
			&item.Schedule,
			&item.Timezone,
			&item.Recipients,
			&item.DueAt,
		); err != nil {
			rows.Close()
			return 0, err
		}
		due = append(due, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()

	materialized := 0
	for _, item := range due {
		nextDue, scheduleErr := computeNextDue(
			item.Schedule,
			item.Timezone,
			item.DueAt,
		)
		name, nameErr := normalizeReportName(item.Name)
		recipients, recipientErr := normalizeRecipients(item.Recipients)
		timezone, _, timezoneErr := normalizeTimezone(item.Timezone)
		templateOK := item.Template == "engagement_summary" ||
			item.Template == "deliverability" ||
			item.Template == "growth"
		configValid := scheduleErr == nil &&
			nameErr == nil &&
			recipientErr == nil &&
			timezoneErr == nil &&
			templateOK

		if nameErr != nil {
			name = "Scheduled report"
		}
		if timezoneErr != nil {
			timezone = safeTimezoneSnapshot(item.Timezone)
		}
		scheduleSnapshot := boundedDiagnostic(item.Schedule, maxScheduleBytes)
		if scheduleSnapshot == "" {
			scheduleSnapshot = "invalid"
		}

		status := "queued"
		var completedAt any
		var errorCode any
		var errorSummary any
		if !configValid {
			status = "failed"
			completedAt = nowUTC()
			errorCode = "report_configuration_invalid"
			errorSummary = "The recurring definition was disabled because its stored configuration is invalid."
		}

		var runID string
		err := tx.QueryRow(ctx, `
INSERT INTO scheduled_report_runs (
    tenant_id,
    scheduled_report_id,
    scheduled_report_id_snapshot,
    run_kind,
    occurrence_at,
    report_name_snapshot,
    template_snapshot,
    schedule_snapshot,
    timezone_snapshot,
    status,
    completed_at,
    last_error_code,
    last_error_summary
)
VALUES (
    $1::uuid,
    $2::uuid,
    $2::uuid,
    'recurring',
    $3,
    $4,
    $5,
    $6,
    $7,
    $8,
    $9,
    $10,
    $11
)
ON CONFLICT DO NOTHING
RETURNING id::text`,
			item.TenantID,
			item.ID,
			item.DueAt,
			name,
			safeTemplateSnapshot(item.Template),
			scheduleSnapshot,
			timezone,
			status,
			completedAt,
			errorCode,
			errorSummary,
		).Scan(&runID)
		created := err == nil
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return 0, err
		}

		if created && configValid {
			batch := &pgx.Batch{}
			for ordinal, recipient := range recipients {
				batch.Queue(`
INSERT INTO scheduled_report_delivery_receipts (
    tenant_id,
    run_id,
    recipient,
    recipient_hash,
    recipient_ordinal
)
VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
					item.TenantID,
					runID,
					recipient,
					recipientHash(item.TenantID, recipient),
					ordinal,
				)
			}
			results := tx.SendBatch(ctx, batch)
			for range recipients {
				if _, err := results.Exec(); err != nil {
					_ = results.Close()
					return 0, err
				}
			}
			if err := results.Close(); err != nil {
				return 0, err
			}
		}

		if configValid {
			if _, err := tx.Exec(ctx, `
UPDATE scheduled_reports
   SET delivery_next_due_at = $1,
       updated_at = now()
 WHERE tenant_id = $2::uuid
   AND id = $3::uuid
   AND delivery_next_due_at = $4`,
				nextDue,
				item.TenantID,
				item.ID,
				item.DueAt,
			); err != nil {
				return 0, err
			}
		} else {
			if _, err := tx.Exec(ctx, `
UPDATE scheduled_reports
   SET enabled = false,
       delivery_next_due_at = NULL,
       last_run_at = now(),
       last_run_error =
           'The recurring definition was disabled because its stored configuration is invalid.',
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
				item.TenantID,
				item.ID,
			); err != nil {
				return 0, err
			}
		}
		if created {
			materialized++
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return materialized, nil
}

func safeTemplateSnapshot(value string) string {
	value = boundedDiagnostic(value, 64)
	if value == "" {
		return "invalid"
	}
	return value
}

func safeTimezoneSnapshot(value string) string {
	value = boundedDiagnostic(value, 64)
	if value == "" || strings.IndexFunc(value, func(r rune) bool {
		return r < 0x20 || r == 0x7f
	}) >= 0 {
		return "invalid"
	}
	return value
}

func leaseSeconds(ttl time.Duration) int {
	seconds := int(ttl / time.Second)
	if seconds < 1 {
		return 1
	}
	return seconds
}

// recoverAmbiguousDeliveries is deliberately not a retry operation. Once a
// sending lease expires, the provider may already have accepted the email.
func (w *Worker) recoverAmbiguousDeliveries(ctx context.Context) (int, error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
WITH expired AS (
    SELECT id
      FROM scheduled_report_delivery_receipts
     WHERE state = 'sending'
       AND lease_expires_at <= now()
       AND ($2 = '' OR tenant_id::text = $2)
     ORDER BY lease_expires_at, id
     LIMIT $1
     FOR UPDATE SKIP LOCKED
)
UPDATE scheduled_report_delivery_receipts AS receipts
   SET state = 'unknown',
       lease_owner = NULL,
       lease_expires_at = NULL,
       error_code = 'worker_crash_outcome_unknown',
       error_summary =
           'Provider acceptance could not be confirmed after the delivery lease expired. No automatic retry will occur.',
       completed_at = now(),
       updated_at = now()
  FROM expired
 WHERE receipts.id = expired.id
RETURNING receipts.tenant_id::text, receipts.run_id::text`,
		w.BatchSize*maxScheduledRecipients,
		w.tenantFilter,
	)
	if err != nil {
		return 0, err
	}
	type runIdentity struct {
		tenantID string
		runID    string
	}
	identities := map[runIdentity]struct{}{}
	count := 0
	for rows.Next() {
		var identity runIdentity
		if err := rows.Scan(&identity.tenantID, &identity.runID); err != nil {
			rows.Close()
			return 0, err
		}
		identities[identity] = struct{}{}
		count++
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}

	for identity := range identities {
		if err := w.finalizeRun(ctx, identity.tenantID, identity.runID); err != nil {
			return count, err
		}
	}
	return count, nil
}

// purgeExpiredRuns enforces the schema's 90-day evidence window. Recipient
// addresses, rendered body, and metric snapshots disappear together because
// delivery receipts cascade from their run.
func (w *Worker) purgeExpiredRuns(ctx context.Context) (int64, error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
WITH expired AS (
    SELECT id
      FROM scheduled_report_runs
     WHERE status IN ('succeeded', 'partial', 'failed', 'needs_review')
       AND retention_until <= now()
       AND ($1 = '' OR tenant_id::text = $1)
     ORDER BY retention_until, id
     LIMIT $2
     FOR UPDATE SKIP LOCKED
)
DELETE FROM scheduled_report_runs AS runs
 USING expired
 WHERE runs.id = expired.id`,
		w.tenantFilter,
		w.BatchSize,
	)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (w *Worker) claimRuns(ctx context.Context) ([]runSnapshot, error) {
	w.defaults()
	return w.claimRunsLimit(ctx, w.BatchSize)
}

func (w *Worker) claimRunsLimit(
	ctx context.Context,
	limit int,
) ([]runSnapshot, error) {
	w.defaults()
	if limit <= 0 || limit > w.BatchSize {
		limit = w.BatchSize
	}
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
WITH candidates AS (
    SELECT id
      FROM scheduled_report_runs
     WHERE (
               status = 'queued'
               OR (
                   status IN ('leased', 'delivering')
                   AND lease_expires_at <= now()
               )
           )
       AND ($4 = '' OR tenant_id::text = $4)
     ORDER BY COALESCE(lease_expires_at, created_at), created_at, id
     LIMIT $1
     FOR UPDATE SKIP LOCKED
)
UPDATE scheduled_report_runs AS runs
   SET status = CASE
           WHEN runs.rendered_at IS NULL THEN 'leased'
           ELSE 'delivering'
       END,
       lease_owner = $2,
       lease_expires_at = now() + make_interval(secs => $3),
       attempt_count = runs.attempt_count + 1,
       started_at = COALESCE(runs.started_at, now()),
       updated_at = now()
  FROM candidates
 WHERE runs.id = candidates.id
RETURNING
    runs.id::text,
    runs.tenant_id::text,
    runs.scheduled_report_id::text,
    runs.run_kind,
    runs.occurrence_at,
    runs.report_name_snapshot,
    runs.template_snapshot,
    runs.schedule_snapshot,
    runs.timezone_snapshot,
    runs.subject_snapshot,
    runs.body_snapshot`,
		limit,
		w.OwnerID,
		leaseSeconds(w.LeaseTTL),
		w.tenantFilter,
	)
	if err != nil {
		return nil, err
	}
	runs := make([]runSnapshot, 0, limit)
	for rows.Next() {
		var run runSnapshot
		if err := rows.Scan(
			&run.ID,
			&run.TenantID,
			&run.ScheduledReportID,
			&run.RunKind,
			&run.OccurrenceAt,
			&run.Name,
			&run.Template,
			&run.Schedule,
			&run.Timezone,
			&run.Subject,
			&run.Body,
		); err != nil {
			rows.Close()
			return nil, err
		}
		runs = append(runs, run)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return runs, nil
}

func (w *Worker) processRun(ctx context.Context, run runSnapshot) error {
	subject, body := "", ""
	if run.Subject == nil || run.Body == nil {
		rendered, err := w.RenderReportAt(
			ctx,
			run.TenantID,
			run.Template,
			run.Name,
			run.Schedule,
			run.Timezone,
			run.OccurrenceAt,
		)
		if err != nil {
			return w.failRun(
				ctx,
				run,
				"report_render_failed",
				"The report snapshot could not be rendered. No recipient was contacted.",
			)
		}
		owned, err := w.storeRendered(ctx, run, rendered)
		if err != nil {
			return err
		}
		if !owned {
			return nil
		}
		subject, body = rendered.Subject, rendered.Body
	} else {
		subject, body = *run.Subject, *run.Body
	}

	if w.Mailer == nil {
		return w.failRun(
			ctx,
			run,
			"mailer_unavailable",
			"Scheduled report delivery is not configured. No recipient was contacted.",
		)
	}

	for {
		delivery, ok, err := w.claimNextDelivery(ctx, run)
		if err != nil {
			return err
		}
		if !ok {
			break
		}

		sendCtx, cancel := context.WithTimeout(ctx, w.SendWindow)
		sendErr := w.Mailer.Send(
			sendCtx,
			delivery.Recipient,
			subject,
			body,
		)
		cancel()

		bookkeepingCtx, bookkeepingCancel := context.WithTimeout(
			context.Background(),
			30*time.Second,
		)
		if sendErr == nil {
			err = w.completeDelivery(
				bookkeepingCtx,
				run,
				delivery.ID,
				"accepted",
				"",
				"",
			)
		} else {
			failure := classifyDeliveryFailure(sendErr)
			err = w.completeDelivery(
				bookkeepingCtx,
				run,
				delivery.ID,
				failure.State,
				failure.Code,
				failure.Summary,
			)
		}
		bookkeepingCancel()
		if err != nil {
			// The committed sending receipt intentionally remains in place.
			// Recovery converts it to unknown; never call the provider again.
			return err
		}
	}

	bookkeepingCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return w.finalizeRun(bookkeepingCtx, run.TenantID, run.ID)
}

func (w *Worker) storeRendered(
	ctx context.Context,
	run runSnapshot,
	rendered RenderedReport,
) (bool, error) {
	metrics, err := json.Marshal(rendered.Metrics)
	if err != nil {
		return false, err
	}
	tx, err := db.WithTenant(ctx, w.Pool, run.TenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE scheduled_report_runs
   SET status = 'delivering',
       period_start_at = $1,
       period_end_at = $2,
       metrics_snapshot = $3::jsonb,
       subject_snapshot = $4,
       body_snapshot = $5,
       rendered_at = now(),
       lease_expires_at = now() + make_interval(secs => $6),
       updated_at = now()
 WHERE tenant_id = $7::uuid
   AND id = $8::uuid
   AND status = 'leased'
   AND lease_owner = $9
   AND rendered_at IS NULL`,
		rendered.PeriodStart,
		rendered.PeriodEnd,
		metrics,
		rendered.Subject,
		rendered.Body,
		leaseSeconds(w.LeaseTTL),
		run.TenantID,
		run.ID,
		w.OwnerID,
	)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func (w *Worker) claimNextDelivery(
	ctx context.Context,
	run runSnapshot,
) (deliverySnapshot, bool, error) {
	var delivery deliverySnapshot
	tx, err := db.WithTenant(ctx, w.Pool, run.TenantID)
	if err != nil {
		return delivery, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Lock and re-confirm the run lease before crossing the committed
	// per-recipient `sending` boundary. Without this lock, another replica
	// could take an expired run between the receipt selection and the lease
	// renewal, leaving two workers believing they may contact the provider.
	var ownsRun bool
	err = tx.QueryRow(ctx, `
SELECT true
  FROM scheduled_report_runs
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status = 'delivering'
   AND lease_owner = $3
   AND lease_expires_at > now()
 FOR UPDATE`,
		run.TenantID,
		run.ID,
		w.OwnerID,
	).Scan(&ownsRun)
	if errors.Is(err, pgx.ErrNoRows) {
		return delivery, false, nil
	}
	if err != nil {
		return delivery, false, err
	}
	err = tx.QueryRow(ctx, `
WITH candidate AS (
    SELECT receipts.id
      FROM scheduled_report_delivery_receipts AS receipts
      JOIN scheduled_report_runs AS runs
        ON runs.tenant_id = receipts.tenant_id
       AND runs.id = receipts.run_id
     WHERE receipts.tenant_id = $1::uuid
       AND receipts.run_id = $2::uuid
       AND receipts.state = 'pending'
       AND runs.status = 'delivering'
       AND runs.lease_owner = $3
       AND runs.lease_expires_at > now()
     ORDER BY receipts.recipient_ordinal, receipts.id
     LIMIT 1
     FOR UPDATE OF receipts SKIP LOCKED
)
UPDATE scheduled_report_delivery_receipts AS receipts
   SET state = 'sending',
       lease_owner = $3,
       lease_expires_at = now() + make_interval(secs => $4),
       attempt_count = 1,
       sending_started_at = now(),
       error_code = NULL,
       error_summary = NULL,
       updated_at = now()
  FROM candidate
 WHERE receipts.id = candidate.id
RETURNING receipts.id::text, receipts.recipient`,
		run.TenantID,
		run.ID,
		w.OwnerID,
		leaseSeconds(w.LeaseTTL),
	).Scan(&delivery.ID, &delivery.Recipient)
	if errors.Is(err, pgx.ErrNoRows) {
		return delivery, false, nil
	}
	if err != nil {
		return delivery, false, err
	}
	tag, err := tx.Exec(ctx, `
UPDATE scheduled_report_runs
   SET lease_expires_at = now() + make_interval(secs => $1),
       updated_at = now()
 WHERE tenant_id = $2::uuid
   AND id = $3::uuid
   AND status = 'delivering'
   AND lease_owner = $4`,
		leaseSeconds(w.LeaseTTL),
		run.TenantID,
		run.ID,
		w.OwnerID,
	)
	if err != nil {
		return delivery, false, err
	}
	if tag.RowsAffected() != 1 {
		return delivery, false, errors.New(
			"scheduled_reports: run lease no longer owned",
		)
	}
	if err := tx.Commit(ctx); err != nil {
		return delivery, false, err
	}
	return delivery, true, nil
}

func (w *Worker) completeDelivery(
	ctx context.Context,
	run runSnapshot,
	deliveryID, state, code, summary string,
) error {
	tx, err := db.WithTenant(ctx, w.Pool, run.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE scheduled_report_delivery_receipts
   SET state = $1,
       lease_owner = NULL,
       lease_expires_at = NULL,
       error_code = NULLIF($2, ''),
       error_summary = NULLIF($3, ''),
       accepted_at = CASE WHEN $1 = 'accepted' THEN now() ELSE NULL END,
       completed_at = now(),
       updated_at = now()
 WHERE tenant_id = $4::uuid
   AND run_id = $5::uuid
   AND id = $6::uuid
   AND state = 'sending'
   AND lease_owner = $7`,
		state,
		boundedDiagnostic(code, maxPersistedErrorCode),
		boundedDiagnostic(summary, maxPersistedErrorBytes),
		run.TenantID,
		run.ID,
		deliveryID,
		w.OwnerID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("scheduled_reports: delivery lease no longer owned")
	}
	return tx.Commit(ctx)
}

func (w *Worker) failRun(
	ctx context.Context,
	run runSnapshot,
	code, summary string,
) error {
	tx, err := db.WithTenant(ctx, w.Pool, run.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Validate ownership before changing any receipt. A stale renderer must
	// not skip pending recipients after a different replica has acquired the
	// expired run lease.
	var ownsRun bool
	err = tx.QueryRow(ctx, `
SELECT true
  FROM scheduled_report_runs
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status IN ('leased', 'delivering')
   AND lease_owner = $3
 FOR UPDATE`,
		run.TenantID,
		run.ID,
		w.OwnerID,
	).Scan(&ownsRun)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("scheduled_reports: run lease no longer owned")
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
UPDATE scheduled_report_delivery_receipts
   SET state = 'skipped',
       error_code = 'run_failed_before_delivery',
       error_summary =
           'The run failed before this recipient was contacted.',
       completed_at = now(),
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND run_id = $2::uuid
   AND state = 'pending'`,
		run.TenantID,
		run.ID,
	); err != nil {
		return err
	}
	var accepted, failed, unknown, sending int
	if err := tx.QueryRow(ctx, `
SELECT
    COUNT(*) FILTER (WHERE state = 'accepted')::integer,
    COUNT(*) FILTER (WHERE state IN ('failed', 'skipped'))::integer,
    COUNT(*) FILTER (WHERE state = 'unknown')::integer,
    COUNT(*) FILTER (WHERE state = 'sending')::integer
  FROM scheduled_report_delivery_receipts
 WHERE tenant_id = $1::uuid
   AND run_id = $2::uuid`,
		run.TenantID,
		run.ID,
	).Scan(&accepted, &failed, &unknown, &sending); err != nil {
		return err
	}
	if sending != 0 {
		return errors.New("scheduled_reports: cannot fail run with active delivery")
	}
	status := "failed"
	finalCode := boundedDiagnostic(code, maxPersistedErrorCode)
	finalSummary := boundedDiagnostic(summary, maxPersistedErrorBytes)
	switch {
	case unknown > 0:
		status = "needs_review"
		finalCode = "provider_outcome_unknown"
		finalSummary = "At least one recipient has an unknown provider outcome. No automatic retry will occur."
	case accepted > 0:
		status = "partial"
		finalCode = "partial_delivery"
		finalSummary = "Some recipients were already accepted before the remaining deliveries were skipped."
	case failed == 0:
		finalCode = "run_failed"
		finalSummary = "The run failed before any recipient delivery was confirmed."
	}
	tag, err := tx.Exec(ctx, `
UPDATE scheduled_report_runs
   SET status = $1,
       lease_owner = NULL,
       lease_expires_at = NULL,
       last_error_code = $2,
       last_error_summary = $3,
       completed_at = now(),
       updated_at = now()
 WHERE tenant_id = $4::uuid
   AND id = $5::uuid
   AND status IN ('leased', 'delivering')
   AND lease_owner = $6`,
		status,
		finalCode,
		finalSummary,
		run.TenantID,
		run.ID,
		w.OwnerID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("scheduled_reports: run lease no longer owned")
	}
	if run.ScheduledReportID != nil {
		if _, err := tx.Exec(ctx, `
UPDATE scheduled_reports
   SET last_run_at = now(),
       last_run_error = $1,
       updated_at = now()
 WHERE tenant_id = $2::uuid
   AND id = $3::uuid`,
			finalSummary,
			run.TenantID,
			*run.ScheduledReportID,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (w *Worker) finalizeRun(ctx context.Context, tenantID, runID string) error {
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		reportID                         *string
		pending, sending                 int
		accepted, failed, unknown, total int
	)
	err = tx.QueryRow(ctx, `
SELECT
    runs.scheduled_report_id::text,
    COUNT(receipts.id) FILTER (WHERE receipts.state = 'pending')::integer,
    COUNT(receipts.id) FILTER (WHERE receipts.state = 'sending')::integer,
    COUNT(receipts.id) FILTER (WHERE receipts.state = 'accepted')::integer,
    COUNT(receipts.id) FILTER (WHERE receipts.state IN ('failed', 'skipped'))::integer,
    COUNT(receipts.id) FILTER (WHERE receipts.state = 'unknown')::integer,
    COUNT(receipts.id)::integer
  FROM scheduled_report_runs AS runs
  LEFT JOIN scheduled_report_delivery_receipts AS receipts
    ON receipts.tenant_id = runs.tenant_id
   AND receipts.run_id = runs.id
 WHERE runs.tenant_id = $1::uuid
   AND runs.id = $2::uuid
 GROUP BY runs.scheduled_report_id`,
		tenantID,
		runID,
	).Scan(
		&reportID,
		&pending,
		&sending,
		&accepted,
		&failed,
		&unknown,
		&total,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if pending > 0 || sending > 0 {
		return nil
	}

	status := "succeeded"
	code, summary := "", ""
	switch {
	case unknown > 0:
		status = "needs_review"
		code = "provider_outcome_unknown"
		summary = "At least one recipient has an unknown provider outcome. No automatic retry will occur."
	case accepted == total && total > 0:
		// succeeded
	case accepted > 0 && failed > 0:
		status = "partial"
		code = "partial_delivery"
		summary = "The report was accepted for some recipients and rejected or skipped for others."
	default:
		status = "failed"
		code = "delivery_failed"
		summary = "No recipient delivery was confirmed."
	}

	tag, err := tx.Exec(ctx, `
UPDATE scheduled_report_runs
   SET status = $1,
       lease_owner = NULL,
       lease_expires_at = NULL,
       last_error_code = NULLIF($2, ''),
       last_error_summary = NULLIF($3, ''),
       completed_at = now(),
       updated_at = now()
 WHERE tenant_id = $4::uuid
   AND id = $5::uuid
   AND status IN ('leased', 'delivering')`,
		status,
		code,
		summary,
		tenantID,
		runID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return nil
	}
	if reportID != nil {
		if _, err := tx.Exec(ctx, `
UPDATE scheduled_reports
   SET last_run_at = now(),
       last_run_error = NULLIF($1, ''),
       updated_at = now()
 WHERE tenant_id = $2::uuid
   AND id = $3::uuid`,
			boundedDiagnostic(summary, maxPersistedErrorBytes),
			tenantID,
			*reportID,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// RenderReport is retained for callers/tests that want a current UTC report.
func (w *Worker) RenderReport(
	ctx context.Context,
	tenantID, template, name string,
) (string, string, error) {
	rendered, err := w.RenderReportAt(
		ctx,
		tenantID,
		template,
		name,
		"weekly:mon@09:00",
		"UTC",
		nowUTC(),
	)
	if err != nil {
		return "", "", err
	}
	return rendered.Subject, rendered.Body, nil
}

// RenderReportAt freezes aggregates to [period_start, occurrence_at). Future
// events and data arriving after the occurrence can never rewrite the email.
func (w *Worker) RenderReportAt(
	ctx context.Context,
	tenantID, template, name, schedule, timezone string,
	occurrenceAt time.Time,
) (RenderedReport, error) {
	var out RenderedReport
	if w == nil || w.Pool == nil {
		return out, errors.New("scheduled_reports: missing pool")
	}
	periodStart, err := reportingPeriodStart(schedule, timezone, occurrenceAt)
	if err != nil {
		return out, err
	}
	out.PeriodStart = periodStart.UTC()
	out.PeriodEnd = occurrenceAt.UTC()

	tx, err := db.WithTenantOptions(
		ctx,
		w.Pool,
		tenantID,
		pgx.TxOptions{
			IsoLevel:   pgx.RepeatableRead,
			AccessMode: pgx.ReadOnly,
		},
	)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	err = tx.QueryRow(ctx, `
SELECT
    COUNT(*) FILTER (WHERE event_type = 'sent'),
    COUNT(*) FILTER (WHERE event_type = 'opened'),
    COUNT(*) FILTER (WHERE event_type = 'clicked'),
    COUNT(*) FILTER (WHERE event_type = 'bounced'),
    COUNT(*) FILTER (WHERE event_type = 'unsubscribed')
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND at >= $2
   AND at < $3`,
		tenantID,
		out.PeriodStart,
		out.PeriodEnd,
	).Scan(
		&out.Metrics.Sent,
		&out.Metrics.Opened,
		&out.Metrics.Clicked,
		&out.Metrics.Bounced,
		&out.Metrics.Unsubscribed,
	)
	if err != nil {
		return RenderedReport{}, err
	}
	err = tx.QueryRow(ctx, `
SELECT COUNT(*)
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND created_at >= $2
   AND created_at < $3`,
		tenantID,
		out.PeriodStart,
		out.PeriodEnd,
	).Scan(&out.Metrics.NewSubs)
	if err != nil {
		return RenderedReport{}, err
	}

	out.Subject = fmt.Sprintf("[Moosewave] %s — report", name)
	var body strings.Builder
	fmt.Fprintf(&body, "Report for %q\n\n", name)
	fmt.Fprintf(
		&body,
		"Period: %s to %s (%s schedule)\n\n",
		out.PeriodStart.Format(time.RFC3339),
		out.PeriodEnd.Format(time.RFC3339),
		timezone,
	)
	fmt.Fprintf(&body, "Sends:           %d\n", out.Metrics.Sent)
	fmt.Fprintf(&body, "Opens:           %d (%.1f%%)\n",
		out.Metrics.Opened, percent(out.Metrics.Opened, out.Metrics.Sent))
	fmt.Fprintf(&body, "Clicks:          %d (%.1f%%)\n",
		out.Metrics.Clicked, percent(out.Metrics.Clicked, out.Metrics.Sent))
	fmt.Fprintf(&body, "Bounces:         %d\n", out.Metrics.Bounced)
	fmt.Fprintf(&body, "Unsubscribes:    %d\n", out.Metrics.Unsubscribed)
	fmt.Fprintf(&body, "New subscribers: %d\n", out.Metrics.NewSubs)
	switch template {
	case "deliverability":
		fmt.Fprintf(&body, "\nDeliverability focus:\n")
		fmt.Fprintf(&body, "Bounce rate: %.2f%%\n",
			percent(out.Metrics.Bounced, out.Metrics.Sent))
		fmt.Fprintf(&body, "Unsubscribes / sends: %.2f%%\n",
			percent(out.Metrics.Unsubscribed, out.Metrics.Sent))
	case "growth":
		fmt.Fprintf(&body, "\nGrowth focus:\n")
		fmt.Fprintf(&body, "New subscribers / unsubscribes: %s\n",
			ratio(out.Metrics.NewSubs, out.Metrics.Unsubscribed))
	}
	fmt.Fprint(&body, "\n— Moosewave\n")
	out.Body = body.String()
	return out, nil
}

func reportingPeriodStart(
	schedule, timezone string,
	end time.Time,
) (time.Time, error) {
	kind, _, ok := strings.Cut(schedule, ":")
	if !ok {
		return time.Time{}, errors.New("invalid schedule format")
	}
	_, location, err := normalizeTimezone(timezone)
	if err != nil {
		return time.Time{}, err
	}
	localEnd := end.In(location)
	switch strings.ToLower(kind) {
	case "weekly":
		return localEnd.AddDate(0, 0, -7).UTC(), nil
	case "monthly":
		return localEnd.AddDate(0, -1, 0).UTC(), nil
	default:
		return time.Time{}, errors.New("unsupported schedule kind")
	}
}

func percent(num, denom int64) float64 {
	if denom <= 0 {
		return 0
	}
	return float64(num) / float64(denom) * 100
}

func ratio(a, b int64) string {
	if b == 0 {
		if a == 0 {
			return "0:0"
		}
		return fmt.Sprintf("%d:0 (no churn)", a)
	}
	return fmt.Sprintf("%.2f:1", float64(a)/float64(b))
}
