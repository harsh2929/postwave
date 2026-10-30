// SPDX-License-Identifier: AGPL-3.0-only
//
// Package notifications is the gating helper that consults the
// `notification_preferences` table (see settings/notifications.go) before
// existing notification senders fire a customer-facing email.
//
// Today three callers are wired in:
//
//	billing.WebhookHandler.handleInvoiceFailed → PrefBounceAlert
//	  (closest match for a payment-failed dunning notice; the table
//	   doesn't have a dedicated "billing_alert" pref column, so this
//	   reuses bounce_alert as the catch-all "operational alert" toggle.)
//
//	approvals.Deps.RequestApprovalHandler → PrefApprovalRequest
//	  (gate the Postmark approval-needed email sent by Service.Request's
//	   notify hook.)
//
//	sending/sendloop.go → PrefSendComplete
//	  Gates each eligible workspace user's send-complete email after the
//	  campaign transition commits. The in-app feed fanout remains independent
//	  of this email preference.
//
// Fail-open contract: any DB error returns true so the original
// notification still fires. The reasoning is "it's worse to silently
// drop a billing dunning notice on a transient pgx hiccup than to send
// one extra email." The `Logger` (when set) gets a Warn on the error
// path so an operator can spot a stuck preferences read.
package notifications

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Pref names a single boolean column in notification_preferences. The
// underscore form keeps the constant readable; the `column` helper maps
// it to the actual `email_on_<pref>` column name.
type Pref string

// Pref values the dispatcher knows about. Adding a new pref requires
// (a) extending the column() switch below and (b) ideally a matching
// boolean column in the notification_preferences table — though the
// fail-open default keeps the gate functional even if the column is
// missing on an older schema.
const (
	PrefSendComplete    Pref = "send_complete"
	PrefApprovalRequest Pref = "approval_request"
	PrefBounceAlert     Pref = "bounce_alert"
	PrefSegmentDecay    Pref = "segment_decay"
	// PrefDeliverabilityAlert gates blocklist-hit / reputation-drop alerts
	// (INBOX-036).
	PrefDeliverabilityAlert Pref = "deliverability_alert"
	// PrefUsageAlert gates usage/spend threshold alerts (BILL-038).
	PrefUsageAlert Pref = "usage_alert"
)

// Dispatcher gates a notification on a per-user pref lookup.
//
// Implementations must be safe for concurrent use; the typical caller is
// a fire-and-forget goroutine (Stripe webhook → goroutine, approvals
// Service.Request → goroutine) and the underlying DB pool is the shared
// pgx pool.
type Dispatcher interface {
	// Gate returns true iff the given user has opted-in to receive
	// emails for this pref. On lookup error, returns true (fail-open
	// — better to over-send than under-send when the table is
	// unreadable). Callers MUST NOT treat the bool as authoritative if
	// err is non-nil; the bool is a fail-open default in that case.
	Gate(ctx context.Context, tenantID, userID string, pref Pref) (bool, error)
}

// PgDispatcher is the production Dispatcher backed by the pgx pool. It
// reads notification_preferences directly under the tenant_id +
// user_id key. RLS is bypassed by virtue of the dispatcher running
// outside a tenant-scoped tx — but the WHERE clause is the isolation
// boundary, mirroring the same pattern billing/email.go already uses
// to read users.email from the public Stripe webhook path.
type PgDispatcher struct {
	Pool   *pgxpool.Pool
	Logger *slog.Logger // optional; nil-safe
}

// Gate implements Dispatcher.
func (d *PgDispatcher) Gate(ctx context.Context, tenantID, userID string, pref Pref) (bool, error) {
	col := column(pref)
	if col == "" {
		// Unknown pref — fail open and surface the misconfiguration.
		// Check this first so a misconfigured caller surfaces even when
		// the dispatcher itself is unconfigured.
		return true, fmt.Errorf("notifications: unknown pref %q", pref)
	}
	if d == nil || d.Pool == nil {
		// Unconfigured dispatcher = fail open. Lets call sites reference
		// a nil-or-default dispatcher and still send the notification.
		return true, nil
	}
	if tenantID == "" || userID == "" {
		// No keys to look up; default-on is the documented behaviour
		// when no row exists, so fast-path returns true here too.
		return true, nil
	}

	// notification_preferences has a RESTRICTIVE tenant_isolation RLS
	// policy: a pool connection with no `app.tenant_id` GUC set will
	// silently filter every row out → pgx.ErrNoRows → fail-open
	// returns true even when the user opted out. Wrap the read in a
	// short tx so set_config(..., true) actually scopes a value.
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		if d.Logger != nil {
			d.Logger.Warn("notifications: tx begin failed; failing open",
				"tenant_id", tenantID, "user_id", userID,
				"pref", string(pref), "err", err.Error())
		}
		return true, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		return true, err
	}
	q := `SELECT ` + col + ` FROM notification_preferences ` +
		`WHERE tenant_id = $1::uuid AND user_id = $2::uuid`
	var allowed bool
	err = tx.QueryRow(ctx, q, tenantID, userID).Scan(&allowed)
	if errors.Is(err, pgx.ErrNoRows) {
		// No row → defaults all-on. Mirrors settings.defaultPrefs in
		// notifications.go, which seeds the same defaults on the GET
		// handler when there's no row yet.
		return true, nil
	}
	if err != nil {
		if d.Logger != nil {
			d.Logger.Warn("notifications: pref lookup failed; failing open",
				"tenant_id", tenantID, "user_id", userID,
				"pref", string(pref), "err", err.Error())
		}
		return true, err
	}
	return allowed, nil
}

// column maps a Pref to its column name. Returns "" for unknown prefs.
func column(p Pref) string {
	switch p {
	case PrefSendComplete:
		return "email_on_send_complete"
	case PrefApprovalRequest:
		return "email_on_approval_request"
	case PrefBounceAlert:
		return "email_on_bounce_alert"
	case PrefSegmentDecay:
		return "email_on_segment_decay"
	case PrefDeliverabilityAlert:
		return "email_on_deliverability_alert"
	case PrefUsageAlert:
		// Keep column() symmetric with baseCategory() (SETC-037). Without this
		// case Gate(PrefUsageAlert) hits the col=="" fail-open branch and would
		// ignore the email_on_usage_alert opt-out the moment a usage-alert email
		// sender (BILL-038) is wired through Gate.
		return "email_on_usage_alert"
	default:
		return ""
	}
}

// baseCategory maps a Pref to the SETC-037 category suffix shared by the
// inapp_on_/webhook_on_ columns, or "" for a category with no channel matrix
// (e.g. segment_decay, which has no in-app/webhook columns).
func baseCategory(p Pref) string {
	switch p {
	case PrefSendComplete:
		return "send_complete"
	case PrefApprovalRequest:
		return "approval_request"
	case PrefBounceAlert:
		return "bounce_alert"
	case PrefDeliverabilityAlert:
		return "deliverability_alert"
	case PrefUsageAlert:
		return "usage_alert"
	default:
		return ""
	}
}

// Channels is the resolved per-channel decision + webhook destination for one
// (user, category), used by the notification fanout (SETC-037).
type Channels struct {
	// InApp gates the bell feed + web/mobile push + SSE. Fails OPEN.
	InApp bool
	// Webhook + WebhookURL drive the Slack/generic outbound webhook. Fail
	// CLOSED — an empty URL or a lookup error simply means no webhook.
	Webhook    bool
	WebhookURL string
	// WebhookKind is "slack" | "generic" and selects the outgoing payload shape.
	// Empty is treated as "slack" by the poster.
	WebhookKind string
}

// Resolve reads the in-app + webhook decision + the user's webhook URL for a
// category in one tenant-scoped tx. In-app fails OPEN (deliver on error /
// unknown category / no row); the webhook channel fails CLOSED.
func (d *PgDispatcher) Resolve(ctx context.Context, tenantID, userID string, pref Pref) (Channels, error) {
	base := baseCategory(pref)
	if base == "" || d == nil || d.Pool == nil || tenantID == "" || userID == "" {
		// No channel matrix for this category, or no keys to look up:
		// deliver in-app (today's default), webhook off.
		return Channels{InApp: true}, nil
	}
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return Channels{InApp: true}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		return Channels{InApp: true}, err
	}
	// Column names come from the fixed baseCategory switch, never user input.
	q := `SELECT inapp_on_` + base + `, webhook_on_` + base +
		`, COALESCE(notification_webhook_url, ''), COALESCE(notification_webhook_kind, 'slack') ` +
		`FROM notification_preferences ` +
		`WHERE tenant_id = $1::uuid AND user_id = $2::uuid`
	var c Channels
	err = tx.QueryRow(ctx, q, tenantID, userID).Scan(&c.InApp, &c.Webhook, &c.WebhookURL, &c.WebhookKind)
	if errors.Is(err, pgx.ErrNoRows) {
		return Channels{InApp: true}, nil
	}
	if err != nil {
		if d.Logger != nil {
			d.Logger.Warn("notifications: channel resolve failed; in-app fails open",
				"tenant_id", tenantID, "user_id", userID, "pref", string(pref), "err", err.Error())
		}
		return Channels{InApp: true}, err
	}
	// The read is complete in c; this tx is read-only (set_config is tx-local,
	// no writes), so release it via the deferred Rollback exactly like Gate()
	// does. Committing here would be superfluous AND harmful: a transient commit
	// error would be surfaced to Dispatch, which discards the correctly-resolved
	// Channels and forces in-app fail-open — over-delivering to a user who
	// legitimately opted OUT of in-app for this category.
	return c, nil
}

// NopDispatcher is a Dispatcher that always returns true. Useful in
// tests and for call sites that want the wire-up without the DB read.
type NopDispatcher struct{}

// Gate always returns true.
func (NopDispatcher) Gate(_ context.Context, _, _ string, _ Pref) (bool, error) {
	return true, nil
}

var _ Dispatcher = (*PgDispatcher)(nil)
var _ Dispatcher = NopDispatcher{}
