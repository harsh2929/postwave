// SPDX-License-Identifier: AGPL-3.0-only
package whatsappsend

import (
	"context"
	"fmt"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/omnichannel"
)

// StatusApproved is the only whatsapp_message_templates.status a template
// may be sent from. Meta reviews every (name, language) pair before it can
// be dispatched — a 'pending', 'rejected', 'paused', or 'disabled' template
// must never reach the Graph API call.
const StatusApproved = "approved"

// Template is the subset of a whatsapp_message_templates row the sender
// needs to place a send.
type Template struct {
	ID       string
	Name     string
	Language string
	Status   string
}

// TemplateGetter resolves an omnichannel EligibleRecipient.TemplateID to its
// WhatsApp template row. *Repo satisfies it against whatsapp_message_templates.
type TemplateGetter interface {
	GetTemplate(ctx context.Context, tenantID, id string) (*Template, error)
}

// VarsResolver optionally supplies the positional body-parameter values
// (Meta's {{1}}, {{2}}, ...) for one recipient's template send. Templates
// with no variables need not implement this — WhatsAppSender treats a nil
// VarsResolver, or one returning no vars, as "no substitutions".
type VarsResolver interface {
	ResolveVars(ctx context.Context, tenantID string, rec omnichannel.EligibleRecipient) ([]string, error)
}

// WhatsAppSender is a live omnichannel.ChannelSender for the "whatsapp"
// channel (G-15): it resolves the recipient's WhatsApp template, refuses to
// send anything that is not Meta-approved, and dispatches through
// WhatsAppProvider (Meta Cloud API in production). Non-whatsapp channels
// fall through to Next, mirroring omnichannel.EmailSender.
type WhatsAppSender struct {
	Provider  WhatsAppProvider
	Templates TemplateGetter
	Vars      VarsResolver // optional
	Next      omnichannel.ChannelSender
}

// Send implements omnichannel.ChannelSender.
func (s WhatsAppSender) Send(ctx context.Context, tenantID string, rec omnichannel.EligibleRecipient) omnichannel.SendOutcome {
	if rec.Channel != "whatsapp" {
		if s.Next != nil {
			return s.Next.Send(ctx, tenantID, rec)
		}
		return omnichannel.SendOutcome{Status: "queued", Provider: "postwave"}
	}
	if s.Provider == nil || s.Templates == nil {
		return omnichannel.SendOutcome{Status: "queued", Provider: "whatsapp", Reason: errNotConfiguredMsg}
	}
	phone := strings.TrimSpace(rec.PhoneE164)
	if phone == "" {
		return omnichannel.SendOutcome{Status: "failed", Provider: "whatsapp", Reason: "recipient has no phone number"}
	}
	if strings.TrimSpace(rec.TemplateID) == "" {
		return omnichannel.SendOutcome{Status: "failed", Provider: "whatsapp", Reason: "no whatsapp template configured"}
	}

	tmpl, err := s.Templates.GetTemplate(ctx, tenantID, rec.TemplateID)
	if err != nil {
		return omnichannel.SendOutcome{Status: "failed", Provider: "whatsapp", Reason: "template lookup: " + err.Error()}
	}
	if tmpl == nil {
		return omnichannel.SendOutcome{Status: "failed", Provider: "whatsapp", Reason: "whatsapp template not found"}
	}
	if tmpl.Status != StatusApproved {
		return omnichannel.SendOutcome{
			Status:   "failed",
			Provider: "whatsapp",
			Reason:   fmt.Sprintf("whatsapp template %q is not approved for sending (status=%s)", tmpl.Name, tmpl.Status),
		}
	}

	var vars []string
	if s.Vars != nil {
		vars, err = s.Vars.ResolveVars(ctx, tenantID, rec)
		if err != nil {
			return omnichannel.SendOutcome{Status: "failed", Provider: "whatsapp", Reason: "resolve template vars: " + err.Error()}
		}
	}

	providerMessageID, err := s.Provider.SendTemplate(ctx, phone, tmpl.Name, tmpl.Language, vars)
	if err != nil {
		return omnichannel.SendOutcome{Status: "failed", Provider: "whatsapp", Reason: err.Error()}
	}
	return omnichannel.SendOutcome{Status: "sent", Provider: "whatsapp", ProviderMessageID: providerMessageID}
}
