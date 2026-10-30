// SPDX-License-Identifier: AGPL-3.0-only
package referrals

import (
	"context"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// VerificationWorker promotes referral conversions from pending to
// credited after the tenant's verification window elapses.
type VerificationWorker struct {
	Pool     *db.Pool
	Repo     *Repo
	Events   EventEmitter
	Interval time.Duration
	Logger   *slog.Logger
}

func (w *VerificationWorker) Run(ctx context.Context) {
	if w.Interval <= 0 {
		w.Interval = 15 * time.Minute
	}
	t := time.NewTicker(w.Interval)
	defer t.Stop()
	w.tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			w.tick(ctx)
		}
	}
}

func (w *VerificationWorker) tick(ctx context.Context) {
	if w == nil || w.Pool == nil || w.Repo == nil {
		return
	}
	tenants, err := w.listTenants(ctx)
	if err != nil {
		if w.Logger != nil {
			w.Logger.Warn("referrals verification worker: tenants", "err", err.Error())
		}
		return
	}
	for _, tenantID := range tenants {
		if ctx.Err() != nil {
			return
		}
		rows, err := w.Repo.CreditDuePending(ctx, tenantID, 200)
		if err != nil {
			if w.Logger != nil {
				w.Logger.Warn("referrals verification worker: credit due",
					"tenant", tenantID, "err", err.Error())
			}
			continue
		}
		for _, row := range rows {
			w.Events.emit(ctx, tenantID, EventReferralPayoutPending, map[string]any{
				"conversion_id": row.ConversionID,
				"referrer_id":   row.ReferrerID,
				"referee_id":    row.RefereeID,
				"status":        "credited",
			})
		}
	}
}

// listTenants enumerates every tenant for the credit fan-out. The scan
// is cross-tenant, so it MUST run under db.WithWorkerScope: after the
// tenants RLS split (migration 0333) a bare Pool.Query binds no GUC and
// returns zero rows; only the tenant_worker_select policy (1728, gated
// on app.outbox_worker = 'true') re-admits worker enumeration. Same bug
// class as the congrats sender's conversion scan (fixed alongside it,
// 2026-06-10 desktop audit).
func (w *VerificationWorker) listTenants(ctx context.Context) ([]string, error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return nil, err
	}
	// Read-only — rollback releases the worker scope with the tx.
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `SELECT id::text FROM tenants ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

type CreditedConversion struct {
	ConversionID string
	ReferrerID   string
	RefereeID    string
}

// CreditDuePending promotes mature, non-fraud pending conversions for one tenant.
func (r *Repo) CreditDuePending(ctx context.Context, tenantID string, limit int) ([]CreditedConversion, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
WITH due AS (
    SELECT id
      FROM referral_conversions
     WHERE tenant_id = $1::uuid
       AND credit_status = 'pending'
       AND pending_until IS NOT NULL
       AND pending_until <= now()
       AND COALESCE(fraud_score, 0) < $2
     ORDER BY pending_until ASC
     LIMIT $3
     FOR UPDATE SKIP LOCKED
)
UPDATE referral_conversions c
   SET credit_status = 'credited',
       credited_at = now()
  FROM due
 WHERE c.id = due.id
RETURNING c.id::text, c.referrer_subscriber_id, c.referee_subscriber_id`,
		tenantID, referralFraudThreshold, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CreditedConversion{}
	for rows.Next() {
		var row CreditedConversion
		if err := rows.Scan(&row.ConversionID, &row.ReferrerID, &row.RefereeID); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}
