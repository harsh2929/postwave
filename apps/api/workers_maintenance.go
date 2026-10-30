// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/approvals"
	"github.com/postwave/postwave/apps/api/internal/billing"
	"github.com/postwave/postwave/apps/api/internal/billing/webhook_retry"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/notifications"
	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
	"github.com/postwave/postwave/apps/api/internal/ops"
	"github.com/postwave/postwave/apps/api/internal/ops/checks"
	"github.com/postwave/postwave/apps/api/internal/replies"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/sending"
)

// startStripeWebhookRetryWorker builds the Stripe webhook retry store + worker,
// binds the ops DLQ action, and starts the worker. Moved verbatim from run().
func startStripeWebhookRetryWorker(retryStore *webhook_retry.PgStore, billingWebhook *billing.WebhookHandler, logger *slog.Logger, authMailer mailer.Mailer, trustOpsCtx context.Context) error {
	// The ops console's billing.dlq-depth button, bound to THIS store — the
	// same replay transaction the admin DLQ endpoint below and the retry
	// worker use, so the console cannot drift into a second, subtly different
	// replay path. It is bound here rather than in the ops block above simply
	// because the retry store is constructed here; ops.BindAction writes a
	// package-level map, and the check itself is registered from
	// ops/checks/billing.go's init(), so the ordering is safe either way.
	ops.BindAction("billing.dlq-depth", checks.DLQReplayRunner(retryStore))

	retryWorker := webhook_retry.NewWorker(retryStore, billingWebhook)
	retryWorker.Logger = logger
	retryWorker.SignerSecret = os.Getenv("STRIPE_WEBHOOK_SECRET")
	retryWorker.AlertEmail = strings.TrimSpace(os.Getenv("STRIPE_DLQ_ALERT_EMAIL"))
	// Wire the dead-letter alert through the platform transactional
	// mailer (authMailer — always non-nil by this point). From address
	// resolution mirrors the nearby report/evidence adapters.
	dlqAlertFrom := strings.TrimSpace(os.Getenv("POSTWAVE_REPORT_FROM_EMAIL"))
	if dlqAlertFrom == "" {
		dlqAlertFrom = strings.TrimSpace(os.Getenv("POSTWAVE_DEFAULT_FROM_EMAIL"))
	}
	retryWorker.Mailer = &stripeDLQMailerAdapter{Mailer: authMailer, From: dlqAlertFrom}
	if err := retryWorker.Validate(); err != nil {
		return fmt.Errorf("stripe retry worker configuration: %w", err)
	}
	// safego.Go participates in the shutdown WaitGroup drain.
	safego.Go(logger, "trust-ops-stripe-retry-worker", func() { retryWorker.Run(trustOpsCtx) })

	return nil
}

// wireReplyObjectWorkerAndIMAPPoller attaches the SES inbound object worker
// and starts the IMAP reply poller when configured. Moved verbatim from run().
func wireReplyObjectWorkerAndIMAPPoller(repliesDeps *replies.Deps, repliesStore *replies.Store, repliesMatcher *replies.Matcher, repliesRepo *replies.Repo, pool *db.Pool, logger *slog.Logger, outboxCtx context.Context) error {
	if inboundBucket := strings.TrimSpace(os.Getenv("POSTWAVE_REPLIES_INBOUND_BUCKET")); inboundBucket != "" {
		objectSource, err := replies.NewS3ObjectSource(
			context.Background(),
			strings.TrimSpace(os.Getenv("POSTWAVE_SES_REGION")),
			inboundBucket,
		)
		if err != nil {
			// Fail loudly. A deployment that set the bucket has asked for inbound
			// replies; starting without them would silently discard every reply
			// SES writes, and the first symptom would be "our customers stopped
			// replying".
			return fmt.Errorf("inbound reply object source: %w", err)
		}
		repliesDeps.ObjectWorker = &replies.InboundObjectWorker{
			Objects:              objectSource,
			Store:                repliesStore,
			Matcher:              repliesMatcher,
			TenantResolver:       repliesRepo,
			EnvelopeDomainSuffix: os.Getenv("POSTWAVE_REPLIES_ENVELOPE_DOMAIN"),
		}
	}
	// F05 IMAP reply adapter. Replies otherwise arrive only by PUSH — a
	// provider webhook or MX delivery to a per-tenant address — which does not
	// help a sender whose customers reply to a mailbox the tenant already owns.
	//
	// Starts only when a mailbox is actually configured AND the secret resolver
	// is available. A half-configured poller that logs an error every two
	// minutes is how a deployment ends up with a worker nobody trusts.
	replyIMAPPoller := &replies.Poller{
		Mailboxes: &replies.MailboxStore{Pool: pool},
		Store:     repliesStore,
		Matcher:   repliesMatcher,
		Secrets:   replies.EnvironmentSecretResolver{},
		NewSource: func() replies.MessageSource { return replies.NewIMAPSource() },
		Logger:    logger,
	}
	if replyIMAPPoller.Configured() {
		safego.Go(logger, "reply-imap-poller", func() {
			if err := replyIMAPPoller.Run(outboxCtx); err != nil && !errors.Is(err, context.Canceled) {
				logger.Warn("reply IMAP poller exited", "err", err)
			}
		})
	}

	return nil
}

// startSendGuardStuckRecovery starts the sweep that returns legacy rows stuck
// in 'sending' to pending. Moved verbatim from run().
func startSendGuardStuckRecovery(logger *slog.Logger, outboxCtx context.Context, sendGuard *sending.Guard) {
	safego.Go(logger, "send-guard-stuck-recovery", func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-outboxCtx.Done():
				return
			case <-ticker.C:
				if _, err := sendGuard.RecoverStuckSends(outboxCtx, 10*time.Minute); err != nil {
					logger.Warn("send guard stuck-recovery failed", "error", err)
				}
			}
		}
	})
}

// wireNotificationGating wires the per-user notification dispatcher into the
// billing webhook, approvals, and the per-recipient approval notifier. Moved
// verbatim from run().
func wireNotificationGating(pool *db.Pool, logger *slog.Logger, billingWebhook *billing.WebhookHandler, approvalsDeps *approvals.Deps, approvalsService *approvals.Service, notifyFanout *notifyfanout.Fanout) *notifications.PgDispatcher {
	notifDispatcher := &notifications.PgDispatcher{Pool: pool, Logger: logger}
	billingWebhook.NotifDispatcher = notifDispatcher
	approvalsDeps.NotifDispatcher = notifDispatcher

	// ----- approvals: per-recipient gating wire-up -----
	//
	// Activate the per-recipient AdminLister + Dispatcher path on the
	// PostmarkNotifier that was constructed up at approvalsService.Notifier
	// (see "Approval gate service" region). Until this wires, the notifier
	// has AdminLister == nil and falls back to the legacy single-mailbox
	// path. With the adapter wired, every tenant owner+admin gets the
	// approval email — each consulted individually via
	// notifications.Dispatcher.Gate(PrefApprovalRequest). If the adapter
	// returns an empty list (tenant has no enumerated admins) the
	// notifier still falls back to the legacy single-mailbox path, so
	// degradation is graceful.
	if pmNotifier, ok := approvalsService.Notifier.(*approvals.PostmarkNotifier); ok && pmNotifier != nil {
		pmNotifier.AdminLister = &approvalsAdminListerAdapter{Pool: pool}
		pmNotifier.Dispatcher = notifDispatcher
		pmNotifier.Logger = logger
		// Parallel browser-push channel: each gated approval recipient also
		// gets a web push (no-op when VAPID is unconfigured). Bridged via an
		// adapter so the approvals package needn't import internal/webpush.
		pmNotifier.Push = approvalsPushAdapter{fanout: notifyFanout}
	}

	return notifDispatcher
}
