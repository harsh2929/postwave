// SPDX-License-Identifier: AGPL-3.0-only

package retention

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/intelligent_retry"
)

const (
	// Frequency rules accept windows up to 720 hours. The send ledger must
	// retain that full lookback even when a malformed privacy reader supplies a
	// smaller value.
	minSendingIdentityRetentionDays = 720 / 24

	// This is the enforced upper bound of email_event_retention_days in the
	// privacy settings contract and database constraint. Clamping again at the
	// destructive boundary prevents a corrupt/custom reader from turning a
	// bounded lifecycle into indefinite retention.
	maxSendingIdentityRetentionDays = 2555

	subscriberSendLogDataClass       = "subscriber_send_log"
	intelligentRetryEventsDataClass  = "intelligent_retry_events"
	sendingIdentityRetentionSource   = "email_event_retention_days"
	sendingIdentityLegalHoldPolicy   = "campaign_assurance_legal_hold_active"
	sendingIdentityPurgeActorLabel   = "sending-identity-retention-sweeper"
	sendingIdentityPurgeResourceType = "retention_policy"
)

func (s *Sweeper) sendingIdentityRetentionDays(ctx context.Context, tenantID string) (int, error) {
	if s == nil || s.Privacy == nil {
		return 0, errors.New("retention: privacy policy reader is required for sending identity")
	}
	days, err := s.Privacy.EmailEventRetentionDays(ctx, tenantID)
	if err != nil {
		return 0, fmt.Errorf("retention: read sending identity window: %w", err)
	}
	if days < minSendingIdentityRetentionDays {
		days = minSendingIdentityRetentionDays
	}
	if days > maxSendingIdentityRetentionDays {
		days = maxSendingIdentityRetentionDays
	}
	return days, nil
}

// lockSendingIdentityLegalHoldFence serializes each destructive batch with
// placement/release of a campaign-assurance legal hold. Migration 2013's hold
// trigger and the assurance raw-output sweeper use this exact (legacy-named)
// tenant lock key. Taking it before the DELETE means a hold committed first is
// visible to the DELETE statement's READ COMMITTED snapshot; a hold that starts
// second cannot claim it preceded an already-committed purge.
func lockSendingIdentityLegalHoldFence(ctx context.Context, tx pgx.Tx, tenantID string) error {
	_, err := tx.Exec(ctx, `
SELECT pg_advisory_xact_lock(
    hashtextextended('campaign-assurance-raw-output:' || $1::uuid::text, 0)
)`, tenantID)
	if err != nil {
		return fmt.Errorf("lock sending identity legal-hold fence: %w", err)
	}
	return nil
}

// writeSendingIdentityPurgeReceipt appends one content-free aggregate receipt
// in the same transaction as its bounded DELETE. audit.retention.purge is the
// repository's permanent retention action: the audit trimmer explicitly
// excludes it, so the proof cannot age out with ordinary audit rows.
//
// This intentionally writes the canonical audit row directly rather than
// routing the metadata through tenant-configurable PII redaction. Counts and
// policy cutoffs are the proof itself and contain no subject identity. Any
// insert failure aborts the surrounding delete transaction (fail closed).
func writeSendingIdentityPurgeReceipt(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, dataClass string,
	retentionDays int,
	cutoffAt, oldestDeletedAt, newestDeletedAt time.Time,
	deletedCount int64,
) error {
	if deletedCount <= 0 {
		return nil
	}
	metadata, err := json.Marshal(map[string]any{
		"data_class":           dataClass,
		"deleted_count":        deletedCount,
		"retention_days":       retentionDays,
		"cutoff_at":            cutoffAt.UTC().Format(time.RFC3339Nano),
		"oldest_deleted_at":    oldestDeletedAt.UTC().Format(time.RFC3339Nano),
		"newest_deleted_at":    newestDeletedAt.UTC().Format(time.RFC3339Nano),
		"retention_source":     sendingIdentityRetentionSource,
		"legal_hold_predicate": sendingIdentityLegalHoldPolicy,
	})
	if err != nil {
		return fmt.Errorf("marshal sending identity purge receipt: %w", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.audit_internal_writer', 'true', true)`); err != nil {
		return fmt.Errorf("authorize sending identity purge receipt: %w", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO audit_log
    (tenant_id, action, resource_type, resource_id, metadata, actor_type, actor_label)
VALUES
    ($1::uuid, $2, $3, $4, $5::jsonb, 'system', $6)`,
		tenantID, audit.PurgeAction, sendingIdentityPurgeResourceType,
		dataClass, string(metadata), sendingIdentityPurgeActorLabel); err != nil {
		return fmt.Errorf("insert sending identity purge receipt: %w", err)
	}
	return nil
}

// sweepSubscriberSendLog removes plaintext queue-admission history only after
// the tenant's email-event window. The privacy setting cannot be shorter than
// the longest supported frequency-cap window, so no enforceable send history
// is removed early. Active tenant/campaign legal holds suspend eligible rows;
// every committed batch has a permanent aggregate audit receipt.
func (s *Sweeper) sweepSubscriberSendLog(ctx context.Context, tenantID string, days int) (int64, error) {
	var total int64
	for i := 0; i < s.maxBatchesPerTenant(); i++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		tx, err := db.WithTenant(ctx, s.Pool, tenantID)
		if err != nil {
			return total, err
		}
		if err := lockSendingIdentityLegalHoldFence(ctx, tx, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			return total, err
		}
		var (
			n               int64
			cutoffAt        time.Time
			oldestDeletedAt *time.Time
			newestDeletedAt *time.Time
		)
		err = tx.QueryRow(ctx, `
WITH policy AS (
    SELECT statement_timestamp() - make_interval(days => $2::int) AS cutoff_at
), victims AS (
    SELECT candidate.ctid
      FROM subscriber_send_log AS candidate
     WHERE candidate.tenant_id = $1::uuid
       AND candidate.sent_at < (SELECT cutoff_at FROM policy)
       AND NOT campaign_assurance_legal_hold_active(
               candidate.tenant_id, candidate.campaign_id
           )
     ORDER BY candidate.sent_at, candidate.id
     LIMIT $3
     FOR UPDATE SKIP LOCKED
), deleted AS (
    DELETE FROM subscriber_send_log AS send_log
     WHERE send_log.ctid IN (SELECT ctid FROM victims)
    RETURNING send_log.sent_at
)
SELECT count(*)::bigint, min(sent_at), max(sent_at),
       (SELECT cutoff_at FROM policy)
  FROM deleted`, tenantID, days, s.batchSize()).Scan(
			&n, &oldestDeletedAt, &newestDeletedAt, &cutoffAt,
		)
		if err != nil {
			_ = tx.Rollback(ctx)
			return total, fmt.Errorf("delete expired subscriber send log: %w", err)
		}
		if n > 0 {
			if oldestDeletedAt == nil || newestDeletedAt == nil {
				_ = tx.Rollback(ctx)
				return total, errors.New("delete expired subscriber send log: missing aggregate timestamp")
			}
			if err := writeSendingIdentityPurgeReceipt(
				ctx, tx, tenantID, subscriberSendLogDataClass, days,
				cutoffAt, *oldestDeletedAt, *newestDeletedAt, n,
			); err != nil {
				_ = tx.Rollback(ctx)
				return total, err
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return total, fmt.Errorf("commit subscriber send log sweep: %w", err)
		}
		total += n
		if n == 0 {
			break
		}
	}
	return total, nil
}

// sweepIntelligentRetryEvents removes retry state after the same reviewed
// email-event window. A row currently owned by a live retry worker survives;
// once its exact lease expires, it is eligible like every other old status.
// created_at, not updated_at, is the privacy deadline so hourly deferrals
// cannot extend retention forever. Active tenant/campaign legal holds suspend
// eligible rows; every committed batch has a permanent aggregate audit receipt.
func (s *Sweeper) sweepIntelligentRetryEvents(ctx context.Context, tenantID string, days int) (int64, error) {
	var total int64
	leaseSeconds := int64(intelligent_retry.RetryClaimLeaseDuration / time.Second)
	for i := 0; i < s.maxBatchesPerTenant(); i++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		tx, err := db.WithTenant(ctx, s.Pool, tenantID)
		if err != nil {
			return total, err
		}
		if err := lockSendingIdentityLegalHoldFence(ctx, tx, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			return total, err
		}
		var (
			n               int64
			cutoffAt        time.Time
			oldestDeletedAt *time.Time
			newestDeletedAt *time.Time
		)
		err = tx.QueryRow(ctx, `
WITH policy AS (
    SELECT statement_timestamp() - make_interval(days => $2::int) AS cutoff_at
), victims AS (
    SELECT candidate.ctid
      FROM intelligent_retry_events AS candidate
     WHERE candidate.tenant_id = $1::uuid
       AND candidate.created_at < (SELECT cutoff_at FROM policy)
       AND (
            candidate.status <> 'retrying'
            OR candidate.updated_at < statement_timestamp() - ($3::bigint * interval '1 second')
       )
       AND NOT campaign_assurance_legal_hold_active(
               candidate.tenant_id, candidate.campaign_id
           )
     ORDER BY candidate.created_at, candidate.id
     LIMIT $4
     FOR UPDATE SKIP LOCKED
), deleted AS (
    DELETE FROM intelligent_retry_events AS retry
     WHERE retry.ctid IN (SELECT ctid FROM victims)
    RETURNING retry.created_at
)
SELECT count(*)::bigint, min(created_at), max(created_at),
       (SELECT cutoff_at FROM policy)
  FROM deleted`, tenantID, days, leaseSeconds, s.batchSize()).Scan(
			&n, &oldestDeletedAt, &newestDeletedAt, &cutoffAt,
		)
		if err != nil {
			_ = tx.Rollback(ctx)
			return total, fmt.Errorf("delete expired intelligent retry events: %w", err)
		}
		if n > 0 {
			if oldestDeletedAt == nil || newestDeletedAt == nil {
				_ = tx.Rollback(ctx)
				return total, errors.New("delete expired intelligent retry events: missing aggregate timestamp")
			}
			if err := writeSendingIdentityPurgeReceipt(
				ctx, tx, tenantID, intelligentRetryEventsDataClass, days,
				cutoffAt, *oldestDeletedAt, *newestDeletedAt, n,
			); err != nil {
				_ = tx.Rollback(ctx)
				return total, err
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return total, fmt.Errorf("commit intelligent retry event sweep: %w", err)
		}
		total += n
		if n == 0 {
			break
		}
	}
	return total, nil
}
