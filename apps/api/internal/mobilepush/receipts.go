// SPDX-License-Identifier: AGPL-3.0-only
package mobilepush

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	defaultExpoReceiptURL      = "https://exp.host/--/api/v2/push/getReceipts"
	defaultReceiptPollInterval = 15 * time.Second
	defaultReceiptBatchSize    = 100
	maxReceiptBatchSize        = 100
	receiptClaimLease          = 45 * time.Second
	maxReceiptAttempts         = 8
	missingReceiptRetryDelay   = 5 * time.Minute
	maxReceiptRetryDelay       = time.Hour
)

type claimedSendRetry struct {
	ID       string
	TenantID string
	UserID   string
	Device   storedDevice
	Notice   Notification
	Attempts int
}

type claimedReceipt struct {
	ID              string
	TenantID        string
	UserID          string
	DeviceID        string
	TicketID        string
	SendAttempts    int
	ReceiptAttempts int
}

type expoReceipt struct {
	Status  string `json:"status"`
	Message string `json:"message"`
	Details struct {
		Error string `json:"error"`
	} `json:"details"`
}

type deliveryLifecycleStore interface {
	ClaimSendRetries(context.Context, time.Time, time.Time, int) ([]claimedSendRetry, error)
	ClaimReceipts(context.Context, time.Time, time.Time, int) ([]claimedReceipt, error)
	MarkAccepted(context.Context, claimedSendRetry, string, time.Time) error
	MarkSendFailed(context.Context, claimedSendRetry, string, time.Time, bool) error
	MarkDelivered(context.Context, claimedReceipt) error
	ScheduleReceiptRetry(context.Context, claimedReceipt, string, time.Time, bool) error
	ScheduleSendRetry(context.Context, claimedReceipt, string, time.Time, bool) error
	RevokeDevice(context.Context, string, string, string, string, string) error
}

// ReceiptWorker closes both durable halves of the Expo lifecycle:
//
//   - failed/abandoned send attempts are claimed and retried with a lease;
//   - accepted Expo ticket IDs are polled in bounded batches until a terminal
//     receipt is persisted.
//
// Cross-tenant enumeration occurs only inside the capability-declaring worker
// scope. Each state transition then re-enters the matching tenant scope, so a
// claim never leaks broad RLS access into slow network I/O or a mutation.
type ReceiptWorker struct {
	Deps      *Deps
	Store     deliveryLifecycleStore
	Interval  time.Duration
	BatchSize int
	Now       func() time.Time
	Logger    *slog.Logger
}

// Run blocks until cancellation and performs an immediate tick so pending
// receipts do not wait for the first interval after a deployment.
func (w *ReceiptWorker) Run(ctx context.Context) {
	if !w.configured() {
		return
	}
	interval := w.Interval
	if interval <= 0 {
		interval = defaultReceiptPollInterval
	}
	if err := w.Tick(ctx); err != nil {
		w.logError(err)
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := w.Tick(ctx); err != nil {
				w.logError(err)
			}
		}
	}
}

// Tick is exported for deterministic tests and operational one-shot checks.
func (w *ReceiptWorker) Tick(ctx context.Context) error {
	if !w.configured() {
		return ErrPushDeliveryDisabled
	}
	store := w.Store
	if store == nil {
		if w.Deps.Pool == nil {
			return errors.New("mobile push: receipt worker store is unavailable")
		}
		store = &postgresDeliveryLifecycleStore{pool: w.Deps.Pool}
	}
	batch := w.BatchSize
	if batch <= 0 || batch > maxReceiptBatchSize {
		batch = defaultReceiptBatchSize
	}
	now := w.now()
	var errs []error

	retries, claimErr := store.ClaimSendRetries(ctx, now, now.Add(deliveryAttemptLease), batch)
	if claimErr != nil {
		errs = append(errs, fmt.Errorf("claim send retries: %w", claimErr))
	} else {
		for _, delivery := range retries {
			if err := w.retrySend(ctx, store, delivery, now); err != nil {
				errs = append(errs, err)
			}
		}
	}

	receipts, claimErr := store.ClaimReceipts(ctx, now, now.Add(receiptClaimLease), batch)
	if claimErr != nil {
		errs = append(errs, fmt.Errorf("claim receipts: %w", claimErr))
	} else if len(receipts) > 0 {
		if err := w.reconcileReceipts(ctx, store, receipts, now); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (w *ReceiptWorker) configured() bool {
	if w == nil || w.Deps == nil || w.Deps.Cipher == nil {
		return false
	}
	if w.Deps.RequireAccessToken && strings.TrimSpace(w.Deps.ExpoAccessToken) == "" {
		return false
	}
	return w.Store != nil || w.Deps.Pool != nil
}

func (w *ReceiptWorker) retrySend(ctx context.Context, store deliveryLifecycleStore, delivery claimedSendRetry, now time.Time) error {
	ticket, err := w.Deps.sendOne(ctx, delivery.Device, delivery.Notice)
	if err != nil {
		terminal := delivery.Attempts >= maxSendAttempts || !retryableExpoFailure(err)
		next := time.Time{}
		if !terminal {
			next = now.Add(sendRetryBackoff(delivery.Attempts))
		}
		if storeErr := store.MarkSendFailed(ctx, delivery, "upstream_unavailable", next, terminal); storeErr != nil {
			return errors.Join(err, storeErr)
		}
		return err
	}
	if ticket.Status == "ok" {
		return store.MarkAccepted(ctx, delivery, ticket.ID, now.Add(initialReceiptDelay))
	}
	code := normalizeExpoErrorCode(ticket.Details.Error, "expo_rejected")
	if code == "DeviceNotRegistered" {
		return store.RevokeDevice(ctx, delivery.TenantID, delivery.UserID, delivery.Device.ID, delivery.ID, code)
	}
	terminal := delivery.Attempts >= maxSendAttempts || !retryableExpoCode(code)
	next := time.Time{}
	if !terminal {
		next = now.Add(sendRetryBackoff(delivery.Attempts))
	}
	if err := store.MarkSendFailed(ctx, delivery, code, next, terminal); err != nil {
		return err
	}
	return fmt.Errorf("mobile push: Expo rejected retried message (%s)", code)
}

func (w *ReceiptWorker) reconcileReceipts(ctx context.Context, store deliveryLifecycleStore, claimed []claimedReceipt, now time.Time) error {
	ids := make([]string, 0, len(claimed))
	for _, delivery := range claimed {
		ids = append(ids, delivery.TicketID)
	}
	receipts, err := w.Deps.fetchExpoReceipts(ctx, ids)
	if err != nil {
		var errs []error
		for _, delivery := range claimed {
			terminal := delivery.ReceiptAttempts >= maxReceiptAttempts || !retryableExpoFailure(err)
			next := time.Time{}
			if !terminal {
				next = now.Add(receiptRetryBackoff(delivery.ReceiptAttempts))
			}
			if scheduleErr := store.ScheduleReceiptRetry(ctx, delivery, "receipt_upstream_unavailable", next, terminal); scheduleErr != nil {
				errs = append(errs, scheduleErr)
			}
		}
		return errors.Join(append(errs, err)...)
	}

	var errs []error
	for _, delivery := range claimed {
		receipt, present := receipts[delivery.TicketID]
		if !present || (receipt.Status != "ok" && receipt.Status != "error") {
			terminal := delivery.ReceiptAttempts >= maxReceiptAttempts
			next := time.Time{}
			if !terminal {
				next = now.Add(receiptRetryBackoff(delivery.ReceiptAttempts))
			}
			code := "receipt_missing"
			if present {
				code = "receipt_invalid"
			}
			if err := store.ScheduleReceiptRetry(ctx, delivery, code, next, terminal); err != nil {
				errs = append(errs, err)
			}
			continue
		}
		if receipt.Status == "ok" {
			if err := store.MarkDelivered(ctx, delivery); err != nil {
				errs = append(errs, err)
			}
			continue
		}
		code := normalizeExpoErrorCode(receipt.Details.Error, "expo_receipt_error")
		switch {
		case code == "DeviceNotRegistered":
			if err := store.RevokeDevice(ctx, delivery.TenantID, delivery.UserID, delivery.DeviceID, delivery.ID, code); err != nil {
				errs = append(errs, err)
			}
		case retryableExpoCode(code):
			terminal := delivery.SendAttempts >= maxSendAttempts
			next := time.Time{}
			if !terminal {
				next = now.Add(sendRetryBackoff(delivery.SendAttempts))
			}
			if err := store.ScheduleSendRetry(ctx, delivery, code, next, terminal); err != nil {
				errs = append(errs, err)
			}
		default:
			if err := store.ScheduleSendRetry(ctx, delivery, code, time.Time{}, true); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

func (d *Deps) fetchExpoReceipts(ctx context.Context, ticketIDs []string) (map[string]expoReceipt, error) {
	if len(ticketIDs) == 0 || len(ticketIDs) > maxReceiptBatchSize {
		return nil, errors.New("mobile push: receipt batch must contain 1-100 tickets")
	}
	seen := make(map[string]struct{}, len(ticketIDs))
	ids := append([]string(nil), ticketIDs...)
	for _, id := range ids {
		if strings.TrimSpace(id) == "" || len(id) > 256 || hasControl(id) {
			return nil, errors.New("mobile push: invalid receipt ticket id")
		}
		if _, duplicate := seen[id]; duplicate {
			return nil, errors.New("mobile push: duplicate receipt ticket id")
		}
		seen[id] = struct{}{}
	}
	// Stable request ordering makes no-network fixtures and upstream tracing
	// reproducible without changing the ticket-to-delivery mapping.
	sort.Strings(ids)
	payload, err := json.Marshal(struct {
		IDs []string `json:"ids"`
	}{IDs: ids})
	if err != nil {
		return nil, err
	}
	endpoint := strings.TrimSpace(d.ExpoReceiptURL)
	if endpoint == "" {
		endpoint = defaultExpoReceiptURL
	}
	raw, err := d.postExpoJSON(ctx, endpoint, payload)
	if err != nil {
		return nil, err
	}
	var envelope struct {
		Data map[string]expoReceipt `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil || envelope.Data == nil {
		return nil, &expoUpstreamError{reason: "returned an invalid receipt response", retryable: true}
	}
	return envelope.Data, nil
}

func receiptRetryBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	delay := missingReceiptRetryDelay
	for i := 1; i < attempt && delay < maxReceiptRetryDelay; i++ {
		delay *= 2
		if delay > maxReceiptRetryDelay {
			delay = maxReceiptRetryDelay
		}
	}
	return delay
}

func (w *ReceiptWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *ReceiptWorker) logError(err error) {
	logger := w.Logger
	if logger == nil && w.Deps != nil {
		logger = w.Deps.Logger
	}
	if logger != nil && err != nil && !errors.Is(err, context.Canceled) {
		logger.Warn("mobile push receipt worker tick failed", "err", err.Error())
	}
}

type postgresDeliveryLifecycleStore struct{ pool *db.Pool }

func (s *postgresDeliveryLifecycleStore) ClaimSendRetries(ctx context.Context, now, leaseUntil time.Time, limit int) ([]claimedSendRetry, error) {
	tx, txErr := withMobilePushWorkerScope(ctx, s.pool)
	if txErr != nil {
		return nil, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE mobile_push_deliveries
   SET status = 'failed', error_code = COALESCE(error_code, 'send_attempts_exhausted'),
       next_retry_at = NULL, terminal_at = $1
 WHERE status IN ('queued', 'failed') AND next_retry_at <= $1
   AND attempts >= $2`, now, maxSendAttempts); err != nil {
		return nil, err
	}
	rows, txErr := tx.Query(ctx, `
WITH candidates AS (
    SELECT md.id
      FROM mobile_push_deliveries md
      JOIN mobile_push_devices d ON d.id = md.device_id
     WHERE md.status IN ('queued', 'failed')
       AND md.next_retry_at <= $1
       AND md.attempts < $2
       AND d.status = 'active' AND d.token_envelope IS NOT NULL
     ORDER BY md.next_retry_at, md.created_at
     FOR UPDATE OF md SKIP LOCKED
     LIMIT $3
), claimed AS (
    UPDATE mobile_push_deliveries md
       SET status = 'queued', attempts = md.attempts + 1,
           error_code = NULL, expo_ticket_id = NULL,
           receipt_attempts = 0, next_retry_at = $4,
           terminal_at = NULL, delivered_at = NULL
      FROM candidates c
     WHERE md.id = c.id
 RETURNING md.id, md.tenant_id, md.user_id, md.device_id,
           md.event_type, COALESCE(md.entity_id, '') AS entity_id, md.idempotency_key,
           COALESCE(md.notification_id::text, '') AS notification_id,
           md.title, md.body, md.category_id, md.attempts
)
SELECT c.id::text, c.tenant_id::text, c.user_id::text, c.device_id::text,
       d.token_envelope, c.event_type, c.entity_id, c.idempotency_key,
       c.notification_id, c.title, c.body, c.category_id, c.attempts
  FROM claimed c
  JOIN mobile_push_devices d ON d.id = c.device_id
 ORDER BY c.id`, now, maxSendAttempts, limit, leaseUntil)
	if txErr != nil {
		return nil, txErr
	}
	defer rows.Close()
	var out []claimedSendRetry
	for rows.Next() {
		var item claimedSendRetry
		if err := rows.Scan(&item.ID, &item.TenantID, &item.UserID, &item.Device.ID,
			&item.Device.Envelope, &item.Notice.EventType, &item.Notice.EntityID,
			&item.Notice.IdempotencyKey, &item.Notice.NotificationID,
			&item.Notice.Title, &item.Notice.Body,
			&item.Notice.CategoryID, &item.Attempts); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (s *postgresDeliveryLifecycleStore) ClaimReceipts(ctx context.Context, now, leaseUntil time.Time, limit int) ([]claimedReceipt, error) {
	tx, txErr := withMobilePushWorkerScope(ctx, s.pool)
	if txErr != nil {
		return nil, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE mobile_push_deliveries
   SET status = 'failed', error_code = COALESCE(error_code, 'receipt_attempts_exhausted'),
       next_retry_at = NULL, terminal_at = $1
 WHERE status = 'accepted' AND next_retry_at <= $1
   AND receipt_attempts >= $2`, now, maxReceiptAttempts); err != nil {
		return nil, err
	}
	rows, txErr := tx.Query(ctx, `
WITH candidates AS (
    SELECT id
      FROM mobile_push_deliveries
     WHERE status = 'accepted' AND expo_ticket_id IS NOT NULL
       AND next_retry_at <= $1 AND receipt_attempts < $2
     ORDER BY next_retry_at, created_at
     FOR UPDATE SKIP LOCKED
     LIMIT $3
)
UPDATE mobile_push_deliveries md
   SET receipt_attempts = md.receipt_attempts + 1,
       next_retry_at = $4
  FROM candidates c
 WHERE md.id = c.id
RETURNING md.id::text, md.tenant_id::text, md.user_id::text,
          md.device_id::text, md.expo_ticket_id, md.attempts,
          md.receipt_attempts`, now, maxReceiptAttempts, limit, leaseUntil)
	if txErr != nil {
		return nil, txErr
	}
	defer rows.Close()
	var out []claimedReceipt
	for rows.Next() {
		var item claimedReceipt
		if err := rows.Scan(&item.ID, &item.TenantID, &item.UserID, &item.DeviceID,
			&item.TicketID, &item.SendAttempts, &item.ReceiptAttempts); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (s *postgresDeliveryLifecycleStore) MarkAccepted(ctx context.Context, item claimedSendRetry, ticketID string, next time.Time) error {
	return s.updateTenant(ctx, item.TenantID, `
UPDATE mobile_push_deliveries
   SET status = 'accepted', expo_ticket_id = $3, error_code = NULL,
       receipt_attempts = 0, next_retry_at = $4, terminal_at = NULL
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'queued'`, item.ID, ticketID, next)
}

func (s *postgresDeliveryLifecycleStore) MarkSendFailed(ctx context.Context, item claimedSendRetry, code string, next time.Time, terminal bool) error {
	return s.markFailed(ctx, item.TenantID, item.ID, code, next, terminal, "queued")
}

func (s *postgresDeliveryLifecycleStore) MarkDelivered(ctx context.Context, item claimedReceipt) error {
	tx, err := withMobilePushTenantScope(ctx, s.pool, item.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	updated, err := tx.Exec(ctx, `
UPDATE mobile_push_deliveries
   SET status = 'delivered', error_code = NULL, next_retry_at = NULL,
       delivered_at = now(), terminal_at = now()
	WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'accepted'`, item.TenantID, item.ID)
	if err != nil {
		return err
	}
	if updated.RowsAffected() == 0 {
		return tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `
UPDATE mobile_push_devices
   SET last_delivery_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'active'`, item.TenantID, item.DeviceID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *postgresDeliveryLifecycleStore) ScheduleReceiptRetry(ctx context.Context, item claimedReceipt, code string, next time.Time, terminal bool) error {
	if terminal {
		return s.markFailed(ctx, item.TenantID, item.ID, code, time.Time{}, true, "accepted")
	}
	return s.updateTenant(ctx, item.TenantID, `
UPDATE mobile_push_deliveries
   SET error_code = $3, next_retry_at = $4
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'accepted'`, item.ID, normalizeExpoErrorCode(code, "receipt_unavailable"), next)
}

func (s *postgresDeliveryLifecycleStore) ScheduleSendRetry(ctx context.Context, item claimedReceipt, code string, next time.Time, terminal bool) error {
	return s.markFailed(ctx, item.TenantID, item.ID, code, next, terminal, "accepted")
}

func (s *postgresDeliveryLifecycleStore) RevokeDevice(ctx context.Context, tenantID, userID, deviceID, deliveryID, code string) error {
	d := &Deps{Pool: s.pool}
	return d.revokeDeviceForDelivery(ctx, tenantID, userID, deviceID, deliveryID, code)
}

func (s *postgresDeliveryLifecycleStore) markFailed(ctx context.Context, tenantID, deliveryID, code string, next time.Time, terminal bool, expectedStatus string) error {
	var retry any
	if !next.IsZero() {
		retry = next
	}
	var terminalAt any
	if terminal {
		terminalAt = time.Now().UTC()
	}
	return s.updateTenant(ctx, tenantID, `
UPDATE mobile_push_deliveries
   SET status = 'failed', error_code = $3, next_retry_at = $4,
       terminal_at = $5
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = $6`, deliveryID,
		normalizeExpoErrorCode(code, "unknown"), retry, terminalAt, expectedStatus)
}

func (s *postgresDeliveryLifecycleStore) updateTenant(ctx context.Context, tenantID, query, deliveryID string, args ...any) error {
	tx, err := withMobilePushTenantScope(ctx, s.pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	params := make([]any, 0, len(args)+2)
	params = append(params, tenantID, deliveryID)
	params = append(params, args...)
	if _, err := tx.Exec(ctx, query, params...); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
