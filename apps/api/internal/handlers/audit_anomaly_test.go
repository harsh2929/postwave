// SPDX-License-Identifier: AGPL-3.0-only
package handlers

import "testing"

func TestRiskBucket(t *testing.T) {
	cases := []struct {
		score float64
		want  string
	}{
		{0, "low"},
		{10, "low"},
		{24.99, "low"},
		{25, "med"},
		{59, "med"},
		{60, "high"},
		{100, "high"},
	}
	for _, c := range cases {
		if got := riskBucket(c.score); got != c.want {
			t.Errorf("score=%f: got %s want %s", c.score, got, c.want)
		}
	}
}

func TestParsePgTextArray(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"{}", []string{}},
		{`{"T1078"}`, []string{"T1078"}},
		{`{"T1078","T1098","T1134"}`, []string{"T1078", "T1098", "T1134"}},
	}
	for _, c := range cases {
		got := parsePgTextArray(c.in)
		if len(got) != len(c.want) {
			t.Errorf("input=%s len mismatch got=%v want=%v", c.in, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("input=%s [%d] got=%s want=%s", c.in, i, got[i], c.want[i])
			}
		}
	}
}
