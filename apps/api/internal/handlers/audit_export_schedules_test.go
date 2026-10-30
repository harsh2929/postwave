// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_export_schedules_test.go — pure tests for the evidence-pack
// schedule validation + due computation. DB-backed paths are covered
// by the shared handler integration suite (skipped without TEST_DATABASE_URL).

package handlers

import (
	"testing"
	"time"
)

func TestValidateExportScheduleInput(t *testing.T) {
	t.Parallel()

	t.Run("accepts weekly with one recipient", func(t *testing.T) {
		cadence, rec, err := validateExportScheduleInput("Weekly", []string{" soc@example.com "})
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if cadence != "weekly" {
			t.Fatalf("cadence = %q, want weekly", cadence)
		}
		if len(rec) != 1 || rec[0] != "soc@example.com" {
			t.Fatalf("recipients = %v", rec)
		}
	})

	t.Run("dedupes recipients case-insensitively", func(t *testing.T) {
		_, rec, err := validateExportScheduleInput("monthly",
			[]string{"a@example.com", "A@example.com", "b@example.com"})
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if len(rec) != 2 {
			t.Fatalf("recipients = %v, want 2 entries", rec)
		}
	})

	t.Run("rejects bad cadence", func(t *testing.T) {
		if _, _, err := validateExportScheduleInput("daily", []string{"a@example.com"}); err == nil {
			t.Fatal("want error for cadence=daily")
		}
	})

	t.Run("rejects empty recipients", func(t *testing.T) {
		if _, _, err := validateExportScheduleInput("weekly", []string{"", "  "}); err == nil {
			t.Fatal("want error for no recipients")
		}
	})

	t.Run("rejects malformed email", func(t *testing.T) {
		if _, _, err := validateExportScheduleInput("weekly", []string{"not-an-email"}); err == nil {
			t.Fatal("want error for malformed recipient")
		}
	})

	t.Run("rejects recipient overflow", func(t *testing.T) {
		many := make([]string, 0, maxExportScheduleRecipients+1)
		for i := 0; i <= maxExportScheduleRecipients; i++ {
			many = append(many, string(rune('a'+i%26))+string(rune('0'+i/26))+"@example.com")
		}
		if _, _, err := validateExportScheduleInput("weekly", many); err == nil {
			t.Fatal("want error for too many recipients")
		}
	})
}

func TestScheduleDue(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 6, 11, 12, 0, 0, 0, time.UTC)
	ago := func(d time.Duration) *time.Time { v := now.Add(-d); return &v }

	cases := []struct {
		name     string
		cadence  string
		last     *time.Time
		expected bool
	}{
		{"never enqueued is always due", "weekly", nil, true},
		{"weekly 6 days ago not due", "weekly", ago(6 * 24 * time.Hour), false},
		{"weekly exactly 7 days ago due", "weekly", ago(7 * 24 * time.Hour), true},
		{"weekly 8 days ago due", "weekly", ago(8 * 24 * time.Hour), true},
		{"monthly 20 days ago not due", "monthly", ago(20 * 24 * time.Hour), false},
		{"monthly 31 days ago due", "monthly", ago(31 * 24 * time.Hour), true},
		{"unknown cadence never due", "daily", ago(365 * 24 * time.Hour), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := scheduleDue(tc.cadence, tc.last, now); got != tc.expected {
				t.Fatalf("scheduleDue(%s) = %v, want %v", tc.name, got, tc.expected)
			}
		})
	}

	t.Run("monthly anchors on calendar month", func(t *testing.T) {
		// Jan 31 + 1 month (AddDate) = Mar 2/3 — verify we use AddDate
		// semantics rather than a fixed 30-day window.
		last := time.Date(2026, 1, 31, 0, 0, 0, 0, time.UTC)
		notYet := time.Date(2026, 2, 28, 0, 0, 0, 0, time.UTC)
		if scheduleDue("monthly", &last, notYet) {
			t.Fatal("Feb 28 should not be due for a Jan 31 monthly anchor")
		}
		due := time.Date(2026, 3, 3, 0, 0, 0, 0, time.UTC)
		if !scheduleDue("monthly", &last, due) {
			t.Fatal("Mar 3 should be due for a Jan 31 monthly anchor")
		}
	})
}
