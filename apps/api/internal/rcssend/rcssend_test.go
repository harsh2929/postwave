// SPDX-License-Identifier: AGPL-3.0-only
package rcssend

import (
	"context"
	"errors"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/omnichannel"
)

type fakeRBM struct {
	delivered bool
	err       error
	calls     int
	lastPhone string
	lastMsg   string
	lastCard  any
}

func (f *fakeRBM) SendRCS(_ context.Context, phone, message string, richCard any) (bool, error) {
	f.calls++
	f.lastPhone, f.lastMsg, f.lastCard = phone, message, richCard
	return f.delivered, f.err
}

type fakeCapability struct {
	capable bool
	err     error
}

func (f fakeCapability) IsRCSCapable(context.Context, string, string) (bool, error) {
	return f.capable, f.err
}

type fakeTemplates struct {
	tmpl *omnichannel.MessageTemplate
	err  error
}

func (f fakeTemplates) GetTemplate(context.Context, string, string) (*omnichannel.MessageTemplate, error) {
	return f.tmpl, f.err
}

type fakeNext struct {
	out   omnichannel.SendOutcome
	calls int
	last  omnichannel.EligibleRecipient
}

func (f *fakeNext) Send(_ context.Context, _ string, rec omnichannel.EligibleRecipient) omnichannel.SendOutcome {
	f.calls++
	f.last = rec
	return f.out
}

func TestRCSSender_CapableSendsViaRBM(t *testing.T) {
	rbm := &fakeRBM{delivered: true}
	s := RCSSender{
		RBM:        rbm,
		Capability: fakeCapability{capable: true},
		Templates:  fakeTemplates{tmpl: &omnichannel.MessageTemplate{BodyText: "Your order shipped!", Media: map[string]any{"title": "Track it"}}},
	}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{
		Channel: "rcs", PhoneE164: "+15551234567", TemplateID: "tmpl1",
	})
	if out.Status != "sent" || out.Provider != "rcs" {
		t.Fatalf("expected a sent RCS message, got %+v", out)
	}
	if rbm.calls != 1 {
		t.Fatalf("expected exactly one RBM call, got %d", rbm.calls)
	}
	if rbm.lastPhone != "+15551234567" {
		t.Fatalf("phone not passed through: %q", rbm.lastPhone)
	}
	if rbm.lastMsg != "Your order shipped!" {
		t.Fatalf("template body not resolved: %q", rbm.lastMsg)
	}
	if rbm.lastCard == nil {
		t.Fatalf("expected rich card media to be passed through")
	}
}

func TestRCSSender_NotCapableFallsBackToSMS(t *testing.T) {
	rbm := &fakeRBM{delivered: true} // would succeed if called
	next := &fakeNext{out: omnichannel.SendOutcome{Status: "sent", Provider: "sms"}}
	s := RCSSender{RBM: rbm, Capability: fakeCapability{capable: false}, Next: next}
	rec := omnichannel.EligibleRecipient{Channel: "rcs", PhoneE164: "+15551234567", RecipientID: "r1"}
	out := s.Send(context.Background(), "t1", rec)

	if rbm.calls != 0 {
		t.Fatalf("RBM must not be called for a non-capable recipient, got %d calls", rbm.calls)
	}
	if next.calls != 1 {
		t.Fatalf("expected fallback to hand off to Next exactly once, got %d", next.calls)
	}
	if next.last.Channel != "sms" {
		t.Fatalf("fallback must flip Channel to sms, got %q", next.last.Channel)
	}
	if next.last.RecipientID != "r1" || next.last.PhoneE164 != "+15551234567" {
		t.Fatalf("fallback must preserve recipient identity, got %+v", next.last)
	}
	if out.Status != "sent" || out.Provider != "sms" {
		t.Fatalf("expected the fallback outcome to surface, got %+v", out)
	}
	if out.Reason == "" {
		t.Fatalf("expected the fallback reason to be recorded")
	}
}

func TestRCSSender_RBMErrorFallsBackToSMS(t *testing.T) {
	rbm := &fakeRBM{err: errors.New("upstream unavailable")}
	next := &fakeNext{out: omnichannel.SendOutcome{Status: "queued", Provider: "sms"}}
	s := RCSSender{RBM: rbm, Next: next}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{Channel: "rcs", PhoneE164: "+15550000000"})

	if rbm.calls != 1 {
		t.Fatalf("expected RBM to be attempted once, got %d", rbm.calls)
	}
	if next.calls != 1 {
		t.Fatalf("expected an RBM error to fall back to Next, got %d calls", next.calls)
	}
	if out.Status != "queued" {
		t.Fatalf("expected the fallback outcome to surface, got %+v", out)
	}
}

func TestRCSSender_NonDeliveredFallsBackToSMS(t *testing.T) {
	rbm := &fakeRBM{delivered: false}
	next := &fakeNext{out: omnichannel.SendOutcome{Status: "sent", Provider: "sms"}}
	s := RCSSender{RBM: rbm, Next: next}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{Channel: "rcs", PhoneE164: "+15550000000"})

	if next.calls != 1 {
		t.Fatalf("expected non-delivery to fall back to Next, got %d calls", next.calls)
	}
	if out.Status != "sent" {
		t.Fatalf("expected the fallback outcome, got %+v", out)
	}
}

func TestRCSSender_NotConfiguredFallsBackToSMS(t *testing.T) {
	next := &fakeNext{out: omnichannel.SendOutcome{Status: "queued", Provider: "sms"}}
	s := RCSSender{RBM: nil, Next: next} // RBM never wired
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{Channel: "rcs", PhoneE164: "+15550000000"})

	if next.calls != 1 {
		t.Fatalf("expected an unconfigured RBM to fall back to Next, got %d calls", next.calls)
	}
	if out.Status != "queued" {
		t.Fatalf("expected the fallback outcome, got %+v", out)
	}
}

func TestRCSSender_NotConfiguredNoNextQueuesWithReason(t *testing.T) {
	s := RCSSender{} // nothing wired at all
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{Channel: "rcs", PhoneE164: "+15550000000"})
	if out.Status != "queued" || out.Provider != "rcs" {
		t.Fatalf("expected a queued documented fallback, got %+v", out)
	}
	if out.Reason == "" {
		t.Fatalf("expected the queued outcome to document why RCS could not send")
	}
}

func TestRCSSender_NoPhoneFallsBackWithoutCallingRBM(t *testing.T) {
	rbm := &fakeRBM{delivered: true}
	next := &fakeNext{out: omnichannel.SendOutcome{Status: "failed", Provider: "sms", Reason: "recipient has no phone number"}}
	s := RCSSender{RBM: rbm, Next: next}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{Channel: "rcs"})
	if rbm.calls != 0 {
		t.Fatalf("must not call RBM with no phone number")
	}
	if next.calls != 1 || out.Status != "failed" {
		t.Fatalf("expected fallback to run and surface its outcome, got calls=%d out=%+v", next.calls, out)
	}
}

func TestRCSSender_NonRCSChannelChainsToNext(t *testing.T) {
	next := &fakeNext{out: omnichannel.SendOutcome{Status: "sent", Provider: "email"}}
	s := RCSSender{Next: next}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{Channel: "email"})
	if next.calls != 1 || out.Status != "sent" {
		t.Fatalf("non-rcs channel must chain straight to Next, got calls=%d out=%+v", next.calls, out)
	}
}

func TestRCSSender_NonRCSChannelNoNextQueues(t *testing.T) {
	s := RCSSender{}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{Channel: "whatsapp"})
	if out.Status != "queued" {
		t.Fatalf("expected a queued record with no Next wired, got %+v", out)
	}
}

func TestRCSSender_TemplateLookupErrorDegradesToFallbackMessage(t *testing.T) {
	rbm := &fakeRBM{delivered: true}
	s := RCSSender{RBM: rbm, Templates: fakeTemplates{err: errors.New("db down")}}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{Channel: "rcs", PhoneE164: "+1", TemplateID: "x"})
	if out.Status != "sent" {
		t.Fatalf("a template lookup error should degrade content, not fail the send: %+v", out)
	}
	if rbm.lastMsg != fallbackMessage {
		t.Fatalf("expected fallbackMessage on template error, got %q", rbm.lastMsg)
	}
}
