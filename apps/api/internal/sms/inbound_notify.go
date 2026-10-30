// SPDX-License-Identifier: AGPL-3.0-only
//
// inbound_notify.go — COMMERCE#2: tell a human that a subscriber texted back.
//
// RecordInbound has always persisted the message and the SMS inbox has always
// rendered it, but nothing ever ANNOUNCED it. An inbox nobody is told about is
// an inbox nobody opens, which is how two-way SMS quietly becomes one-way.
//
// The hook mirrors the existing Mirror hook exactly (a nil-able func field on
// Deps, wired in main.go, fired off the request path, best-effort) so the
// provider webhook never blocks on — or fails because of — notification
// delivery. It is deliberately a func rather than a direct notifyfanout
// dependency: internal/sms must not grow an import edge to the notification
// stack, and main.go already owns the one adapter that resolves a tenant's
// operators.
//
// WHAT IS DELIBERATELY NOT NOTIFIED
//
//   - Carrier STOP/START keywords. ClassifyInbound routes those into durable
//     consent state transitions, so a person need not act on them.
//   - Messages for which a durable automatic reply was actually dispatched.
//     While automatic dispatch is source-held, HELP and tenant keyword matches
//     still notify an operator rather than silently dropping customer intent.
//   - Exact provider retries. The call sites only notify when RecordInbound
//     reports the message as new, so a Twilio redelivery cannot re-ping.
//
// The message BODY is never carried into the notice. A notification payload
// crosses into a push provider and a device lock screen; the phone number is
// the same class of identifier the bounce notification already carries (an
// email address), but the text of a customer's message is not.
package sms

import (
	"context"
	"time"
)

// inboundNotifyTimeout bounds the detached notification attempt. Generous
// because the adapter resolves recipients and fans to two push providers, but
// finite so a wedged provider cannot leak goroutines per inbound message.
const inboundNotifyTimeout = 30 * time.Second

// InboundNotice is the PII-bounded description of one newly received message.
// Deliberately no body text: see the file header.
type InboundNotice struct {
	// MessageID is the sms_messages row id — the entity a client deep-links
	// to and the dedupe input the notifier may key on.
	MessageID string
	// Phone is the sender in E.164. Present so the operator knows which
	// conversation woke them; the notifier decides whether to render it.
	Phone string
	// Provider is the carrier gateway that delivered it (twilio, telnyx, …).
	Provider string
	// ReceivedAt is the server receive time, used by the notifier for its
	// collapsing window so replicas agree on the same bucket.
	ReceivedAt time.Time
}

// InboundNotifier is the shape main.go wires into Deps.Notify.
type InboundNotifier func(ctx context.Context, tenantID string, notice InboundNotice)

// notifyInbound fires the inbound-SMS notification for a message that was just
// stored for the first time. Safe to call with a nil Deps.Notify, an empty
// tenant, or a message that turned out to be machine-handled — every one of
// those is a silent no-op, so call sites stay a single unconditional line.
func (d *Deps) notifyInbound(tenantID string, msg Message, body string, autoReply InboundAutoReply) {
	if d == nil || d.Notify == nil || tenantID == "" || msg.ID == "" {
		return
	}
	action := ClassifyInbound(body)
	if action == ConsentRevoked || action == ConsentGranted {
		// STOP/START are durable consent transitions even while outbound
		// confirmation effects remain held.
		return
	}
	if autoReply.Matched && smsComplianceAutoReplyReleaseReady {
		// Re-enable this suppression only with a durable dispatched-reply
		// receipt. Today the source gate is false, so the operator is notified.
		return
	}
	receivedAt := msg.ReceivedAt
	if receivedAt == nil || receivedAt.IsZero() {
		now := time.Now().UTC()
		receivedAt = &now
	}
	notice := InboundNotice{
		MessageID:  msg.ID,
		Phone:      msg.PhoneE164,
		Provider:   msg.Provider,
		ReceivedAt: receivedAt.UTC(),
	}
	notify := d.Notify
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), inboundNotifyTimeout)
		defer cancel()
		notify(ctx, tenantID, notice)
	}()
}
