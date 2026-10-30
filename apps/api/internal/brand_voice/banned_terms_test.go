// SPDX-License-Identifier: AGPL-3.0-only

package brand_voice

import (
	"sort"
	"testing"
)

func TestBannedTermsFromRules(t *testing.T) {
	cases := []struct {
		name  string
		rules []string
		want  []string
	}{
		{"none", []string{"Be warm and concise."}, nil},
		{"avoid quoted", []string{`Avoid "cheap" in subject lines`}, []string{"cheap"}},
		{"never say", []string{"Never say synergy"}, []string{"synergy"}},
		{"the word stripper", []string{`Avoid the word "blast"`}, []string{"blast"}},
		{"dont use", []string{"Don't use jargon"}, []string{"jargon"}},
		{
			name:  "multiple rules dedup",
			rules: []string{"Avoid cheap", "never say cheap", "Don't use hurry"},
			want:  []string{"cheap", "hurry"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := BannedTermsFromRules(tc.rules)
			sort.Strings(got)
			sort.Strings(tc.want)
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("got %v, want %v", got, tc.want)
				}
			}
		})
	}
}
