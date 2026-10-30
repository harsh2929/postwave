package worker

import (
	"testing"
	"time"
)

func TestParseCron_BadShape(t *testing.T) {
	if _, err := parseCron("0 9 * *"); err == nil {
		t.Errorf("4-field expr should fail")
	}
	if _, err := parseCron("60 0 * * *"); err == nil {
		t.Errorf("minute=60 should fail")
	}
}

func TestDueWithin_NextDayAt9AM(t *testing.T) {
	spec, err := parseCron("0 9 * * *")
	if err != nil {
		t.Fatal(err)
	}
	from := time.Date(2026, 5, 3, 0, 0, 0, 0, time.UTC)
	until := from.Add(24 * time.Hour)
	got := dueWithin(spec, from, until)
	if len(got) != 1 {
		t.Fatalf("want 1 fire, got %d (%v)", len(got), got)
	}
	if got[0].Hour() != 9 {
		t.Errorf("want hour=9, got %v", got[0])
	}
}

func TestDueWithin_PreLastRunSkipped(t *testing.T) {
	// Simulate the scanner choosing `from = max(now, last_run)` so already-
	// fired timestamps are not duplicated.
	spec, _ := parseCron("0 9 * * *")
	now := time.Date(2026, 5, 3, 8, 0, 0, 0, time.UTC)
	lastRun := time.Date(2026, 5, 3, 9, 1, 0, 0, time.UTC)
	from := now
	if lastRun.After(from) {
		from = lastRun
	}
	got := dueWithin(spec, from, now.Add(24*time.Hour))
	for _, fire := range got {
		if !fire.After(lastRun) {
			t.Errorf("fire %v should be strictly after last_run %v", fire, lastRun)
		}
	}
}
