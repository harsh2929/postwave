package sending

import (
	"context"
	"errors"
	"testing"
)

func TestApplyTrackingPrefsHeadersNoOptOutPassesThrough(t *testing.T) {
	if got := applyTrackingPrefsHeaders(nil, false, false); got != nil {
		t.Fatalf("nil headers + no opt-out should return nil, got %#v", got)
	}
	in := map[string]string{"X-Other": "1"}
	got := applyTrackingPrefsHeaders(in, false, false)
	if len(got) != 1 || got["X-Other"] != "1" {
		t.Fatalf("no opt-out should preserve existing headers untouched, got %#v", got)
	}
}

func TestApplyTrackingPrefsHeadersAddsOpenOnly(t *testing.T) {
	got := applyTrackingPrefsHeaders(nil, true, false)
	if got["X-Postwave-No-Open-Track"] != "1" {
		t.Fatalf("missing open opt-out header: %#v", got)
	}
	if _, ok := got["X-Postwave-No-Click-Track"]; ok {
		t.Fatalf("click header should NOT be set when only open opt-out: %#v", got)
	}
}

func TestApplyTrackingPrefsHeadersAddsClickOnly(t *testing.T) {
	got := applyTrackingPrefsHeaders(map[string]string{"List-Unsubscribe": "<x>"}, false, true)
	if got["X-Postwave-No-Click-Track"] != "1" {
		t.Fatalf("missing click opt-out header: %#v", got)
	}
	if _, ok := got["X-Postwave-No-Open-Track"]; ok {
		t.Fatalf("open header should NOT be set when only click opt-out: %#v", got)
	}
	if got["List-Unsubscribe"] != "<x>" {
		t.Fatalf("existing headers must not be clobbered: %#v", got)
	}
}

func TestApplyTrackingPrefsHeadersBothOptOuts(t *testing.T) {
	got := applyTrackingPrefsHeaders(nil, true, true)
	if got["X-Postwave-No-Open-Track"] != "1" || got["X-Postwave-No-Click-Track"] != "1" {
		t.Fatalf("both headers should be set: %#v", got)
	}
}

// stubLookup is the test double the send loop would consume.
type stubLookup struct {
	skipOpen, skipClick bool
	err                 error
}

func (s stubLookup) Lookup(_ context.Context, _, _ string) (bool, bool, error) {
	return s.skipOpen, s.skipClick, s.err
}

func TestTrackingPrefsLookupContract(t *testing.T) {
	cases := []struct {
		name     string
		lookup   stubLookup
		wantOpen bool
		wantClk  bool
		wantErr  bool
	}{
		{"none", stubLookup{}, false, false, false},
		{"open_only", stubLookup{skipOpen: true}, true, false, false},
		{"click_only", stubLookup{skipClick: true}, false, true, false},
		{"both", stubLookup{skipOpen: true, skipClick: true}, true, true, false},
		{"stub_error_shape_is_preserved_for_caller_policy",
			stubLookup{err: errors.New("transient")}, false, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			open, click, err := tc.lookup.Lookup(context.Background(), "t", "e@example.com")
			if (err != nil) != tc.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, tc.wantErr)
			}
			if open != tc.wantOpen || click != tc.wantClk {
				t.Fatalf("open=%v want=%v ; click=%v want=%v", open, tc.wantOpen, click, tc.wantClk)
			}
		})
	}
}

type failingBatchTrackingLookup struct{}

func (failingBatchTrackingLookup) Lookup(context.Context, string, string) (bool, bool, error) {
	return false, false, errors.New("recipient lookup must not be reached")
}

type incompleteBatchTrackingLookup struct{}

func (incompleteBatchTrackingLookup) Lookup(context.Context, string, string) (bool, bool, error) {
	return false, false, errors.New("recipient lookup must not be reached")
}

func (incompleteBatchTrackingLookup) LookupBatch(context.Context, string, []string) (map[string]TrackingPrefsBatchEntry, error) {
	return map[string]TrackingPrefsBatchEntry{
		"one@example.com": {},
	}, nil
}

func (failingBatchTrackingLookup) LookupBatch(context.Context, string, []string) (map[string]TrackingPrefsBatchEntry, error) {
	return nil, errors.New("consent store unavailable")
}

func TestTrackingBatchErrorFailsClosedWithoutPerRecipientRetry(t *testing.T) {
	guard := &Guard{TrackingFilter: failingBatchTrackingLookup{}}
	got, ok := guard.prefetchTrackingOptOuts(context.Background(), "tenant-1", []string{
		"One@Example.com", "two@example.com",
	})
	if !ok {
		t.Fatal("batch uncertainty must be a resolved fail-closed decision")
	}
	for _, email := range []string{"one@example.com", "two@example.com"} {
		entry, exists := got[email]
		if !exists || !entry.SkipOpen || !entry.SkipClick {
			t.Fatalf("%s decision = %+v exists=%v; want both tracking modes suppressed", email, entry, exists)
		}
	}
}

func TestMissingTrackingFilterFailsClosedForWholeBatch(t *testing.T) {
	guard := &Guard{}
	got, ok := guard.prefetchTrackingOptOuts(context.Background(), "tenant-1", []string{
		"One@Example.com", "two@example.com",
	})
	if !ok {
		t.Fatal("missing tracking filter must produce a resolved fail-closed batch")
	}
	for _, email := range []string{"one@example.com", "two@example.com"} {
		entry, exists := got[email]
		if !exists || !entry.SkipOpen || !entry.SkipClick {
			t.Fatalf("%s decision = %+v exists=%v; want both tracking modes suppressed", email, entry, exists)
		}
	}
}

func TestIncompleteTrackingBatchFailsClosedOnlyMissingDecisions(t *testing.T) {
	guard := &Guard{TrackingFilter: incompleteBatchTrackingLookup{}}
	got, ok := guard.prefetchTrackingOptOuts(context.Background(), "tenant-1", []string{
		"One@Example.com", "two@example.com",
	})
	if !ok {
		t.Fatal("incomplete batch must remain a resolved batch decision")
	}
	if one := got["one@example.com"]; one.SkipOpen || one.SkipClick {
		t.Fatalf("known allow decision changed: %+v", one)
	}
	two, exists := got["two@example.com"]
	if !exists || !two.SkipOpen || !two.SkipClick {
		t.Fatalf("missing decision = %+v exists=%v; want fail closed", two, exists)
	}
}
