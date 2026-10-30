// SPDX-License-Identifier: AGPL-3.0-only
package omnichannel

import (
	"context"
	"strings"
	"testing"
)

func TestConsentChannel(t *testing.T) {
	cases := map[string]string{
		"email": "email", "sms": "sms", "whatsapp": "sms", "rcs": "sms",
		"push": "push", "unknown": "email",
	}
	for in, want := range cases {
		if got := consentChannel(in); got != want {
			t.Errorf("consentChannel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIdentityColumns(t *testing.T) {
	for _, ch := range []string{"email", "sms", "whatsapp", "rcs"} {
		sub, rec, ok := identityColumns(ch)
		if !ok || sub == "" || rec == "" {
			t.Errorf("identityColumns(%q) = (%q,%q,%v), want a real identity column", ch, sub, rec, ok)
		}
	}
	if _, _, ok := identityColumns("push"); ok {
		t.Errorf("push must not be materializable by this spine yet")
	}
	if sub, _, _ := identityColumns("email"); sub != "email" {
		t.Errorf("email identity column = %q, want email", sub)
	}
	// The phone channels resolve operator-supplied data first and the DERIVED
	// identity only as a fallback. Asserted as a property rather than a literal:
	// the two must both be consulted, and phone_e164 must come first, because
	// `sms_binding_not_contradicted` reads phone_e164 as evidence of which number
	// belongs to a subscriber. Deriving into that column made the guard arbitrate
	// against its own output and locked subscribers out of SMS permanently after
	// a number change (migration 1866).
	for _, ch := range []string{"sms", "whatsapp", "rcs"} {
		sub, _, _ := identityColumns(ch)
		if !strings.Contains(sub, "phone_e164") {
			t.Errorf("%s identity does not consult the operator column: %q", ch, sub)
		}
		if !strings.Contains(sub, "sms_send_identity") {
			t.Errorf("%s identity does not fall back to the derived column, so a "+
				"subscriber whose only phone came from their opt-in is unreachable: %q",
				ch, sub)
		}
		if strings.Index(sub, "phone_e164") > strings.Index(sub, "sms_send_identity") {
			t.Errorf("%s identity prefers the derived value over operator data: %q", ch, sub)
		}
	}
}

func TestRenumberPlaceholders(t *testing.T) {
	got := renumberPlaceholders("a = $1 AND b IN ($2,$3)", 3)
	want := "a = $4 AND b IN ($5,$6)"
	if got != want {
		t.Errorf("renumberPlaceholders = %q, want %q", got, want)
	}
	// No placeholders → unchanged.
	if got := renumberPlaceholders("x = 'lit'", 5); got != "x = 'lit'" {
		t.Errorf("renumber of literal changed it: %q", got)
	}
}

func TestPathSegmentID(t *testing.T) {
	// Path-level segment wins.
	if got := pathSegmentID(CampaignPath{Audience: map[string]any{"segment_id": "seg-path"}}, map[string]any{"segment_id": "seg-camp"}); got != "seg-path" {
		t.Errorf("path segment should win, got %q", got)
	}
	// Falls back to campaign-level.
	if got := pathSegmentID(CampaignPath{}, map[string]any{"segment_id": "seg-camp"}); got != "seg-camp" {
		t.Errorf("should fall back to campaign segment, got %q", got)
	}
	// Neither → empty; materialization must reject it rather than expanding
	// to the whole consented base.
	if got := pathSegmentID(CampaignPath{}, nil); got != "" {
		t.Errorf("no segment should be empty, got %q", got)
	}
	if _, err := explicitPathSegmentID(CampaignPath{PathKey: "email"}, nil); err == nil {
		t.Fatal("missing explicit segment must fail closed")
	}
}

func TestRecordOnlySenderFailsClosed(t *testing.T) {
	out := recordOnlySender{}.Send(context.Background(), "t1", EligibleRecipient{Channel: "email"})
	if out.Status != "failed" || out.Reason == "" {
		t.Errorf("record-only sender outcome = %+v, want explicit failure", out)
	}
}

func TestTerminalSendStatusRejectsQueuedOrUnknownOutcome(t *testing.T) {
	for _, status := range []string{"queued", "accepted", ""} {
		outcome := SendOutcome{Status: status}
		if got := terminalSendStatus(&outcome); got != "failed" {
			t.Errorf("terminalSendStatus(%q) = %q, want failed", status, got)
		}
		if outcome.Status != "failed" || outcome.Reason == "" {
			t.Errorf("normalized outcome for %q = %+v", status, outcome)
		}
	}
	for _, status := range []string{"sent", "failed"} {
		outcome := SendOutcome{Status: status}
		if got := terminalSendStatus(&outcome); got != status {
			t.Errorf("terminalSendStatus(%q) = %q", status, got)
		}
	}
}
