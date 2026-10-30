// SPDX-License-Identifier: AGPL-3.0-only
//
// Package spam_trap_guard auto-suppresses subscribers that hit a
// spam trap.
//
// Spam traps are dead or never-existed mailboxes operated by
// blocklist providers (Spamhaus, SORBS, Validity) and individual
// inbox providers as bait. Sending to one is treated as a strong
// signal that the operator's list hygiene is broken. The damage:
//
//   * single trap hit → temporary deliverability drop
//   * repeated hits  → block on the sending domain/IP for days
//
// The bounce-classifier (analytics/devices.CategorizeBounce)
// already labels spam traps as `bounce_type='spam_trap'` when the
// receiver returns the canonical pattern. This package closes the
// loop:
//
//   1. periodically scan subscriber_events for new spam_trap rows
//   2. for each, immediately:
//        a. flip the subscriber to status='blocklisted'
//        b. log a sentinel in spam_trap_hits for the operator audit
//        c. NEVER send to that address again (handled by 1a)
//
// SUB-048: in addition to flipping subscribers.status='blocklisted',
// we now ALSO write a canonical suppression row with
// reason='spamtrap' (bounce_category='spamtrap') to
// subscriber_suppressions. Before SUB-048 the Reason enum didn't
// carry spamtrap so this package only blocklisted; migration 0512
// widened the CHECK constraint, so the suppression row is now the
// source-of-truth signal the deliverability dashboard + send-time
// filter read. The status flip stays as belt-and-suspenders (the
// dispatcher's audience query filters status='enabled').
//
// The suppression write is optional: SweepTenant takes a nil-able
// *suppressions.Store so the blocklist path still works on deploys
// that haven't wired the store.
//
// Surfaces:
//
//   GET  /api/v1/spam-trap-guard/hits             recent trap hits
//   GET  /api/v1/spam-trap-guard/stats            counts + last run
//   POST /api/v1/spam-trap-guard/run-now          manual sweep (admin)

package spam_trap_guard

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
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// Worker is the background sweeper.
type Worker struct {
	Pool     *db.Pool
	Logger   *slog.Logger
	Interval time.Duration
	// Suppressions, when set, receives a reason='spamtrap' row for every
	// address the sweep blocklists (SUB-048). Nil-safe.
	Suppressions *suppressions.Store

	// tenantCursor is an in-memory pagination hint for the bounded tenant
	// inventory walk. Durable retry state lives in the database (a spam-trap
	// event without a permanent spamtrap suppression), so losing this cursor on
	// restart can only repeat safe, idempotent work.
	tenantCursor string
}

const (
	// Bound both dimensions of a tick. The tenant cursor makes the outer walk a
	// deterministic round-robin; the recipient limit prevents one tenant's
	// backlog from monopolising a sweep.
	spamTrapTenantBatchLimit    = 100
	spamTrapRecipientBatchLimit = 500
)

type suppressionWriter interface {
	AddWithCategory(
		ctx context.Context,
		tenantID, email string,
		reason suppressions.Reason,
		source suppressions.Source,
		sourceEventID string,
		expiresAt *time.Time,
		metadata map[string]any,
		category suppressions.BounceCategory,
	) (*suppressions.Entry, error)
}

// Run blocks until ctx is canceled.
func (w *Worker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return errors.New("spam_trap_guard: missing pool")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = 30 * time.Minute
	}
	if w.Logger != nil {
		w.Logger.Info("spam_trap_guard worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if n, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("spam_trap_guard tick failed", "err", err.Error())
		} else if w.Logger != nil && n > 0 {
			w.Logger.Warn("spam_trap_guard: blocklisted subscribers", "count", n)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *Worker) tick(ctx context.Context) (int, error) {
	// Enumerate the existing tenant inventory rather than reading recipient
	// events cross-tenant. Migration 1728 exposes tenant UUIDs (and no recipient
	// data) to this worker scope; SweepTenant binds tenant RLS before it reads
	// events, subscribers, or suppressions.
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text
  FROM tenants
 WHERE NULLIF($1, '') IS NULL
    OR id > NULLIF($1, '')::uuid
 ORDER BY id
 LIMIT $2`, w.tenantCursor, spamTrapTenantBatchLimit)
	if err != nil {
		return 0, err
	}
	tenants := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err == nil {
			tenants = append(tenants, t)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	if len(tenants) == 0 {
		// End of the UUID-ordered inventory. Restart the round-robin on the
		// next tick rather than doing an unbounded second query now.
		w.tenantCursor = ""
		return 0, nil
	}
	w.tenantCursor = tenants[len(tenants)-1]
	if len(tenants) < spamTrapTenantBatchLimit {
		// This page reached the end. Restart at the beginning next tick.
		w.tenantCursor = ""
	}
	total := 0
	for _, tenantID := range tenants {
		n, err := SweepTenant(ctx, w.Pool, tenantID, w.Suppressions)
		if err != nil {
			if w.Logger != nil {
				w.Logger.Warn("spam_trap_guard sweep failed",
					"tenant", tenantID, "err", err.Error())
			}
			continue
		}
		total += n
	}
	return total, nil
}

// SweepTenant is the per-tenant action. Exported so the run-now
// HTTP handler can call it. `store`, when non-nil, additionally writes
// a permanent bounce_category='spamtrap' suppression for every distinct trap
// address in this bounded batch (SUB-048). Pending work is derived from the
// event plus absence of that canonical suppression, never from subscriber
// status or event age. Suppression failures therefore remain discoverable on
// later sweeps. The already-committed blocklist flip remains the load-bearing
// safety action.
func SweepTenant(ctx context.Context, pool *db.Pool, tenantID string, store *suppressions.Store) (int, error) {
	var writer suppressionWriter
	if store != nil {
		writer = store
	}
	return sweepTenant(ctx, pool, tenantID, writer)
}

func sweepTenant(ctx context.Context, pool *db.Pool, tenantID string, store suppressionWriter) (int, error) {
	if pool == nil || tenantID == "" {
		return 0, nil
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Oldest evidence first, with normalised email as the stable tie-breaker.
	// A permanent spamtrap bounce_category is the durable completion marker;
	// reason may legitimately change later (for example, a subsequent global
	// unsubscribe) without erasing the raw spam-trap classification.
	rows, err := tx.Query(ctx, `
SELECT lower(btrim(event.subscriber_email::text)) AS email
  FROM subscriber_events AS event
 WHERE event.tenant_id = $1::uuid
   AND event.event_type = 'bounced'
   AND event.bounce_type = 'spam_trap'
   AND NOT EXISTS (
       SELECT 1
         FROM subscriber_suppressions AS suppression
        WHERE suppression.tenant_id = $1::uuid
          AND suppression.email = event.subscriber_email
          AND suppression.bounce_category = 'spamtrap'
          AND suppression.expires_at IS NULL
   )
 GROUP BY lower(btrim(event.subscriber_email::text))
 ORDER BY min(event.at), lower(btrim(event.subscriber_email::text))
 LIMIT $2`, tenantID, spamTrapRecipientBatchLimit)
	if err != nil {
		return 0, err
	}
	candidates := []string{}
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			rows.Close()
			return 0, err
		}
		candidates = append(candidates, email)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	// Block matching subscribers before any external/store fan-out. Addresses
	// without a subscriber row are still suppressed below, closing the gap
	// between event ingestion and subscriber materialisation.
	var blocklisted int64
	if len(candidates) > 0 {
		result, err := tx.Exec(ctx, `
UPDATE subscribers
   SET status = 'blocklisted', updated_at = now()
 WHERE tenant_id = $1::uuid
   AND status <> 'blocklisted'
   AND lower(btrim(email::text)) = ANY($2::text[])`, tenantID, candidates)
		if err != nil {
			return 0, err
		}
		blocklisted = result.RowsAffected()
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}

	// SUB-048: mirror every pending candidate, including subscribers already
	// blocklisted by an earlier failed attempt. Continue after an individual
	// failure so one poison candidate cannot prevent the rest of the bounded
	// batch from converging. Errors intentionally omit recipient PII.
	var suppressionErrors []error
	if store != nil {
		for index, email := range candidates {
			if _, err := store.AddWithCategory(ctx, tenantID, email,
				suppressions.ReasonSpamtrap, suppressions.SourceManual, "", nil,
				map[string]any{"detector": "spam_trap_guard"},
				suppressions.CategorySpamtrap,
			); err != nil {
				suppressionErrors = append(suppressionErrors,
					fmt.Errorf("spam_trap_guard: suppress candidate %d: %w", index+1, err))
			}
		}
	}
	return int(blocklisted), errors.Join(suppressionErrors...)
}

// --- HTTP surface ---

// Deps wires the read endpoints.
type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
	// Suppressions, when set, makes the manual run-now sweep also write
	// reason='spamtrap' suppression rows (SUB-048). Nil-safe.
	Suppressions *suppressions.Store
}

// Hit is one trap-detection row for the operator review screen.
type Hit struct {
	Email        string    `json:"email"`
	FirstHitAt   time.Time `json:"first_hit_at"`
	LastHitAt    time.Time `json:"last_hit_at"`
	HitCount     int       `json:"hit_count"`
	SubscriberID string    `json:"subscriber_id,omitempty"`
	Status       string    `json:"status,omitempty"`
}

// MountRoutes registers the admin endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/spam-trap-guard/hits", d.Hits)
	r.With(read).Get("/api/v1/spam-trap-guard/stats", d.Stats)
	r.With(admin).Post("/api/v1/spam-trap-guard/run-now", d.RunNow)
}

// Hits GET /api/v1/spam-trap-guard/hits?days=30.
func (d *Deps) Hits(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	days := 30
	if v := r.URL.Query().Get("days"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 365 {
			days = n
		}
	}
	since := time.Now().UTC().AddDate(0, 0, -days)
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT e.subscriber_email::text,
       MIN(e.at) AS first_hit_at,
       MAX(e.at) AS last_hit_at,
       count(*) AS hits,
       COALESCE(s.id::text, ''),
       COALESCE(s.status, '')
  FROM subscriber_events e
  LEFT JOIN subscribers s ON s.tenant_id = $1::uuid AND s.email = e.subscriber_email
 WHERE e.tenant_id = $1::uuid
   AND e.event_type = 'bounced'
   AND e.bounce_type = 'spam_trap'
   AND e.at >= $2
 GROUP BY e.subscriber_email, s.id, s.status
 ORDER BY last_hit_at DESC
 LIMIT 500`, t.ID, since)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []Hit{}
	for rows.Next() {
		var h Hit
		if err := rows.Scan(&h.Email, &h.FirstHitAt, &h.LastHitAt, &h.HitCount,
			&h.SubscriberID, &h.Status); err == nil {
			out = append(out, h)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"hits":  out,
		"count": len(out),
	})
}

// Stats GET /api/v1/spam-trap-guard/stats.
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
	var hits30d, blocklistedSubs, eligibleNow int64
	if err := tx.QueryRow(r.Context(), `
SELECT count(*) FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND event_type = 'bounced' AND bounce_type = 'spam_trap'
   AND at >= now() - INTERVAL '30 days'`, t.ID).Scan(&hits30d); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.QueryRow(r.Context(), `
SELECT count(*) FROM subscribers
	 WHERE tenant_id = $1::uuid AND status = 'blocklisted'`, t.ID).Scan(&blocklistedSubs); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.QueryRow(r.Context(), `
SELECT count(*)
  FROM subscribers s
 WHERE s.tenant_id = $1::uuid
   AND s.status <> 'blocklisted'
   AND EXISTS (
     SELECT 1
       FROM subscriber_events e
      WHERE e.tenant_id = $1::uuid
        AND e.subscriber_email = s.email
        AND e.event_type = 'bounced'
        AND e.bounce_type = 'spam_trap'
   )`, t.ID).Scan(&eligibleNow); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	observedAt := time.Now().UTC()
	writeJSON(w, http.StatusOK, map[string]any{
		"hits_last_30_days": hits30d,
		"blocklisted_count": blocklistedSubs,
		"eligible_now":      eligibleNow,
		"observed_at":       observedAt,
	})
}

// RunNow POST /api/v1/spam-trap-guard/run-now.
func (d *Deps) RunNow(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	n, err := SweepTenant(r.Context(), d.Pool, t.ID, d.Suppressions)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	completedAt := time.Now().UTC()
	if d.Logger != nil {
		actorType, actorLabel := middleware.ActorFromContext(r.Context())
		d.Logger.Info("spam-trap guard manual sweep completed",
			"tenant", t.ID,
			"actor_type", actorType,
			"actor_label", actorLabel,
			"blocklisted", n,
			"completed_at", completedAt,
		)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"blocklisted":  n,
		"completed_at": completedAt,
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
