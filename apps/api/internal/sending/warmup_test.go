package sending

import (
	"context"
	"testing"
	"time"
)

func TestCapForDay(t *testing.T) {
	cases := []struct{ day, limit, want int }{
		{0, 0, 0},
		{1, 0, 50},
		{7, 0, 10_000},
		{30, 0, 2_000_000},
		{99, 5_000_000, 5_000_000}, // beyond schedule -> tier cap
		{5, 1_000, 1_000},          // tier limit clamps schedule
	}
	for _, tc := range cases {
		if got := CapForDay(tc.day, tc.limit); got != tc.want {
			t.Fatalf("day=%d limit=%d got=%d want=%d", tc.day, tc.limit, got, tc.want)
		}
	}
}

func TestEnforceCap_AllowsBelow(t *testing.T) {
	tr := NewMemoryWarmupTracker()
	now := time.Date(2026, 4, 29, 12, 0, 0, 0, time.UTC)
	if err := tr.Start(context.Background(), "t1", now, 0); err != nil {
		t.Fatal(err)
	}
	allowed, deferred, err := EnforceCap(context.Background(), tr, "t1", 30, now)
	if err != nil {
		t.Fatal(err)
	}
	if allowed != 30 || deferred != 0 {
		t.Fatalf("got allowed=%d deferred=%d", allowed, deferred)
	}
}

func TestEnforceCap_Defers(t *testing.T) {
	tr := NewMemoryWarmupTracker()
	now := time.Date(2026, 4, 29, 12, 0, 0, 0, time.UTC)
	if err := tr.Start(context.Background(), "t1", now, 0); err != nil {
		t.Fatal(err)
	}
	allowed, deferred, err := EnforceCap(context.Background(), tr, "t1", 200, now)
	if err != nil {
		t.Fatal(err)
	}
	if allowed != 50 || deferred != 150 {
		t.Fatalf("got allowed=%d deferred=%d", allowed, deferred)
	}
}

func TestEnforceCap_Cumulative(t *testing.T) {
	tr := NewMemoryWarmupTracker()
	now := time.Date(2026, 4, 29, 12, 0, 0, 0, time.UTC)
	_ = tr.Start(context.Background(), "t1", now, 0)
	a, _, _ := EnforceCap(context.Background(), tr, "t1", 30, now)
	b, def, _ := EnforceCap(context.Background(), tr, "t1", 40, now)
	if a != 30 || b != 20 || def != 20 {
		t.Fatalf("got a=%d b=%d def=%d (want 30,20,20)", a, b, def)
	}
}

func TestEnforceCap_NewDayResets(t *testing.T) {
	tr := NewMemoryWarmupTracker()
	day1 := time.Date(2026, 4, 29, 12, 0, 0, 0, time.UTC)
	day2 := day1.Add(24 * time.Hour)
	_ = tr.Start(context.Background(), "t1", day1, 0)
	_, _, _ = EnforceCap(context.Background(), tr, "t1", 50, day1) // exhaust day 1
	allowed, _, _ := EnforceCap(context.Background(), tr, "t1", 80, day2)
	// Day 2 cap is 100; nothing yet sent today → all 80 allowed.
	if allowed != 80 {
		t.Fatalf("day2 allowed=%d want 80", allowed)
	}
}

func TestEnforceCap_NoStart(t *testing.T) {
	tr := NewMemoryWarmupTracker()
	now := time.Date(2026, 4, 29, 12, 0, 0, 0, time.UTC)
	allowed, deferred, err := EnforceCap(context.Background(), tr, "t1", 10, now)
	if err != nil {
		t.Fatal(err)
	}
	if allowed != 0 || deferred != 10 {
		t.Fatalf("untracked tenant should defer all; got a=%d d=%d", allowed, deferred)
	}
}
