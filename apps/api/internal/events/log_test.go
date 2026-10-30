// SPDX-License-Identifier: AGPL-3.0-only
package events

import (
	"testing"
	"time"
)

func mustTime(t *testing.T, v string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, v)
	if err != nil {
		t.Fatalf("bad fixture time %q: %v", v, err)
	}
	return parsed
}

func TestPatternMatches_Glob(t *testing.T) {
	cases := []struct {
		patterns []string
		topic    string
		want     bool
	}{
		{nil, "campaign.created", true},
		{[]string{"*"}, "campaign.created", true},
		{[]string{"campaign.created"}, "campaign.created", true},
		{[]string{"campaign.*"}, "campaign.created", true},
		{[]string{"campaign.*"}, "campaign.sent", true},
		{[]string{"campaign.*"}, "subscriber.added", false},
		{[]string{"campaign.created", "subscriber.added"}, "subscriber.added", true},
		{[]string{"campaign.created"}, "campaign.sent", false},
	}
	for _, c := range cases {
		if got := patternMatches(c.patterns, c.topic); got != c.want {
			t.Errorf("patternMatches(%v, %q) = %v want %v", c.patterns, c.topic, got, c.want)
		}
	}
}

// --- replay paging ---------------------------------------------------------
//
// Gap recovery is only correct if the cursor a client stores always moves past
// everything the server actually examined. The first implementation filtered by
// topic AFTER the LIMIT and advanced the cursor only for MATCHING rows, so a
// page of 200 events containing none of the client's topics returned an empty
// list, left the cursor unmoved, and reported "no more" — the client stopped
// and permanently missed every matching event beyond that page. On a busy
// tenant that is silent, unbounded event loss, and it defeats the entire
// feature.

func TestReplayPageAdvancesCursorPastNonMatchingRows(t *testing.T) {
	scanned := []ReplayEvent{
		{SequenceID: 10, Topic: "subscriber.opened"},
		{SequenceID: 11, Topic: "subscriber.clicked"},
		{SequenceID: 12, Topic: "subscriber.opened"},
	}
	events, cursor, hasMore := replayPage(scanned, []string{"campaign.*"}, 3)
	if len(events) != 0 {
		t.Fatalf("events = %d, want 0 (none match campaign.*)", len(events))
	}
	if cursor != 12 {
		t.Fatalf("cursor = %d, want 12 — it must pass every row EXAMINED, not every row returned", cursor)
	}
	if !hasMore {
		t.Fatal("hasMore = false on a full page; the client would stop and lose everything after it")
	}
}

func TestReplayPageReportsMoreFromScannedCount(t *testing.T) {
	full := make([]ReplayEvent, 5)
	for i := range full {
		full[i] = ReplayEvent{SequenceID: int64(i + 1), Topic: "campaign.sent"}
	}
	if _, _, hasMore := replayPage(full, nil, 5); !hasMore {
		t.Fatal("a page filled to the limit must report has_more")
	}
	if _, _, hasMore := replayPage(full[:2], nil, 5); hasMore {
		t.Fatal("a short page must NOT report has_more")
	}
	// The case that actually distinguishes the fix. With no topic filter,
	// scanned == matched, so the old (broken) implementation passed both
	// assertions above — this test certified nothing until here. `has_more`
	// must come from what was SCANNED: a full page that matched nothing still
	// means there is more to walk, and reporting false there is exactly how a
	// client stops one page short of its own gap, forever.
	if _, _, hasMore := replayPage(full, []string{"subscriber.*"}, 5); !hasMore {
		t.Fatal("a page filled to the limit but matching nothing must STILL report has_more")
	}
}

func TestReplayPageFiltersButKeepsOrder(t *testing.T) {
	scanned := []ReplayEvent{
		{SequenceID: 1, Topic: "campaign.sent"},
		{SequenceID: 2, Topic: "subscriber.opened"},
		{SequenceID: 3, Topic: "campaign.created"},
	}
	events, cursor, _ := replayPage(scanned, []string{"campaign.*"}, 10)
	if len(events) != 2 || events[0].SequenceID != 1 || events[1].SequenceID != 3 {
		t.Fatalf("events = %+v, want the two campaign rows in sequence order", events)
	}
	if cursor != 3 {
		t.Fatalf("cursor = %d, want 3", cursor)
	}
}

func TestReplayPageEmptyScanKeepsCallerCursor(t *testing.T) {
	events, cursor, hasMore := replayPage(nil, nil, 200)
	if len(events) != 0 || cursor != 0 || hasMore {
		t.Fatalf("empty scan = (%d events, cursor %d, more %v), want (0, 0, false)", len(events), cursor, hasMore)
	}
}

func TestReplayPageTracksLatestTimestamp(t *testing.T) {
	// The SSE stream carries `at` but NOT sequence_id — the log write is a
	// best-effort hook decoupled from fanout (LogWriter.OnPublish), so a live
	// event cannot be given a sequence id without coupling the stream to the
	// log's health. A live client therefore replays by TIME, and needs the
	// server to tell it how far the page reached.
	base := mustTime(t, "2026-08-04T09:00:00Z")
	scanned := []ReplayEvent{
		{SequenceID: 1, Topic: "campaign.sent", At: base},
		{SequenceID: 2, Topic: "subscriber.opened", At: base.Add(90 * 1e9)},
	}
	if got := latestScannedAt(scanned); !got.Equal(base.Add(90 * 1e9)) {
		t.Fatalf("latestScannedAt = %v, want the max over ALL scanned rows", got)
	}
	if got := latestScannedAt(nil); !got.IsZero() {
		t.Fatalf("latestScannedAt(nil) = %v, want zero", got)
	}
}
