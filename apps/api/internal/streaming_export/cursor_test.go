// SPDX-License-Identifier: AGPL-3.0-only

package streaming_export

import (
	"strings"
	"testing"
	"time"
)

func TestStreamingCursorRoundTripAndValidation(t *testing.T) {
	cutoff := time.Date(2026, 8, 29, 14, 0, 0, 0, time.FixedZone("test", 5*60*60+30*60))
	raw, err := encodeStreamingCursor(streamingCursor{ID: 42, Cutoff: cutoff})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	got, ok := parseStreamingCursor(raw)
	if !ok {
		t.Fatalf("parse rejected encoded cursor: %s", raw)
	}
	if got.Schema != "streaming.v1" || got.ID != 42 || got.Cutoff.Location() != time.UTC || !got.Cutoff.Equal(cutoff) {
		t.Fatalf("round trip = %#v", got)
	}

	invalid := []string{
		"",
		"2026-08-29T14:00:00Z",
		`{"schema":"streaming.v0","id":42,"cutoff":"2026-08-29T14:00:00Z"}`,
		`{"schema":"streaming.v1","id":-1,"cutoff":"2026-08-29T14:00:00Z"}`,
		`{"schema":"streaming.v1","id":42,"cutoff":"0001-01-01T00:00:00Z"}`,
		strings.Repeat("x", 513),
	}
	for _, candidate := range invalid {
		if _, ok := parseStreamingCursor(candidate); ok {
			t.Fatalf("accepted invalid cursor %q", candidate)
		}
	}
	if _, err := encodeStreamingCursor(streamingCursor{ID: -1, Cutoff: cutoff}); err == nil {
		t.Fatal("negative cursor ID was accepted")
	}
	if _, err := encodeStreamingCursor(streamingCursor{ID: 1}); err == nil {
		t.Fatal("zero cutoff was accepted")
	}
}

func TestNextStreamingCursorPreservesOverflowWindowUntilExhausted(t *testing.T) {
	start := time.Date(2026, 8, 29, 10, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)

	overflow, err := nextStreamingCursor(100, 200, start, end, true)
	if err != nil {
		t.Fatalf("overflow transition: %v", err)
	}
	if overflow.ID != 200 || !overflow.Cutoff.Equal(start) {
		t.Fatalf("overflow cursor = %#v, want ID 200 anchored at %s", overflow, start)
	}

	complete, err := nextStreamingCursor(200, 250, start, end, false)
	if err != nil {
		t.Fatalf("complete transition: %v", err)
	}
	if complete.ID != 250 || !complete.Cutoff.Equal(end) {
		t.Fatalf("complete cursor = %#v, want ID 250 advanced to %s", complete, end)
	}

	bad := []struct {
		from, to   int64
		start, end time.Time
	}{
		{from: 10, to: 9, start: start, end: end},
		{from: -1, to: 0, start: start, end: end},
		{from: 0, to: 0, start: end, end: start},
	}
	for _, candidate := range bad {
		if _, err := nextStreamingCursor(candidate.from, candidate.to, candidate.start, candidate.end, true); err == nil {
			t.Fatalf("accepted invalid transition %#v", candidate)
		}
	}
}
