package sms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

// AutomationOutboxKind is the cross-service outbox kind a services/automation
// send_sms node enqueues (runtime.smsKind). apps/api owns delivery because the
// automation engine has no provider credentials and must never bypass consent —
// this handler re-runs the full SMS Gate (consent / quiet-hours / cost /
// suppression) before a single message leaves the building.
//
// MUST stay equal to services/automation/internal/runtime.smsKind.
const AutomationOutboxKind = "automation.sms"

var ErrAutomationSMSDispatchReleaseHeld = errors.New("automation sms dispatch release-held: durable budget/reconciliation unavailable")

// automationSMSPayload mirrors runtime.SMSSendRequest in services/automation.
// Keep the json tags in sync — this is the wire contract for the outbox row.
type automationSMSPayload struct {
	SubscriberEmail string `json:"subscriber_email"`
	Phone           string `json:"phone"`
	Body            string `json:"body"`
	AutomationID    string `json:"automation_id"`
	NodeID          string `json:"node_id"`
}

// AutomationSMSHandler delivers automation.sms outbox rows through the exact
// same consent path as every other outbound SMS: resolve a sendable sender,
// bind the recipient to a list they are genuinely opted into, run the Gate, and
// only then dispatch + record. No automation graph can short-circuit consent,
// quiet-hours, suppression, or cost caps.
type AutomationSMSHandler struct {
	Deps *Deps
}

// Handle implements outbox.HandlerFunc for kind=automation.sms.
//
// Ack-vs-retry policy (the outbox is at-least-once; returning nil acks the row,
// returning an error backs off and retries until MaxAttempts → DLQ):
//   - parse failure, empty phone/body, no approved sender, or a TERMINAL gate
//     rejection (no consent / suppressed / sender not approved) → log + ack.
//     Retrying cannot change the outcome, and a permanent error would just DLQ.
//   - TRANSIENT gate rejection (quiet_hours / tenant_limit_reached) or any DB /
//     provider error → return error so the worker retries with backoff. Quiet
//     hours in particular must defer, not drop.
//
// Idempotency: each outbox event id is stamped into the recorded message's
// metadata and checked first, so a worker re-dispatch (crash between send and
// Complete) never double-charges or double-texts the recipient.
func (h *AutomationSMSHandler) Handle(ctx context.Context, ev outbox.Event) error {
	// A live provider effect cannot precede durable budget reservation and a
	// provider-bound intent/reconciliation record. Preserve the outbox row for
	// retry/DLQ visibility, but never cross the provider boundary until the same
	// saga used by inbox replies is available.
	if !smsLegacyDispatchReleaseReady {
		return ErrAutomationSMSDispatchReleaseHeld
	}
	d := h.Deps
	if d == nil {
		return errors.New("automation sms: nil deps")
	}

	var p automationSMSPayload
	if err := json.Unmarshal(ev.Payload, &p); err != nil {
		// Unparseable payload is terminal — never retry a row we can't read.
		d.logAutomationSMS("automation sms: bad payload, dropping", ev.TenantID, ev.ID, err)
		return nil
	}

	body := strings.TrimSpace(p.Body)
	phone := strings.TrimSpace(p.Phone)
	if body == "" || phone == "" {
		// Nothing deliverable (e.g. contact has no phone on file). Ack so the
		// row doesn't churn forever; a phone won't appear by retrying.
		d.logAutomationSMS("automation sms: empty body or phone, dropping", ev.TenantID, ev.ID, nil)
		return nil
	}

	// Idempotency guard: was this exact outbox row already delivered? This
	// catches the common replay — the handler errored after recording, or a
	// fully-successful row is re-leased. It does NOT close the crash window
	// between safeProviderSend and RecordOutbound (provider charged, row never
	// written → a re-dispatch sends again). That residual at-least-once exposure
	// is identical to the campaign worker's record-after-send path; we accept it
	// rather than reserve-before-send, because a reservation that crashed before
	// dispatch would DROP a consent-critical message — the worse failure.
	if already, err := d.store().automationSMSAlreadySent(ctx, ev.TenantID, ev.ID); err != nil {
		return err // transient DB error → retry
	} else if already {
		return nil
	}

	// Pick a sendable sender (approved registration, not paused by kill switch).
	sender, ok, err := d.store().firstSendableSender(ctx, ev.TenantID)
	if err != nil {
		return err // transient DB error → retry
	}
	if !ok {
		d.logAutomationSMS("automation sms: no approved sender, dropping", ev.TenantID, ev.ID, nil)
		return nil // terminal: tenant has no approved/active sender
	}

	// Bind the Gate's consent check to a list this phone is actually opted into.
	// Empty listID makes Gate treat the subscription as pending → it rejects
	// with sms_consent_required, so a missing opt-in can never send.
	listID, err := d.store().optedInListForPhone(ctx, ev.TenantID, phone)
	if err != nil {
		return err // transient DB error → retry
	}

	// limitRemaining=-1 matches every other Gate caller (campaign worker, inbox
	// reply, send-test): per-recipient Gate does NOT enforce tenant spend. Cost
	// caps are a per-campaign policy applied at the broadcast layer; individual
	// triggered sends (replies, automation) aren't campaign-capped.
	normPhone, decision, err := d.store().Gate(ctx, ev.TenantID, sender, listID, phone, body, -1)
	if err != nil {
		// invalid_phone surfaces here as (err != nil) with a terminal decision;
		// treat a normalization failure as terminal, anything else as transient.
		if decision.Reason == "invalid_phone" {
			d.logAutomationSMS("automation sms: invalid phone, dropping", ev.TenantID, ev.ID, err)
			return nil
		}
		return err
	}
	if !decision.Allowed {
		if gateReasonTransient(decision.Reason) {
			// quiet_hours / tenant_limit_reached — defer and retry later.
			return fmt.Errorf("automation sms deferred: %s", decision.Reason)
		}
		// Terminal: consent absent / suppressed / sender not approved. A
		// recipient_suppressed row with a future expires_at is treated terminal
		// here too — same as the campaign path, which skips suppressed
		// recipients without re-queuing for after the window. A triggered
		// automation send is a point-in-time message, not a standing audience.
		d.logAutomationSMS("automation sms gated: "+decision.Reason, ev.TenantID, ev.ID, nil)
		return nil
	}

	provider := d.Provider
	if provider == nil {
		return errors.New("automation sms: provider not configured")
	}

	in := SendInput{
		SenderProfileID: sender.ID,
		ListID:          listID,
		To:              normPhone,
		Body:            body,
		Metadata: map[string]any{
			"source":           "automation",
			"automation_id":    p.AutomationID,
			"node_id":          p.NodeID,
			"subscriber_email": p.SubscriberEmail,
			"outbox_event_id":  ev.ID,
		},
	}
	result, err := safeProviderSend(ctx, provider, ProviderOutbound{
		Provider:            sender.Provider,
		To:                  normPhone,
		Body:                body,
		FromNumber:          sender.PhoneNumber,
		MessagingServiceSID: sender.MessagingServiceSID,
		StatusCallbackURL:   d.statusCallbackURL(sender.Provider, ev.TenantID, sender.ID),
	})
	if err != nil {
		return err // transient provider error → retry
	}
	if _, err := d.store().RecordOutbound(ctx, ev.TenantID, in, normPhone, decision, result); err != nil {
		return err
	}
	return nil
}

// gateReasonTransient reports whether a gate rejection should be retried later
// rather than dropped. Only quiet-hours and tenant rate-limit windows clear on
// their own; consent/suppression/sender-not-approved are terminal for this row.
func gateReasonTransient(reason string) bool {
	switch reason {
	case "quiet_hours", "tenant_limit_reached":
		return true
	default:
		return false
	}
}

func (d *Deps) logAutomationSMS(msg, tenantID, eventID string, err error) {
	if d.Logger == nil {
		return
	}
	attrs := []any{"tenant_id", tenantID, "outbox_event_id", eventID}
	if err != nil {
		attrs = append(attrs, "err", err.Error())
	}
	d.Logger.Warn(msg, attrs...)
}

// firstSendableSender returns the first approved, non-paused sender profile for
// the tenant — the same sendability rule Store.Setup uses to compute CanSend.
// ok=false means the tenant has no sender able to send right now.
func (s *Store) firstSendableSender(ctx context.Context, tenantID string) (SenderProfile, bool, error) {
	senders, err := s.ListSenders(ctx, tenantID)
	if err != nil {
		return SenderProfile{}, false, err
	}
	for _, sender := range senders {
		if sender.RegistrationStatus == RegistrationApproved && !SenderPaused(sender.Metadata) {
			return sender, true, nil
		}
	}
	return SenderProfile{}, false, nil
}

// optedInListForPhone returns a list_id the phone is currently opted into for
// SMS in this tenant (most-recently-consented first), or "" if none. The
// automation SMS path passes this into Gate so the consent check is anchored to
// a real opt-in instead of defaulting to pending.
func (s *Store) optedInListForPhone(ctx context.Context, tenantID, phone string) (string, error) {
	normalized, err := NormalizePhoneUSCA(phone)
	if err != nil {
		return "", nil // unnormalizable → no consent record can match; Gate will reject
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var listID string
	err = tx.QueryRow(ctx, `
		SELECT list_id::text
		  FROM sms_subscriptions
		 WHERE tenant_id = $1::uuid
		   AND phone_e164 = $2
		   AND public.sms_subscription_send_eligible(
		     tenant_id, list_id, phone_e164, status,
		     consent_source, consent_text, consent_at, proof)
		 ORDER BY consent_at DESC NULLS LAST, created_at DESC
		 LIMIT 1`, tenantID, normalized).Scan(&listID)
	if err != nil {
		if isNoRows(err) {
			return "", tx.Commit(ctx)
		}
		return "", err
	}
	return listID, tx.Commit(ctx)
}

// automationSMSAlreadySent reports whether an outbound message recording this
// outbox event id already exists — the idempotency guard against worker
// re-dispatch double-sending.
func (s *Store) automationSMSAlreadySent(ctx context.Context, tenantID, outboxEventID string) (bool, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM sms_messages
			 WHERE tenant_id = $1::uuid
			   AND direction = 'outbound'
			   AND metadata->>'outbox_event_id' = $2
		)`, tenantID, outboxEventID).Scan(&exists); err != nil {
		return false, err
	}
	return exists, tx.Commit(ctx)
}
