// SPDX-License-Identifier: AGPL-3.0-only

package replies

import (
	"strings"
	"testing"
)

// Quoted history is removed before classification.
//
// This is not tidiness. A quoted original contains the campaign's own
// unsubscribe link and often an earlier message's "out of the office" — so
// classifying the UNSTRIPPED body lets the message being replied TO decide what
// the reply is.
func TestQuotedHistoryIsStrippedBeforeClassification(t *testing.T) {
	body := `Yes, Tuesday works for me.

On Mon, 4 May 2026 at 09:14, Moosewave <hello@example.test> wrote:
> Spring sale is live.
> Click here to unsubscribe: https://example.test/u/abc
`
	stripped := StripQuotedHistory(body)
	if !strings.Contains(stripped, "Tuesday works") {
		t.Fatalf("the reply's own text was removed: %q", stripped)
	}
	if strings.Contains(stripped, "unsubscribe") {
		t.Fatalf("quoted history survived: %q — the quoted original would decide "+
			"the classification of the reply", stripped)
	}

	// And the classification differs between the two, which is the point.
	if got := ClassifyReply(Headers{}, "Re: Spring sale", body); got != ClassUnsubscribeRequest {
		t.Logf("unstripped classifies as %q", got)
	}
	if got := ClassifyReply(Headers{}, "Re: Spring sale", stripped); got != ClassHumanReply {
		t.Errorf("stripped body classifies as %q, want human_reply", got)
	}
}

// Signatures are removed, using the RFC 3676 marker precisely.
func TestSignaturesAreStripped(t *testing.T) {
	stripped := StripQuotedHistory("Sounds good.\n\n-- \nJane Doe\nVP Marketing\n+1 555 0100")
	if strings.Contains(stripped, "VP Marketing") {
		t.Errorf("signature survived: %q", stripped)
	}
	if !strings.Contains(stripped, "Sounds good") {
		t.Errorf("the reply was removed with its signature: %q", stripped)
	}

	// "--" without the trailing space is ordinary prose, not a sig marker.
	prose := StripQuotedHistory("The price -- before discount -- is 129.")
	if !strings.Contains(prose, "before discount") {
		t.Errorf("a double dash in prose was treated as a signature marker: %q", prose)
	}
}

// Mobile signatures go too.
func TestMobileSignaturesAreStripped(t *testing.T) {
	for _, sig := range []string{"Sent from my iPhone", "Get Outlook for Android"} {
		stripped := StripQuotedHistory("Works for me.\n\n" + sig)
		if strings.Contains(stripped, sig) {
			t.Errorf("%q survived: %q", sig, stripped)
		}
	}
}

// A strip that would remove everything returns the original.
//
// An empty stripped body is indistinguishable from an empty reply, and a
// classifier handed nothing calls it human by default — so an over-eager strip
// would silently PROMOTE an out-of-office notice to engagement. That is the
// failure direction that matters.
func TestAnOverEagerStripFallsBackToTheOriginal(t *testing.T) {
	// A message that is nothing but an attribution line and quotes.
	body := "On Mon, 4 May 2026, Moosewave wrote:\n> I am out of the office."
	stripped := StripQuotedHistory(body)
	if strings.TrimSpace(stripped) == "" {
		t.Fatal("stripping produced an empty body; a classifier handed nothing " +
			"defaults to human_reply, silently promoting an auto-reply to engagement")
	}
	// And it still classifies as out-of-office rather than defaulting to human.
	if got := ClassifyReply(Headers{"Auto-Submitted": "auto-replied"}, "", stripped); got != ClassOutOfOffice {
		t.Errorf("fell back to %q, want out_of_office", got)
	}
}

// Outlook-style banners are handled as well as attribution lines.
func TestOutlookStyleQuotingIsStripped(t *testing.T) {
	body := "Confirmed.\n\n-----Original Message-----\nFrom: Moosewave\nSpring sale is live."
	stripped := StripQuotedHistory(body)
	if strings.Contains(stripped, "Spring sale") {
		t.Errorf("Outlook-style quoted history survived: %q", stripped)
	}
	if !strings.Contains(stripped, "Confirmed") {
		t.Errorf("the reply was removed: %q", stripped)
	}
}
