// SPDX-License-Identifier: AGPL-3.0-only
//
// notifier.go owns the per-recipient gating glue between the approvals
// Notifier (today: PostmarkNotifier in notify.go) and the
// notifications.Dispatcher. The PostmarkNotifier historically iterated a
// single tenant-level "approval_notify_email" address; that was a fine
// inbox model but it made per-user pref gating impossible because the
// dispatcher.Gate signature is (tenantID, userID, pref) and there is no
// userID for a generic mailing-list address.
//
// The new shape:
//
//   - AdminLister returns the list of (user_id, email) pairs that should
//     receive an approval-request email for tenantID. Production wires
//     this to the `users` table filtered by role IN ('owner','admin').
//   - PerRecipientGater wraps an inner per-recipient send (the Postmark
//     HTTP call) with a notifications.Dispatcher.Gate(...) check keyed
//     on the recipient's user_id. Fail-open: a DB error on the gate
//     lookup logs and proceeds to send (mirrors PgDispatcher's contract).
//
// The handler used to perform a single pre-Request gate keyed on the
// REQUESTER's user_id, which silenced the notifier for every recipient
// when the requester had opted out. That's wrong: approvals fan out to
// every tenant admin, and each admin's pref is their own choice. The
// fix moves the gate from handler-level to per-recipient inside the
// notifier loop.
//
// WithSilencedNotifier() remains available on Service.Request for the
// "kill the whole dispatch" case (cron sweeps, test fixtures, etc.) and
// is unaffected by this refactor.
package approvals

import (
	"context"
	"log/slog"

	"github.com/postwave/postwave/apps/api/internal/notifications"
)

// AdminRecipient is one (user_id, email) pair the approvals notifier
// will email. The user_id keys the per-user pref lookup in
// notifications.Dispatcher.Gate; the email is the SMTP envelope address.
type AdminRecipient struct {
	UserID string
	Email  string
}

// AdminLister returns the recipients that should receive an
// approval-request email for tenantID. Implementations are responsible
// for filtering on role (owner/admin) and for not returning duplicates.
// Empty list = no recipients; the notifier becomes a no-op.
type AdminLister interface {
	ListApprovalRecipients(ctx context.Context, tenantID string) ([]AdminRecipient, error)
}

// AdminListerFunc adapts a function to the AdminLister interface. The
// adapter is here mostly for tests that supply a static recipient list
// inline.
type AdminListerFunc func(ctx context.Context, tenantID string) ([]AdminRecipient, error)

// ListApprovalRecipients implements AdminLister by calling f.
func (f AdminListerFunc) ListApprovalRecipients(ctx context.Context, tenantID string) ([]AdminRecipient, error) {
	return f(ctx, tenantID)
}

// gateRecipient consults the dispatcher to decide whether the named
// recipient should receive an approval-request email. Fail-open: any
// error from the dispatcher returns true so the message still fires,
// matching the contract documented on notifications.Dispatcher.
//
// Centralised so PostmarkNotifier and any future Notifier impl reuse
// the exact same fail-open semantics + log shape.
func gateRecipient(ctx context.Context, d notifications.Dispatcher, logger *slog.Logger, tenantID string, r AdminRecipient) bool {
	if d == nil {
		return true
	}
	allowed, err := d.Gate(ctx, tenantID, r.UserID, notifications.PrefApprovalRequest)
	if err != nil {
		if logger != nil {
			logger.Warn("approvals: per-recipient gate failed; failing open",
				"tenant_id", tenantID, "user_id", r.UserID, "err", err.Error())
		}
		return true
	}
	return allowed
}

// notifierLogger returns a non-nil logger so call sites don't sprinkle
// nil checks. Falls back to slog.Default(), which writes to stderr.
func notifierLogger(l *slog.Logger) *slog.Logger {
	if l != nil {
		return l
	}
	return slog.Default()
}
