// SPDX-License-Identifier: AGPL-3.0-only
//
// sms_inbound_notification_adapter.go — the composition-root half of
// COMMERCE#2: bind internal/sms's inbound hook to the unified notification
// fanout.
//
// Lives in its own file rather than alongside the other operatorNotifyAdapter
// methods because event_billing_notification_adapters.go is held to a 1000-line
// budget by TestCompositionAdapterFilesStayInsideDefaultSourceBudget, and the
// budget is a ceiling to split under, never one to raise.

package main

import (
	"context"
	"time"

	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
	"github.com/postwave/postwave/apps/api/internal/sms"
)

// inboundSMSNotifyWindow collapses a burst of inbound SMS into one
// notification per tenant per window.
//
// This is a deliberate fidelity-for-safety trade. A single SMS campaign can
// draw thousands of replies inside a minute; one feed row + one push per reply
// per operator would be a self-inflicted denial of service on the very people
// it is meant to help, and no human reads 500 lock-screen pings. A push into
// an inbox is a NUDGE — the inbox itself is the authority on what is unread —
// so collapsing is the correct shape. The window is derived from the message's
// server receive time (not wall clock at dispatch) so concurrent replicas
// compute the same bucket and the feed's (tenant, user, dedupe_key) uniqueness
// does the collapsing for us, without any state of our own.
const inboundSMSNotifyWindow = 15 * time.Minute

// inboundSMSDedupeKey is the collapsing identity for one window. Pure so the
// bucketing rule is testable without a database, a fanout, or a clock.
func inboundSMSDedupeKey(receivedAt time.Time) string {
	if receivedAt.IsZero() {
		receivedAt = time.Now()
	}
	return "sms.received:" + receivedAt.UTC().Truncate(inboundSMSNotifyWindow).Format("20060102T1504Z")
}

// NotifyInboundSMS implements the sms.InboundNotifier hook (COMMERCE#2). The
// caller has already filtered out consent keywords, keyword-auto-answered
// messages and provider retries, and already detached from the webhook
// request, so this runs inline on the goroutine sms gave us.
func (a *operatorNotifyAdapter) NotifyInboundSMS(ctx context.Context, tenantID string, notice sms.InboundNotice) {
	if a == nil || a.Fanout == nil || tenantID == "" {
		return
	}
	admins := a.adminUserIDs(ctx, tenantID)
	if len(admins) == 0 {
		return
	}
	a.Fanout.Dispatch(ctx, tenantID, admins, notifyfanout.Event{
		Type:  "sms.received",
		Title: "New SMS reply",
		// The 15-minute tenant-wide dedupe can collapse different phones. Keep
		// every retained field generic so the surviving row truthfully describes
		// the whole bucket and does not persist E.164 in a notification feed.
		Body: "One or more subscribers replied by SMS. Open the SMS inbox to respond.",
		// The native payload stays content-light: no phone number and never
		// the message text, which would otherwise land on a lock screen.
		MobileBody: "A subscriber replied by SMS.",
		URL:        "/app/sms?tab=inbox",
		DedupeKey:  inboundSMSDedupeKey(notice.ReceivedAt),
	})
}
