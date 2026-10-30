// SPDX-License-Identifier: AGPL-3.0-only
package whatsappsend

import (
	"context"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/omnichannel"
)

type fakeProvider struct {
	calls int
	last  struct{ to, name, lang string }
	msgID string
	err   error
}

func (p *fakeProvider) SendTemplate(_ context.Context, toPhone, templateName, lang string, _ []string) (string, error) {
	p.calls++
	p.last.to, p.last.name, p.last.lang = toPhone, templateName, lang
	if p.err != nil {
		return "", p.err
	}
	return p.msgID, nil
}

type fakeTemplates struct {
	tmpl *Template
	err  error
}

func (t fakeTemplates) GetTemplate(context.Context, string, string) (*Template, error) {
	return t.tmpl, t.err
}

func TestWhatsAppSender_ApprovedTemplateSends(t *testing.T) {
	provider := &fakeProvider{msgID: "wamid.ABC123"}
	s := WhatsAppSender{
		Provider:  provider,
		Templates: fakeTemplates{tmpl: &Template{ID: "tmpl1", Name: "order_shipped", Language: "en_US", Status: "approved"}},
	}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{
		Channel:    "whatsapp",
		PhoneE164:  "+15551234567",
		TemplateID: "tmpl1",
	})
	if out.Status != "sent" {
		t.Fatalf("expected sent, got %+v", out)
	}
	if out.Provider != "whatsapp" {
		t.Fatalf("expected provider=whatsapp, got %+v", out)
	}
	if out.ProviderMessageID != "wamid.ABC123" {
		t.Fatalf("expected provider message id to surface, got %+v", out)
	}
	if provider.calls != 1 || provider.last.to != "+15551234567" || provider.last.name != "order_shipped" || provider.last.lang != "en_US" {
		t.Fatalf("provider not called with the right args: calls=%d last=%+v", provider.calls, provider.last)
	}
}

func TestWhatsAppSender_UnapprovedTemplateRejected(t *testing.T) {
	for _, status := range []string{"pending", "rejected", "paused", "disabled"} {
		provider := &fakeProvider{msgID: "should-not-send"}
		s := WhatsAppSender{
			Provider:  provider,
			Templates: fakeTemplates{tmpl: &Template{ID: "tmpl1", Name: "promo", Language: "en_US", Status: status}},
		}
		out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{
			Channel:    "whatsapp",
			PhoneE164:  "+15551234567",
			TemplateID: "tmpl1",
		})
		if out.Status != "failed" {
			t.Fatalf("status=%s: expected failed, got %+v", status, out)
		}
		if provider.calls != 0 {
			t.Fatalf("status=%s: provider must never be called for an unapproved template, calls=%d", status, provider.calls)
		}
		if out.Reason == "" {
			t.Fatalf("status=%s: expected a reason explaining the rejection", status)
		}
	}
}

func TestWhatsAppSender_NotConfigured(t *testing.T) {
	// Nil provider/templates at the sender level: never even attempts a
	// send, and reports the account as unconfigured rather than erroring
	// or silently dropping the recipient.
	s := WhatsAppSender{}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{
		Channel:    "whatsapp",
		PhoneE164:  "+15551234567",
		TemplateID: "tmpl1",
	})
	if out.Status != "queued" {
		t.Fatalf("expected queued (not failed) when unconfigured, got %+v", out)
	}
	if out.Reason != errNotConfiguredMsg {
		t.Fatalf("expected the standard not-configured reason, got %q", out.Reason)
	}

	// The real Meta provider with no credentials: request construction is
	// real, but SendTemplate fails closed with the same message rather than
	// firing an unauthenticated request.
	real := &MetaCloudProvider{}
	s2 := WhatsAppSender{
		Provider:  real,
		Templates: fakeTemplates{tmpl: &Template{ID: "tmpl1", Name: "order_shipped", Language: "en_US", Status: "approved"}},
	}
	out2 := s2.Send(context.Background(), "t1", omnichannel.EligibleRecipient{
		Channel:    "whatsapp",
		PhoneE164:  "+15551234567",
		TemplateID: "tmpl1",
	})
	if out2.Status != "failed" {
		t.Fatalf("expected failed for an unconfigured real provider, got %+v", out2)
	}
	if out2.Reason != errNotConfiguredMsg {
		t.Fatalf("expected reason %q, got %q", errNotConfiguredMsg, out2.Reason)
	}
}

func TestWhatsAppSender_NonWhatsAppChannelFallsThrough(t *testing.T) {
	// No Next -> queued, matching omnichannel.EmailSender's fallback shape.
	s := WhatsAppSender{Provider: &fakeProvider{}, Templates: fakeTemplates{}}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{Channel: "email"})
	if out.Status != "queued" {
		t.Fatalf("non-whatsapp channel with no Next must queue: %+v", out)
	}

	// With Next set, delegate.
	var delegated bool
	next := chainedSenderFunc(func(context.Context, string, omnichannel.EligibleRecipient) omnichannel.SendOutcome {
		delegated = true
		return omnichannel.SendOutcome{Status: "sent", Provider: "email"}
	})
	s2 := WhatsAppSender{Provider: &fakeProvider{}, Templates: fakeTemplates{}, Next: next}
	out2 := s2.Send(context.Background(), "t1", omnichannel.EligibleRecipient{Channel: "email"})
	if !delegated || out2.Status != "sent" {
		t.Fatalf("expected delegation to Next: delegated=%v out=%+v", delegated, out2)
	}
}

func TestWhatsAppSender_MissingPhone(t *testing.T) {
	s := WhatsAppSender{
		Provider:  &fakeProvider{},
		Templates: fakeTemplates{tmpl: &Template{ID: "tmpl1", Name: "x", Language: "en_US", Status: "approved"}},
	}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{Channel: "whatsapp", TemplateID: "tmpl1"})
	if out.Status != "failed" {
		t.Fatalf("missing phone must fail, got %+v", out)
	}
}

func TestWhatsAppSender_TemplateNotFound(t *testing.T) {
	s := WhatsAppSender{
		Provider:  &fakeProvider{},
		Templates: fakeTemplates{tmpl: nil},
	}
	out := s.Send(context.Background(), "t1", omnichannel.EligibleRecipient{Channel: "whatsapp", PhoneE164: "+15551234567", TemplateID: "missing"})
	if out.Status != "failed" {
		t.Fatalf("missing template must fail, got %+v", out)
	}
}

// chainedSenderFunc lets a plain function satisfy omnichannel.ChannelSender
// for the fallthrough test above.
type chainedSenderFunc func(context.Context, string, omnichannel.EligibleRecipient) omnichannel.SendOutcome

func (f chainedSenderFunc) Send(ctx context.Context, tenantID string, rec omnichannel.EligibleRecipient) omnichannel.SendOutcome {
	return f(ctx, tenantID, rec)
}
