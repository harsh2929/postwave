// SPDX-License-Identifier: AGPL-3.0-only

package replies

import "testing"

// Out-of-office replies must never count as engagement.
//
// The PRD calls this "the single most common way reply metrics get corrupted",
// and the reason is worth stating: every property that makes a reply
// trustworthy is present in an OOO. It comes from a real mailbox, with a real
// address, in response to a real campaign. A metric that counts them looks
// BETTER the more people are on holiday — and looks best exactly when a send
// lands in a holiday period, which is when somebody is most likely reading the
// report to decide whether the send worked.
func TestOutOfOfficeIsNeverEngagement(t *testing.T) {
	for _, tc := range []struct {
		name    string
		headers Headers
		subject string
		body    string
	}{
		{
			name:    "RFC 3834 Auto-Submitted",
			headers: Headers{"Auto-Submitted": "auto-replied"},
			subject: "Re: Spring sale",
			body:    "I am currently out of the office and will return on Monday.",
		},
		{
			name:    "subject convention alone",
			headers: Headers{},
			subject: "Automatic reply: Spring sale",
			body:    "Thanks for your message.",
		},
		{
			name:    "X-Autoreply header",
			headers: Headers{"X-Autoreply": "yes"},
			subject: "Re: Spring sale",
			body:    "On annual leave until the 14th.",
		},
		{
			name:    "Precedence auto_reply",
			headers: Headers{"Precedence": "auto_reply"},
			subject: "Re: Spring sale",
			body:    "Currently away from my desk.",
		},
		// Multilingual: an English-only classifier counts these as engagement,
		// and the customer whose list is not American is the one whose numbers
		// are most wrong.
		{name: "German", headers: Headers{}, subject: "Abwesenheitsnotiz", body: "Ich bin abwesend."},
		{name: "French", headers: Headers{}, subject: "Réponse automatique", body: "Absence du bureau."},
		{name: "Spanish", headers: Headers{}, subject: "Respuesta automática", body: "Ausente de la oficina."},
		{name: "Dutch", headers: Headers{}, subject: "Automatisch antwoord", body: "Ik ben afwezig."},
		{name: "Italian", headers: Headers{}, subject: "Risposta automatica", body: "Fuori sede."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyReply(tc.headers, tc.subject, tc.body)
			if got != ClassOutOfOffice {
				t.Fatalf("classified as %q, want out_of_office", got)
			}
			if got.CountsAsEngagement() {
				t.Fatal("an out-of-office reply counts as engagement; the metric " +
					"improves the more recipients are on holiday")
			}
		})
	}
}

// A real human reply is counted.
//
// The false-negative direction matters as much: replies are the hardest signal
// for an agent to fake and rise in value as clicks decay, so a classifier that
// discards them destroys the metric it exists to protect.
func TestARealReplyIsCountedAsEngagement(t *testing.T) {
	for _, tc := range []struct {
		name    string
		headers Headers
		subject string
		body    string
	}{
		{"plain reply", Headers{}, "Re: Spring sale", "This looks great — can you send pricing for 20 seats?"},
		{
			// RFC 3834 lets a real reply assert it is NOT automatic. Treating the
			// header's presence as evidence of automation would discard exactly
			// the messages that took the trouble to say otherwise.
			name:    "Auto-Submitted: no is an assertion of humanity",
			headers: Headers{"Auto-Submitted": "no"}, subject: "Re: Spring sale",
			body: "Yes please, Tuesday works.",
		},
		{
			// The words appear, but as content rather than as an auto-response.
			name: "a human mentioning the office", headers: Headers{},
			subject: "Re: Spring sale",
			body:    "I was out of the office last week so I only just saw this — still interested.",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyReply(tc.headers, tc.subject, tc.body)
			if got != ClassHumanReply {
				t.Fatalf("classified as %q, want human_reply — a real reply was "+
					"discarded, and replies are the signal that rises in value as "+
					"clicks decay", got)
			}
			if !got.CountsAsEngagement() {
				t.Fatal("a human reply does not count as engagement")
			}
		})
	}
}

// The remaining four classes, each excluded for its own reason.
func TestTheOtherClassesAreRecognisedAndExcluded(t *testing.T) {
	for _, tc := range []struct {
		name    string
		headers Headers
		subject string
		body    string
		want    ReplyClass
	}{
		{
			name:    "DSN by content type",
			headers: Headers{"Content-Type": "multipart/report; report-type=delivery-status"},
			subject: "Undeliverable: Spring sale", want: ClassBounce,
		},
		{
			// The null reverse-path RFC 5321 mandates for notifications: the most
			// reliable single signal in this whole classifier.
			name:    "DSN by null return-path",
			headers: Headers{"Return-Path": "<>"},
			subject: "Mail delivery failed", want: ClassBounce,
		},
		{
			name: "challenge-response", headers: Headers{},
			subject: "Please verify your email address to deliver your message",
			body:    "Confirm you are human to complete delivery.", want: ClassChallengeResponse,
		},
		{
			name: "unsubscribe intent in prose", headers: Headers{},
			subject: "Re: Spring sale",
			body:    "Please take me off this list, I no longer wish to receive these.",
			want:    ClassUnsubscribeRequest,
		},
		{
			name: "generic auto-reply", headers: Headers{"Auto-Submitted": "auto-generated"},
			subject: "Ticket #4821 received",
			body:    "Your request has been logged and assigned to an agent.",
			want:    ClassAutoReply,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyReply(tc.headers, tc.subject, tc.body)
			if got != tc.want {
				t.Fatalf("classified as %q, want %q", got, tc.want)
			}
			if got.CountsAsEngagement() {
				t.Fatalf("%q counts as engagement", got)
			}
		})
	}
}

// A bounce that quotes the original must not be reclassified by the quote.
//
// DSNs routinely include the original message, so every pattern in this file
// appears in their bodies. Checking bounces FIRST is what stops an undeliverable
// notice being read as an unsubscribe request.
func TestABounceQuotingTheOriginalStaysABounce(t *testing.T) {
	got := ClassifyReply(
		Headers{"Content-Type": "multipart/report; report-type=delivery-status"},
		"Undeliverable: Spring sale",
		"Your message could not be delivered.\n\n--- Original message ---\n"+
			"Click here to unsubscribe. I am out of the office.",
	)
	if got != ClassBounce {
		t.Fatalf("classified as %q; the quoted original overrode the DSN headers", got)
	}
}

// Only human_reply counts. Asserted over the whole closed set so a class added
// later must make a deliberate decision rather than inheriting a default.
func TestOnlyHumanReplyCountsAsEngagement(t *testing.T) {
	all := []ReplyClass{
		ClassHumanReply, ClassAutoReply, ClassOutOfOffice,
		ClassBounce, ClassUnsubscribeRequest, ClassChallengeResponse,
	}
	counted := 0
	for _, class := range all {
		if !class.Valid() {
			t.Errorf("%q is not a member of its own closed set", class)
		}
		if class.CountsAsEngagement() {
			counted++
			if class != ClassHumanReply {
				t.Errorf("%q counts as engagement", class)
			}
		}
	}
	if counted != 1 {
		t.Fatalf("%d classes count as engagement, want exactly 1", counted)
	}
}
