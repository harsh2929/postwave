// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/postwave/postwave/apps/api/internal/approvals"
	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/mobilepush"
	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
	"github.com/postwave/postwave/apps/api/internal/safego"
	"github.com/postwave/postwave/apps/api/internal/subscriberscore"
	"github.com/postwave/postwave/apps/api/internal/webhooks"
)

// buildApprovalsServiceDeps carries the dependencies buildApprovalsService needs.
type buildApprovalsServiceDeps struct {
	pool                   *db.Pool
	canonicalWebhookFanout *outbound_webhooks.TransactionalFanout
	webhooksDispatcher     *webhooks.Dispatcher
	cfg                    config.Config
	eventsBus              *events.Bus
	logger                 *slog.Logger
	notifyFanout           *notifyfanout.Fanout
	outboxCtx              context.Context
	mobilePushDeps         *mobilepush.Deps
}

// buildApprovalsService builds the approval gate service, its escalation
// sweeper, the churn scorer, the Postmark notifier, the approvals deps and the
// mobile push receipt worker. Moved verbatim from run().
func buildApprovalsService(d buildApprovalsServiceDeps) (*approvals.Service, *approvals.Deps) {
	pool := d.pool
	canonicalWebhookFanout := d.canonicalWebhookFanout
	webhooksDispatcher := d.webhooksDispatcher
	cfg := d.cfg
	eventsBus := d.eventsBus
	logger := d.logger
	notifyFanout := d.notifyFanout
	outboxCtx := d.outboxCtx
	mobilePushDeps := d.mobilePushDeps
	// Approval gate service. The HMAC key is reused from the sending KEK so
	// signed one-click decide links are not externally guessable; production
	// should split this into a dedicated APPROVAL_HMAC_KEY env var.
	approvalsRepo := &approvals.Repo{
		Pool: pool,
		TransactionalWebhookFanout: approvalsTransactionalWebhookFanoutAdapter{
			canonical: canonicalWebhookFanout,
			legacy:    webhooksDispatcher,
		},
	}
	approvalsService := &approvals.Service{
		Repo:    approvalsRepo,
		HMACKey: cfg.SendingKEK,
		TTL:     approvals.DefaultTTL,
		// Forward `approval.expired` into the presentation/automation bus.
		// Customer approval webhooks use Repo's transactional fanout and
		// never depend on this best-effort channel.
		EventEmitter: &approvalsEventBusAdapter{Bus: eventsBus},
		// Delegation lookup — when an active approval_delegations row
		// covers (requester → decider), Service.Decide suppresses
		// ErrSelfApproval. The *Repo satisfies the interface.
		Delegations: approvalsRepo,
	}
	// Escalation sweeper — re-fires "approval.escalated" for pending
	// approvals past the per-tenant escalate_after_hours threshold.
	approvalsEscalation := &approvals.EscalationSweeper{
		Pool:    pool,
		Emitter: &approvalsEventBusAdapter{Bus: eventsBus},
		Logger:  logger,
		// The consumer "approval.escalated" never had. It emitted on the bus and
		// nothing subscribed, so an escalation stamped a column and reached
		// nobody — the approval sat as unattended as before while the record said
		// it had been escalated. Routed through the same notifyfanout chokepoint
		// approval.requested uses, to the same admin recipients.
		Notifier: approvalsEscalationNotifier{
			fanout: notifyFanout,
			admins: &approvalsAdminListerAdapter{Pool: pool},
			logger: logger,
		},
	}
	safego.Go(logger, "approvals-escalation-sweeper",
		func() { approvalsEscalation.Run(outboxCtx) })

	// Subscriber churn-risk scorer — heuristic 0..100 model writing
	// to subscribers.churn_score every 6h. Powers the dashboard's
	// "at-risk" view + the smart-unsubscribe page's "we noticed
	// you're not engaging — would less email help?" prompt.
	churnScorer := &subscriberscore.Scorer{Pool: pool, Logger: logger}
	safego.Go(logger, "subscriber-churn-scorer",
		func() { churnScorer.Run(outboxCtx) })
	approvalsService.Notifier = approvals.NewPostmarkNotifier(
		os.Getenv("POSTMARK_TRANSACTIONAL_TOKEN"),
		os.Getenv("APPROVAL_FROM_EMAIL"),
		os.Getenv("PUBLIC_BASE_URL"),
		approvalsService,
		approvalsRepo,
	)
	approvalsDeps := &approvals.Deps{
		Service:       approvalsService,
		PublicBaseURL: os.Getenv("PUBLIC_BASE_URL"),
		Bus:           eventsBus,
	}

	// Web Push + native push deps are constructed early (see the unified
	// notification fanout block before the workers) so the fanout, the route
	// mounts below, and the approvals wire-up all share one instance.
	// Expo ticket acceptance is not delivery. Reconcile tickets against the
	// receipts endpoint and recover leased send attempts for the full API
	// lifecycle. The worker is a no-op when push is not configured and shares
	// the process cancellation context used by the other durable workers.
	mobilePushReceiptWorker := &mobilepush.ReceiptWorker{
		Deps: mobilePushDeps, Logger: logger,
	}
	safego.Go(logger, "mobile-push-receipt-worker", func() {
		mobilePushReceiptWorker.Run(outboxCtx)
	})

	return approvalsService, approvalsDeps
}
