// SPDX-License-Identifier: AGPL-3.0-only
package livecert

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixedClock() func() time.Time {
	return func() time.Time { return time.Date(2026, 6, 20, 0, 0, 0, 0, time.UTC) }
}

func TestRecorderWritesSanitizedJSONL(t *testing.T) {
	reportPath := filepath.Join(t.TempDir(), "evidence.jsonl")
	rec := &Recorder{Provider: "stripe", ReportPath: reportPath, Now: fixedClock()}

	if err := rec.Record("backfill_customers", map[string]any{
		"customers":     3,
		"cursor_first":  true,
		"access_token":  "rk_live_raw",
		"client_secret": "shh",
		"api_password":  "p",
	}); err != nil {
		t.Fatalf("record: %v", err)
	}

	raw, err := os.ReadFile(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	for _, want := range []string{
		`"provider":"stripe"`,
		`"check":"backfill_customers"`,
		`"status":"passed"`,
		`"recorded_at":"2026-06-20T00:00:00Z"`,
		`"customers":3`,
		`"cursor_first":true`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("evidence missing %q in %s", want, body)
		}
	}
	for _, leaked := range []string{"rk_live_raw", "shh", "access_token", "client_secret", "api_password"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("evidence leaked sensitive material %q: %s", leaked, body)
		}
	}
}

func TestRecorderNoopWhenNoReportPath(t *testing.T) {
	rec := &Recorder{Provider: "stripe", Now: fixedClock()}
	if err := rec.Record("backfill_customers", map[string]any{"customers": 1}); err != nil {
		t.Fatalf("record without report path should be a silent no-op, got %v", err)
	}
}

func TestReadReportRoundTrip(t *testing.T) {
	reportPath := filepath.Join(t.TempDir(), "evidence.jsonl")
	rec := &Recorder{Provider: "square", ReportPath: reportPath, Now: fixedClock()}
	if err := rec.Record("backfill_customers", nil); err != nil {
		t.Fatal(err)
	}
	if err := rec.Record("backfill_orders", map[string]any{"orders": 2}); err != nil {
		t.Fatal(err)
	}

	entries, err := ReadReport(reportPath)
	if err != nil {
		t.Fatalf("read report: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	if entries[0].Check != "backfill_customers" || entries[1].Check != "backfill_orders" {
		t.Fatalf("unexpected entries: %+v", entries)
	}
}

func TestValidateCompletenessDetectsMissing(t *testing.T) {
	required := []string{"a", "b", "c"}
	entries := []Evidence{
		{Provider: "square", Check: "a", Status: "passed", RecordedAt: "2026-06-20T00:00:00Z"},
		{Provider: "square", Check: "b", Status: "passed", RecordedAt: "2026-06-20T00:00:00Z"},
	}
	err := ValidateCompleteness("square", entries, required)
	if err == nil || !strings.Contains(err.Error(), "missing") || !strings.Contains(err.Error(), "c") {
		t.Fatalf("expected missing-check error mentioning c, got %v", err)
	}
}

func TestValidateCompletenessAcceptsComplete(t *testing.T) {
	required := []string{"a", "b"}
	entries := []Evidence{
		{Provider: "square", Check: "a", Status: "passed", RecordedAt: "2026-06-20T00:00:00Z"},
		{Provider: "square", Check: "b", Status: "passed", RecordedAt: "2026-06-20T00:00:00Z"},
	}
	if err := ValidateCompleteness("square", entries, required); err != nil {
		t.Fatalf("complete evidence should validate: %v", err)
	}
}

func TestValidateCompletenessIgnoresForeignAndUnpassed(t *testing.T) {
	required := []string{"a"}
	entries := []Evidence{
		{Provider: "shopify", Check: "a", Status: "passed", RecordedAt: "2026-06-20T00:00:00Z"}, // wrong provider
		{Provider: "square", Check: "a", Status: "failed", RecordedAt: "2026-06-20T00:00:00Z"},  // not passed
	}
	if err := ValidateCompleteness("square", entries, required); err == nil {
		t.Fatal("evidence from another provider or with non-passed status must not satisfy completeness")
	}
}

func TestValidateCompletenessRequiresRecordedAt(t *testing.T) {
	required := []string{"a"}
	entries := []Evidence{{Provider: "square", Check: "a", Status: "passed", RecordedAt: ""}}
	if err := ValidateCompleteness("square", entries, required); err == nil || !strings.Contains(err.Error(), "recorded_at") {
		t.Fatalf("expected recorded_at error, got %v", err)
	}
}

func TestCSVDedupesAndTrims(t *testing.T) {
	got := CSV("persons, deals\tdeals\n organizations ")
	want := []string{"persons", "deals", "organizations"}
	if len(got) != len(want) {
		t.Fatalf("CSV got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("CSV got %v want %v", got, want)
		}
	}
}

func TestBoolTruthy(t *testing.T) {
	t.Setenv("LIVECERT_TEST_FLAG", "yes")
	if !Bool("LIVECERT_TEST_FLAG") {
		t.Fatal("expected yes to be truthy")
	}
	t.Setenv("LIVECERT_TEST_FLAG", "0")
	if Bool("LIVECERT_TEST_FLAG") {
		t.Fatal("expected 0 to be falsey")
	}
}
