package control_group

import "testing"

// control_group is a GLOBAL program holdout: a deterministic % of a tenant's
// subscribers who must receive NO campaigns, so the engagement gap between them
// and everyone else measures the marketing program's incremental lift.
//
// IsInControl was exported and called from nowhere, so control members received
// every campaign and the lift compared two cohorts that both got the email. The
// send path must exclude control members — hashing the SAME identifier the
// report uses (email, after this change), or the two silently disagree.
func TestPartitionControl_ExcludesControlMembersDeterministically(t *testing.T) {
	groups := []ControlGroup{{Seed: "prog-2026", Percent: 20, Status: StatusActive}}
	emails := make([]string, 0, 1000)
	for i := 0; i < 1000; i++ {
		emails = append(emails, "user"+itoa(i)+"@example.com")
	}

	kept, excluded := PartitionControl(groups, emails)

	if len(kept)+len(excluded) != len(emails) {
		t.Fatalf("partition lost rows: %d + %d != %d", len(kept), len(excluded), len(emails))
	}
	// ~20% excluded, with generous tolerance for a 1k sample.
	frac := float64(len(excluded)) / float64(len(emails))
	if frac < 0.12 || frac > 0.28 {
		t.Fatalf("excluded fraction %.2f is nowhere near the 20%% control percent", frac)
	}
	// Deterministic: the same email lands the same side every time, and agrees
	// with the raw predicate the report uses.
	for _, e := range excluded {
		if !IsInControl("prog-2026", e, 20) {
			t.Fatalf("%q was excluded but IsInControl says treated — send and report will disagree", e)
		}
	}
	for _, e := range kept {
		if IsInControl("prog-2026", e, 20) {
			t.Fatalf("%q was kept but IsInControl says control — a control member would be mailed", e)
		}
	}
}

func TestPartitionControl_NoGroupsKeepsEveryone(t *testing.T) {
	emails := []string{"a@x.com", "b@x.com"}
	kept, excluded := PartitionControl(nil, emails)
	if len(kept) != 2 || len(excluded) != 0 {
		t.Fatalf("no active control groups must keep everyone; kept=%d excluded=%d", len(kept), len(excluded))
	}
}

// A subscriber in ANY active group is excluded (multiple concurrent programs).
func TestPartitionControl_UnionAcrossGroups(t *testing.T) {
	// Two groups with different seeds; a 100% group excludes everyone.
	groups := []ControlGroup{
		{Seed: "s1", Percent: 0, Status: StatusActive},
		{Seed: "s2", Percent: 100, Status: StatusActive},
	}
	kept, excluded := PartitionControl(groups, []string{"a@x.com", "b@x.com"})
	if len(kept) != 0 || len(excluded) != 2 {
		t.Fatalf("a 100%% group must exclude everyone; kept=%d excluded=%d", len(kept), len(excluded))
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
