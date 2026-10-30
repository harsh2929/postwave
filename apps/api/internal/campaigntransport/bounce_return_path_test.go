// SPDX-License-Identifier: AGPL-3.0-only

package campaigntransport

import "testing"

// The envelope relaxation must be bounded to ONE named domain.
//
// Permitting the SMTP envelope sender to differ from the RFC822 From is what
// makes a VERP return path possible, and a VERP return path is what makes
// BOUNCES and RFC 3834 auto-replies attributable — they arrive at the envelope
// sender, not at Reply-To, so a Reply-To-only VERP leaves exactly the
// machine-generated traffic unattributed.
//
// But an unconstrained relaxation is how a message ends up with a MAIL FROM
// nobody authorised. SPF authenticates the MAIL FROM domain, so the envelope
// domain decides which DNS record must permit the send; only a domain the
// operator has actually published SPF for is safe to use.
//
// The suffix case is the one worth stating: a naive HasSuffix check would accept
// "evil-moosewave.com" for a configured "moosewave.com", which is a domain an
// attacker can register.
func TestTheEnvelopeRelaxationIsBoundedToTheConfiguredDomain(t *testing.T) {
	for _, tc := range []struct {
		name, envelope, configured string
		want                       bool
	}{
		{"exact domain match", "bounce+tok@bounce.example.test", "bounce.example.test", true},
		{"case-insensitive", "bounce+tok@BOUNCE.example.test", "bounce.example.test", true},
		{"different domain", "attacker@evil.test", "bounce.example.test", false},
		{"suffix is not a match", "x@evil-bounce.example.test", "example.test", false},
		{"parent is not a match", "x@example.test", "bounce.example.test", false},
		{"no configured domain refuses everything", "bounce+tok@bounce.example.test", "", false},
		{"blank configured domain refuses everything", "bounce+tok@bounce.example.test", "   ", false},
		{"address with no domain", "not-an-address", "bounce.example.test", false},
		{"trailing at", "local@", "bounce.example.test", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := envelopeInBounceDomain(tc.envelope, tc.configured); got != tc.want {
				t.Fatalf("envelopeInBounceDomain(%q, %q) = %v, want %v",
					tc.envelope, tc.configured, got, tc.want)
			}
		})
	}
}

// The DEFAULT must remain strict equality.
//
// A deployment that has not named a bounce domain has published no SPF record
// for one, so it must keep the rule this transport has always enforced. The
// default being safe is what makes the feature opt-in rather than a change every
// deployment silently receives.
func TestAnUnconfiguredTransportStillRequiresEnvelopeEquality(t *testing.T) {
	// The package's own valid fixture, so this exercises the REAL validator on a
	// message that satisfies every other rule. Hand-building MIME here would test
	// my MIME writing rather than the envelope rule.
	compiled := transportFixture(t)
	message := validRequest(compiled).Message
	message.EnvelopeFrom = "bounce+tok@bounce.example.test"

	if err := validateCompiled(message, "fixture@example.test", ""); err == nil {
		t.Fatal("an unconfigured transport accepted a mismatched envelope sender")
	}
	// The SAME message with the domain configured must be accepted, or the
	// assertion above would hold for a transport that refused everything.
	if err := validateCompiled(message, "fixture@example.test", "bounce.example.test"); err != nil {
		t.Fatalf("a configured bounce domain still refused its own envelope: %v", err)
	}
	// A third domain stays refused even when one is configured.
	message.EnvelopeFrom = "attacker@evil.test"
	if err := validateCompiled(message, "fixture@example.test", "bounce.example.test"); err == nil {
		t.Fatal("a configured transport accepted an envelope outside its bounce domain")
	}
	// And the unchanged fixture — envelope equal to From — must still pass in
	// both configurations, since the relaxation adds a case rather than
	// replacing one.
	original := validRequest(compiled).Message
	for _, domain := range []string{"", "bounce.example.test"} {
		if err := validateCompiled(original, "fixture@example.test", domain); err != nil {
			t.Fatalf("an envelope equal to From was refused with domain %q: %v", domain, err)
		}
	}
}
