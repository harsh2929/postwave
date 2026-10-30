// SPDX-License-Identifier: AGPL-3.0-only
package worker

import (
	"testing"
	"time"
)

func TestModeSimpleMajority(t *testing.T) {
	hours := []int{9, 9, 14, 9, 21}
	best, count := mode(hours)
	if best != 9 || count != 3 {
		t.Fatalf("want (9,3), got (%d,%d)", best, count)
	}
}

func TestModeTieBreaksLow(t *testing.T) {
	hours := []int{20, 20, 5, 5}
	best, _ := mode(hours)
	if best != 5 {
		t.Fatalf("tie should pick lower hour, got %d", best)
	}
}

func TestHourOfWeek(t *testing.T) {
	sun9 := time.Date(2026, 5, 3, 9, 0, 0, 0, time.UTC)
	if got := hourOfWeek(sun9); got != 9 {
		t.Fatalf("Sunday 09:00 want 9, got %d", got)
	}
}
