package suppressions

import (
	"testing"
)

// TestConvergerScopeAllows is the table-driven unit test for the
// always-block carve-out: hard_bounce + global_unsubscribe MUST trip
// against a transactional-scope send even though every other reason
// passes through.
func TestConvergerScopeAllows(t *testing.T) {
	cases := []struct {
		reason Reason
		scope  Scope
		want   bool
	}{
		{ReasonHardBounce, ScopeTransactional, true},
		{ReasonHardBounce, ScopeMarketing, true},
		{ReasonGlobalUnsubscribe, ScopeTransactional, true},
		{ReasonGlobalUnsubscribe, ScopeMarketing, true},
		{ReasonManualUnsubscribe, ScopeMarketing, true},
		{ReasonManualUnsubscribe, ScopeTransactional, false},
		{ReasonListManual, ScopeMarketing, true},
		{ReasonListManual, ScopeTransactional, false},
		{ReasonSpamComplaint, ScopeMarketing, true},
		{ReasonSpamComplaint, ScopeTransactional, false},
		{ReasonSpamComplaint, ScopeAll, true},
	}
	for _, tc := range cases {
		got := scopeAllows(tc.reason, tc.scope)
		if got != tc.want {
			t.Errorf("scopeAllows(%q, %q) = %v, want %v",
				tc.reason, tc.scope, got, tc.want)
		}
	}
}

// TestConvergerChannelMatches covers the email-only default + the
// 'any' wildcard. SMS / push channels will get rows of their own once
// the write paths land; until then everything is email-coloured.
func TestConvergerChannelMatches(t *testing.T) {
	cases := []struct {
		src  Source
		want Channel
		ok   bool
	}{
		{SourcePostmark, ChannelEmail, true},
		{SourceMailgun, ChannelEmail, true},
		{SourceManual, ChannelEmail, true},
		{SourceAPI, ChannelAny, true},
		{SourceImport, ChannelSMS, false},
		{SourceMailgun, ChannelPush, false},
	}
	for _, tc := range cases {
		got := channelMatches(tc.src, tc.want)
		if got != tc.ok {
			t.Errorf("channelMatches(%q, %q) = %v, want %v",
				tc.src, tc.want, got, tc.ok)
		}
	}
}

// TestConvergerNormalizeReason — the legacy admin-add / one-click /
// import surfaces emit free-form reason strings; the canonical X1
// CHECK constraint refuses anything outside the enum. NormalizeReason
// is the single mapping function callers must run.
func TestConvergerNormalizeReason(t *testing.T) {
	cases := map[string]Reason{
		"hard_bounce":           ReasonHardBounce,
		"bounce":                ReasonHardBounce,
		"hardBounce":            ReasonHardBounce,
		"complaint":             ReasonSpamComplaint,
		"spam":                  ReasonSpamComplaint,
		"SPAM_COMPLAINT":        ReasonSpamComplaint,
		"unsubscribe":           ReasonManualUnsubscribe,
		"one_click":             ReasonManualUnsubscribe,
		"manual":                ReasonManualUnsubscribe,
		"imported":              ReasonManualUnsubscribe,
		"":                      ReasonManualUnsubscribe,
		"dsar_deletion":         ReasonDSARDeletion,
		"role_address":          ReasonRoleAddress,
		"invalid_email":         ReasonInvalidEmail,
		"blocklist_auto":        ReasonBlocklistAuto,
		"list_manual":           ReasonListManual,
		"global_unsubscribe":    ReasonGlobalUnsubscribe,
		"soft_bounce_threshold": ReasonSoftBounceThreshold,
		"some_garbage_value":    ReasonManualUnsubscribe,
	}
	for input, want := range cases {
		got := NormalizeReason(input)
		if got != want {
			t.Errorf("NormalizeReason(%q) = %q, want %q", input, got, want)
		}
	}
}

// TestConvergerNilSafe — every converger entrypoint must tolerate a
// nil receiver / nil pool without panicking. Production wiring always
// constructs the converger, but defence-in-depth keeps tests + zero-
// value adapters safe.
func TestConvergerNilSafe(t *testing.T) {
	var c *SuppressionConverger
	if _, _, err := c.Check(t.Context(), "tid", "x@y.co", ChannelEmail, ScopeMarketing); err == nil {
		t.Errorf("nil converger Check: expected error")
	}
	if _, err := c.LookupBulk(t.Context(), "tid", []string{"x@y.co"}, ChannelEmail, ScopeMarketing); err == nil {
		t.Errorf("nil converger LookupBulk: expected error")
	}
	if err := c.Remove(t.Context(), "tid", "x@y.co"); err == nil {
		t.Errorf("nil converger Remove: expected error")
	}
}
