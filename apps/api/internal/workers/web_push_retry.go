// SPDX-License-Identifier: AGPL-3.0-only

package workers

import (
	"context"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/notifywebhook"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/webpush"
)

// WebPushRetrier is the sweep half of the web push delivery ledger.
//
// Migration 1883 recorded failures and its own comment called the retry worker
// "separate work". This is that worker, and it is registered here rather than
// left as a method nobody calls — a delivery ledger nothing sweeps is a more
// detailed way of losing the notification, which is the failure the ledger this
// belongs to keeps recording about other people's code.
type WebPushRetrier interface {
	RetryDue(ctx context.Context, now time.Time, limit int) (retried, retired int, err error)
}

// webPushRetryInterval is how often due deliveries are swept.
//
// A minute, matching the shortest backoff the sender schedules. Sweeping less
// often than the shortest backoff would make that first retry wait for the
// sweep rather than for the backoff, quietly turning a one-minute delay into
// whatever the interval happens to be.
const webPushRetryInterval = time.Minute

// webPushRetryBatch bounds one sweep.
//
// A cap rather than "everything due": a push service outage makes every
// delivery due at once, and an unbounded sweep would then hold one transaction
// open across the whole backlog and re-send in a burst the service is already
// rejecting.
const webPushRetryBatch = 100

// StartWebPushRetryWorker sweeps due web push retries until ctx is done.
//
// A nil retrier is a no-op, matching the notification stack's convention that a
// deployment without web push still runs.
func StartWebPushRetryWorker(ctx context.Context, retrier WebPushRetrier, logger *slog.Logger) {
	if retrier == nil {
		return
	}
	if logger == nil {
		logger = slog.Default()
	}
	safego.Go(logger, "web-push-retry", func() {
		tick := func() {
			retried, retired, err := retrier.RetryDue(ctx, time.Now().UTC(), webPushRetryBatch)
			if err != nil {
				logger.Warn("web push retry sweep failed", "err", err.Error())
				return
			}
			// Logged only when something happened: a sweep that finds nothing is
			// the normal case every minute, and logging it would bury the sweeps
			// that matter.
			if retried > 0 || retired > 0 {
				logger.Info("web push retry sweep", "retried", retried, "retired", retired)
			}
		}
		tick()
		ticker := time.NewTicker(webPushRetryInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				tick()
			}
		}
	})
}

// Compile-time proof that the real sender satisfies the interface. Without it a
// signature change would be caught only where main.go wires them together.
var _ WebPushRetrier = (*webpush.Deps)(nil)

// NotificationWebhookRetrier is the sweep half of the notification webhook
// ledger (migrations 1885/1889).
//
// Separate from WebPushRetrier because it needs a poster: the destination lives
// in the person's preferences and the message is rebuilt from the feed row, so
// the sweep resolves both and hands them to the same SSRF-safe poster the
// original post used.
type NotificationWebhookRetrier interface {
	RetryDue(ctx context.Context, p notifywebhook.PostSender, now time.Time, limit int) (retried, failed int, err error)
}

// StartNotificationWebhookRetryWorker sweeps due webhook retries until ctx is
// done. A nil retrier or poster is a no-op.
func StartNotificationWebhookRetryWorker(
	ctx context.Context, retrier NotificationWebhookRetrier, p notifywebhook.PostSender, logger *slog.Logger,
) {
	if retrier == nil || p == nil {
		return
	}
	if logger == nil {
		logger = slog.Default()
	}
	safego.Go(logger, "notification-webhook-retry", func() {
		tick := func() {
			retried, failed, err := retrier.RetryDue(ctx, p, time.Now().UTC(), webPushRetryBatch)
			if err != nil {
				logger.Warn("notification webhook retry sweep failed", "err", err.Error())
				return
			}
			if retried > 0 || failed > 0 {
				logger.Info("notification webhook retry sweep", "retried", retried, "failed", failed)
			}
		}
		tick()
		ticker := time.NewTicker(webPushRetryInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				tick()
			}
		}
	})
}

var _ NotificationWebhookRetrier = (*notifywebhook.Recorder)(nil)
