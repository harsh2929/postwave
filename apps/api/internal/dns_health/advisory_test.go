// SPDX-License-Identifier: AGPL-3.0-only
package dns_health

import (
	"strings"
	"testing"
)

func TestRecheckSQLClearsEveryFailedVerificationLeg(t *testing.T) {
	t.Parallel()
	for _, column := range []string{
		"spf_verified_at", "dkim_verified_at", "dmarc_verified_at",
	} {
		if !strings.Contains(recheckIdentitySQL, column) {
			t.Fatalf("recheck SQL does not assign %s", column)
		}
	}
	if got := strings.Count(strings.ToUpper(recheckIdentitySQL), "ELSE NULL END"); got != 3 {
		t.Fatalf("failed verification legs cleared %d times, want 3; SQL=%s", got, recheckIdentitySQL)
	}
	for _, stale := range []string{
		"ELSE spf_verified_at", "ELSE dkim_verified_at", "ELSE dmarc_verified_at",
	} {
		if strings.Contains(recheckIdentitySQL, stale) {
			t.Fatalf("recheck SQL retains stale green evidence via %q", stale)
		}
	}
}

func TestParseDMARCPolicy(t *testing.T) {
	cases := map[string]string{
		"v=DMARC1; p=reject; rua=mailto:x@y.com": "reject",
		"v=DMARC1;p=quarantine":                  "quarantine",
		"v=DMARC1; sp=none; p=none":              "none",
		"v=DMARC1; rua=mailto:x":                 "",
	}
	for rec, want := range cases {
		if got := parseDMARCPolicy(rec); got != want {
			t.Fatalf("parseDMARCPolicy(%q)=%q want %q", rec, got, want)
		}
	}
}

func TestSendingDomainAdvisories(t *testing.T) {
	apex := sendingDomainAdvisories("acme.com", "none", true)
	if len(apex) != 1 || !strings.Contains(apex[0], "dedicated marketing subdomain") {
		t.Fatalf("apex domain should advise a subdomain: %v", apex)
	}
	if sub := sendingDomainAdvisories("mail.acme.com", "none", true); len(sub) != 0 {
		t.Fatalf("a subdomain with p=none should have no advisory: %v", sub)
	}
	rej := sendingDomainAdvisories("mail.acme.com", "reject", false)
	if len(rej) != 1 || !strings.Contains(rej[0], "p=reject") || !strings.Contains(rej[0], "DKIM") {
		t.Fatalf("p=reject without DKIM should warn about DKIM: %v", rej)
	}
}
