package webhooks

// SUB-048 — spamtrap / role-account / dns-failure / invalid-address
// categorisation tests for the bounce-ingest loop. These exercise the
// pure classification helpers (no DB, no HTTP) so they run everywhere.

import (
	"testing"

	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// TestDetectBounceCategory covers the precedence ladder
// (spamtrap > dns_failure > invalid_address > role_account) plus the
// "no category" fall-through.
func TestDetectBounceCategory(t *testing.T) {
	cases := []struct {
		name       string
		diagnostic string
		email      string
		want       suppressions.BounceCategory
	}{
		{"spamtrap diagnostic", "Recipient flagged as a known spamtrap", "x@y.co", suppressions.CategorySpamtrap},
		{"honeypot diagnostic", "honeypot hit detected by Validity", "x@y.co", suppressions.CategorySpamtrap},
		{"dns nxdomain", "550 NXDOMAIN: domain not found", "x@nope.invalid", suppressions.CategoryDNSFailure},
		{"dns no mx", "no MX record for recipient domain", "x@y.co", suppressions.CategoryDNSFailure},
		{"invalid 5.1.1", "550 5.1.1 user unknown", "ghost@y.co", suppressions.CategoryInvalidAddress},
		{"invalid mailbox", "mailbox unavailable: does not exist", "ghost@y.co", suppressions.CategoryInvalidAddress},
		{"role account info", "550 mailbox full", "info@acme.co", suppressions.CategoryRoleAccount},
		{"role account abuse", "temporary failure", "abuse@acme.co", suppressions.CategoryRoleAccount},
		{"generic hard bounce", "550 mailbox full", "real.person@acme.co", suppressions.BounceCategory("")},
		{"empty", "", "", suppressions.BounceCategory("")},
		// Precedence: spamtrap wins even when the localpart is a role.
		{"spamtrap beats role", "spamtrap hit", "info@acme.co", suppressions.CategorySpamtrap},
		// Precedence: dns_failure wins over a role localpart.
		{"dns beats role", "no such domain", "info@acme.co", suppressions.CategoryDNSFailure},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := detectBounceCategory(tc.diagnostic, tc.email)
			if got != tc.want {
				t.Errorf("detectBounceCategory(%q, %q) = %q, want %q",
					tc.diagnostic, tc.email, got, tc.want)
			}
		})
	}
}

// TestClassifyHardBounceReason maps each category to the right (reason,
// category) pair, and confirms the empty/unknown case falls back to a
// generic hard bounce carrying bounce_category=hard_bounce.
func TestClassifyHardBounceReason(t *testing.T) {
	cases := []struct {
		in         suppressions.BounceCategory
		wantReason suppressions.Reason
		wantCat    suppressions.BounceCategory
	}{
		{suppressions.CategorySpamtrap, suppressions.ReasonSpamtrap, suppressions.CategorySpamtrap},
		{suppressions.CategoryRoleAccount, suppressions.ReasonRoleAccount, suppressions.CategoryRoleAccount},
		{suppressions.CategoryDNSFailure, suppressions.ReasonDNSFail, suppressions.CategoryDNSFailure},
		{suppressions.CategoryInvalidAddress, suppressions.ReasonInvalidAddress, suppressions.CategoryInvalidAddress},
		{"", suppressions.ReasonHardBounce, suppressions.CategoryHardBounce},
		{suppressions.BounceCategory("garbage"), suppressions.ReasonHardBounce, suppressions.CategoryHardBounce},
	}
	for _, tc := range cases {
		gotReason, gotCat := classifyHardBounceReason(tc.in)
		if gotReason != tc.wantReason || gotCat != tc.wantCat {
			t.Errorf("classifyHardBounceReason(%q) = (%q,%q), want (%q,%q)",
				tc.in, gotReason, gotCat, tc.wantReason, tc.wantCat)
		}
	}
}

// TestLocalpart sanity-checks the role-detection input parser.
func TestLocalpart(t *testing.T) {
	cases := map[string]string{
		"Info@Acme.CO":  "info",
		"a.b+tag@x.com": "a.b+tag",
		"noatsign":      "",
		"@nodomain":     "",
		"  pad@x.com  ": "pad",
	}
	for in, want := range cases {
		if got := localpart(in); got != want {
			t.Errorf("localpart(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSubscriberBounceTypeFitsCanonicalEventConstraint(t *testing.T) {
	cases := []struct {
		category suppressions.BounceCategory
		fallback string
		want     string
	}{
		{suppressions.CategorySpamtrap, "hard", "spam_trap"},
		{suppressions.CategoryInvalidAddress, "hard", "hard"},
		{suppressions.CategoryDNSFailure, "hard", "hard"},
		{"", "soft", "soft"},
	}
	for _, tc := range cases {
		if got := subscriberBounceType(tc.category, tc.fallback); got != tc.want {
			t.Fatalf("subscriberBounceType(%q, %q) = %q, want %q", tc.category, tc.fallback, got, tc.want)
		}
	}
}
