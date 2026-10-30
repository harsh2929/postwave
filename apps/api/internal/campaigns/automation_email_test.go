package campaigns

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/sendallowance"
)

type fakeSuppression struct {
	suppressed bool
	err        error
}

func (f fakeSuppression) Check(_ context.Context, _, _ string) (bool, error) {
	return f.suppressed, f.err
}

type fakePause struct {
	paused bool
	reason string
}

func (f fakePause) EmailSendingPaused(_ context.Context, _ string) (bool, string, error) {
	return f.paused, f.reason, nil
}

type fakeEmailSender struct {
	sent []listmonk.SendTransactionalReq
	err  error
}

type automationAllowance struct {
	err       error
	reserved  int
	committed int
	released  int
}

func (a *automationAllowance) Reserve(_ context.Context, in sendallowance.Request) (sendallowance.Reservation, error) {
	a.reserved++
	if a.err != nil {
		return sendallowance.Reservation{}, a.err
	}
	return sendallowance.Reservation{ID: "r", TenantID: in.TenantID, Managed: true, Units: 1}, nil
}
func (a *automationAllowance) Commit(context.Context, sendallowance.Reservation) error {
	a.committed++
	return nil
}
func (a *automationAllowance) Release(context.Context, sendallowance.Reservation, string) error {
	a.released++
	return nil
}

func (f *fakeEmailSender) SendTransactional(_ context.Context, req listmonk.SendTransactionalReq) error {
	f.sent = append(f.sent, req)
	return f.err
}

func emailPayload(t *testing.T, tpl string) []byte {
	t.Helper()
	b, err := json.Marshal(automationEmailPayload{
		SubscriberEmail: "u@x.com",
		TemplateID:      tpl,
		AutomationID:    "a",
		NodeID:          "n1",
	})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The whole reason this handler exists: a flow's send_email called Listmonk
// directly and could mail a SUPPRESSED address. It must not.
func TestAutomationEmail_SuppressedRecipientIsNeverMailed(t *testing.T) {
	sender := &fakeEmailSender{}
	h := &AutomationEmailHandler{
		Suppression: fakeSuppression{suppressed: true},
		Sender:      sender,
	}
	if err := h.Deliver(context.Background(), "t", emailPayload(t, "7")); err != nil {
		t.Fatalf("a suppressed recipient is terminal, not an error: %v", err)
	}
	if len(sender.sent) != 0 {
		t.Fatal("a suppressed address must never be mailed by a flow")
	}
}

// A paused tenant must not have flows quietly mailing on its behalf. Deferring
// (not dropping) lets the outbox retry once sending resumes.
func TestAutomationEmail_KillSwitchDefersRatherThanSends(t *testing.T) {
	sender := &fakeEmailSender{}
	h := &AutomationEmailHandler{
		Pause:       fakePause{paused: true, reason: "billing"},
		Suppression: fakeSuppression{},
		Sender:      sender,
	}
	err := h.Deliver(context.Background(), "t", emailPayload(t, "7"))
	if !errors.Is(err, ErrAutomationEmailDeferred) {
		t.Fatalf("a paused tenant must defer, got %v", err)
	}
	if len(sender.sent) != 0 {
		t.Fatal("the kill switch must stop the send")
	}
}

// A numeric id is a listmonk template and passes straight through.
func TestAutomationEmail_NumericTemplateIsPassedThrough(t *testing.T) {
	sender := &fakeEmailSender{}
	h := &AutomationEmailHandler{Suppression: fakeSuppression{}, Sender: sender}
	if err := h.Deliver(context.Background(), "t", emailPayload(t, "7")); err != nil {
		t.Fatal(err)
	}
	if len(sender.sent) != 1 || sender.sent[0].TemplateID != 7 {
		t.Fatalf("numeric template id must pass through; got %+v", sender.sent)
	}
}

// A send_email node with no template must fail loudly.
func TestAutomationEmail_MissingTemplateErrors(t *testing.T) {
	h := &AutomationEmailHandler{Suppression: fakeSuppression{}, Sender: &fakeEmailSender{}}
	if err := h.Deliver(context.Background(), "t", emailPayload(t, "")); err == nil {
		t.Fatal("a missing template_id must error")
	}
}

func TestAutomationEmail_AllowanceExhaustionDefersWithoutSending(t *testing.T) {
	sender := &fakeEmailSender{}
	gate := &automationAllowance{err: &sendallowance.ExhaustedError{Limit: 1, Current: 1, Requested: 1}}
	h := &AutomationEmailHandler{Suppression: fakeSuppression{}, Sender: sender, Allowance: gate, RequireAllowance: true}
	err := h.Handle(context.Background(), outbox.Event{ID: "event-1", TenantID: "tenant-1", Payload: emailPayload(t, "7")})
	if !errors.Is(err, ErrAutomationEmailDeferred) || !errors.Is(err, sendallowance.ErrExhausted) {
		t.Fatalf("allowance error = %v, want deferred + exhausted", err)
	}
	if len(sender.sent) != 0 || gate.committed != 0 {
		t.Fatalf("exhausted automation crossed provider: sent=%d committed=%d", len(sender.sent), gate.committed)
	}
}

func TestAutomationEmail_UsesOutboxIdentityForAllowanceAndProviderDedup(t *testing.T) {
	sender := &fakeEmailSender{}
	gate := &automationAllowance{}
	h := &AutomationEmailHandler{Suppression: fakeSuppression{}, Sender: sender, Allowance: gate, RequireAllowance: true}
	if err := h.Handle(context.Background(), outbox.Event{ID: "event-1", TenantID: "tenant-1", Payload: emailPayload(t, "7")}); err != nil {
		t.Fatal(err)
	}
	if len(sender.sent) != 1 || sender.sent[0].IdempotencyKey != "automation-outbox:event-1" || gate.committed != 1 {
		t.Fatalf("automation identities diverged: sent=%+v gate=%+v", sender.sent, gate)
	}
}

func TestAutomationEmail_DefiniteProviderRejectionReleasesAllowance(t *testing.T) {
	sender := &fakeEmailSender{err: &listmonk.HTTPError{Method: "POST", Path: "/api/tx", StatusCode: 400}}
	gate := &automationAllowance{}
	h := &AutomationEmailHandler{Suppression: fakeSuppression{}, Sender: sender, Allowance: gate, RequireAllowance: true}
	if err := h.Handle(context.Background(), outbox.Event{ID: "event-1", TenantID: "tenant-1", Payload: emailPayload(t, "7")}); err == nil {
		t.Fatal("provider rejection must remain visible to the outbox")
	}
	if gate.committed != 1 || gate.released != 1 {
		t.Fatalf("definite rejection did not reconcile allowance: %+v", gate)
	}
}
