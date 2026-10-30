// SPDX-License-Identifier: AGPL-3.0-only

package campaigndelivery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var reconciliationSourcePattern = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,95}$`)

// SweepExpiredDispatching is tenant-bound and deliberately never requeues an
// ambiguous provider call. It only makes the unknown outcome explicit.
func (r *Repo) SweepExpiredDispatching(ctx context.Context, tenantID string, limit int) ([]Attempt, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if _, err := uuid.Parse(strings.TrimSpace(tenantID)); err != nil {
		return nil, fmt.Errorf("%w: invalid tenant_id", ErrInvalidInput)
	}
	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	tx, err := db.WithTenantWorker(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
WITH expired AS (
    SELECT id AS expired_id FROM campaign_send_deliveries
     WHERE tenant_id = $1::uuid AND state = 'dispatching'
       AND lease_expires_at <= statement_timestamp()
     ORDER BY lease_expires_at, id
     FOR UPDATE SKIP LOCKED
     LIMIT $2
)
UPDATE campaign_send_deliveries AS deliveries
   SET state = 'indeterminate', lease_owner = NULL, lease_expires_at = NULL,
       failure_disposition = 'indeterminate',
       failure_code = 'DISPATCH_LEASE_EXPIRED',
       indeterminate_at = clock_timestamp(), updated_at = clock_timestamp()
  FROM expired
 WHERE deliveries.id = expired.expired_id
RETURNING `+attemptColumns, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	attempts := make([]Attempt, 0)
	for rows.Next() {
		attempt, scanErr := scanAttempt(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		attempts = append(attempts, attempt)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return attempts, nil
}

func (r *Repo) ReconcileAccepted(ctx context.Context, input ReconcileInput) (*Attempt, error) {
	return r.reconcile(ctx, input, StateAccepted)
}

func (r *Repo) ReconcileRejected(ctx context.Context, input ReconcileInput) (*Attempt, error) {
	return r.reconcile(ctx, input, StateRejected)
}

func (r *Repo) reconcile(ctx context.Context, input ReconcileInput, target string) (*Attempt, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("%w: repository pool is required", ErrInvalidInput)
	}
	if _, err := uuid.Parse(strings.TrimSpace(input.TenantID)); err != nil {
		return nil, fmt.Errorf("%w: invalid tenant_id", ErrInvalidInput)
	}
	if _, err := uuid.Parse(strings.TrimSpace(input.AttemptID)); err != nil ||
		!reconciliationSourcePattern.MatchString(strings.TrimSpace(input.Source)) {
		return nil, fmt.Errorf("%w: invalid attempt_id or reconciliation source", ErrInvalidInput)
	}
	tx, err := db.WithTenantWorker(ctx, r.Pool, input.TenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	existing, err := scanAttempt(tx.QueryRow(ctx, `
SELECT `+attemptColumns+` FROM campaign_send_deliveries
 WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
		input.TenantID, input.AttemptID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if existing.State != StateIndeterminate {
		return nil, ErrInvalidTransition
	}

	if target == StateAccepted {
		input.Receipt, err = normalizeReceiptIdentity(input.Receipt)
		if err != nil {
			return nil, err
		}
		if err := validateReceipt(existing.AttemptInput, input.Receipt); err != nil {
			return nil, err
		}
		if len(input.Receipt.ProviderMessageID) > 512 ||
			strings.ContainsAny(input.Receipt.ProviderMessageID, "\r\n\x00") {
			return nil, fmt.Errorf("%w: invalid provider message ID", ErrInvalidInput)
		}
		receiptJSON, hashErr := json.Marshal(input.Receipt)
		if hashErr != nil {
			return nil, hashErr
		}
		existing, err = scanAttempt(tx.QueryRow(ctx, `
UPDATE campaign_send_deliveries
   SET state = 'accepted', provider_message_id = NULLIF($3, ''),
       receipt_hash = $4, idempotency_mode = $5,
       failure_disposition = NULL, failure_code = NULL,
       accepted_at = clock_timestamp(),
       provider_reconciled_at = clock_timestamp(), reconciliation_source = $6,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'indeterminate'
RETURNING `+attemptColumns, input.TenantID, input.AttemptID,
			strings.TrimSpace(input.Receipt.ProviderMessageID), deliveryHash(receiptJSON),
			input.Receipt.IdempotencyMode, strings.TrimSpace(input.Source)))
	} else {
		if !deliveryFailureCode.MatchString(input.RejectCode) {
			return nil, fmt.Errorf("%w: invalid reconciliation reject code", ErrInvalidInput)
		}
		existing, err = scanAttempt(tx.QueryRow(ctx, `
UPDATE campaign_send_deliveries
   SET state = 'rejected', provider_message_id = NULL,
       failure_disposition = 'definitely_not_sent', failure_code = $3,
       rejected_at = clock_timestamp(),
       provider_reconciled_at = clock_timestamp(), reconciliation_source = $4,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'indeterminate'
RETURNING `+attemptColumns, input.TenantID, input.AttemptID,
			input.RejectCode, strings.TrimSpace(input.Source)))
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrInvalidTransition
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &existing, nil
}
