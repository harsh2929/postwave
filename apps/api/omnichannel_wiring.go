package main

import (
	"context"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/omnichannel"
	"github.com/postwave/postwave/apps/api/internal/pushsend"
	"github.com/postwave/postwave/apps/api/internal/rcssend"
	"github.com/postwave/postwave/apps/api/internal/whatsappsend"
)

// omniEmailDelivery adapts the platform mailer to omnichannel's narrow
// EmailDelivery seam so the live email ChannelSender (G-09) can deliver through
// the same SES/dev mailer the rest of the app uses, without omnichannel
// importing the mailer package.
type omniEmailDelivery struct{ m mailer.Mailer }

func (a omniEmailDelivery) Send(ctx context.Context, from, to, subject, textBody, htmlBody string) error {
	return a.m.Send(ctx, mailer.Message{
		From: from, To: to, Subject: subject, Body: textBody, HTMLBody: htmlBody,
	})
}

// newOmnichannelSender builds the provider chain retained behind the contained
// runtime boundary. A non-terminal queued outcome is normalized to failure by
// omnichannel.Dispatch; it cannot be reported as a completed send.
func newOmnichannelSender(m mailer.Mailer, repo *omnichannel.Repo, from string, pool *db.Pool) omnichannel.ChannelSender {
	// The channel chain: email → push → whatsapp → rcs. Each adapter handles its
	// own channel and falls through to Next for the others (mirrors EmailSender).
	// The push/whatsapp/rcs providers are left nil until a tenant configures
	// credentials (APNs/FCM, Meta Cloud API, Google RBM). Their legacy queued
	// outcomes remain inert behind the HTTP gate and fail closed if invoked
	// directly (G-14/15/16).
	rcs := rcssend.RCSSender{}
	wa := whatsappsend.WhatsAppSender{Templates: &whatsappsend.Repo{Pool: pool}, Next: rcs}
	push := pushsend.PushSender{Devices: &pushsend.Repo{Pool: pool}, Templates: repo, Next: wa}
	return omnichannel.EmailSender{Mailer: omniEmailDelivery{m: m}, Templates: repo, From: from, Next: push}
}
