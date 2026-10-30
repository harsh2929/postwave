// SPDX-License-Identifier: AGPL-3.0-only

package omnichannel

import "context"

// EmailDelivery is the narrow send surface the email adapter needs — satisfied
// in the composition root by an adapter over the platform mailer (SES/dev), so
// omnichannel does not import the mailer package directly.
type EmailDelivery interface {
	Send(ctx context.Context, from, to, subject, textBody, htmlBody string) error
}

// TemplateGetter resolves a path's message template to content. *Repo satisfies it.
type TemplateGetter interface {
	GetTemplate(ctx context.Context, tenantID, id string) (*MessageTemplate, error)
}

// EmailSender is a live ChannelSender for the email channel (G-09): it resolves
// the recipient's message template and delivers through the platform mailer,
// reporting 'sent' or 'failed' with a reason — replacing the recordOnlySender
// no-op that only ever wrote 'queued'. Non-email channels fall through to Next
// (another adapter, e.g. SMS) or, if unset, to a queued record so the dispatch
// remains accurate for channels without an adapter yet.
type EmailSender struct {
	Mailer    EmailDelivery
	Templates TemplateGetter
	From      string        // default From when a template carries none
	Next      ChannelSender // handles non-email channels
}

func (s EmailSender) Send(ctx context.Context, tenantID string, rec EligibleRecipient) SendOutcome {
	if rec.Channel != "email" {
		if s.Next != nil {
			return s.Next.Send(ctx, tenantID, rec)
		}
		return SendOutcome{Status: "queued", Provider: "postwave"}
	}
	if s.Mailer == nil || s.Templates == nil {
		return SendOutcome{Status: "queued", Provider: "postwave", Reason: "email sender not configured"}
	}
	if rec.Email == "" {
		return SendOutcome{Status: "failed", Provider: "email", Reason: "recipient has no email address"}
	}
	tmpl, err := s.Templates.GetTemplate(ctx, tenantID, rec.TemplateID)
	if err != nil {
		return SendOutcome{Status: "failed", Provider: "email", Reason: "template lookup: " + err.Error()}
	}
	if tmpl == nil {
		return SendOutcome{Status: "failed", Provider: "email", Reason: "message template not found"}
	}
	if err := s.Mailer.Send(ctx, s.From, rec.Email, tmpl.Subject, tmpl.BodyText, tmpl.BodyHTML); err != nil {
		return SendOutcome{Status: "failed", Provider: "email", Reason: err.Error()}
	}
	return SendOutcome{Status: "sent", Provider: "email"}
}
