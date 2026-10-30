// SPDX-License-Identifier: AGPL-3.0-only
package audit

import (
	"fmt"
	"strconv"
	"strings"
	"testing"
)

func TestParseEventIDs(t *testing.T) {
	t.Run("happy path", func(t *testing.T) {
		got, err := ParseEventIDs("1,2,3")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := []int64{1, 2, 3}
		if len(got) != len(want) {
			t.Fatalf("got %v, want %v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("got %v, want %v", got, want)
			}
		}
	})

	t.Run("dedupes and tolerates whitespace and trailing commas", func(t *testing.T) {
		got, err := ParseEventIDs(" 7, 7 ,8,,9, ")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(got) != 3 || got[0] != 7 || got[1] != 8 || got[2] != 9 {
			t.Fatalf("got %v, want [7 8 9]", got)
		}
	})

	t.Run("rejects empty", func(t *testing.T) {
		for _, raw := range []string{"", "  ", ",,,"} {
			if _, err := ParseEventIDs(raw); err == nil {
				t.Fatalf("ParseEventIDs(%q) should error", raw)
			}
		}
	})

	t.Run("rejects non-numeric, zero, and negative entries", func(t *testing.T) {
		for _, raw := range []string{"1,abc", "0", "-3", "1,2,-1", "1;2", "9223372036854775808"} {
			if _, err := ParseEventIDs(raw); err == nil {
				t.Fatalf("ParseEventIDs(%q) should error", raw)
			}
		}
	})

	t.Run("caps at MaxEventIDsPerRequest distinct ids", func(t *testing.T) {
		atCap := make([]string, MaxEventIDsPerRequest)
		for i := range atCap {
			atCap[i] = strconv.Itoa(i + 1)
		}
		if got, err := ParseEventIDs(strings.Join(atCap, ",")); err != nil || len(got) != MaxEventIDsPerRequest {
			t.Fatalf("exactly %d ids should parse, got len=%d err=%v", MaxEventIDsPerRequest, len(got), err)
		}
		over := strings.Join(atCap, ",") + fmt.Sprintf(",%d", MaxEventIDsPerRequest+1)
		if _, err := ParseEventIDs(over); err == nil {
			t.Fatalf("%d ids should exceed the cap", MaxEventIDsPerRequest+1)
		}
		// Duplicates do not count against the cap.
		dups := strings.Join(atCap, ",") + ",1,2,3"
		if got, err := ParseEventIDs(dups); err != nil || len(got) != MaxEventIDsPerRequest {
			t.Fatalf("duplicates must not count against the cap, got len=%d err=%v", len(got), err)
		}
	})
}

func TestNormalizeAccessRequestNote(t *testing.T) {
	t.Run("trims", func(t *testing.T) {
		got, err := NormalizeAccessRequestNote("  need audit for SOC2 review  ")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "need audit for SOC2 review" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("empty is allowed", func(t *testing.T) {
		got, err := NormalizeAccessRequestNote("")
		if err != nil || got != "" {
			t.Fatalf("empty note must be allowed, got %q err=%v", got, err)
		}
	})

	t.Run("rejects past the cap", func(t *testing.T) {
		atCap := strings.Repeat("a", MaxAccessRequestNoteLen)
		if _, err := NormalizeAccessRequestNote(atCap); err != nil {
			t.Fatalf("note at the cap must pass: %v", err)
		}
		if _, err := NormalizeAccessRequestNote(atCap + "a"); err == nil {
			t.Fatalf("note past the cap must error")
		}
		// Trim happens before the length check — padded-but-within
		// notes pass.
		if _, err := NormalizeAccessRequestNote("  " + atCap + "  "); err != nil {
			t.Fatalf("trimmed note at the cap must pass: %v", err)
		}
	})
}
