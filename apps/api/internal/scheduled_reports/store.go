// SPDX-License-Identifier: AGPL-3.0-only
package scheduled_reports

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Store owns the tenant-scoped request-path mutations for durable report
// runs. Cross-tenant worker discovery lives in worker.go and every subsequent
// mutation is constrained by both tenant_id and the frozen run identity.
type Store struct {
	Pool *db.Pool
}

func (s *Store) QueueManualRun(
	ctx context.Context,
	tenantID, reportID, idempotencyKey string,
) (SendNowResult, error) {
	var zero SendNowResult
	idempotencyKey, err := normalizeIdempotencyKey(idempotencyKey)
	if err != nil {
		return zero, err
	}
	if s == nil || s.Pool == nil {
		return zero, errors.New("scheduled_reports: missing store pool")
	}
	if _, err := uuid.Parse(tenantID); err != nil {
		return zero, ErrReportNotFound
	}
	reportUUID, err := uuid.Parse(strings.TrimSpace(reportID))
	if err != nil {
		return zero, ErrReportNotFound
	}

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return zero, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	keyHash := manualRunKeyHash(tenantID, idempotencyKey)
	err = tx.QueryRow(ctx, `
SELECT
    id::text,
    scheduled_report_id_snapshot::text,
    occurrence_at,
    created_at
  FROM scheduled_report_runs
 WHERE tenant_id = $1::uuid
   AND scheduled_report_id_snapshot = $2::uuid
   AND run_kind = 'manual'
   AND idempotency_key_hash = $3`,
		tenantID,
		reportUUID.String(),
		keyHash,
	).Scan(
		&zero.RunID,
		&zero.ScheduledReportID,
		&zero.OccurrenceAt,
		&zero.CreatedAt,
	)
	if err == nil {
		if err := tx.Commit(ctx); err != nil {
			return SendNowResult{}, err
		}
		zero.RunKind = "manual"
		zero.Status = "queued"
		return zero, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return zero, err
	}

	var (
		name, template, schedule, timezone string
		recipients                         []string
	)
	err = tx.QueryRow(ctx, `
SELECT name, template, schedule, timezone, recipients
  FROM scheduled_reports
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
 FOR SHARE`,
		tenantID, reportUUID.String(),
	).Scan(&name, &template, &schedule, &timezone, &recipients)
	if errors.Is(err, pgx.ErrNoRows) {
		return zero, ErrReportNotFound
	}
	if err != nil {
		return zero, err
	}

	name, err = normalizeReportName(name)
	if err != nil {
		return zero, ErrReportConfigInvalid
	}
	if len(schedule) == 0 || len(schedule) > maxScheduleBytes {
		return zero, ErrReportConfigInvalid
	}
	timezone, _, err = normalizeTimezone(timezone)
	if err != nil {
		return zero, ErrReportConfigInvalid
	}
	if _, err := computeNextDue(schedule, timezone, nowUTC()); err != nil {
		return zero, ErrReportConfigInvalid
	}
	switch template {
	case "engagement_summary", "deliverability", "growth":
	default:
		return zero, ErrReportConfigInvalid
	}
	recipients, err = normalizeRecipients(recipients)
	if err != nil {
		return zero, ErrReportConfigInvalid
	}

	created := false
	err = tx.QueryRow(ctx, `
INSERT INTO scheduled_report_runs (
    tenant_id,
    scheduled_report_id,
    scheduled_report_id_snapshot,
    run_kind,
    occurrence_at,
    idempotency_key_hash,
    report_name_snapshot,
    template_snapshot,
    schedule_snapshot,
    timezone_snapshot
)
VALUES (
    $1::uuid,
    $2::uuid,
    $2::uuid,
    'manual',
    now(),
    $3,
    $4,
    $5,
    $6,
    $7
)
ON CONFLICT DO NOTHING
RETURNING
    id::text,
    scheduled_report_id_snapshot::text,
    occurrence_at,
    created_at`,
		tenantID,
		reportUUID.String(),
		keyHash,
		name,
		template,
		schedule,
		timezone,
	).Scan(
		&zero.RunID,
		&zero.ScheduledReportID,
		&zero.OccurrenceAt,
		&zero.CreatedAt,
	)
	switch {
	case err == nil:
		created = true
	case errors.Is(err, pgx.ErrNoRows):
		// ON CONFLICT may have waited for another request to commit. This is
		// a second statement under READ COMMITTED, so it sees that row.
		err = tx.QueryRow(ctx, `
SELECT
    id::text,
    scheduled_report_id_snapshot::text,
    occurrence_at,
    created_at
  FROM scheduled_report_runs
 WHERE tenant_id = $1::uuid
   AND scheduled_report_id_snapshot = $2::uuid
   AND run_kind = 'manual'
   AND idempotency_key_hash = $3`,
			tenantID,
			reportUUID.String(),
			keyHash,
		).Scan(
			&zero.RunID,
			&zero.ScheduledReportID,
			&zero.OccurrenceAt,
			&zero.CreatedAt,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return SendNowResult{}, errors.New("scheduled_reports: idempotent run disappeared")
		}
		if err != nil {
			return SendNowResult{}, err
		}
	default:
		return SendNowResult{}, err
	}

	if created {
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
				tenantID,
				zero.RunID,
				recipient,
				recipientHash(tenantID, recipient),
				ordinal,
			)
		}
		results := tx.SendBatch(ctx, batch)
		for range recipients {
			if _, err := results.Exec(); err != nil {
				_ = results.Close()
				return SendNowResult{}, fmt.Errorf("create manual delivery snapshot: %w", err)
			}
		}
		if err := results.Close(); err != nil {
			return SendNowResult{}, fmt.Errorf("close manual delivery snapshot batch: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return SendNowResult{}, err
	}
	zero.RunKind = "manual"
	// Queue acceptance is the frozen HTTP response. The live run state is
	// intentionally not returned here because an idempotent retry must not
	// change bytes merely because the worker advanced meanwhile.
	zero.Status = "queued"
	return zero, nil
}
