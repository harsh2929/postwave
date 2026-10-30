// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
)

// FanoutAutoDisableNotifier delivers the auto-disable alert through the unified
// notification fanout — in-app feed, web push, SSE, and native mobile push
// (COMMERCE#3).
//
// The backend has detected and acted on this for a long time:
// AutoDisableThreshold consecutive failures pauses the endpoint, an outbox row
// is written, and EmailAutoDisableNotifier mails the owner. Email was the ONLY
// channel, so the first anyone learns that their systems stopped receiving data
// is whenever they next read that inbox. Queued deliveries stay paused until a
// human re-enables the endpoint, which makes this the definition of an alert
// worth a phone buzzing.
//
// THE AUDIENCE IS IDENTICAL TO THE EMAIL'S, DELIBERATELY. Not "every admin":
// EmailAutoDisableNotifier notifies exactly one recipient — the earliest-created
// owner whose webhook_alert_prefs allow it — and a notification is a disclosure.
// Widening the set here would quietly tell more people about a tenant's
// integration health than the existing policy chose to, so the query below is a
// deliberate mirror of the email's, differing only in selecting the id instead
// of the address. Change one and you must change the other.
//
// RECEIVER URLS ARE NEVER INCLUDED, for the same reason the email omits them:
// the path and query of a webhook destination can themselves be credentials.
type FanoutAutoDisableNotifier struct {
	Pool   *db.Pool
	Fanout *notifyfanout.Fanout
	Logger *slog.Logger
}

// webhookAutoDisabledEvent is the manifest event name. It is a CROSS-LANGUAGE
// contract: packages/notifications carries the entry, mobilepush's
// allowedDeviceEvents mirrors it, apps/mobile derives the Android channel id
// ("integrations") from the same manifest, and
// apps/mobile/src/lib/pushRoutingContract.test.ts asserts a tap resolves to a
// screen. Renaming it here alone makes Android silently drop the notification.
const webhookAutoDisabledEvent = "webhook.auto_disabled"

// NotifyWebhookAutoDisabled implements AutoDisableNotifier.
//
// It returns nil on every non-fatal outcome (no eligible recipient, fanout not
// wired) because the caller is the durable outbox worker: a non-nil error
// reschedules the row, and there is nothing to retry when the answer is "this
// tenant has nobody to tell". A genuine lookup failure DOES return an error so
// the outbox retries it.
func (n *FanoutAutoDisableNotifier) NotifyWebhookAutoDisabled(
	ctx context.Context,
	tenantID,
	webhookID string,
) error {
	if n == nil || n.Pool == nil || n.Fanout == nil || tenantID == "" {
		return nil
	}
	userID, err := n.recipient(ctx, tenantID)
	if err != nil {
		return err
	}
	if userID == "" {
		return nil
	}
	n.Fanout.Dispatch(ctx, tenantID, []string{userID}, notifyfanout.Event{
		Type:  webhookAutoDisabledEvent,
		Title: "Webhook paused",
		Body: "An outbound webhook was paused after repeated delivery failures. " +
			"Queued deliveries are held until it is re-enabled.",
		// The native payload stays content-light — an id, never a destination.
		MobileBody: "An outbound webhook was paused after repeated delivery failures.",
		URL:        "/app/settings/webhooks",
		EntityID:   webhookID,
		// One logical notification per paused endpoint. The outbox worker
		// retries this call whenever the EMAIL leg fails, so without a dedupe
		// key a flaky mailbox would re-buzz the phone on every attempt; with
		// one, the second dispatch finds the existing feed row and delivers
		// nothing twice.
		DedupeKey: webhookAutoDisabledEvent + ":" + webhookID,
		// Pref is intentionally empty: the recipient query below has ALREADY
		// applied webhook_alert_prefs.notify_auto_disabled, which is the
		// preference that governs this alert. Naming a second, unrelated pref
		// here would let a bounce-alert setting silence an integration outage.
		Payload: map[string]any{"webhook_id": webhookID},
	})
	return nil
}

// recipient resolves the single user the auto-disable alert goes to. See the
// type comment: this predicate is a deliberate mirror of the one in
// EmailAutoDisableNotifier.NotifyWebhookAutoDisabled.
func (n *FanoutAutoDisableNotifier) recipient(ctx context.Context, tenantID string) (string, error) {
	tx, err := db.WithTenant(ctx, n.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var userID string
	err = tx.QueryRow(ctx, `
SELECT user_account.id::text
  FROM users AS user_account
  LEFT JOIN webhook_alert_prefs AS preference
    ON preference.tenant_id = user_account.tenant_id
   AND preference.user_id = user_account.id
 WHERE user_account.tenant_id = $1::uuid
   AND user_account.role = 'owner'
   AND NULLIF(btrim(user_account.email), '') IS NOT NULL
   AND COALESCE(preference.notify_auto_disabled, true) = true
 ORDER BY user_account.created_at, user_account.id
 LIMIT 1`, tenantID).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", tx.Commit(ctx)
	}
	if err != nil {
		return "", err
	}
	return userID, tx.Commit(ctx)
}

// MultiAutoDisableNotifier fans one auto-disable alert across several notifiers.
//
// ORDERING AND ERROR SEMANTICS MATTER HERE. The caller is
// AutoDisableNotificationWorker, which treats a non-nil error as "retry this
// outbox row later" — so if a partial failure returned an error, the notifiers
// that already SUCCEEDED would run again on the retry. That is safe for the
// fanout leg (notifyfanout dedupes on DedupeKey and suppresses the channels the
// second time) and NOT safe for the email leg (a mailer has no such dedup), so
// the fanout runs first and only the last notifier's error propagates. Wire the
// email last.
type MultiAutoDisableNotifier []AutoDisableNotifier

func (m MultiAutoDisableNotifier) NotifyWebhookAutoDisabled(
	ctx context.Context,
	tenantID,
	webhookID string,
) error {
	var last error
	for i, notifier := range m {
		if notifier == nil {
			continue
		}
		err := notifier.NotifyWebhookAutoDisabled(ctx, tenantID, webhookID)
		if err != nil && i < len(m)-1 {
			// A non-terminal leg failed. Swallow it so the retry-driving
			// error can only come from the authoritative last notifier, but
			// never silently: this is the alert about alerts failing.
			slog.Default().Warn("outbound_webhooks: auto-disable notifier leg failed",
				"tenant_id", tenantID, "webhook_id", webhookID, "leg", i, "err", err.Error())
			continue
		}
		last = err
	}
	return last
}
