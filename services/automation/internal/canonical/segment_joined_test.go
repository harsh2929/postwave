// SPDX-License-Identifier: AGPL-3.0-only
//
// segment_joined_test.go — canonical segment-entry matcher.
package canonical

import "testing"

func TestMatchSegmentJoined(t *testing.T) {
	cases := []struct {
		name      string
		trig      AutomationTrigger
		segmentID string
		wantMatch bool
	}{
		{
			name:      "matches the named segment",
			trig:      AutomationTrigger{Type: TriggerSegmentJoined, SegmentID: "seg-1"},
			segmentID: "seg-1",
			wantMatch: true,
		},
		{
			name:      "rejects a different segment",
			trig:      AutomationTrigger{Type: TriggerSegmentJoined, SegmentID: "seg-1"},
			segmentID: "seg-2",
			wantMatch: false,
		},
		{
			name:      "empty trigger segment never fires (no any-segment semantic)",
			trig:      AutomationTrigger{Type: TriggerSegmentJoined, SegmentID: ""},
			segmentID: "seg-1",
			wantMatch: false,
		},
		{
			name:      "empty event segment never fires",
			trig:      AutomationTrigger{Type: TriggerSegmentJoined, SegmentID: "seg-1"},
			segmentID: "",
			wantMatch: false,
		},
		{
			name:      "wrong trigger type never matches",
			trig:      AutomationTrigger{Type: TriggerProductEvent, SegmentID: "seg-1"},
			segmentID: "seg-1",
			wantMatch: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := MatchSegmentJoined(tc.trig, tc.segmentID); got != tc.wantMatch {
				t.Errorf("MatchSegmentJoined(%+v, %q) = %v; want %v",
					tc.trig, tc.segmentID, got, tc.wantMatch)
			}
		})
	}
}
