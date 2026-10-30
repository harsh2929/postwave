// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
)

const deviceGrantCleanupBatch = 500

// CleanupExpiredDeviceGrants bounds retention of short codes and the target's
// IP/User-Agent/account metadata. Pending, denied, and legacy API-key rows are
// removed shortly after their authorization window. A confirmed session
// binding is retained for 31 days (one day beyond the maximum issued session)
// so response replay/cancellation and incident investigation never outlive the
// record that identifies the exact session. Unconfirmed sessions are unusable
// and expire with their two-minute lease, then become cleanup-eligible.
func (r *Repo) CleanupExpiredDeviceGrants(ctx context.Context, limit int) (int64, error) {
	if r == nil || r.Pool == nil {
		return 0, errors.New("device grant cleanup repository is unavailable")
	}
	if limit <= 0 || limit > deviceGrantCleanupBatch {
		limit = deviceGrantCleanupBatch
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		"SELECT set_config('app.cli_device_grant_janitor', 'true', true)"); err != nil {
		return 0, err
	}
	command, err := tx.Exec(ctx, `
		WITH doomed AS (
		    SELECT id
		      FROM cli_device_grants
		     WHERE (
		         (grant_kind <> 'session' AND expires_at < now() - interval '1 hour')
		         OR (
		             grant_kind = 'session' AND status <> 'consumed'
		             AND expires_at < now() - interval '1 hour'
		         )
		         OR (
		             grant_kind = 'session' AND status = 'consumed'
		             AND session_confirmed_at IS NULL
		             AND session_confirmation_expires_at < now() - interval '1 hour'
		         )
		         OR (
		             grant_kind = 'session' AND status = 'consumed'
		             AND session_confirmed_at < now() - interval '31 days'
		         )
		     )
		     ORDER BY expires_at, id
		     LIMIT $1
		)
		DELETE FROM cli_device_grants g
		 USING doomed
		 WHERE g.id = doomed.id`, limit)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (r *Repo) StartDeviceGrantJanitor(ctx context.Context, interval time.Duration, logger *slog.Logger) {
	if interval <= 0 {
		interval = time.Hour
	}
	if logger == nil {
		logger = slog.Default()
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			if _, err := r.CleanupExpiredDeviceGrants(ctx, deviceGrantCleanupBatch); err != nil &&
				ctx.Err() == nil {
				logger.WarnContext(ctx, "auth: device grant cleanup failed", "err", err.Error())
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}
