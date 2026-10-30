// SPDX-License-Identifier: AGPL-3.0-only
package bounceclass

import "testing"

func TestClassify_EnhancedHardMailboxNotFound(t *testing.T) {
	got := Classify(Input{EnhancedStatusCode: "5.1.1", SMTPCode: "550", DiagnosticCode: "User unknown"})
	if got != ClassHard {
		t.Errorf("5.1.1 user unknown = %s, want hard", got)
	}
}

func TestClassify_EnhancedSoftMailboxFull(t *testing.T) {
	got := Classify(Input{EnhancedStatusCode: "5.2.2", SMTPCode: "552", DiagnosticCode: "Mailbox full"})
	if got != ClassSoftMailbox {
		t.Errorf("5.2.2 mailbox full = %s, want soft_mailbox", got)
	}
}

func TestClassify_5_7_1_DefaultIsPolicyReject(t *testing.T) {
	got := Classify(Input{EnhancedStatusCode: "5.7.1", SMTPCode: "550", DiagnosticCode: "Recipient policy refuses to accept"})
	if got != ClassPolicyReject {
		t.Errorf("5.7.1 plain = %s, want policy_reject", got)
	}
}

func TestClassify_5_7_1_RefinedToReputation(t *testing.T) {
	cases := []string{
		"5.7.1 Service unavailable; IP blacklisted by Spamhaus",
		"5.7.1 Blocked using zen.spamhaus.org",
		"5.7.1 sender ip on a block list",
	}
	for _, diag := range cases {
		got := Classify(Input{EnhancedStatusCode: "5.7.1", DiagnosticCode: diag})
		if got != ClassReputation {
			t.Errorf("%q -> %s, want reputation", diag, got)
		}
	}
}

func TestClassify_5_7_1_RefinedToContent(t *testing.T) {
	cases := []string{
		"5.7.1 message rejected as spam",
		"5.7.1 high probability of spam content",
		"5.7.1 message contains spam-like content",
	}
	for _, diag := range cases {
		got := Classify(Input{EnhancedStatusCode: "5.7.1", DiagnosticCode: diag})
		if got != ClassContentReject {
			t.Errorf("%q -> %s, want content_reject", diag, got)
		}
	}
}

func TestClassify_5_7_1_RefinedToUnsubscribe(t *testing.T) {
	got := Classify(Input{
		EnhancedStatusCode: "5.7.1",
		DiagnosticCode:     "550 5.7.1 The recipient has opted out of receiving mail from this sender",
	})
	if got != ClassUnsubscribe {
		t.Errorf("5.7.1 opt-out -> %s, want unsubscribe", got)
	}
}

func TestClassify_4xxRetryable(t *testing.T) {
	cases := []struct {
		enh  string
		want BounceClass
	}{
		{"4.2.1", ClassSoftMailbox},
		{"4.2.2", ClassSoftMailbox},
		{"4.4.1", ClassSoftDNS},
		{"4.4.7", ClassSoftDNS},
		{"4.7.1", ClassReputation},
	}
	for _, c := range cases {
		got := Classify(Input{EnhancedStatusCode: c.enh})
		if got != c.want {
			t.Errorf("%s -> %s, want %s", c.enh, got, c.want)
		}
	}
}

func TestClassify_ChallengeResponse(t *testing.T) {
	got := Classify(Input{
		EnhancedStatusCode: "5.1.1",
		DiagnosticCode:     "Please confirm your message via challenge response",
	})
	if got != ClassChallenge {
		t.Errorf("challenge response should override hard, got %s", got)
	}
}

func TestClassify_EnhancedFallbackByClass(t *testing.T) {
	// Codes not in the map should still classify via the class digit.
	cases := []struct {
		enh  string
		want BounceClass
	}{
		{"5.1.99", ClassHard},        // unknown 5.1.X
		{"5.2.99", ClassSoftMailbox}, // unknown 5.2.X
		{"5.6.99", ClassContentReject},
		{"5.7.99", ClassPolicyReject},
		{"4.9.99", ClassSoftDNS},
	}
	for _, c := range cases {
		got := Classify(Input{EnhancedStatusCode: c.enh})
		if got != c.want {
			t.Errorf("%s -> %s, want %s", c.enh, got, c.want)
		}
	}
}

func TestClassify_SMTPCodeOnly(t *testing.T) {
	cases := []struct {
		smtp string
		want BounceClass
	}{
		{"421", ClassSoftDNS},
		{"450", ClassSoftMailbox},
		{"550", ClassHard},
		{"541", ClassPolicyReject},
		{"552", ClassSoftMailbox},
	}
	for _, c := range cases {
		got := Classify(Input{SMTPCode: c.smtp})
		if got != c.want {
			t.Errorf("SMTP %s alone -> %s, want %s", c.smtp, got, c.want)
		}
	}
}

func TestClassify_DiagRegexNoCodeFallback(t *testing.T) {
	cases := []struct {
		diag string
		want BounceClass
	}{
		{"No such user here", ClassHard},
		{"User Unknown", ClassHard},
		{"recipient address rejected: user unknown", ClassHard},
		{"Mailbox is full", ClassSoftMailbox},
		{"Quota exceeded for this account", ClassSoftMailbox},
		{"Greylisted - try again later", ClassSoftDNS},
		{"DNS lookup failed", ClassSoftDNS},
		{"Message rejected as spam", ClassContentReject},
		{"Sender reputation too low", ClassReputation},
	}
	for _, c := range cases {
		got := Classify(Input{DiagnosticCode: c.diag})
		if got != c.want {
			t.Errorf("%q -> %s, want %s", c.diag, got, c.want)
		}
	}
}

func TestClassify_UnknownIsLastResort(t *testing.T) {
	if Classify(Input{}) != ClassUnknown {
		t.Errorf("empty input should classify as unknown")
	}
	if Classify(Input{DiagnosticCode: "completely opaque error message with no clue"}) != ClassUnknown {
		t.Errorf("opaque diag should classify as unknown")
	}
}

func TestClassify_4xxLeadingDigitFallback(t *testing.T) {
	// SMTP code with no enhanced + no recognised diag — fall through
	// to the leading-digit rule.
	got := Classify(Input{SMTPCode: "499"}) // not in the map
	if got != ClassSoftDNS {
		t.Errorf("499 fallback should be soft_dns, got %s", got)
	}
	got = Classify(Input{SMTPCode: "599"})
	if got != ClassHard {
		t.Errorf("599 fallback should be hard, got %s", got)
	}
}

func TestShouldSuppress(t *testing.T) {
	wantSuppress := map[BounceClass]bool{
		ClassHard:          true,
		ClassUnsubscribe:   true,
		ClassSoftMailbox:   false,
		ClassSoftDNS:       false,
		ClassPolicyReject:  false,
		ClassContentReject: false,
		ClassReputation:    false,
		ClassChallenge:     false,
		ClassUnknown:       false,
	}
	for c, want := range wantSuppress {
		if c.ShouldSuppress() != want {
			t.Errorf("%s.ShouldSuppress() = %v, want %v", c, !want, want)
		}
	}
}

func TestIsRetryable(t *testing.T) {
	wantRetry := map[BounceClass]bool{
		ClassSoftMailbox:   true,
		ClassSoftDNS:       true,
		ClassReputation:    true,
		ClassHard:          false,
		ClassPolicyReject:  false,
		ClassContentReject: false,
		ClassChallenge:     false,
		ClassUnsubscribe:   false,
		ClassUnknown:       false,
	}
	for c, want := range wantRetry {
		if c.IsRetryable() != want {
			t.Errorf("%s.IsRetryable() = %v, want %v", c, !want, want)
		}
	}
}

// TestClassify_RealWorldBounces pins the classifier against actual
// bounce strings observed in production from each major ESP. Adding
// a new ESP-specific weirdness = adding one row here, not a
// behavioural drift.
func TestClassify_RealWorldBounces(t *testing.T) {
	cases := []struct {
		name string
		in   Input
		want BounceClass
	}{
		{
			name: "SES hard bounce — mailbox does not exist",
			in:   Input{ESP: "ses", SMTPCode: "550", EnhancedStatusCode: "5.1.1", DiagnosticCode: "smtp; 550 5.1.1 user unknown"},
			want: ClassHard,
		},
		{
			name: "Mailgun reputation reject (Gmail)",
			in:   Input{ESP: "mailgun", SMTPCode: "550", EnhancedStatusCode: "5.7.1", DiagnosticCode: "Our system has detected that this message is suspicious due to the very low reputation of the sending IP address."},
			want: ClassReputation,
		},
		{
			name: "Postmark content reject",
			in:   Input{ESP: "postmark", SMTPCode: "550", EnhancedStatusCode: "5.7.1", DiagnosticCode: "Message rejected as spam by Content Filter"},
			want: ClassContentReject,
		},
		{
			name: "Outlook 5.4.4 routing failure",
			in:   Input{SMTPCode: "554", EnhancedStatusCode: "5.4.4", DiagnosticCode: "Mailbox unavailable; unable to route"},
			want: ClassSoftDNS,
		},
		{
			name: "Yahoo greylist temporary defer",
			in:   Input{SMTPCode: "421", EnhancedStatusCode: "4.7.0", DiagnosticCode: "[TS01] Messages from this sending IP are temporarily deferred. Try again later."},
			want: ClassReputation,
		},
		{
			name: "Custom MAILER-DAEMON no codes",
			in:   Input{DiagnosticCode: "MAILER-DAEMON: User unknown in virtual alias table"},
			want: ClassHard,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Classify(c.in)
			if got != c.want {
				t.Errorf("Classify(%q) = %s, want %s", c.name, got, c.want)
			}
		})
	}
}
