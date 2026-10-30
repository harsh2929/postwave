// SPDX-License-Identifier: AGPL-3.0-only
//
// Package soft_bounce_recovery expires recovery-owned transient suppressions
// after the most recent soft bounce has aged past the recovery window.
//
// Background: when a subscriber soft-bounces (typically a 4xx SMTP
// error — mailbox full, greylisted, temp DNS issue), repeated failures can
// create a time-bounded soft_bounce_threshold suppression. Bounce counters are
// not consent or lifecycle evidence: this worker therefore NEVER changes
// subscribers.status. An operator or an evidence-backed subscriber workflow
// must make any later lifecycle reactivation decision.
//
// The worker:
//
//   1. walks every tenant with any subscriber_events in the last
//      90 days
//   2. for each tenant, finds expired soft_bounce_threshold suppressions whose
//      MOST RECENT bounce is soft and older than RecoveryWindow (default 14d)
//   3. locks and deletes only those exact suppression identities
//   4. deletes only identity-linked expired legacy mirrors and writes
//      suppression_audit rows atomically
//
// Surfaces:
//
//   GET  /api/v1/soft-bounce-recovery/stats     last run + counts
//   POST /api/v1/soft-bounce-recovery/run-now   manual trigger (admin)

package soft_bounce_recovery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Default lookback. Set per-tenant via env later if needed.
const DefaultRecoveryWindow = 14 * 24 * time.Hour

// The suppressions store writes this server-owned identity into the legacy
// mirror metadata. Email/reason similarity is deliberately insufficient for a
// destructive cleanup because either can describe a newer independent row.
const legacyMirrorSuppressionIDKey = "subscriber_suppression_id"

// Worker is the background recoverer.
type Worker struct {
	Pool           *db.Pool
	Logger         *slog.Logger
	Interval       time.Duration
	RecoveryWindow time.Duration
}

// Run blocks until ctx is canceled.
func (w *Worker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return errors.New("soft_bounce_recovery: missing pool")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = 6 * time.Hour
	}
	if w.RecoveryWindow <= 0 {
		w.RecoveryWindow = DefaultRecoveryWindow
	}
	if w.Logger != nil {
		w.Logger.Info("soft-bounce recovery worker: starting",
			"interval", interval.String(),
			"recovery_window", w.RecoveryWindow.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if expired, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("soft-bounce recovery tick failed", "err", err.Error())
		} else if w.Logger != nil && expired > 0 {
			w.Logger.Info("soft-bounce recovery tick complete", "expired_suppressions", expired)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

// tick walks tenants and expires eligible transient suppressions. Returns the
// total number expired for logging.
func (w *Worker) tick(ctx context.Context) (int, error) {
	// Tenant discovery runs inside a worker-scoped tx; per-tenant recovery
	// runs in its own RecoverTenant call (which takes its own connection),
	// so we commit the discovery tx before the loop.
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT DISTINCT tenant_id::text
  FROM subscriber_events
 WHERE at > now() - INTERVAL '90 days'`)
	if err != nil {
		return 0, err
	}
	tenants := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			rows.Close()
			return 0, fmt.Errorf("soft_bounce_recovery: scan tenant: %w", err)
		}
		tenants = append(tenants, t)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, fmt.Errorf("soft_bounce_recovery: iterate tenants: %w", err)
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	total := 0
	for _, tenantID := range tenants {
		n, err := RecoverTenant(ctx, w.Pool, tenantID, w.RecoveryWindow)
		if err != nil {
			if w.Logger != nil {
				w.Logger.Warn("recovery failed", "tenant", tenantID, "err", err.Error())
			}
			continue
		}
		total += n
	}
	return total, nil
}

// RecoverTenant runs one recovery pass for a tenant. The exported name remains
// for API compatibility with the run-now handler; "recovery" now means
// expiring an already-inactive transient suppression, never changing a
// subscriber lifecycle status.
func RecoverTenant(ctx context.Context, pool *db.Pool, tenantID string, window time.Duration) (int, error) {
	if pool == nil {
		return 0, errors.New("soft_bounce_recovery: missing pool")
	}
	if tenantID == "" {
		return 0, errors.New("soft_bounce_recovery: missing tenant")
	}
	if window <= 0 {
		return 0, errors.New("soft_bounce_recovery: recovery window must be positive")
	}
	now := time.Now().UTC()
	cutoff := now.Add(-window)
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Pick only canonical transient suppressions that are already expired and
	// whose latest bounce is still an old soft bounce. DISTINCT ON with id DESC
	// makes equal-timestamp events deterministic. FOR UPDATE SKIP LOCKED means a
	// concurrent webhook reclassification wins: this pass skips the row and a
	// later pass re-evaluates its new state. The xmin comparison is a final
	// fail-closed guard before deletion.
	rows, err := tx.Query(ctx, `
WITH latest_bounce AS (
  SELECT DISTINCT ON (lower(subscriber_email::text))
         lower(subscriber_email::text) AS email_key,
         bounce_type AS last_type,
         at AS last_at
    FROM subscriber_events
   WHERE tenant_id = $1::uuid
     AND event_type = 'bounced'
   ORDER BY lower(subscriber_email::text), at DESC, id DESC
), candidates AS (
  SELECT suppression.id, suppression.xmin::text AS row_version
    FROM subscriber_suppressions suppression
    JOIN latest_bounce bounce
      ON bounce.email_key = lower(suppression.email::text)
   WHERE suppression.tenant_id = $1::uuid
     AND suppression.reason = 'soft_bounce_threshold'
     AND suppression.expires_at IS NOT NULL
     AND suppression.expires_at <= $3::timestamptz
     AND bounce.last_type = 'soft'
     AND bounce.last_at < $2::timestamptz
   FOR UPDATE OF suppression SKIP LOCKED
), deleted AS (
  DELETE FROM subscriber_suppressions suppression
   USING candidates candidate
   WHERE suppression.tenant_id = $1::uuid
     AND suppression.id = candidate.id
     AND suppression.xmin::text = candidate.row_version
     AND suppression.reason = 'soft_bounce_threshold'
     AND suppression.expires_at IS NOT NULL
     AND suppression.expires_at <= $3::timestamptz
   RETURNING suppression.id, suppression.tenant_id, suppression.email,
             suppression.reason, suppression.source,
             suppression.source_event_id, suppression.created_at,
             suppression.expires_at, suppression.metadata
), audited AS (
  INSERT INTO suppression_audit
      (tenant_id, email, action, reason, source_table, payload)
  SELECT deleted.tenant_id, deleted.email, 'expire', deleted.reason,
         'subscriber_suppressions',
         jsonb_build_object(
           'id', deleted.id::text,
           'reason', deleted.reason,
           'source', deleted.source,
           'source_event_id', deleted.source_event_id,
           'created_at', deleted.created_at,
           'expires_at', deleted.expires_at,
           'metadata', deleted.metadata,
           'recovery', 'soft_bounce_window_elapsed'
         )
    FROM deleted
  RETURNING email
)
SELECT deleted.id::text
  FROM deleted
  JOIN audited ON lower(audited.email::text) = lower(deleted.email::text)`,
		tenantID, cutoff, now)
	if err != nil {
		return 0, fmt.Errorf("soft_bounce_recovery: expire canonical suppressions: %w", err)
	}
	deletedIDs := make([]string, 0, 16)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, fmt.Errorf("soft_bounce_recovery: scan expired suppression: %w", err)
		}
		deletedIDs = append(deletedIDs, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, fmt.Errorf("soft_bounce_recovery: iterate expired suppressions: %w", err)
	}
	rows.Close()

	if len(deletedIDs) > 0 {
		// Delete only exact identity-linked, already-expired soft-bounce mirrors.
		// The audit INSERT depends on the DELETE result, so any audit failure
		// aborts this statement and the surrounding transaction restores both
		// canonical and legacy rows.
		if _, err := tx.Exec(ctx, `
WITH deleted AS (
  DELETE FROM email_suppressions legacy
   WHERE legacy.tenant_id = $1::uuid
     AND legacy.reason = 'soft_bounce'
     AND legacy.expires_at IS NOT NULL
     AND legacy.expires_at <= $3::timestamptz
     AND legacy.metadata ->> $4 = ANY($2::text[])
   RETURNING legacy.tenant_id, legacy.email, legacy.reason, legacy.source,
             legacy.provider_event_id, legacy.campaign_id,
             legacy.suppressed_at, legacy.expires_at, legacy.metadata
)
INSERT INTO suppression_audit
    (tenant_id, email, action, reason, source_table, payload)
SELECT deleted.tenant_id, deleted.email, 'expire', deleted.reason,
       'email_suppressions',
       jsonb_build_object(
         'reason', deleted.reason,
         'source', deleted.source,
         'provider_event_id', deleted.provider_event_id,
         'campaign_id', deleted.campaign_id,
         'suppressed_at', deleted.suppressed_at,
         'expires_at', deleted.expires_at,
         'metadata', deleted.metadata,
         'recovery', 'linked_soft_bounce_threshold_expired'
       )
  FROM deleted`, tenantID, deletedIDs, now, legacyMirrorSuppressionIDKey); err != nil {
			return 0, fmt.Errorf("soft_bounce_recovery: expire linked legacy suppressions: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(deletedIDs), nil
}

// --- HTTP surface ---

// Deps wires the read endpoint.
type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// MountRoutes registers the admin endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/soft-bounce-recovery/stats", d.Stats)
	r.With(admin).Post("/api/v1/soft-bounce-recovery/run-now", d.RunNow)
}

// Stats GET /api/v1/soft-bounce-recovery/stats.
func (d *Deps) Stats(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var disabled, eligibleSuppressionsNow int64
	cutoff := time.Now().UTC().Add(-DefaultRecoveryWindow)
	if err := tx.QueryRow(r.Context(), `
SELECT count(*) FROM subscribers
 WHERE tenant_id = $1::uuid AND status = 'disabled'`, t.ID).Scan(&disabled); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Eligible right now = expired recovery-owned suppressions whose latest
	// bounce is still soft and older than the cutoff. Subscriber status is not
	// part of this decision and is never changed by recovery.
	if err := tx.QueryRow(r.Context(), `
WITH latest_bounce AS (
  SELECT DISTINCT ON (lower(subscriber_email::text))
         lower(subscriber_email::text) AS email_key,
         bounce_type AS last_type,
         at AS last_at
    FROM subscriber_events
   WHERE tenant_id = $1::uuid AND event_type = 'bounced'
   ORDER BY lower(subscriber_email::text), at DESC, id DESC
)
SELECT count(*)
  FROM subscriber_suppressions suppression
  JOIN latest_bounce lb
    ON lb.email_key = lower(suppression.email::text)
 WHERE suppression.tenant_id = $1::uuid
   AND suppression.reason = 'soft_bounce_threshold'
   AND suppression.expires_at IS NOT NULL
   AND suppression.expires_at <= now()
   AND lb.last_type = 'soft'
   AND lb.last_at < $2`, t.ID, cutoff).Scan(&eligibleSuppressionsNow); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"disabled_count": disabled,
		// Compatibility field consumed by older clients as "subscribers eligible
		// for automatic reactivation". That operation no longer exists, so the
		// only honest value is zero. Newer clients can display the separate
		// transient-suppression cleanup count below.
		"eligible_now":                  0,
		"eligible_suppressions_now":     eligibleSuppressionsNow,
		"recovery_window_days":          int(DefaultRecoveryWindow / (24 * time.Hour)),
		"automatic_reactivation_active": false,
	})
}

// RunNow POST /api/v1/soft-bounce-recovery/run-now?window_days=. `recovered`
// remains for compatibility with clients that interpreted it as subscriber
// reactivation; it is always zero because this worker never changes lifecycle
// status. `expired_suppressions` reports the cleanup that actually occurred.
func (d *Deps) RunNow(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	window := DefaultRecoveryWindow
	if v := r.URL.Query().Get("window_days"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 90 {
			window = time.Duration(n) * 24 * time.Hour
		}
	}
	n, err := RecoverTenant(r.Context(), d.Pool, t.ID, window)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"recovered":            0,
		"expired_suppressions": n,
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}
