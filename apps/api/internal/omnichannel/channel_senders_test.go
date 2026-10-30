// SPDX-License-Identifier: AGPL-3.0-only
package omnichannel

import (
	"context"
	"errors"
	"testing"
)

type fakeMailer struct {
	sent int
	err  error
	last struct{ to, subject string }
}

func (m *fakeMailer) Send(_ context.Context, _, to, subject, _, _ string) error {
	m.sent++
	m.last.to, m.last.subject = to, subject
	return m.err
}

type fakeTemplates struct {
	tmpl *MessageTemplate
	err  error
}

func (t fakeTemplates) GetTemplate(context.Context, string, string) (*MessageTemplate, error) {
	return t.tmpl, t.err
}

func TestEmailSender_Sends(t *testing.T) {
	m := &fakeMailer{}
	s := EmailSender{Mailer: m, Templates: fakeTemplates{tmpl: &MessageTemplate{Subject: "Hi", BodyHTML: "<p>hi</p>"}}, From: "Moosewave <n@p.com>"}
	out := s.Send(context.Background(), "t1", EligibleRecipient{Channel: "email", Email: "a@b.com", TemplateID: "tmpl1"})
	if out.Status != "sent" || m.sent != 1 || m.last.to != "a@b.com" {
		t.Fatalf("expected a sent email, got %+v (sent=%d)", out, m.sent)
	}
}

func TestEmailSender_FailuresAndFallthrough(t *testing.T) {
	// no email -> failed
	s := EmailSender{Mailer: &fakeMailer{}, Templates: fakeTemplates{tmpl: &MessageTemplate{}}}
	if got := s.Send(context.Background(), "t", EligibleRecipient{Channel: "email"}); got.Status != "failed" {
		t.Fatalf("missing email must fail: %+v", got)
	}
	// mailer error -> failed with reason
	s2 := EmailSender{Mailer: &fakeMailer{err: errors.New("smtp down")}, Templates: fakeTemplates{tmpl: &MessageTemplate{}}}
	if got := s2.Send(context.Background(), "t", EligibleRecipient{Channel: "email", Email: "x@y.com"}); got.Status != "failed" || got.Reason != "smtp down" {
		t.Fatalf("mailer error must surface: %+v", got)
	}
	// non-email channel with no Next -> queued
	if got := (EmailSender{}).Send(context.Background(), "t", EligibleRecipient{Channel: "sms", PhoneE164: "+1"}); got.Status != "queued" {
		t.Fatalf("non-email with no Next must queue: %+v", got)
	}
}
