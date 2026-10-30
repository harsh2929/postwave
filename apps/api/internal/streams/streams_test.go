// SPDX-License-Identifier: AGPL-3.0-only

package streams

import "testing"

func TestStreamIsValid(t *testing.T) {
	cases := []struct {
		s    Stream
		want bool
	}{
		{Transactional, true},
		{Marketing, true},
		{Broadcast, true},
		{Stream(""), false},
		{Stream("Marketing"), false}, // case-sensitive — Normalize() handles casing
		{Stream("transactional "), false},
		{Stream("bulk"), false},
	}
	for _, c := range cases {
		if got := c.s.IsValid(); got != c.want {
			t.Errorf("Stream(%q).IsValid()=%v want %v", c.s, got, c.want)
		}
	}
}

func TestNormalize(t *testing.T) {
	cases := []struct {
		in   string
		want Stream
	}{
		{"", Marketing},   // empty → safe default
		{"  ", Marketing}, // whitespace → empty → default
		{"TRANSACTIONAL", Transactional},
		{"Transactional", Transactional},
		{"  marketing  ", Marketing},
		{"broadcast", Broadcast},
		{"bogus", Marketing}, // invalid → default
	}
	for _, c := range cases {
		if got := Normalize(c.in); got != c.want {
			t.Errorf("Normalize(%q)=%q want %q", c.in, got, c.want)
		}
	}
}

func TestEQScoreFloor(t *testing.T) {
	cases := []struct {
		s    Stream
		want int
	}{
		// Transactional gets the lowest floor (40) because receipts are
		// boilerplate / link-heavy / spam-like in shape but legitimate.
		{Transactional, 40},
		{Broadcast, 55},
		{Marketing, 60},
		// Unknown stream values fall through to the marketing default
		// (the switch's default branch).
		{Stream("bogus"), 60},
	}
	for _, c := range cases {
		if got := c.s.EQScoreFloor(); got != c.want {
			t.Errorf("Stream(%q).EQScoreFloor()=%d want %d", c.s, got, c.want)
		}
	}
}

// Ordering invariant — the bands MUST be monotonically increasing in
// strictness. If this breaks the dispatcher will start allowing
// marketing messages with worse hygiene than transactional.
func TestEQScoreFloor_StreamOrdering(t *testing.T) {
	if !(Transactional.EQScoreFloor() < Broadcast.EQScoreFloor()) {
		t.Errorf("transactional floor must be < broadcast: %d vs %d",
			Transactional.EQScoreFloor(), Broadcast.EQScoreFloor())
	}
	if !(Broadcast.EQScoreFloor() < Marketing.EQScoreFloor()) {
		t.Errorf("broadcast floor must be < marketing: %d vs %d",
			Broadcast.EQScoreFloor(), Marketing.EQScoreFloor())
	}
}
