// SPDX-License-Identifier: AGPL-3.0-only
//
// Customer-facing email notifications fired from the billing webhook
// path. Today this is just the payment-failed dunning email; future
// notifications (refund-issued, plan-change-confirmation, etc.) belong
// here too.
//
// Sender abstraction: we accept a narrow interface (PaymentFailedMailer)
// rather than coupling to internal/mailer.Mailer directly so a Stripe
// test that constructs a WebhookHandler doesn't have to spin up a real
// SES client. main.go wires the actual mailer.

package billing

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// PaymentFailedMailer is the narrow contract billing needs to send a
// dunning email. Implementations are responsible for their own
// transport (SES, SMTP, listmonk transactional, etc.). Should be safe
// for concurrent use.
type PaymentFailedMailer interface {
	SendPaymentFailed(ctx context.Context, in PaymentFailedEmail) error
}

// PaymentFailedEmail is the rendered envelope for the dunning notice.
type PaymentFailedEmail struct {
	To           string // owner email
	HostedURL    string // Stripe hosted invoice URL — where they update card
	AttemptCount int
}

// PaymentFailedNotifier is the narrow contract billing needs to raise the
// dunning alert on the NON-email channels — in-app feed, web push, SSE, and
// native mobile push (COMMERCE#4).
//
// Kept to primitives on purpose. The implementation (main.go's
// operatorNotifyAdapter) owns the notifyfanout wiring; billing must not import
// the notification stack to gain a channel, and this way the payments package
// stays testable with a two-line fake.
//
// It returns nothing: like the email leg, this is best-effort and must never
// fail a Stripe webhook — an error here would make Stripe retry the entire
// event chain, re-running SetDunning and re-emitting the audit row.
type PaymentFailedNotifier interface {
	NotifyPaymentFailed(ctx context.Context, in PaymentFailedAlert)
}

// PaymentFailedAlert is what the non-email channels need. The recipient is
// resolved by the caller so it is provably the SAME user the dunning email
// goes to — the owner — rather than a separately-derived audience.
type PaymentFailedAlert struct {
	TenantID string
	UserID   string
	// InvoiceID and AttemptCount together identify one failed attempt. They
	// form the dedupe key, so a Stripe REDELIVERY of the same event is
	// silent while a genuinely new retry attempt alerts again — matching the
	// cadence of the email, which also sends once per attempt.
	InvoiceID    string
	AttemptCount int
	// HostedURL is Stripe's hosted invoice page. Deliberately NOT put into any
	// push payload: it is a bearer URL for a payment surface.
	HostedURL string
}

// billingPaymentFailedEmailFailures counts emails that didn't send.
// We don't fail the webhook on email errors (Stripe would retry the
// whole event, double-charging the customer's audit log) — instead we
// log and bump this counter. Alert when nonzero.
var billingPaymentFailedEmailFailures = promauto.NewCounter(prometheus.CounterOpts{
	Name: "billing_payment_failed_email_failures_total",
	Help: "Total customer-facing payment-failed emails that failed to enqueue/send. Webhook itself succeeds regardless; this is a degraded-comms signal.",
})

// ownerEmailForTenant resolves the tenant's owner-role user's email.
// Returns "" + nil error when no owner row exists (we treat that as a
// "skip the email" rather than an error so the webhook still acks).
//
// We pick the EARLIEST-created owner so a tenant with multiple owners
// gets a stable choice (the original creator).
//
// IMPORTANT: previously this opened a bare pool.QueryRow and the
// docstring claimed "the query bypasses RLS because we're in the
// public Stripe webhook path". That was wrong: the `users` table has
// FORCE RLS with a `tenant_isolation` policy, so a bare query with
// no `app.tenant_id` GUC set returned ZERO rows for every tenant.
// Result: every payment-failed Stripe webhook silently skipped the
// dunning email (function returned ""+nil; webhook ack'd Stripe;
// customer learned about the failed card by getting locked out).
//
// Fix: open a tenant-scoped tx via db.WithTenant so the RLS policy
// matches the row.
func ownerEmailForTenant(ctx context.Context, pool poolQuerier, tenantID string) (string, error) {
	email, _, err := ownerEmailAndIDForTenant(ctx, pool, tenantID)
	return email, err
}

// ownerEmailAndIDForTenant is the gating-friendly variant: returns the
// owner email AND the owner user_id so callers can consult the
// notification_preferences row before sending. user_id is "" when no
// owner exists.
func ownerEmailAndIDForTenant(ctx context.Context, pool poolQuerier, tenantID string) (string, string, error) {
	if pool == nil || tenantID == "" {
		return "", "", nil
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", "", fmt.Errorf("owner email lookup begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		"SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		return "", "", fmt.Errorf("owner email lookup set_config: %w", err)
	}
	var email, userID string
	err = tx.QueryRow(ctx, `
SELECT email, id::text FROM users
 WHERE tenant_id = $1::uuid
   AND role = 'owner'
 ORDER BY created_at ASC
 LIMIT 1`, tenantID).Scan(&email, &userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", nil
	}
	if err != nil {
		return "", "", fmt.Errorf("owner email lookup: %w", err)
	}
	return strings.TrimSpace(email), strings.TrimSpace(userID), nil
}

// poolQuerier is the narrow surface ownerEmailForTenant needs from a
// pgx pool. Defined here so a test can pass a stub without standing up
// a real pool. The Begin returns a Tx that exposes Exec + QueryRow +
// Rollback — the minimum needed to scope the read to a tenant GUC.
type poolQuerier interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// RenderPaymentFailedEmail returns (subject, plainBody, htmlBody) for
// the dunning notice. Pulled out so a test can pin the copy without
// having to mock a full mailer; exported so a main.go-level mailer
// adapter can render without re-implementing the copy.
func RenderPaymentFailedEmail(in PaymentFailedEmail) (subject, plain, html string) {
	updateURL := strings.TrimSpace(in.HostedURL)
	if updateURL == "" {
		updateURL = "https://billing.stripe.com/p/login/" // generic billing portal hint
	}
	subject = "Payment failed — action needed"
	plain = strings.Join([]string{
		"Hi,",
		"",
		"Your most recent Moosewave payment didn't go through. We're",
		"automatically retrying — but if it keeps failing your account",
		"will be flagged for dunning and sending will be paused.",
		"",
		"Update your card here so we can take it from there:",
		updateURL,
		"",
		"Questions? Just reply to this email.",
		"",
		"— Moosewave",
	}, "\n")
	html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:#111;max-width:540px;margin:0 auto;padding:24px">
<h2 style="margin:0 0 16px">Payment failed — action needed</h2>
<p>Hi,</p>
<p>Your most recent Moosewave payment didn't go through. We're automatically retrying — but if it keeps failing your account will be flagged for dunning and sending will be paused.</p>
<p><a href="` + updateURL + `" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px">Update payment method</a></p>
<p>Or copy this link: <code>` + updateURL + `</code></p>
<p>Questions? Just reply to this email.</p>
<p>— Moosewave</p>
</body></html>`
	return subject, plain, html
}
