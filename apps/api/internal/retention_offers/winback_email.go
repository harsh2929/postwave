// SPDX-License-Identifier: AGPL-3.0-only
//
// winback_email.go — the win-back e-mail itself.
//
// Recon (honest): before close-open-loops, retention offers were ONLY
// shown as a portal modal in the cancel flow — there was no e-mail
// template or sender for them anywhere in the codebase. This file adds
// the missing piece: a minimal, deterministic render of a win-back
// e-mail (subject + plain + HTML) whose call-to-action is intended for a
// subscriber retention/preference portal. That customer action surface is
// not mounted; WinbackDispatchAvailable therefore remains false. We do NOT build a parallel
// mailer — the worker hands this Message to the platform's
// mailer.Mailer (the same transactional sender used for referral
// congrats, verify-email, etc.), so SES/dev selection, tagging, and the
// bounce/complaint FBL pipeline all apply unchanged.
//
// The copy is a sane built-in default. It's intentionally tenant-
// overridable LATER (the offer's own headline/body already flow in here
// when set); for now a tenant with no custom copy still gets a coherent
// e-mail.

package retention_offers

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/mailer"
)

// WinbackEmailData is everything the render needs. Kept as a plain
// struct (no DB/HTTP deps) so renderWinbackEmail is a pure function and
// trivially unit-tested.
type WinbackEmailData struct {
	// Offer is the active retention offer being surfaced.
	Offer Offer
	// AmountLabel is Offer.FormatAmount() (e.g. "25% off"). Passed in so
	// the render doesn't recompute it.
	AmountLabel string
	// PortalURL is the fully-formed link to the retention/preference
	// portal where AcceptOffer applies the coupon. Built by
	// winbackPortalURL.
	PortalURL string
}

// winbackPortalURL builds the CTA link to the retention/preference
// portal for a given offer + recipient. Shape:
//
//	{base}/portal/retention?offer_id=<id>
//
// Recipient email is intentionally absent: a raw address in a CTA leaks PII
// through browser, proxy, CDN, and analytics query logs and is not proof of
// recipient authority. A future portal must establish recipient identity with
// a scoped credential. base is an HTTPS ORIGIN, not an arbitrary URL prefix.
func winbackPortalURL(base, offerID, _ string) string {
	base = strings.TrimSpace(base)
	offerID = strings.TrimSpace(offerID)
	if base == "" || offerID == "" {
		return ""
	}
	parsed, err := url.Parse(base)
	if err != nil || !strings.EqualFold(parsed.Scheme, "https") || parsed.Host == "" ||
		parsed.Hostname() == "" || parsed.User != nil || parsed.Opaque != "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" ||
		(parsed.Path != "" && parsed.Path != "/") {
		return ""
	}
	q := url.Values{}
	q.Set("offer_id", offerID)
	parsed.Path = "/portal/retention"
	parsed.RawPath = ""
	parsed.RawQuery = q.Encode()
	return parsed.String()
}

// renderWinbackEmail produces (subject, plain, html). Pure +
// deterministic. Uses the offer's own headline/body when the tenant set
// them, else a sane default. The amount label and portal CTA always
// appear so the e-mail is self-explanatory even with empty copy.
func renderWinbackEmail(d WinbackEmailData) (subject, plain, html string) {
	amount := strings.TrimSpace(d.AmountLabel)
	headline := strings.TrimSpace(d.Offer.Headline)
	if headline == "" {
		if amount != "" {
			headline = "We'd love you to stay — here's " + amount
		} else {
			headline = "We'd love you to stay"
		}
	}
	body := strings.TrimSpace(d.Offer.Body)
	if body == "" {
		if amount != "" {
			body = "It's been a while. As a thank-you for being a member, we've put together a special offer just for you: " + amount + " on your subscription. Tap below to claim it."
		} else {
			body = "It's been a while. We've put together a special offer to welcome you back — tap below to see it."
		}
	}

	subject = headline

	var pb strings.Builder
	pb.WriteString(headline)
	pb.WriteString("\n\n")
	pb.WriteString(body)
	pb.WriteString("\n\n")
	if d.PortalURL != "" {
		pb.WriteString("Claim your offer: ")
		pb.WriteString(d.PortalURL)
		pb.WriteString("\n")
	}
	plain = pb.String()

	cta := ""
	if d.PortalURL != "" {
		cta = fmt.Sprintf(
			`<p style="margin:20px 0"><a href="%s" `+
				`style="display:inline-block;background:#14171f;color:#fff;`+
				`text-decoration:none;padding:12px 20px;border-radius:8px;`+
				`font-size:14px">Claim your offer</a></p>`,
			htmlEscapeWinback(d.PortalURL),
		)
	}
	html = fmt.Sprintf(
		`<!doctype html><html><body style="font-family:system-ui,sans-serif;`+
			`max-width:520px;margin:24px auto;color:#14171f">`+
			`<h2 style="margin:0 0 8px 0">%s</h2>`+
			`<p style="font-size:14px;color:#485160">%s</p>`+
			`%s`+
			`<p style="font-size:12px;color:#9aa1ad;margin-top:24px">`+
			`If you'd rather not hear from us, you can update your preferences anytime.</p>`+
			`</body></html>`,
		htmlEscapeWinback(headline), htmlEscapeWinback(body), cta,
	)
	return subject, plain, html
}

// buildWinbackMessage assembles the platform mailer.Message for a
// recipient. from + portalBase come from the worker's config. Returns
// (msg, false) when the message can't be built (no from address) so the
// caller skips rather than sending an invalid envelope.
func buildWinbackMessage(from, recipient string, d WinbackEmailData) (mailer.Message, bool) {
	from = strings.TrimSpace(from)
	recipient = strings.TrimSpace(recipient)
	if from == "" || recipient == "" {
		return mailer.Message{}, false
	}
	subject, plain, html := renderWinbackEmail(d)
	return mailer.Message{
		From:     from,
		To:       recipient,
		Subject:  subject,
		Body:     plain,
		HTMLBody: html,
		Tags:     map[string]string{"purpose": "retention_winback"},
	}, true
}

// htmlEscapeWinback is the package-local HTML escaper for the win-back
// render (mirrors referrals.htmlEscapeRef — kept local so the packages
// stay decoupled).
func htmlEscapeWinback(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")
	return r.Replace(s)
}
