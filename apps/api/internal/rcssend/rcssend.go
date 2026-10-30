// SPDX-License-Identifier: AGPL-3.0-only
//
// Package rcssend is the RCS (Rich Communication Services) ChannelSender for
// omnichannel campaigns (G-16). The omnichannel control plane has carried an
// "rcs" channel with a required fallback_path_key since the schema shipped
// (see internal/omnichannel/omnichannel.go), but runtime_status was left
// "planned" — no adapter ever sent an RCS message. This package is that
// adapter: it dispatches through Google RBM (Rich Business Messaging) and,
// on any failure to deliver via RCS, falls back to the SMS path the
// operator wired via fallback_path_key.
package rcssend

import (
	"context"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/omnichannel"
)

// RBMProvider is the narrow send surface RCSSender needs from Google RBM. The
// rbm.go adapter (RBMAdapter) satisfies it with real request construction;
// tests use a fake.
type RBMProvider interface {
	// SendRCS delivers one RCS message via RBM. delivered reports whether
	// Google's API accepted and confirmed the message (a rich card or a
	// plain-text fallback within RCS itself); richCard is an optional
	// structured payload (Google's RCS RichCard JSON shape) and may be nil
	// for a plain-text message. err is non-nil for transport/auth/config
	// failures — those always trigger the SMS fallback exactly like
	// delivered=false does.
	SendRCS(ctx context.Context, phone, message string, richCard any) (delivered bool, err error)
}

// CapabilityChecker reports whether a phone number is currently RCS-capable
// (has Google Messages / an RCS-capable client reachable). RCS availability
// is carrier- and device-dependent, so campaigns that care about avoiding a
// doomed RBM round-trip can wire a capability cache/lookup here. Optional:
// a nil CapabilityChecker means RCSSender always attempts RBM first and lets
// RBM's own response (delivered=false or an error) drive the fallback.
type CapabilityChecker interface {
	IsRCSCapable(ctx context.Context, tenantID, phoneE164 string) (bool, error)
}

// TemplateGetter resolves a path's message template to RCS content
// (body text + optional rich-card media). *omnichannel.Repo satisfies it —
// the same GetTemplate seam EmailSender uses (channel_senders.go).
type TemplateGetter interface {
	GetTemplate(ctx context.Context, tenantID, id string) (*omnichannel.MessageTemplate, error)
}

// RCSSender is a live omnichannel.ChannelSender for the "rcs" channel (G-16).
//
// For each eligible RCS recipient it:
//  1. Fails closed to the SMS fallback if there's no phone number, no RBM
//     provider configured, or (when wired) the recipient is not RCS-capable.
//  2. Resolves the path's message template for body text / rich-card media.
//  3. Calls RBM.SendRCS. A transport/auth error or delivered=false both fall
//     back to SMS — RBM has no partial-success state worth distinguishing
//     here; either way the recipient still needs the message.
//
// The SMS fallback is executed by handing the recipient — with Channel
// flipped to "sms" — to Next, mirroring EmailSender's Next-chaining pattern
// (channel_senders.go) rather than re-resolving the sibling path named by
// fallback_path_key. omni_recipients already carries this recipient's
// verified phone identity (the same one the sibling SMS path would resolve
// to for the same subscriber), so re-materializing against the sibling path
// would just re-derive an identical phone number at the cost of an extra
// path lookup. omnichannel.Validate already enforces, at save time, that a
// path's fallback_path_key references a sibling path on channel "sms" — so
// wherever the composition root wires an RCSSender, Next should be the
// tenant's live SMS ChannelSender (or, until one exists, DefaultSender's
// queued no-op — never nil in production, since a nil Next silently
// downgrades a failed RCS send to a bare "queued" record with no delivery
// path at all).
type RCSSender struct {
	RBM        RBMProvider
	Capability CapabilityChecker // optional
	Templates  TemplateGetter    // optional; missing template = plain fallback text
	// Next handles: (a) any recipient whose Channel isn't "rcs" (chaining,
	// same as EmailSender.Next), and (b) the SMS fallback for RCS recipients
	// RBM couldn't reach. nil means "no SMS sender wired" — the fallback then
	// reports a queued record carrying the fallback reason rather than losing
	// the send outright.
	Next omnichannel.ChannelSender
}

// fallbackMessage is used when no template resolves any body text — RCS (and
// its SMS fallback) must still carry *something* rather than send empty.
const fallbackMessage = "You have a new update."

func (s RCSSender) Send(ctx context.Context, tenantID string, rec omnichannel.EligibleRecipient) omnichannel.SendOutcome {
	if rec.Channel != "rcs" {
		if s.Next != nil {
			return s.Next.Send(ctx, tenantID, rec)
		}
		return omnichannel.SendOutcome{Status: "queued", Provider: "postwave"}
	}

	phone := strings.TrimSpace(rec.PhoneE164)
	if phone == "" {
		return s.fallback(ctx, tenantID, rec, "recipient has no phone number")
	}
	if s.RBM == nil {
		return s.fallback(ctx, tenantID, rec, "RBM agent not configured")
	}
	if s.Capability != nil {
		capable, err := s.Capability.IsRCSCapable(ctx, tenantID, phone)
		if err != nil {
			return s.fallback(ctx, tenantID, rec, "rcs capability check: "+err.Error())
		}
		if !capable {
			return s.fallback(ctx, tenantID, rec, "recipient is not RCS-capable")
		}
	}

	message, richCard := s.resolveContent(ctx, tenantID, rec)

	delivered, err := s.RBM.SendRCS(ctx, phone, message, richCard)
	if err != nil {
		return s.fallback(ctx, tenantID, rec, "rbm: "+err.Error())
	}
	if !delivered {
		return s.fallback(ctx, tenantID, rec, "rbm reported non-delivery")
	}
	return omnichannel.SendOutcome{Status: "sent", Provider: "rcs"}
}

// resolveContent loads the path's message template for RCS body text and an
// optional rich-card payload. Any lookup problem (nil Templates, empty
// TemplateID, lookup error, missing row) degrades to fallbackMessage with no
// rich card rather than failing the send — content resolution is best-effort,
// not a reason to skip a recipient who is otherwise reachable.
func (s RCSSender) resolveContent(ctx context.Context, tenantID string, rec omnichannel.EligibleRecipient) (string, any) {
	if s.Templates == nil || rec.TemplateID == "" {
		return fallbackMessage, nil
	}
	tmpl, err := s.Templates.GetTemplate(ctx, tenantID, rec.TemplateID)
	if err != nil || tmpl == nil {
		return fallbackMessage, nil
	}
	message := strings.TrimSpace(tmpl.BodyText)
	if message == "" {
		message = strings.TrimSpace(tmpl.Subject)
	}
	if message == "" {
		message = fallbackMessage
	}
	var richCard any
	if len(tmpl.Media) > 0 {
		richCard = tmpl.Media
	}
	return message, richCard
}

// fallback routes an RCS recipient to the SMS path via Next, tagging the
// outcome with why RCS was skipped so channel_send_history.metadata.reason
// (see runtime.go recordSend) preserves the reason for reporting/debugging
// even though the message ultimately went out (or queued) over SMS.
func (s RCSSender) fallback(ctx context.Context, tenantID string, rec omnichannel.EligibleRecipient, reason string) omnichannel.SendOutcome {
	if s.Next == nil {
		return omnichannel.SendOutcome{
			Status:   "queued",
			Provider: "rcs",
			Reason:   "rcs fallback with no SMS sender wired: " + reason,
		}
	}
	smsRec := rec
	smsRec.Channel = "sms"
	out := s.Next.Send(ctx, tenantID, smsRec)
	if out.Reason == "" {
		out.Reason = "rcs fallback: " + reason
	} else {
		out.Reason = "rcs fallback: " + reason + "; " + out.Reason
	}
	return out
}
