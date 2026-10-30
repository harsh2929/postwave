// SPDX-License-Identifier: AGPL-3.0-only

package campaign_replies

import "testing"

func TestNormalizeIntent(t *testing.T) {
	cases := map[string]string{
		"question":      "question",
		"praise":        "praise",
		"unsub":         "unsub",
		"ooo":           "ooo",
		"other":         "other",
		"UNSUB":         "unsub",
		"  Praise  ":    "praise",
		"unsubscribe":   "unsub",
		"opt-out":       "unsub",
		"out_of_office": "ooo",
		"out-of-office": "ooo",
		"autoreply":     "ooo",
		"garbage":       "",
		"":              "",
	}
	for in, want := range cases {
		if got := normalizeIntent(in); got != want {
			t.Errorf("normalizeIntent(%q) = %q, want %q", in, got, want)
		}
	}
}

// The heuristic short-circuit must recognise the obvious buckets before
// the LLM is consulted (keeps token spend down on auto-replies etc.).
func TestClassifyHeuristic(t *testing.T) {
	cases := []struct {
		subject, body string
		wantLabel     string
		wantHit       bool
	}{
		{"Out of office", "I am away until Monday", "ooo", true},
		{"Re: launch", "please unsubscribe me", "unsub", true},
		{"Quick question", "how do I change my plan?", "question", true},
		{"Re: newsletter", "this was great, thanks for sharing", "praise", true},
		{"Re: hello", "ok", "", false},
	}
	for _, tc := range cases {
		got, hit := classifyHeuristic(tc.subject, tc.body)
		if hit != tc.wantHit {
			t.Errorf("classifyHeuristic(%q,%q) hit = %v, want %v", tc.subject, tc.body, hit, tc.wantHit)
			continue
		}
		if hit && got.Label != tc.wantLabel {
			t.Errorf("classifyHeuristic(%q,%q) label = %q, want %q", tc.subject, tc.body, got.Label, tc.wantLabel)
		}
	}
}
