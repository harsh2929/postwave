// SPDX-License-Identifier: AGPL-3.0-only
//
// reengagement.go — pure-function re-engagement campaign template
// generator. Given a list of winback candidates + a small brand
// snapshot, produces a ready-to-edit campaign template. No DB, no
// LLM — heuristic templates the customer can ship as-is or edit.
//
// Why heuristic rather than LLM:
//
//   - The shape of a winback email is well-understood: an honest
//     "we noticed you've been quiet" + a single CTA. Customers
//     don't need novel copy, they need the muscle-memory shape.
//
//   - Pure-function templating means the MCP tool
//     "sunset.preview_winback" can render the same output without
//     burning AI credits — important for the "every screen has a
//     preview" UX the dashboard ships.
//
//   - When the customer DOES want a creative variant, the AI
//     content composer (T1 item 5 from the roadmap) can be wired
//     to consume this template's slots as its prompt frame.

package sunset

import (
	"fmt"
	"strings"
)

// BrandSnapshot is the small bag of customer-supplied fields the
// generator needs to render copy that doesn't read like a stock
// SaaS email. None of these are required — every field has a
// "good enough" fallback.
type BrandSnapshot struct {
	WorkspaceName  string
	SenderName     string // "Moosewave Team" / "Anna" / "Acme Marketing"
	ProductName    string // "Acme" / "the Acme newsletter"
	Tone           string // "casual" | "formal" | "professional" — affects salutation + sign-off
	UnsubscribeURL string // The link to put under "unsubscribe with one click"
	HomepageURL    string // The link the primary CTA points at
}

// TemplateOptions tune the generator. Variant lets the caller pick
// between alternative shapes (we ship three: "soft", "direct",
// "last_chance") so an A/B test can compare them.
type TemplateOptions struct {
	Variant string // "soft" (default) | "direct" | "last_chance"
}

// Template is the rendered output.
type Template struct {
	Subject        string `json:"subject"`
	Preheader      string `json:"preheader"`
	BodyText       string `json:"bodyText"`
	BodyHTML       string `json:"bodyHtml"`
	PrimaryCTA     string `json:"primaryCta"`
	CandidateCount int    `json:"candidateCount"`
	Variant        string `json:"variant"`
}

// GenerateTemplate produces a campaign template suitable for sending
// to the winback candidates. The output is the SAME for every
// candidate — the personalisation (recipient first name, last-engaged
// date) is left for the dispatcher's merge-tag pass.
func GenerateTemplate(brand BrandSnapshot, candidateCount int, opts TemplateOptions) Template {
	brand = withDefaults(brand)
	variant := opts.Variant
	switch variant {
	case "soft", "direct", "last_chance":
	default:
		variant = "soft"
	}
	if candidateCount < 0 {
		candidateCount = 0
	}

	subject := subjectFor(variant, brand)
	preheader := preheaderFor(variant, brand)
	body, primaryCta := bodyFor(variant, brand)
	html := htmlBodyFor(variant, brand)

	return Template{
		Subject:        subject,
		Preheader:      preheader,
		BodyText:       body,
		BodyHTML:       html,
		PrimaryCTA:     primaryCta,
		CandidateCount: candidateCount,
		Variant:        variant,
	}
}

// withDefaults fills empty fields so downstream rendering doesn't have
// to null-check at every interpolation point.
func withDefaults(b BrandSnapshot) BrandSnapshot {
	b.WorkspaceName = strings.TrimSpace(b.WorkspaceName)
	b.SenderName = strings.TrimSpace(b.SenderName)
	b.ProductName = strings.TrimSpace(b.ProductName)
	b.Tone = strings.TrimSpace(b.Tone)
	b.HomepageURL = strings.TrimSpace(b.HomepageURL)
	b.UnsubscribeURL = strings.TrimSpace(b.UnsubscribeURL)
	if b.WorkspaceName == "" {
		b.WorkspaceName = "our team"
	}
	if b.SenderName == "" {
		b.SenderName = b.WorkspaceName
	}
	if b.ProductName == "" {
		b.ProductName = b.WorkspaceName
	}
	if b.Tone == "" {
		b.Tone = "casual"
	}
	if b.HomepageURL == "" {
		b.HomepageURL = "{{ tenant.homepage_url | default: '' }}"
	}
	if b.UnsubscribeURL == "" {
		b.UnsubscribeURL = "{{ unsubscribe_url }}"
	}
	return b
}

// subjectFor picks the subject line for the variant. Subject lines
// are calibrated AGAINST the worst spammy patterns we'd otherwise
// trip in eqscore (no all-caps, no !!!, no "free money") so the
// template ships at an A grade on the pre-send check.
func subjectFor(variant string, b BrandSnapshot) string {
	switch variant {
	case "direct":
		return fmt.Sprintf("Are you still interested in %s?", b.ProductName)
	case "last_chance":
		return fmt.Sprintf("Last chance — should we keep sending you %s?", b.ProductName)
	}
	// soft (default)
	return fmt.Sprintf("We've missed you at %s", b.WorkspaceName)
}

func preheaderFor(variant string, b BrandSnapshot) string {
	switch variant {
	case "direct":
		return "A two-click answer is all we need."
	case "last_chance":
		return "Reply with one click — or we'll stop sending."
	}
	return fmt.Sprintf("A quick note from %s.", b.SenderName)
}

// bodyFor returns the plain-text body + the primary-CTA label. We
// keep the text-only body short (200-400 chars) so it lands in the
// Primary tab on Gmail; long winback emails read as marketing and
// drop to Promotions.
func bodyFor(variant string, b BrandSnapshot) (string, string) {
	switch variant {
	case "direct":
		return strings.Join([]string{
			fmt.Sprintf("Hi {{ subscriber.first_name | default: 'there' }},"),
			"",
			fmt.Sprintf("We noticed you haven't opened anything from us in a while. No hard feelings — we'd just rather not crowd your inbox if these emails aren't useful."),
			"",
			fmt.Sprintf("Want to keep getting %s? Click below — that's all it takes.", b.ProductName),
			"",
			fmt.Sprintf("Otherwise we'll quietly unsubscribe you in a week."),
			"",
			fmt.Sprintf("— %s", b.SenderName),
		}, "\n"), "Yes, keep me subscribed"
	case "last_chance":
		return strings.Join([]string{
			fmt.Sprintf("Hi {{ subscriber.first_name | default: 'there' }},"),
			"",
			"This is the last email we'll send unless you tell us you still want them.",
			"",
			fmt.Sprintf("Click the button below to stay on the %s list. Do nothing and we'll unsubscribe you tomorrow — no need to take action.", b.ProductName),
			"",
			fmt.Sprintf("Thanks for everything,"),
			fmt.Sprintf("%s", b.SenderName),
		}, "\n"), "Keep me on the list"
	}
	// soft
	return strings.Join([]string{
		fmt.Sprintf("Hi {{ subscriber.first_name | default: 'there' }},"),
		"",
		fmt.Sprintf("It's been a while since you've heard from %s, and we wanted to check in.", b.WorkspaceName),
		"",
		fmt.Sprintf("If %s isn't useful to you any more, we totally understand — just hit reply and let us know, or use the unsubscribe link below.", b.ProductName),
		"",
		"If you'd like to keep hearing from us, just click the button — we'll know to keep sending.",
		"",
		fmt.Sprintf("— The %s team", b.WorkspaceName),
	}, "\n"), "Yes, keep me subscribed"
}

// htmlBodyFor renders a minimal HTML wrapper around the text. We
// keep this intentionally simple — no images, no nested tables. The
// goal is "Primary tab placement" not "design showcase". Customers
// who want a fancy template should edit this in the editor.
func htmlBodyFor(variant string, b BrandSnapshot) string {
	text, cta := bodyFor(variant, b)
	paragraphs := []string{}
	for _, line := range strings.Split(text, "\n\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		paragraphs = append(paragraphs, "<p>"+escapeHTML(line)+"</p>")
	}
	var sb strings.Builder
	sb.WriteString(`<!doctype html><html lang="en"><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a">`)
	for _, p := range paragraphs {
		sb.WriteString(p)
	}
	// CTA button — single button, inline-styled so it renders in
	// every major client without external CSS.
	sb.WriteString(`<p style="margin:24px 0"><a href="`)
	// URLs occupy an HTML attribute context. Handler validation constrains
	// customer-supplied values to absolute HTTPS URLs, while escaping here keeps
	// the pure generator safe for every internal caller as well.
	sb.WriteString(escapeHTML(b.HomepageURL))
	sb.WriteString(`" style="background:#0f172a;color:#fff;padding:12px 20px;text-decoration:none;border-radius:6px;display:inline-block">`)
	sb.WriteString(escapeHTML(cta))
	sb.WriteString(`</a></p>`)
	// Footer with unsubscribe link.
	sb.WriteString(`<p style="font-size:12px;color:#64748b;margin-top:32px">If you no longer want these emails, you can <a href="`)
	sb.WriteString(escapeHTML(b.UnsubscribeURL))
	sb.WriteString(`" style="color:#64748b">unsubscribe here</a>.</p>`)
	sb.WriteString(`</body></html>`)
	return sb.String()
}

func escapeHTML(s string) string {
	r := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&#39;",
	)
	return r.Replace(s)
}
