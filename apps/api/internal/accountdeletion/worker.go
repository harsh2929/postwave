// SPDX-License-Identifier: AGPL-3.0-only
package accountdeletion

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Worker deletes only the request's subject user. It rechecks the owner
// interlock while holding the user row lock, so concurrent owner requests can
// never leave a workspace ownerless.
type Worker struct {
	Pool     *db.Pool
	Interval time.Duration
	Batch    int
	Now      func() time.Time
	Logger   *slog.Logger
	Notifier CompletionNotifier
}

func (w *Worker) Run(ctx context.Context) {
	if w == nil || w.Pool == nil {
		return
	}
	interval := w.Interval
	if interval <= 0 {
		interval = time.Minute
	}
	_ = w.Tick(ctx)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := w.Tick(ctx); err != nil && w.Logger != nil {
				w.Logger.Warn("self account deletion tick failed", "err", err.Error())
			}
		}
	}
}

// Tick is exported for focused worker tests and operational one-shot runs.
func (w *Worker) Tick(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return fmt.Errorf("account deletion worker is not configured")
	}
	batch := w.Batch
	if batch <= 0 || batch > 100 {
		batch = 25
	}
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// The certificate is deliberately retained after the user row is gone, but
	// it is not immortal. Legal holds win; otherwise the worker enforces the
	// counsel-configured retention timestamp without needing an account lookup.
	purged, err := tx.Exec(ctx, `
DELETE FROM privacy_requests
 WHERE request_type = 'account_deletion'
   AND subject_type = 'account_user'
   AND status = 'fulfilled'
   AND legal_hold = false
   AND retention_expires_at IS NOT NULL
   AND retention_expires_at <= $1`, w.now())
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `
SELECT id, tenant_id::text
  FROM privacy_requests
 WHERE request_type = 'account_deletion'
   AND subject_type = 'account_user'
   AND status IN ('queued','in_progress','blocked_legal_hold','blocked_ownership')
   AND (status <> 'blocked_legal_hold' OR legal_hold = false)
   AND COALESCE(execute_after, requested_at) <= $1
 ORDER BY requested_at
 LIMIT $2`, w.now(), batch)
	if err != nil {
		return err
	}
	type candidate struct{ id, tenantID string }
	var candidates []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.id, &c.tenantID); err != nil {
			rows.Close()
			return err
		}
		candidates = append(candidates, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if count := purged.RowsAffected(); count > 0 && w.Logger != nil {
		w.Logger.Info("expired self account deletion certificates purged", "count", count)
	}
	var firstErr error
	for _, c := range candidates {
		if err := w.process(ctx, c.id, c.tenantID); err != nil {
			wrapped := fmt.Errorf("process self account deletion %s: %w", c.id, err)
			if firstErr == nil {
				firstErr = wrapped
			}
			if w.Logger != nil {
				w.Logger.Warn("self account deletion request failed", "request_id", c.id, "err", err.Error())
			}
		}
	}
	return firstErr
}

func (w *Worker) process(ctx context.Context, requestID, tenantID string) error {
	tx, txErr := db.WithWorkerScope(ctx, w.Pool)
	if txErr != nil {
		return txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	var userID *string
	var status string
	var legalHold bool
	txErr = tx.QueryRow(ctx, `
SELECT subject_user_id::text, status, legal_hold
  FROM privacy_requests
 WHERE id = $1 AND tenant_id = $2::uuid
   AND request_type = 'account_deletion' AND subject_type = 'account_user'
 FOR UPDATE`, requestID, tenantID).Scan(&userID, &status, &legalHold)
	if errors.Is(txErr, pgx.ErrNoRows) || status == "fulfilled" || status == "cancelled" || status == "rejected" {
		return tx.Commit(ctx)
	}
	if txErr != nil {
		return txErr
	}
	if legalHold {
		_, txErr = tx.Exec(ctx, `
UPDATE privacy_requests SET status='blocked_legal_hold', updated_at=$3
 WHERE id=$1 AND tenant_id=$2::uuid`, requestID, tenantID, w.now())
		if txErr != nil {
			return txErr
		}
		return tx.Commit(ctx)
	}
	if userID == nil || *userID == "" {
		if err := markFulfilled(ctx, tx, tenantID, requestID, w.now(), "already_absent"); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}

	var role, email string
	txErr = tx.QueryRow(ctx, `
SELECT role, email::text FROM users
 WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, tenantID, *userID).Scan(&role, &email)
	if errors.Is(txErr, pgx.ErrNoRows) {
		if err := markFulfilled(ctx, tx, tenantID, requestID, w.now(), "already_absent"); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if txErr != nil {
		return txErr
	}
	otherOwners := 0
	if role == "owner" {
		if err := tx.QueryRow(ctx, `
SELECT count(*) FROM users
 WHERE tenant_id=$1::uuid AND role='owner' AND id<>$2::uuid`, tenantID, *userID).Scan(&otherOwners); err != nil {
			return err
		}
		if isLastOwner(role, otherOwners) {
			_, txErr = tx.Exec(ctx, `
UPDATE privacy_requests
   SET status='blocked_ownership',
       fulfillment=COALESCE(fulfillment,'{}'::jsonb) || '{"blocked_reason":"last_workspace_owner"}'::jsonb,
       updated_at=$3
 WHERE id=$1 AND tenant_id=$2::uuid`, requestID, tenantID, w.now())
			if txErr != nil {
				return txErr
			}
			return tx.Commit(ctx)
		}
	}

	// These tables intentionally lack user FKs or retain human-readable author
	// labels. Delete personal state and scrub direct attribution before the
	// users-row cascade removes credentials, sessions, IdP links, TOTP, push
	// devices, dashboard layouts, delegations, and other FK-owned state.
	for _, statement := range []string{
		`DELETE FROM notification_preferences WHERE tenant_id=$1::uuid AND user_id=$2::uuid`,
		`DELETE FROM subscriber_view_prefs WHERE tenant_id=$1::uuid AND user_id=$2::uuid`,
		`DELETE FROM web_push_subscriptions WHERE tenant_id=$1::uuid AND user_id=$2::uuid`,
		`DELETE FROM notification_feed WHERE tenant_id=$1::uuid AND user_id=$2::uuid`,
		`DELETE FROM cli_auth_grants WHERE tenant_id=$1::uuid AND user_id=$2::uuid`,
		`DELETE FROM cli_device_grants WHERE tenant_id=$1::uuid AND user_id=$2::uuid`,
		`UPDATE subscriber_notes SET author_user_id=NULL, author_email=NULL WHERE tenant_id=$1::uuid AND author_user_id=$2::uuid`,
		`UPDATE campaign_feedback SET author_user_id=NULL, author_label='Deleted user' WHERE tenant_id=$1::uuid AND author_user_id=$2::uuid`,
	} {
		if _, err := tx.Exec(ctx, statement, tenantID, *userID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM users WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, *userID); err != nil {
		return err
	}
	completedAt := w.now()
	if err := markFulfilled(ctx, tx, tenantID, requestID, completedAt, "user_deleted"); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO audit_log (tenant_id, actor_type, action, resource_type, resource_id, metadata)
VALUES ($1::uuid, 'system', 'account.self_deletion_fulfilled', 'privacy_request', $2,
        '{"scope":"authenticated_user_only","workspace_content_deleted":false}'::jsonb)`, tenantID, requestID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if w.Notifier != nil && email != "" {
		if err := w.Notifier.NotifyAccountDeleted(ctx, email, requestID); err != nil && w.Logger != nil {
			w.Logger.Warn("self account deletion completion notification failed", "request_id", requestID, "err", err.Error())
		}
	}
	return nil
}

func markFulfilled(ctx context.Context, tx pgx.Tx, tenantID, requestID string, now time.Time, mode string) error {
	fulfillment, _ := json.Marshal(map[string]any{
		"mode":                       mode,
		"scope":                      "authenticated_user_only",
		"workspace_content_deleted":  false,
		"direct_identifiers_removed": true,
		"fulfilled_at":               now.UTC().Format(time.RFC3339),
	})
	_, err := tx.Exec(ctx, `
UPDATE privacy_requests
   SET status='fulfilled', completed_at=$3,
       requester_user_id=NULL, requester_email=NULL,
       subject_user_id=NULL, subject_email=NULL,
       idempotency_key_hash=NULL,
       fulfillment=COALESCE(fulfillment,'{}'::jsonb) || $4::jsonb,
       updated_at=$3
 WHERE id=$1 AND tenant_id=$2::uuid`, requestID, tenantID, now, fulfillment)
	return err
}

func (w *Worker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	return time.Now().UTC()
}
