// SPDX-License-Identifier: AGPL-3.0-only

package pushsend

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/omnichannel"
)

// PushSender is a live omnichannel.ChannelSender for the "push" channel
// (G-14) — the same shape as omnichannel.EmailSender in
// internal/omnichannel/channel_senders.go: it resolves per-recipient content
// from a message template, delivers through a provider, and reports
// sent/failed with a reason so channel_send_history stays accurate instead
// of a permanent 'queued' no-op.
//
// Wiring note (composition root, not this package): construct this with the
// same *omnichannel.Repo the email path already uses for Templates (it
// satisfies omnichannel.TemplateGetter), a *pushsend.Repo for Devices, real
// APNs/FCM providers, and chain it as the Next of the existing sender chain
// (e.g. omnichannel.EmailSender{Next: pushsend.PushSender{Next: <sms sender
// or nil>}}) so channel dispatch remains a single chain.
type PushSender struct {
	// Devices resolves a subscriber's enabled push_devices tokens and applies
	// the active suppression-authority gate to the complete set. *Repo (this
	// package) satisfies it against the real database.
	Devices DeviceResolver
	// Templates resolves a path's message template to title/body content.
	// omnichannel.TemplateGetter is satisfied by *omnichannel.Repo — reuse
	// the same value the composition root already builds for EmailSender.
	Templates omnichannel.TemplateGetter
	// APNs delivers to platform "ios" devices.
	APNs PushProvider
	// FCM delivers to platform "android" devices.
	FCM PushProvider
	// Next handles channels other than "push" (chain to the next adapter,
	// e.g. SMS, or leave nil to fall through to a queued record).
	Next omnichannel.ChannelSender
}

func (s PushSender) Send(ctx context.Context, tenantID string, rec omnichannel.EligibleRecipient) omnichannel.SendOutcome {
	if rec.Channel != "push" {
		if s.Next != nil {
			return s.Next.Send(ctx, tenantID, rec)
		}
		return omnichannel.SendOutcome{Status: "queued", Provider: "postwave"}
	}
	if s.Devices == nil {
		return omnichannel.SendOutcome{Status: "queued", Provider: "postwave", Reason: "push sender not configured"}
	}
	if rec.SubscriberID == "" {
		return omnichannel.SendOutcome{Status: "failed", Provider: "push", Reason: "recipient has no subscriber id"}
	}

	title, body, outcome := s.resolveContent(ctx, tenantID, rec)
	if outcome != nil {
		return *outcome
	}

	// The resolver keeps the exact-token advisory locks until this callback
	// returns. Provider delivery therefore cannot sit in a check/commit gap with
	// a concurrent manual, provider, user, complaint, or legacy authority.
	called := false
	var result omnichannel.SendOutcome
	err := s.Devices.WithSendableDevices(ctx, tenantID, rec.SubscriberID, func(leaseCtx context.Context, resolution DeviceResolution) error {
		called = true
		result = s.sendResolution(leaseCtx, resolution, title, body)
		return nil
	})
	if err != nil || !called {
		// Database, checker, and adapter errors are never copied into this
		// durable reason field; they may contain hashes, URLs, or raw tokens.
		return omnichannel.SendOutcome{Status: "failed", Provider: "push", Reason: "push device eligibility unavailable"}
	}
	return result
}

func (s PushSender) sendResolution(
	ctx context.Context,
	resolution DeviceResolution,
	title, body string,
) omnichannel.SendOutcome {
	if err := validateDeviceResolution(resolution); err != nil {
		return omnichannel.SendOutcome{Status: "failed", Provider: "push", Reason: "push device eligibility is ambiguous"}
	}
	if resolution.EnabledCount == 0 {
		return omnichannel.SendOutcome{Status: "failed", Provider: "push", Reason: "subscriber has no enabled push devices"}
	}
	if len(resolution.Devices) == 0 {
		return omnichannel.SendOutcome{Status: "failed", Provider: "push", Reason: "all enabled push devices are suppressed"}
	}

	sentCount, configuredCount := 0, 0
	for _, d := range resolution.Devices {
		provider := s.providerFor(d.Platform)
		if provider == nil {
			continue
		}
		configuredCount++
		if err := provider.SendPush(ctx, d.Token, d.Platform, title, body, nil); err != nil {
			continue
		}
		sentCount++
	}
	if sentCount > 0 {
		return omnichannel.SendOutcome{Status: "sent", Provider: "push"}
	}
	if configuredCount == 0 {
		return omnichannel.SendOutcome{Status: "failed", Provider: "push", Reason: "push provider unavailable"}
	}
	return omnichannel.SendOutcome{Status: "failed", Provider: "push", Reason: "push provider delivery failed"}
}

// validateDeviceResolution defends the provider boundary even when PushSender
// is supplied a custom resolver. A partial count or unknown platform makes it
// impossible to prove that every enabled device was checked against the right
// authority namespace, so the whole recipient fails before the first provider
// call.
func validateDeviceResolution(resolution DeviceResolution) error {
	if resolution.EnabledCount < 0 || resolution.SuppressedCount < 0 ||
		resolution.EnabledCount != len(resolution.Devices)+resolution.SuppressedCount {
		return fmt.Errorf("pushsend: inconsistent device resolution")
	}
	for i := range resolution.Devices {
		if _, err := suppressionKeyForDevice(resolution.Devices[i]); err != nil {
			return err
		}
	}
	return nil
}

// resolveContent resolves the notification title/body from the recipient's
// message template. The template's Subject maps to the push notification
// title and BodyText maps to the push notification body (push has no HTML
// body), matching how EmailSender resolves the same template shape.
func (s PushSender) resolveContent(ctx context.Context, tenantID string, rec omnichannel.EligibleRecipient) (title, body string, failure *omnichannel.SendOutcome) {
	if s.Templates == nil || rec.TemplateID == "" {
		out := omnichannel.SendOutcome{Status: "failed", Provider: "push", Reason: "push notification has no content template"}
		return "", "", &out
	}
	tmpl, err := s.Templates.GetTemplate(ctx, tenantID, rec.TemplateID)
	if err != nil {
		// SendOutcome.Reason is persisted. Repository errors may carry SQL,
		// tenant identifiers, or other internal evidence, so keep the durable
		// vocabulary finite just as the provider path does.
		out := omnichannel.SendOutcome{Status: "failed", Provider: "push", Reason: "push notification content unavailable"}
		return "", "", &out
	}
	if tmpl == nil {
		out := omnichannel.SendOutcome{Status: "failed", Provider: "push", Reason: "message template not found"}
		return "", "", &out
	}
	if tmpl.BodyText == "" {
		out := omnichannel.SendOutcome{Status: "failed", Provider: "push", Reason: "message template has no body text"}
		return "", "", &out
	}
	return tmpl.Subject, tmpl.BodyText, nil
}

func (s PushSender) providerFor(platform string) PushProvider {
	switch platform {
	case "ios":
		return s.APNs
	case "android":
		return s.FCM
	default:
		return nil
	}
}
