// SPDX-License-Identifier: AGPL-3.0-only

package main

// operator_notify_alerts.go — the operator-alert adapters.
//
// Each function here bridges ONE package's narrow, primitive-typed notifier
// interface onto the unified notifyfanout chokepoint. They live together
// because they share a single hard rule that is easy to break one method at a
// time and impossible to see when they are scattered:
//
//	NEVER WIDEN THE AUDIENCE, AND NEVER PUT A BEARER URL IN A PAYLOAD.
//
// A notification is a disclosure. When the producing package already resolved a
// recipient (billing hands us the tenant owner it also emails), this file uses
// that recipient verbatim rather than deriving its own; when it has not
// (auditsink), the audience is the set that can ACT on the alert and is
// verified against BOTH authorization layers — the mount-site wrapper and
// internal/routeauth/manifest.json — before being written down.
//
// Split out of event_billing_notification_adapters.go, which had reached its
// 1000-line budget. The budget is a real constraint and the answer is a
// cohesive file, never a raised ceiling.

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/auditsink"
	"github.com/postwave/postwave/apps/api/internal/billing"
	"github.com/postwave/postwave/apps/api/internal/listmonk_events"
	"github.com/postwave/postwave/apps/api/internal/notifications"
	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
	"github.com/postwave/postwave/apps/api/internal/safego"
)

// operatorNotifyAdapter fans notification-worthy engine events (hard
// bounces, spam complaints) and flow-run failures to the tenant's
// owner+admin operators through the unified notifyfanout chokepoint. The
// recipient query mirrors sendingTenantUserRepo.ListUsersForTenant: the
// explicit tenant_id WHERE clause is the isolation boundary for
// worker-context callers.
//
// The type and its audience derivation live HERE, with the alerts that use
// them, rather than in event_billing_notification_adapters.go. They were split
// apart while NotifyPaymentFailed — whose entire documented rule is "the
// recipient is supplied, not looked up ... deriving an audience here (say,
// adminUserIDs) would tell more people about a tenant's payment trouble than
// the email policy chose to" — sat in one file and adminUserIDs itself sat in
// another. A rule about when NOT to widen an audience is unreadable when the
// widening function is somewhere else.
type operatorNotifyAdapter struct {
	Pool   *pgxpool.Pool
	Fanout *notifyfanout.Fanout
	Logger *slog.Logger
}

func (a *operatorNotifyAdapter) adminUserIDs(ctx context.Context, tenantID string) []string {
	out, err := a.adminUserIDsResult(ctx, tenantID)
	if err != nil && a != nil && a.Logger != nil {
		a.Logger.Warn("operator notify: admin lookup failed", "tenant_id", tenantID, "err", err.Error())
	}
	return out
}

func (a *operatorNotifyAdapter) adminUserIDsResult(ctx context.Context, tenantID string) ([]string, error) {
	if a == nil || a.Pool == nil || tenantID == "" {
		return nil, fmt.Errorf("operator notify: pool and tenant are required")
	}
	rows, err := a.Pool.Query(ctx, `
SELECT id::text
FROM users
WHERE tenant_id = $1::uuid AND role = ANY($2::text[])
ORDER BY created_at ASC`, tenantID, []string{"owner", "admin"})
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]string, 0, 4)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// NotifyEngineEvent implements listmonk_events.EngineEventNotifier. Detached:
// the webhook ingest path never blocks on recipient resolution or channel
// delivery. Soft bounces are deliberately excluded — they self-heal and would
// bury the hard-bounce signal.
func (a *operatorNotifyAdapter) NotifyEngineEvent(ev listmonk_events.CanonicalEvent) {
	if a == nil || a.Fanout == nil || ev.TenantID == "" {
		return
	}
	if ev.EventType == listmonk_events.EventBounced && ev.BounceType == "soft" {
		return
	}
	safego.Go(a.Logger, "operator-notify-engine-event", func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		admins := a.adminUserIDs(ctx, ev.TenantID)
		if len(admins) == 0 {
			return
		}
		payload := map[string]any{"email": ev.SubscriberEmail}
		if ev.CampaignID != "" {
			payload["campaign_id"] = ev.CampaignID
		}
		switch ev.EventType {
		case listmonk_events.EventBounced:
			payload["bounce_type"] = ev.BounceType
			a.Fanout.Dispatch(ctx, ev.TenantID, admins, notifyfanout.Event{
				Type:       "subscriber.bounced",
				Title:      "Subscriber hard-bounced",
				Body:       ev.SubscriberEmail + " hard-bounced and was suppressed.",
				MobileBody: "A subscriber address hard-bounced.",
				URL:        "/app/subscribers",
				EntityID:   ev.CampaignID,
				DedupeKey:  "subscriber.bounced:" + ev.SubscriberEmail + ":" + ev.CampaignID,
				Pref:       notifications.PrefBounceAlert,
				Payload:    payload,
			})
		case listmonk_events.EventComplained:
			a.Fanout.Dispatch(ctx, ev.TenantID, admins, notifyfanout.Event{
				Type:       "subscriber.complained",
				Title:      "Spam complaint",
				Body:       ev.SubscriberEmail + " marked a campaign as spam.",
				MobileBody: "A subscriber filed a spam complaint.",
				URL:        "/app/suppressions",
				EntityID:   ev.CampaignID,
				DedupeKey:  "subscriber.complained:" + ev.SubscriberEmail + ":" + ev.CampaignID,
				Pref:       notifications.PrefBounceAlert,
				Payload:    payload,
			})
		}
	})
}

// NotifyRunFailed implements flowbuilder.RunFailureNotifier. Called from the
// drainer's worker loop (already off the request path), so it runs inline
// with a bounded error string.
func (a *operatorNotifyAdapter) NotifyRunFailed(ctx context.Context, tenantID, runID, flowID, triggerType, errMsg string) {
	if a == nil || a.Fanout == nil || tenantID == "" {
		return
	}
	admins := a.adminUserIDs(ctx, tenantID)
	if len(admins) == 0 {
		return
	}
	if len(errMsg) > 200 {
		errMsg = errMsg[:200] + "…"
	}
	a.Fanout.Dispatch(ctx, tenantID, admins, notifyfanout.Event{
		Type:       "automation.failed",
		Title:      "Automation run failed",
		Body:       "A " + triggerType + "-triggered flow run failed: " + errMsg,
		MobileBody: "An automation run failed.",
		URL:        "/app/automations",
		EntityID:   flowID,
		DedupeKey:  "automation.failed:" + runID,
		Payload:    map[string]any{"run_id": runID, "flow_id": flowID, "trigger": triggerType},
	})
}

// NotifyPaymentFailed implements billing.PaymentFailedNotifier — COMMERCE#4.
//
// A failed charge already flipped billing_state.dunning, wrote an audit row and
// queued a dunning email. Until now that email was the ONLY way anyone found
// out, so a workspace whose owner does not watch that mailbox lapsed in
// silence. This puts the same alert on the in-app feed, the browser and the
// phone.
//
// THE RECIPIENT IS SUPPLIED, NOT LOOKED UP. billing resolves the tenant owner
// and applies the per-user preference gate before calling; deriving an audience
// here (say, adminUserIDs) would tell more people about a tenant's payment
// trouble than the email policy chose to. Same user, more channels — nothing
// else changes.
//
// Runs inline: the caller is already a detached goroutine with a 30s budget.
func (a *operatorNotifyAdapter) NotifyPaymentFailed(ctx context.Context, in billing.PaymentFailedAlert) {
	if a == nil || a.Fanout == nil || in.TenantID == "" || in.UserID == "" {
		return
	}
	// NOTE the deliberate omissions: no amount, and above all no HostedURL.
	// Stripe's hosted invoice page is a bearer URL for a payment surface and
	// must never ride in a notification payload — the in-app destination below
	// makes the customer authenticate first.
	payload := map[string]any{"invoice_id": in.InvoiceID}
	if in.AttemptCount > 0 {
		payload["attempt"] = in.AttemptCount
	}
	a.Fanout.Dispatch(ctx, in.TenantID, []string{in.UserID}, notifyfanout.Event{
		Type:  "billing.payment_failed",
		Title: "Payment failed",
		Body: "Your latest Moosewave payment didn't go through. " +
			"Update your payment method to keep the workspace active.",
		MobileBody: "Your latest payment didn't go through. Update your payment method.",
		URL:        "/app/billing",
		EntityID:   in.InvoiceID,
		// Invoice AND attempt: a Stripe redelivery of the same event is
		// silent, a genuinely new retry attempt alerts again. That matches the
		// email, which also goes out once per attempt.
		DedupeKey: "billing.payment_failed:" + in.InvoiceID + ":" +
			strconv.Itoa(in.AttemptCount),
		// Pref is empty because billing has ALREADY applied the per-user gate
		// (notifications.PrefBounceAlert) before calling — see
		// sendPaymentFailedAsync. Gating twice on the same pref would be
		// harmless; gating on a different one would let an unrelated setting
		// silence a payment failure.
		Payload: payload,
	})
}

// NotifyAuditSinkCircuitOpened implements auditsink.CircuitNotifier —
// GOVERNANCE#48.
//
// When a sink's breaker opens, audit events stop reaching the customer's SIEM
// and start accumulating in audit_sink_dlq. A SIEM cannot raise this alarm for
// you: silence looks exactly like "nothing happened", so the gap is discovered
// during the audit it was meant to survive. Everything needed to notice was
// already on GET /api/v1/audit-sinks; nothing ever pushed it.
//
// AUDIENCE. Owner + admin — the same set that may reset the breaker (POST
// /api/v1/audit-sinks/{id}/circuit/reset is admin-gated at the mount site AND
// in routeauth's manifest). It is strictly NARROWER than who may read the sink
// list, whose session floor is `viewer`, so this discloses nothing new; it just
// tells the people who can actually fix it.
func (a *operatorNotifyAdapter) NotifyAuditSinkCircuitOpened(ctx context.Context, in auditsink.AuditSinkCircuitAlert) {
	if a == nil || a.Fanout == nil || in.TenantID == "" {
		return
	}
	admins := a.adminUserIDs(ctx, in.TenantID)
	if len(admins) == 0 {
		return
	}
	// The operator's own label, bounded. NOT the endpoint: a sink URL can carry
	// a token in its path or query.
	label := strings.TrimSpace(in.SinkName)
	if len(label) > 80 {
		label = label[:80] + "…"
	}
	body := "An audit sink stopped accepting events, so new audit records are being held."
	if label != "" {
		body = "Audit sink “" + label +
			"” stopped accepting events, so new audit records are being held."
	}
	payload := map[string]any{"sink_id": in.SinkID}
	if in.ConsecutiveFailures > 0 {
		payload["consecutive_failures"] = in.ConsecutiveFailures
	}
	a.Fanout.Dispatch(ctx, in.TenantID, admins, notifyfanout.Event{
		Type:  "auditsink.circuit_opened",
		Title: "Audit sink stopped",
		Body:  body,
		// Content-light on the wire: the sink label is the tenant's own text
		// and has no business in a lock-screen payload.
		MobileBody: "An audit sink stopped accepting events. New audit records are being held.",
		URL:        "/app/settings/audit-sinks",
		EntityID:   in.SinkID,
		// One alert per OPEN transition, not per failed batch. The breaker only
		// reports `transitioned` on closed→open and half_open→open, and this
		// key collapses a flapping sink's repeated probes into a single
		// notification until it recovers and opens again.
		DedupeKey: "auditsink.circuit_opened:" + in.SinkID,
		Payload:   payload,
	})
}
