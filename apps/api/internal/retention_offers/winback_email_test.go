// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure tests for the win-back e-mail render + portal-link builder. No DB.

package retention_offers

import (
	"strings"
	"testing"
)

func TestWinbackPortalURL(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name, base, offerID, email, want string
	}{
		{"happy", "https://portal.example.com", "off_1", "a@b.com",
			"https://portal.example.com/portal/retention?offer_id=off_1"},
		{"trailing slash trimmed", "https://portal.example.com/", "off_1", "",
			"https://portal.example.com/portal/retention?offer_id=off_1"},
		{"no base -> empty", "", "off_1", "a@b.com", ""},
		{"no offer -> empty", "https://p.example.com", "", "a@b.com", ""},
		{"http refused", "http://p.example.com", "off_1", "a@b.com", ""},
		{"credentials refused", "https://user:p@example.com", "off_1", "a@b.com", ""},
		{"path prefix refused", "https://p.example.com/arbitrary", "off_1", "a@b.com", ""},
		{"query refused", "https://p.example.com?track=1", "off_1", "a@b.com", ""},
		{"fragment refused", "https://p.example.com/#x", "off_1", "a@b.com", ""},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			if got := winbackPortalURL(c.base, c.offerID, c.email); got != c.want {
				t.Fatalf("winbackPortalURL = %q, want %q", got, c.want)
			}
		})
	}
}

func TestWinbackPortalURLNeverContainsRecipientEmail(t *testing.T) {
	got := winbackPortalURL("https://portal.example.com", "off_1", "person@example.com")
	if strings.Contains(got, "person") || strings.Contains(got, "%40") || strings.Contains(got, "email=") {
		t.Fatalf("recipient PII reached CTA URL: %q", got)
	}
}

func TestRenderWinbackEmailDefaults(t *testing.T) {
	t.Parallel()
	pct := 25
	subject, plain, html := renderWinbackEmail(WinbackEmailData{
		Offer:       Offer{ID: "off_1", PercentOff: &pct},
		AmountLabel: "25% off",
		PortalURL:   "https://portal.example.com/portal/retention?offer_id=off_1",
	})
	if subject == "" {
		t.Fatal("subject empty")
	}
	// Default copy should surface the amount + the portal CTA in both parts.
	if !strings.Contains(plain, "25% off") {
		t.Errorf("plain missing amount: %q", plain)
	}
	if !strings.Contains(plain, "https://portal.example.com/portal/retention?offer_id=off_1") {
		t.Errorf("plain missing portal link: %q", plain)
	}
	if !strings.Contains(html, "Claim your offer") || !strings.Contains(html, "portal/retention") {
		t.Errorf("html missing CTA/link: %q", html)
	}
}

func TestRenderWinbackEmailUsesOfferCopy(t *testing.T) {
	t.Parallel()
	subject, plain, _ := renderWinbackEmail(WinbackEmailData{
		Offer:       Offer{ID: "off_1", Headline: "Come back!", Body: "We miss you."},
		AmountLabel: "",
		PortalURL:   "https://p.example.com/portal/retention?offer_id=off_1",
	})
	if subject != "Come back!" {
		t.Fatalf("subject = %q, want offer headline", subject)
	}
	if !strings.Contains(plain, "We miss you.") {
		t.Fatalf("plain missing offer body: %q", plain)
	}
}

func TestBuildWinbackMessage(t *testing.T) {
	t.Parallel()
	// No from -> not buildable.
	if _, ok := buildWinbackMessage("", "a@b.com", WinbackEmailData{Offer: Offer{ID: "o"}}); ok {
		t.Fatal("expected not-ok with empty from")
	}
	msg, ok := buildWinbackMessage("Moosewave <win@moosewave.com>", "a@b.com", WinbackEmailData{
		Offer:       Offer{ID: "o"},
		AmountLabel: "10% off",
		PortalURL:   "https://p.example.com/portal/retention?offer_id=o",
	})
	if !ok {
		t.Fatal("expected ok")
	}
	if msg.To != "a@b.com" || msg.From == "" || msg.Subject == "" {
		t.Fatalf("bad envelope: %+v", msg)
	}
	if msg.Tags["purpose"] != "retention_winback" {
		t.Fatalf("purpose tag = %q", msg.Tags["purpose"])
	}
	if msg.Body == "" || msg.HTMLBody == "" {
		t.Fatal("expected both plain + html bodies")
	}
}
