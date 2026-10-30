// SPDX-License-Identifier: AGPL-3.0-only
package webhooks

import (
	"context"
	"strings"
	"testing"
)

// The composition root hands the sender the configured platform sender, or ""
// when none is configured. Run must send as the configured one verbatim and
// fall back to its own default only for "", so an unconfigured deployment keeps
// sending exactly what it always sent.
func TestAlertSenderRunDefaultsTheSenderOnlyWhenUnset(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Run returns after its first tick, which a nil Pool makes a no-op.
	for _, tc := range []struct{ from, want string }{
		{"", "Moosewave Alerts <alerts@moosewave.com>"},
		{"Staging <noreply@staging.example.test>", "Staging <noreply@staging.example.test>"},
	} {
		sender := &AlertSender{From: tc.from}
		sender.Run(ctx)
		if sender.From != tc.want {
			t.Errorf("AlertSender{From: %q}.Run sends as %q, want %q", tc.from, sender.From, tc.want)
		}
	}
}

func TestRenderAlertSubjectIncludesCount(t *testing.T) {
	cases := []struct {
		hits int
		want string
	}{
		{1, "⚠ 1 webhook misbehaving"},
		{3, "⚠ 3 webhooks misbehaving"},
	}
	for _, c := range cases {
		hits := make([]triggered, c.hits)
		for i := range hits {
			hits[i] = triggered{WebhookURL: "https://x", Description: "boom"}
		}
		r := alertRecipient{TenantName: "Acme"}
		subj, _, _ := renderAlert(r, hits)
		if !strings.HasPrefix(subj, c.want) {
			t.Errorf("subject prefix mismatch: got %q want %q", subj, c.want)
		}
	}
}

func TestRenderAlertFallsBackTenantName(t *testing.T) {
	r := alertRecipient{TenantName: "  "}
	hits := []triggered{{WebhookURL: "https://x", Description: "boom"}}
	_, plain, html := renderAlert(r, hits)
	if !strings.Contains(plain, "your workspace") {
		t.Errorf("plain missing fallback: %s", plain)
	}
	if !strings.Contains(html, "your workspace") {
		t.Errorf("html missing fallback: %s", html)
	}
}

func TestRenderAlertEscapesHTML(t *testing.T) {
	r := alertRecipient{TenantName: "Acme & <Co>"}
	hits := []triggered{
		{WebhookURL: "https://x?a=1&b=2", Description: "<script>"},
	}
	_, _, html := renderAlert(r, hits)
	for _, want := range []string{"Acme &amp; &lt;Co&gt;", "&lt;script&gt;", "a=1&amp;b=2"} {
		if !strings.Contains(html, want) {
			t.Errorf("expected %q in: %s", want, html)
		}
	}
	for _, banned := range []string{"<script>"} {
		if strings.Contains(html, banned) {
			t.Errorf("unescaped %q in html", banned)
		}
	}
}

func TestRenderAlertReasonTones(t *testing.T) {
	r := alertRecipient{TenantName: "x"}
	hits := []triggered{
		{Reason: "auto_disabled", WebhookURL: "u", Description: "d"},
		{Reason: "failure_rate", WebhookURL: "u", Description: "d"},
		{Reason: "latency", WebhookURL: "u", Description: "d"},
	}
	_, _, html := renderAlert(r, hits)
	// Each reason picks a different tone — confirms the switch works.
	for _, want := range []string{"#ef4444", "#eab308", "#0ea5e9"} {
		if !strings.Contains(html, want) {
			t.Errorf("missing colour %s in html", want)
		}
	}
}

func TestPluralRune(t *testing.T) {
	if pluralRune(1) != "" {
		t.Error("1 should be singular")
	}
	if pluralRune(0) != "s" || pluralRune(2) != "s" {
		t.Error("non-1 should be plural")
	}
}
