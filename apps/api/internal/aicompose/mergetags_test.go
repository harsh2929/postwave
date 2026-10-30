// SPDX-License-Identifier: AGPL-3.0-only

package aicompose

import (
	"sort"
	"testing"
)

func TestMissingMergeTags(t *testing.T) {
	cases := []struct {
		name      string
		original  string
		generated string
		want      []string
	}{
		{
			name:      "no tags anywhere",
			original:  "Big news inside",
			generated: "Huge update for you",
			want:      nil,
		},
		{
			name:      "tag preserved",
			original:  "Hi {{first_name}}, news",
			generated: "{{first_name}}, big news today",
			want:      nil,
		},
		{
			name:      "tag preserved despite inner whitespace",
			original:  "Hi {{first_name}}",
			generated: "Hello {{ first_name }} there",
			want:      nil,
		},
		{
			name:      "tag dropped",
			original:  "Hi {{first_name}}, your {{company}} order",
			generated: "Hi there, your order",
			want:      []string{"{{company}}", "{{first_name}}"},
		},
		{
			name:      "one of two dropped",
			original:  "{{first_name}} — {{city}} deals",
			generated: "{{first_name}} — local deals",
			want:      []string{"{{city}}"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := MissingMergeTags(tc.original, tc.generated)
			sort.Strings(got)
			sort.Strings(tc.want)
			if len(got) != len(tc.want) {
				t.Fatalf("missing = %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("missing = %v, want %v", got, tc.want)
				}
			}
		})
	}
}

func TestPreservesMergeTags(t *testing.T) {
	if !PreservesMergeTags("Hi {{first_name}}", "{{first_name}}, hello") {
		t.Errorf("expected preserved when tag survives")
	}
	if PreservesMergeTags("Hi {{first_name}}", "Hi there") {
		t.Errorf("expected not-preserved when tag dropped")
	}
	// No tags in original => trivially preserved.
	if !PreservesMergeTags("plain subject", "totally different") {
		t.Errorf("expected preserved when original has no tags")
	}
}
