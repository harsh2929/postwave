// SPDX-License-Identifier: AGPL-3.0-only

package sms

import (
	"context"
	"testing"
	"time"
)

// capturingNotifier records notices on a buffered channel so the detached
// goroutine in notifyInbound can be observed without a sleep.
func capturingNotifier(t *testing.T) (InboundNotifier, chan InboundNotice) {
	t.Helper()
	ch := make(chan InboundNotice, 4)
	return func(_ context.Context, tenantID string, n InboundNotice) {
		n.Provider = n.Provider + "|" + tenantID
		ch <- n
	}, ch
}

func inboundMessage() Message {
	at := time.Date(2026, 7, 27, 10, 7, 30, 0, time.UTC)
	return Message{
		ID:         "11111111-1111-4111-8111-111111111111",
		PhoneE164:  "+15551230000",
		Provider:   "twilio",
		Direction:  "inbound",
		Body:       "do you ship to canada?",
		ReceivedAt: &at,
	}
}

func TestNotifyInboundAnnouncesAHumanReply(t *testing.T) {
	notifier, ch := capturingNotifier(t)
	d := &Deps{Notify: notifier}
	msg := inboundMessage()

	d.notifyInbound("tenant-a", msg, msg.Body, InboundAutoReply{})

	select {
	case got := <-ch:
		if got.MessageID != msg.ID {
			t.Fatalf("message id = %q, want %q", got.MessageID, msg.ID)
		}
		if got.Phone != msg.PhoneE164 {
			t.Fatalf("phone = %q, want %q", got.Phone, msg.PhoneE164)
		}
		if got.Provider != "twilio|tenant-a" {
			t.Fatalf("provider/tenant = %q", got.Provider)
		}
		if !got.ReceivedAt.Equal(msg.ReceivedAt.UTC()) {
			t.Fatalf("receivedAt = %v, want %v", got.ReceivedAt, msg.ReceivedAt.UTC())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no notice delivered for a human reply")
	}
}

// A consent keyword is answered by the carrier-compliance path; interrupting a
// person for it would make the highest-volume inbound class the noisiest.
func TestNotifyInboundStaysSilentForConsentStateKeywords(t *testing.T) {
	for _, body := range []string{"STOP", "stop", "START", "unsubscribe"} {
		notifier, ch := capturingNotifier(t)
		d := &Deps{Notify: notifier}
		msg := inboundMessage()
		msg.Body = body

		d.notifyInbound("tenant-a", msg, body, InboundAutoReply{})

		select {
		case got := <-ch:
			t.Fatalf("consent keyword %q produced a notice: %+v", body, got)
		case <-time.After(150 * time.Millisecond):
		}
	}
}

func TestNotifyInboundAnnouncesHELPWhileConfirmationIsHeld(t *testing.T) {
	notifier, ch := capturingNotifier(t)
	d := &Deps{Notify: notifier}
	msg := inboundMessage()
	msg.Body = "HELP"

	d.notifyInbound("tenant-a", msg, msg.Body, InboundAutoReply{})

	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatal("HELP was silently dropped while the compliance reply is held")
	}
}

// Tenant keyword dispatch is source-held, so a matched inbound still needs a
// human notification until a durable outbound receipt exists.
func TestNotifyInboundAnnouncesWhenKeywordDispatchIsHeld(t *testing.T) {
	notifier, ch := capturingNotifier(t)
	d := &Deps{Notify: notifier}
	msg := inboundMessage()

	d.notifyInbound("tenant-a", msg, msg.Body, InboundAutoReply{
		Matched: true, Keyword: "SALE", Body: "20% off with CODE20",
	})

	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatal("matched keyword was silently dropped while auto-dispatch is held")
	}
}

// The hook is optional: a deployment without a notification fanout must keep
// accepting inbound SMS.
func TestNotifyInboundIsANoOpWithoutAHook(t *testing.T) {
	d := &Deps{}
	msg := inboundMessage()
	d.notifyInbound("tenant-a", msg, msg.Body, InboundAutoReply{}) // must not panic

	notifier, ch := capturingNotifier(t)
	withHook := &Deps{Notify: notifier}
	withHook.notifyInbound("", msg, msg.Body, InboundAutoReply{})
	unknownID := msg
	unknownID.ID = ""
	withHook.notifyInbound("tenant-a", unknownID, msg.Body, InboundAutoReply{})
	select {
	case got := <-ch:
		t.Fatalf("notice delivered without a tenant/message id: %+v", got)
	case <-time.After(150 * time.Millisecond):
	}
}

// A message stored without a receive timestamp still produces a usable
// bucketing input for the notifier's collapsing window.
func TestNotifyInboundFallsBackToNowWhenReceivedAtIsMissing(t *testing.T) {
	notifier, ch := capturingNotifier(t)
	d := &Deps{Notify: notifier}
	msg := inboundMessage()
	msg.ReceivedAt = nil

	before := time.Now().UTC().Add(-time.Second)
	d.notifyInbound("tenant-a", msg, msg.Body, InboundAutoReply{})

	select {
	case got := <-ch:
		if got.ReceivedAt.Before(before) {
			t.Fatalf("receivedAt = %v, want >= %v", got.ReceivedAt, before)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no notice delivered")
	}
}
