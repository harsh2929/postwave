// SPDX-License-Identifier: AGPL-3.0-only
//
// sweep_suppressions.go — SUB-049: time-bounded suppressions
// auto-unblock when their expiry fires.
//
// email_suppressions (migration 0030) and subscriber_suppressions
// (0081) both carry a nullable `expires_at timestamptz`. Operators (and
// the soft-bounce-threshold auto-suppressor) set it to roll a
// suppression off automatically — e.g. "block this address for 30 days
// then let it back in". The CHECK + the send-time filter already treat
// an expired row as inactive (Store.Check filters `expires_at IS NULL OR
// expires_at > now()`), but nothing ever DELETED the dead rows: they
// accumulated forever, bloating the suppression list and the dashboard
// counts.
//
// This sweeper closes that gap. Unlike the day-window sweeps in this
// package (which key off a tenant retention setting), this one keys off
// each row's own expires_at: any row with `expires_at IS NOT NULL AND
// expires_at < now()` is past its window and is hard-deleted in batches.
// Both suppression tables are swept; the partial index
// (tenant_id, expires_at) WHERE expires_at IS NOT NULL on
// subscriber_suppressions and email_suppressions_active_idx on
// email_suppressions keep the predicate cheap.
//
// Wired into SweepOnceForTenant's fan-out (raw_payloads.go) as the
// "expired_suppressions" class. No new migration: the expires_at
// columns already exist.

package retention

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// sweepExpiredSuppressions deletes expired rows from both suppression
// tables for one tenant, batching to bound lock contention. Returns the
// total rows purged across both tables. No retention-day argument: the
// cutoff is the row's own expires_at.
func (s *Sweeper) sweepExpiredSuppressions(ctx context.Context, tenantID string) (int64, error) {
	var total int64
	for _, table := range []string{"email_suppressions", "subscriber_suppressions"} {
		n, err := s.sweepExpiredSuppressionsTable(ctx, tenantID, table)
		if err != nil {
			return total, err
		}
		total += n
	}
	return total, nil
}

func (s *Sweeper) sweepExpiredSuppressionsTable(ctx context.Context, tenantID, table string) (int64, error) {
	// Allow-list the table name: it is interpolated into the SQL string
	// so it must never be attacker-influenced. Both values are package
	// constants here, but the guard is defence-in-depth against a future
	// caller passing a tainted name.
	if table != "email_suppressions" && table != "subscriber_suppressions" {
		return 0, fmt.Errorf("retention: unsupported suppression table %q", table)
	}
	var total int64
	for i := 0; i < s.maxBatchesPerTenant(); i++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, err := s.sweepExpiredSuppressionsBatch(ctx, tenantID, table)
		if err != nil {
			return total, err
		}
		total += n
		if n == 0 {
			break
		}
	}
	return total, nil
}

func (s *Sweeper) sweepExpiredSuppressionsBatch(ctx context.Context, tenantID, table string) (int64, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// ctid-bounded batch: LIMIT is not legal on a bare DELETE in Postgres.
	// SUB-049: RETURNING the email+reason of every auto-unblocked row so
	// we can write the compliance audit trail below. Without this the
	// sweeper hard-deleted expired suppressions with no record, and an
	// operator could not answer "why is this address receiving mail again?"
	// during a review. The 'expire' action was reserved for exactly this
	// path in migration 0246.
	rows, err := tx.Query(ctx, fmt.Sprintf(`
DELETE FROM %s
 WHERE ctid IN (
     SELECT ctid FROM %s
      WHERE tenant_id = $1::uuid
        AND expires_at IS NOT NULL
        AND expires_at < now()
      LIMIT $2
 )
 RETURNING email::text, reason::text, expires_at`, table, table), tenantID, s.batchSize())
	if err != nil {
		return 0, fmt.Errorf("delete expired %s: %w", table, err)
	}
	type unblocked struct {
		email     string
		reason    string
		expiresAt *time.Time
	}
	var purged []unblocked
	for rows.Next() {
		var u unblocked
		if err := rows.Scan(&u.email, &u.reason, &u.expiresAt); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan expired %s: %w", table, err)
		}
		purged = append(purged, u)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("iterate expired %s: %w", table, err)
	}

	// Write an action='expire' audit row for each auto-unblocked
	// suppression, inside the SAME tx as the delete so the audit trail can
	// never diverge from the table state. Matches the row shape the manual
	// add/remove/update path uses (suppressions.AuditLogger.Record): the
	// actor columns stay NULL because this is an automated sweep, the
	// reason carries the original suppression reason, and source_table
	// records which table was mutated. The payload mirrors the
	// pre-mutation-snapshot convention so the audit surface can render the
	// row that was rolled off.
	for _, u := range purged {
		payload := map[string]any{
			"detector": "retention_expiry_sweep",
			"reason":   u.reason,
		}
		if u.expiresAt != nil {
			payload["expires_at"] = u.expiresAt.UTC().Format(time.RFC3339)
		}
		raw, err := json.Marshal(payload)
		if err != nil {
			return 0, fmt.Errorf("marshal expire audit payload for %s: %w", table, err)
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO suppression_audit
    (tenant_id, email, action, actor_user_id, actor_api_key_id,
     reason, source_table, payload)
VALUES ($1::uuid, $2::citext, $3, NULL, NULL,
        NULLIF($4,''), $5, $6::jsonb)`,
			tenantID, u.email, string(suppressions.AuditActionExpire), u.reason, table, raw,
		); err != nil {
			return 0, fmt.Errorf("write expire audit for %s: %w", table, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit expired %s sweep: %w", table, err)
	}
	return int64(len(purged)), nil
}
