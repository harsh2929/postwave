// Package handlers — tests for the G10 authored-rule drift overlay.

package handlers

import "testing"

func TestAuthoredAdjustment(t *testing.T) {
	cases := []struct {
		name        string
		buf         string
		descriptors []string
		banned      []string
		want        float64
	}{
		{
			name: "no rules => no-op",
			buf:  "Hello there, big news",
			want: 0,
		},
		{
			name:   "one banned term",
			buf:    "Grab this CHEAP deal now",
			banned: []string{"cheap"},
			want:   -10,
		},
		{
			name:   "banned penalty caps at three hits",
			buf:    "cheap cheap cheap cheap discount blowout",
			banned: []string{"cheap", "discount", "blowout", "cheap"},
			want:   -30,
		},
		{
			name:        "descriptor reward",
			buf:         "A thoughtful, warm welcome",
			descriptors: []string{"thoughtful", "warm"},
			want:        4,
		},
		{
			name:        "penalty and reward combine",
			buf:         "A warm but cheap offer",
			descriptors: []string{"warm"},
			banned:      []string{"cheap"},
			want:        -8,
		},
		{
			name:   "blank rules ignored",
			buf:    "anything",
			banned: []string{"", "  "},
			want:   0,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := authoredAdjustment(tc.buf, tc.descriptors, tc.banned)
			if got != tc.want {
				t.Fatalf("authoredAdjustment = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestClampScore(t *testing.T) {
	if clampScore(-5) != 0 {
		t.Errorf("clampScore(-5) should be 0")
	}
	if clampScore(150) != 100 {
		t.Errorf("clampScore(150) should be 100")
	}
	if clampScore(42) != 42 {
		t.Errorf("clampScore(42) should be 42")
	}
}
