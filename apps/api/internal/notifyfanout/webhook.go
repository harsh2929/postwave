// SPDX-License-Identifier: AGPL-3.0-only
//
// SETC-037 — the Slack/generic outbound-webhook notification channel. The
// concrete SSRF-safe poster lives in package notifywebhook (importing
// outbound_webhooks here would form an import cycle); this file only renders the
// content-light payload text.
package notifyfanout

import "strings"

// webhookText renders a content-light notification line for delivery to a
// third-party endpoint (Slack, or an arbitrary generic receiver). It uses ONLY
// the redacted native-push body (ev.MobileBody) and NEVER ev.Body: Body can
// carry customer PII (e.g. the bounce/complaint producers put a raw subscriber
// email in Body but a redacted "A subscriber address hard-bounced." in
// MobileBody). Because the webhook egresses to hosts outside our trust boundary,
// the no-customer-PII guarantee is made STRUCTURAL here — a producer that
// forgets to set MobileBody yields a body-less line (Title + URL), never a leak,
// rather than relying on every future producer to redact ev.Body.
func webhookText(ev Event) string {
	return WebhookText(ev.Title, ev.MobileBody, ev.URL)
}

// WebhookText is the wire format for a notification webhook message.
//
// Exported so the retry sweep in `notifywebhook` renders a resent message
// identically to the original. A second copy of "title, body, link, joined by
// newlines" would agree today and diverge the first time either is touched —
// and the divergence would be invisible, because nobody compares a retried
// message to the one it replaces.
func WebhookText(title, body, url string) string {
	parts := make([]string, 0, 3)
	if strings.TrimSpace(title) != "" {
		parts = append(parts, title)
	}
	if strings.TrimSpace(body) != "" {
		parts = append(parts, body)
	}
	if strings.TrimSpace(url) != "" {
		parts = append(parts, url)
	}
	return strings.Join(parts, "\n")
}
