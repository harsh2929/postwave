// SPDX-License-Identifier: AGPL-3.0-only
//
// automation_db_test.go — DB-backed tests for the automation.sms outbox
// handler. Skip without DATABASE_URL (same pattern as the other pg-backed
// suites). These lock in the consent-critical invariant: an automation
// send_sms node can only deliver to a phone that is genuinely opted in, with an
// approved sender, and never double-sends on outbox re-dispatch.

package sms

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

// recordingProvider counts Send calls so a test can assert "provider never
// called" (the consent-blocked path) or "called exactly once" (idempotency).
type recordingProvider struct{ calls int }

func (p *recordingProvider) Send(context.Context, ProviderOutbound) (ProviderResult, error) {
	p.calls++
	return ProviderResult{Provider: ProviderTwilio, MessageID: "msg-ok", Status: "queued"}, nil
}

func assertAutomationReleaseHeld(t *testing.T, h *AutomationSMSHandler, ev outbox.Event, provider *recordingProvider) {
	t.Helper()
	err := h.Handle(context.Background(), ev)
	if !errors.Is(err, ErrAutomationSMSDispatchReleaseHeld) {
		t.Fatalf("handle error = %v, want ErrAutomationSMSDispatchReleaseHeld", err)
	}
	if provider.calls != 0 {
		t.Fatalf("release-held automation must not call provider; calls=%d", provider.calls)
	}
}

func automationOutboundCount(t *testing.T, ctx context.Context, pool *db.Pool, tenantID string) int {
	t.Helper()
	var n int
	broadcastQueryRow(t, ctx, pool, tenantID,
		`SELECT count(*) FROM sms_messages WHERE tenant_id = $1::uuid AND direction = 'outbound'`,
		[]any{&n}, tenantID)
	return n
}

func automationEvent(t *testing.T, tenantID, phone, body string) outbox.Event {
	t.Helper()
	payload, err := json.Marshal(automationSMSPayload{
		SubscriberEmail: "v@x.com",
		Phone:           phone,
		Body:            body,
		AutomationID:    "auto-1",
		NodeID:          "node-1",
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return outbox.Event{
		ID:       broadcastUUID(t),
		TenantID: tenantID,
		Kind:     AutomationOutboxKind,
		Payload:  payload,
	}
}

// TestAutomationSMSHandler_DeliversToOptedInPhone is the happy path: approved
// sender + opted-in phone → provider called once, one message recorded carrying
// the automation provenance + outbox event id.
func TestAutomationSMSHandler_DeliversToOptedInPhone(t *testing.T) {
	pool := broadcastDB(t)
	ctx := context.Background()
	tenantID := createBroadcastTenant(t, ctx, pool)
	createSMSSender(t, ctx, pool, tenantID)
	listID := createSMSList(t, ctx, pool, tenantID, "promos")
	phone := "+15552300101"
	seedSubscription(t, ctx, pool, tenantID, listID, phone, "opted_in", "v@x.com")

	prov := &recordingProvider{}
	d := &Deps{Store: &Store{Pool: pool}, Provider: prov}
	h := &AutomationSMSHandler{Deps: d}
	if !smsLegacyDispatchReleaseReady {
		assertAutomationReleaseHeld(t, h, automationEvent(t, tenantID, phone, "Your order shipped"), prov)
		if n := automationOutboundCount(t, ctx, pool, tenantID); n != 0 {
			t.Fatalf("release-held automation recorded %d outbound messages", n)
		}
		return
	}

	if err := h.Handle(ctx, automationEvent(t, tenantID, phone, "Your order shipped")); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if prov.calls != 1 {
		t.Fatalf("want 1 provider send, got %d", prov.calls)
	}
	if n := automationOutboundCount(t, ctx, pool, tenantID); n != 1 {
		t.Fatalf("want 1 recorded message, got %d", n)
	}
	var source, autoID string
	broadcastQueryRow(t, ctx, pool, tenantID, `
		SELECT metadata->>'source', metadata->>'automation_id'
		  FROM sms_messages WHERE tenant_id = $1::uuid AND direction = 'outbound'`,
		[]any{&source, &autoID}, tenantID)
	if source != "automation" || autoID != "auto-1" {
		t.Fatalf("provenance not recorded: source=%q automation_id=%q", source, autoID)
	}
}

// TestAutomationSMSHandler_NoConsentDoesNotSend is the consent-critical test: a
// phone with NO opted-in subscription must never receive an automation SMS. The
// handler acks (returns nil — retrying can't manufacture consent) but the
// provider is never called and nothing is recorded.
func TestAutomationSMSHandler_NoConsentDoesNotSend(t *testing.T) {
	pool := broadcastDB(t)
	ctx := context.Background()
	tenantID := createBroadcastTenant(t, ctx, pool)
	createSMSSender(t, ctx, pool, tenantID)
	// No sms_subscriptions row for this phone at all.
	phone := "+15552300102"

	prov := &recordingProvider{}
	d := &Deps{Store: &Store{Pool: pool}, Provider: prov}
	h := &AutomationSMSHandler{Deps: d}
	if !smsLegacyDispatchReleaseReady {
		assertAutomationReleaseHeld(t, h, automationEvent(t, tenantID, phone, "hi"), prov)
		return
	}

	if err := h.Handle(ctx, automationEvent(t, tenantID, phone, "hi")); err != nil {
		t.Fatalf("handle should ack a consentless send, got err: %v", err)
	}
	if prov.calls != 0 {
		t.Fatalf("consentless send must not reach provider; calls=%d", prov.calls)
	}
	if n := automationOutboundCount(t, ctx, pool, tenantID); n != 0 {
		t.Fatalf("consentless send must not record a message; count=%d", n)
	}
}

// TestAutomationSMSHandler_PendingConsentDoesNotSend: a subscription exists but
// is only "pending" (e.g. double opt-in not completed) — still no send.
func TestAutomationSMSHandler_PendingConsentDoesNotSend(t *testing.T) {
	pool := broadcastDB(t)
	ctx := context.Background()
	tenantID := createBroadcastTenant(t, ctx, pool)
	createSMSSender(t, ctx, pool, tenantID)
	listID := createSMSList(t, ctx, pool, tenantID, "promos")
	phone := "+15552300103"
	seedSubscription(t, ctx, pool, tenantID, listID, phone, "pending", "")

	prov := &recordingProvider{}
	h := &AutomationSMSHandler{Deps: &Deps{Store: &Store{Pool: pool}, Provider: prov}}
	if !smsLegacyDispatchReleaseReady {
		assertAutomationReleaseHeld(t, h, automationEvent(t, tenantID, phone, "hi"), prov)
		return
	}

	if err := h.Handle(ctx, automationEvent(t, tenantID, phone, "hi")); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if prov.calls != 0 {
		t.Fatalf("pending consent must not send; calls=%d", prov.calls)
	}
}

// TestAutomationSMSHandler_SuppressedDoesNotSend: opted in but on the
// suppression list (replied STOP) → no send.
func TestAutomationSMSHandler_SuppressedDoesNotSend(t *testing.T) {
	pool := broadcastDB(t)
	ctx := context.Background()
	tenantID := createBroadcastTenant(t, ctx, pool)
	createSMSSender(t, ctx, pool, tenantID)
	listID := createSMSList(t, ctx, pool, tenantID, "promos")
	phone := "+15552300104"
	seedSubscription(t, ctx, pool, tenantID, listID, phone, "opted_in", "")
	seedSuppression(t, ctx, pool, tenantID, phone, nil)

	prov := &recordingProvider{}
	h := &AutomationSMSHandler{Deps: &Deps{Store: &Store{Pool: pool}, Provider: prov}}
	if !smsLegacyDispatchReleaseReady {
		assertAutomationReleaseHeld(t, h, automationEvent(t, tenantID, phone, "hi"), prov)
		return
	}

	if err := h.Handle(ctx, automationEvent(t, tenantID, phone, "hi")); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if prov.calls != 0 {
		t.Fatalf("suppressed recipient must not send; calls=%d", prov.calls)
	}
}

// TestAutomationSMSHandler_NoApprovedSenderDrops: tenant has only a pending
// (unregistered) sender → no send, ack.
func TestAutomationSMSHandler_NoApprovedSenderDrops(t *testing.T) {
	pool := broadcastDB(t)
	ctx := context.Background()
	tenantID := createBroadcastTenant(t, ctx, pool)
	// A sender that is NOT approved.
	senderID := broadcastUUID(t)
	broadcastExec(t, ctx, pool, tenantID, `
INSERT INTO sms_sender_profiles (id, tenant_id, provider, phone_number, registration_status)
VALUES ($1::uuid, $2::uuid, 'twilio', $3, 'pending')`, senderID, tenantID, "+15005559999")
	listID := createSMSList(t, ctx, pool, tenantID, "promos")
	phone := "+15552300105"
	seedSubscription(t, ctx, pool, tenantID, listID, phone, "opted_in", "")

	prov := &recordingProvider{}
	h := &AutomationSMSHandler{Deps: &Deps{Store: &Store{Pool: pool}, Provider: prov}}
	if !smsLegacyDispatchReleaseReady {
		assertAutomationReleaseHeld(t, h, automationEvent(t, tenantID, phone, "hi"), prov)
		return
	}

	if err := h.Handle(ctx, automationEvent(t, tenantID, phone, "hi")); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if prov.calls != 0 {
		t.Fatalf("no approved sender must not send; calls=%d", prov.calls)
	}
}

// TestAutomationSMSHandler_Idempotent: re-dispatching the SAME outbox event
// (worker crash between send and Complete) must not double-send or double-charge.
func TestAutomationSMSHandler_Idempotent(t *testing.T) {
	pool := broadcastDB(t)
	ctx := context.Background()
	tenantID := createBroadcastTenant(t, ctx, pool)
	createSMSSender(t, ctx, pool, tenantID)
	listID := createSMSList(t, ctx, pool, tenantID, "promos")
	phone := "+15552300106"
	seedSubscription(t, ctx, pool, tenantID, listID, phone, "opted_in", "")

	prov := &recordingProvider{}
	h := &AutomationSMSHandler{Deps: &Deps{Store: &Store{Pool: pool}, Provider: prov}}
	ev := automationEvent(t, tenantID, phone, "ship update")
	if !smsLegacyDispatchReleaseReady {
		assertAutomationReleaseHeld(t, h, ev, prov)
		if n := automationOutboundCount(t, ctx, pool, tenantID); n != 0 {
			t.Fatalf("release-held automation recorded %d outbound messages", n)
		}
		return
	}

	if err := h.Handle(ctx, ev); err != nil {
		t.Fatalf("first handle: %v", err)
	}
	if err := h.Handle(ctx, ev); err != nil { // same event id → replay
		t.Fatalf("second handle: %v", err)
	}
	if prov.calls != 1 {
		t.Fatalf("replay must not re-send; provider calls=%d", prov.calls)
	}
	if n := automationOutboundCount(t, ctx, pool, tenantID); n != 1 {
		t.Fatalf("replay must not record twice; count=%d", n)
	}
}

// TestAutomationSMSHandler_EmptyPhoneOrBodyAcks: a contact with no phone (or an
// empty body) is a terminal data condition — ack without churning the row.
func TestAutomationSMSHandler_EmptyPhoneOrBodyAcks(t *testing.T) {
	pool := broadcastDB(t)
	ctx := context.Background()
	tenantID := createBroadcastTenant(t, ctx, pool)
	createSMSSender(t, ctx, pool, tenantID)

	prov := &recordingProvider{}
	h := &AutomationSMSHandler{Deps: &Deps{Store: &Store{Pool: pool}, Provider: prov}}
	if !smsLegacyDispatchReleaseReady {
		assertAutomationReleaseHeld(t, h, automationEvent(t, tenantID, "", "hi"), prov)
		assertAutomationReleaseHeld(t, h, automationEvent(t, tenantID, "+15552300107", "   "), prov)
		return
	}

	if err := h.Handle(ctx, automationEvent(t, tenantID, "", "hi")); err != nil {
		t.Fatalf("empty phone should ack, got: %v", err)
	}
	if err := h.Handle(ctx, automationEvent(t, tenantID, "+15552300107", "   ")); err != nil {
		t.Fatalf("empty body should ack, got: %v", err)
	}
	if prov.calls != 0 {
		t.Fatalf("empty phone/body must not send; calls=%d", prov.calls)
	}
}
