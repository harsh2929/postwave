// SPDX-License-Identifier: AGPL-3.0-only
package from_name_picker

import "testing"

func TestRankOrdersRowsByCompositeScore(t *testing.T) {
	rows := []Row{
		{FromName: "large but weak", OpenRate: .2, Confidence: .5},
		{FromName: "winner", OpenRate: .4, Confidence: .8},
		{FromName: "complaint-heavy", OpenRate: .8, Confidence: 1, ComplaintRate: .02},
	}
	rank(rows)
	want := []string{"winner", "large but weak", "complaint-heavy"}
	for i, name := range want {
		if rows[i].FromName != name || rows[i].Rank != i+1 {
			t.Fatalf("row %d = %+v, want name %q rank %d", i, rows[i], name, i+1)
		}
	}
}

func TestRankKeepsRecipientOrderForTies(t *testing.T) {
	rows := []Row{
		{FromName: "first", OpenRate: .3, Confidence: .5},
		{FromName: "second", OpenRate: .3, Confidence: .5},
	}
	rank(rows)
	if rows[0].FromName != "first" || rows[1].FromName != "second" {
		t.Fatalf("stable tie order = %+v", rows)
	}
}
