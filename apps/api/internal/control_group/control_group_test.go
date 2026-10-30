// SPDX-License-Identifier: AGPL-3.0-only
package control_group

import "testing"

// control_group.IsInControl is exported and called from nowhere: the send
// path never consults it, so "control" members receive every campaign. The
// report then compared control vs treated — two cohorts that both got the
// email — and produced a believable incremental-lift number measured on
// pure noise. Operators make budget decisions on that number.
//
// Until membership is actually excluded at send time, the report must refuse
// to publish a lift figure at all. An absent number is honest; a fabricated
// one is not.
func TestReportRefusesToPublishLiftWhileUnenforced(t *testing.T) {
	// Enforcement is now ON by default (the send path excludes control members).
	// This test still guards the withhold path — should enforcement ever be
	// turned back off, a report must never publish a lift measured on two
	// cohorts that both received the campaign.
	defer func(prev bool) { enforcedAtSendTime = prev }(enforcedAtSendTime)
	enforcedAtSendTime = false

	rep := finalizeReport("grp-1", 30, cohort{size: 100, engaged: 10}, cohort{size: 900, engaged: 180})

	if rep.Enforced {
		t.Fatal("Enforced must be false while the withhold path is active")
	}
	if rep.IncrementalLift != nil {
		t.Errorf("incremental lift must be omitted while unenforced, got %v", *rep.IncrementalLift)
	}
	if rep.ControlEngagement != nil || rep.TreatedEngagement != nil {
		t.Error("engagement rates must be omitted while unenforced: both cohorts received the campaign")
	}
	if rep.Warning == "" {
		t.Error("an unenforced report must explain why the numbers are missing")
	}
	// Cohort sizes are still real and still useful — only the comparison is
	// meaningless.
	if rep.ControlSize != 100 || rep.TreatedSize != 900 {
		t.Errorf("cohort sizes should survive: got control=%d treated=%d", rep.ControlSize, rep.TreatedSize)
	}
}

// The moment the dispatcher is wired, flipping enforcedAtSendTime must make
// the report publish real numbers. This test pins that contract so the fix
// cannot be half-landed.
func TestReportPublishesLiftOnceEnforced(t *testing.T) {
	defer func(prev bool) { enforcedAtSendTime = prev }(enforcedAtSendTime)
	enforcedAtSendTime = true

	rep := finalizeReport("grp-1", 30, cohort{size: 100, engaged: 10}, cohort{size: 900, engaged: 180})

	if !rep.Enforced {
		t.Fatal("Enforced must be true once the send path excludes control members")
	}
	if rep.Warning != "" {
		t.Errorf("an enforced report needs no warning, got %q", rep.Warning)
	}
	if rep.ControlEngagement == nil || *rep.ControlEngagement != 0.10 {
		t.Errorf("control engagement = %v, want 0.10", rep.ControlEngagement)
	}
	if rep.TreatedEngagement == nil || *rep.TreatedEngagement != 0.20 {
		t.Errorf("treated engagement = %v, want 0.20", rep.TreatedEngagement)
	}
	// lift = treated - control = 0.20 - 0.10
	if rep.IncrementalLift == nil || *rep.IncrementalLift != 0.10 {
		t.Errorf("incremental lift = %v, want 0.10", rep.IncrementalLift)
	}
}
