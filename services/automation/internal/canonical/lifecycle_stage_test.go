// SPDX-License-Identifier: AGPL-3.0-only
//
// lifecycle_stage_test.go — SUB-136 canonical lifecycle-stage matcher.
package canonical

import "testing"

func TestMatchLifecycleStage(t *testing.T) {
	cases := []struct {
		name      string
		trig      AutomationTrigger
		from, to  string
		wantMatch bool
	}{
		{
			name:      "bare trigger fires on any transition",
			trig:      AutomationTrigger{Type: TriggerLifecycleStageChanged},
			from:      "lead",
			to:        "customer",
			wantMatch: true,
		},
		{
			name:      "to_stage narrows to destination",
			trig:      AutomationTrigger{Type: TriggerLifecycleStageChanged, ToStage: "customer"},
			from:      "opportunity",
			to:        "customer",
			wantMatch: true,
		},
		{
			name:      "to_stage rejects other destination",
			trig:      AutomationTrigger{Type: TriggerLifecycleStageChanged, ToStage: "customer"},
			from:      "opportunity",
			to:        "evangelist",
			wantMatch: false,
		},
		{
			name:      "from+to fires only on the exact transition",
			trig:      AutomationTrigger{Type: TriggerLifecycleStageChanged, FromStage: "opportunity", ToStage: "customer"},
			from:      "opportunity",
			to:        "customer",
			wantMatch: true,
		},
		{
			name:      "from_stage rejects other origin",
			trig:      AutomationTrigger{Type: TriggerLifecycleStageChanged, FromStage: "opportunity", ToStage: "customer"},
			from:      "sql",
			to:        "customer",
			wantMatch: false,
		},
		{
			name:      "empty from matches initial assignment",
			trig:      AutomationTrigger{Type: TriggerLifecycleStageChanged, ToStage: "lead"},
			from:      "",
			to:        "lead",
			wantMatch: true,
		},
		{
			name:      "wrong trigger type never matches",
			trig:      AutomationTrigger{Type: TriggerProductEvent, ToStage: "customer"},
			from:      "opportunity",
			to:        "customer",
			wantMatch: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := MatchLifecycleStage(tc.trig, tc.from, tc.to); got != tc.wantMatch {
				t.Errorf("MatchLifecycleStage(%+v, %q, %q) = %v; want %v",
					tc.trig, tc.from, tc.to, got, tc.wantMatch)
			}
		})
	}
}
