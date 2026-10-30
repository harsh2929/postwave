// SPDX-License-Identifier: AGPL-3.0-only

package discounts

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/outbox"
)

// fakeAssigner records the last call and returns a canned error/result.
type fakeAssigner struct {
	calls     int
	lastTenat string
	lastPool  string
	lastIn    CouponAssignmentInput
	err       error
}

func (f *fakeAssigner) AssignCoupon(_ context.Context, tenantID, poolID string, in CouponAssignmentInput, _ time.Time) (*CouponAssignmentResult, error) {
	f.calls++
	f.lastTenat = tenantID
	f.lastPool = poolID
	f.lastIn = in
	if f.err != nil {
		return nil, f.err
	}
	return &CouponAssignmentResult{}, nil
}

func ev(t *testing.T, payload any) outbox.Event {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return outbox.Event{ID: "evt-1", TenantID: "11111111-1111-1111-1111-111111111111", Kind: AutomationCouponKind, Payload: raw}
}

func TestAutomationCouponHandler_Success(t *testing.T) {
	fa := &fakeAssigner{}
	h := &AutomationCouponHandler{Repo: fa}
	e := ev(t, automationCouponPayload{PoolID: "pool-9", SubscriberEmail: "a@b.com", AutomationID: "auto-1", NodeID: "node-7"})
	if err := h.Handle(context.Background(), e); err != nil {
		t.Fatalf("want nil, got %v", err)
	}
	if fa.calls != 1 {
		t.Fatalf("want 1 assign call, got %d", fa.calls)
	}
	if fa.lastPool != "pool-9" || fa.lastTenat != e.TenantID {
		t.Fatalf("wrong pool/tenant: %q %q", fa.lastPool, fa.lastTenat)
	}
	// Idempotency key must be stable per (automation,node).
	if fa.lastIn.ContextKey != "auto-1:node-7" {
		t.Fatalf("want context key auto-1:node-7, got %q", fa.lastIn.ContextKey)
	}
	if fa.lastIn.SubscriberEmail != "a@b.com" {
		t.Fatalf("subscriber not threaded: %q", fa.lastIn.SubscriberEmail)
	}
}

func TestAutomationCouponHandler_TerminalErrorsAck(t *testing.T) {
	for _, term := range []error{ErrInvalidInput, ErrNotFound, ErrCouponExhausted} {
		fa := &fakeAssigner{err: term}
		h := &AutomationCouponHandler{Repo: fa}
		e := ev(t, automationCouponPayload{PoolID: "p", SubscriberEmail: "a@b.com"})
		if err := h.Handle(context.Background(), e); err != nil {
			t.Fatalf("terminal %v should ack (nil), got %v", term, err)
		}
	}
}

func TestAutomationCouponHandler_TransientErrorRetries(t *testing.T) {
	fa := &fakeAssigner{err: errors.New("connection reset")}
	h := &AutomationCouponHandler{Repo: fa}
	e := ev(t, automationCouponPayload{PoolID: "p", SubscriberEmail: "a@b.com"})
	if err := h.Handle(context.Background(), e); err == nil {
		t.Fatal("transient error must be returned so the worker retries")
	}
}

func TestAutomationCouponHandler_BadPayloadAcks(t *testing.T) {
	fa := &fakeAssigner{}
	h := &AutomationCouponHandler{Repo: fa}
	e := outbox.Event{ID: "x", TenantID: "t", Payload: json.RawMessage(`{not json`)}
	if err := h.Handle(context.Background(), e); err != nil {
		t.Fatalf("bad payload must ack, got %v", err)
	}
	if fa.calls != 0 {
		t.Fatalf("must not call AssignCoupon on bad payload, got %d", fa.calls)
	}
}

func TestAutomationCouponHandler_MissingFieldsAck(t *testing.T) {
	cases := []automationCouponPayload{
		{PoolID: "", SubscriberEmail: "a@b.com"}, // no pool
		{PoolID: "p", SubscriberEmail: ""},       // no subscriber
		{PoolID: "  ", SubscriberEmail: "  "},    // whitespace only
	}
	for i, p := range cases {
		fa := &fakeAssigner{}
		h := &AutomationCouponHandler{Repo: fa}
		if err := h.Handle(context.Background(), ev(t, p)); err != nil {
			t.Fatalf("case %d: want ack, got %v", i, err)
		}
		if fa.calls != 0 {
			t.Fatalf("case %d: must not assign on missing fields", i)
		}
	}
}
