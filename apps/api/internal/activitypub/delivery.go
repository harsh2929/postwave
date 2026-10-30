// Package activitypub — delivery worker scaffold.
//
// The v1 publish path (PublishArticle in activitypub.go) writes a row
// into activitypub_outbox and seeds activitypub_delivery_queue with one
// `pending` row per accepted follower. Nothing currently drains that
// queue, so Mastodon-side timelines never see our Articles.
//
// This file is the scaffold for the multi-week worker that:
//
//   1. Acquires the platform-global delivery lease (singleton row in
//      activitypub_delivery_worker_state). On lease loss the goroutine
//      returns and the supervisor in main.go restarts it.
//
//   2. Walks pending queue rows in next_attempt_at order across all
//      tenants (worker scope GUC). For each row:
//        a. Loads the parent outbox envelope.
//        b. Loads/refreshes the remote actor (for inbox URL + key).
//        c. Computes the HTTP Signature header (deferred — see
//           signatures.go for the contract).
//        d. POSTs the envelope to the inbox URL.
//        e. On success: queue.state='success', record last_status_code.
//        f. On 4xx/5xx: queue.attempts++, queue.last_error=..., bump
//           next_attempt_at by exponential backoff (1m, 5m, 30m, 2h, 12h)
//           and at attempts>=max_attempts flip state='failed'.
//
//   3. Reports tick metrics into activitypub_delivery_worker_state.
//
// The current stub is intentionally a no-op tick: it acquires the lease,
// records the empty walk, releases. Enough to wire into main.go without
// regressing today's "writes happen, deliveries don't" behaviour, while
// letting the multi-week implementation slot in via a single function.

package activitypub

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Worker drives the per-(envelope, follower) delivery loop.
//
// Once the multi-week implementation lands, this struct also owns the
// outbound HTTP client (a *http.Client tuned for Mastodon-style 5s
// connect / 30s body deadlines + at most 16 in-flight POSTs).
type Worker struct {
	Pool     *db.Pool
	Logger   *slog.Logger
	Interval time.Duration
	// LeaseTTL is how long the singleton lease row is held per tick.
	// Defaults to 2x Interval to absorb a slow tick without dropping
	// the lease to another replica mid-flight.
	LeaseTTL time.Duration
	// MaxAttempts caps per-(envelope, follower) retries before the
	// queue row flips to state='failed'. Mirrors Mastodon's 8-attempt
	// budget over ~48h of exponential backoff.
	MaxAttempts int
	// Signer signs outbound HTTP requests using the tenant's active
	// signing key. nil signer => emit unsigned (rejected by Mastodon)
	// — only useful for dev / staging.
	Signer Signer
	// Identifier is recorded in activitypub_delivery_worker_state.lease_holder
	// so logs/dashboards can pinpoint which replica is currently leading.
	Identifier string
}

// DefaultInterval / DefaultMaxAttempts / DefaultLeaseTTL — sensible
// defaults that match Mastodon's own scheduler tuning.
const (
	DefaultDeliveryInterval    = 30 * time.Second
	DefaultDeliveryMaxAttempts = 8
	DefaultDeliveryLeaseTTL    = 2 * time.Minute
)

// Run blocks until ctx is canceled. Mirrors the soft_bounce_recovery
// worker shape (interval ticker, per-tick metric log).
func (w *Worker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil {
		return errors.New("activitypub.Worker: missing pool")
	}
	if w.Interval <= 0 {
		w.Interval = DefaultDeliveryInterval
	}
	if w.LeaseTTL <= 0 {
		w.LeaseTTL = DefaultDeliveryLeaseTTL
	}
	if w.MaxAttempts <= 0 {
		w.MaxAttempts = DefaultDeliveryMaxAttempts
	}
	if w.Logger != nil {
		w.Logger.Info("activitypub delivery worker: starting",
			"interval", w.Interval.String(),
			"max_attempts", w.MaxAttempts,
			"lease_ttl", w.LeaseTTL.String(),
			"signed", w.Signer != nil,
		)
	}
	t := time.NewTicker(w.Interval)
	defer t.Stop()
	for {
		if delivered, failed, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("activitypub delivery tick failed", "err", err.Error())
		} else if w.Logger != nil && (delivered > 0 || failed > 0) {
			w.Logger.Info("activitypub delivery tick",
				"delivered", delivered, "failed", failed)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

// tick is the per-iteration body. Today: acquire the lease, record an
// empty walk, release. The full implementation will replace the
// "0, 0, nil" return with the actual queue walk.
//
// NOTE — multi-week deferral lives HERE. See MIGRATION.md.
func (w *Worker) tick(ctx context.Context) (delivered, failed int, err error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	now := time.Now().UTC()
	leaseExpires := now.Add(w.LeaseTTL)

	// Take the singleton lease. If another replica already holds it
	// (lease_expires_at > now), skip this tick.
	tag, err := tx.Exec(ctx, `
UPDATE activitypub_delivery_worker_state
   SET lease_holder      = $1,
       lease_expires_at  = $2,
       last_tick_at      = $3,
       updated_at        = now()
 WHERE id = 'singleton'
   AND (lease_expires_at IS NULL OR lease_expires_at < $3 OR lease_holder = $1)`,
		w.Identifier, leaseExpires, now)
	if err != nil {
		return 0, 0, err
	}
	if tag.RowsAffected() == 0 {
		// Another replica owns the lease; quiet skip.
		if err := tx.Commit(ctx); err != nil {
			return 0, 0, err
		}
		return 0, 0, nil
	}

	// === DEFERRED: walk activitypub_delivery_queue rows where
	//     state = 'pending' AND next_attempt_at <= now()
	//     ORDER BY next_attempt_at ASC
	//     LIMIT BatchSize
	//     FOR UPDATE SKIP LOCKED
	// For each: load outbox envelope -> sign -> POST -> mark.
	// The plumbing for sign + POST lives in signatures.go +
	// remote_actors.go; this is the wiring point.
	//
	// For now: tick is a no-op walk so the worker can be wired into
	// main.go without changing user-visible behaviour.

	// Record empty tick metrics so the admin dashboard surfaces
	// "worker is alive but idle".
	if _, err := tx.Exec(ctx, `
UPDATE activitypub_delivery_worker_state
   SET last_tick_delivered = 0,
       last_tick_failed    = 0,
       last_tick_error     = NULL,
       updated_at          = now()
 WHERE id = 'singleton'`); err != nil {
		return 0, 0, err
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, 0, err
	}
	return 0, 0, nil
}

// nextBackoff returns the next attempt timestamp for a given retry
// count. Exponential, capped at 12h. Exposed so tests can pin the
// schedule.
func nextBackoff(attempts int, now time.Time) time.Time {
	// 1m, 5m, 30m, 2h, 6h, 12h, 12h, ...
	steps := []time.Duration{
		1 * time.Minute,
		5 * time.Minute,
		30 * time.Minute,
		2 * time.Hour,
		6 * time.Hour,
		12 * time.Hour,
	}
	i := attempts
	if i < 0 {
		i = 0
	}
	if i >= len(steps) {
		i = len(steps) - 1
	}
	return now.Add(steps[i])
}
