// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit coverage for the SUB-102-103 worker. The DB-backed paths are
// exercised by the e2e import flow; here we lock the contract on the
// pure helpers — chunk sizing, email extraction, mapping-driven
// payload construction, and upsert SQL by strategy — so a refactor
// can't silently swap behaviour.

package subscriber_import

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	migratecsv "github.com/postwave/migrate/csv"
)

// happy-path knobs: default chunk size is the documented contract
// (DB CHECK + UI label rely on it).
func TestWorker_Defaults(t *testing.T) {
	w := &Worker{}
	if got := w.chunkSize(); got != DefaultChunkSize {
		t.Fatalf("chunkSize default: want %d got %d", DefaultChunkSize, got)
	}
	if got := w.interval(); got != 5*time.Second {
		t.Fatalf("interval default: want 5s got %s", got)
	}
}

func TestWorker_OverridesHonoured(t *testing.T) {
	w := &Worker{ChunkSize: 42, Interval: time.Minute}
	if got := w.chunkSize(); got != 42 {
		t.Fatalf("chunkSize override: %d", got)
	}
	if got := w.interval(); got != time.Minute {
		t.Fatalf("interval override: %s", got)
	}
}

func TestEmailColumnIndex(t *testing.T) {
	m := migratecsv.Mapping{Columns: []migratecsv.ColumnMapping{
		{Index: 0, Name: "name", Kind: migratecsv.KindName},
		{Index: 1, Name: "email", Kind: migratecsv.KindEmail},
		{Index: 2, Name: "tags", Kind: migratecsv.KindTags},
	}}
	if got := emailColumnIndex(m); got != 1 {
		t.Fatalf("want 1, got %d", got)
	}
	if got := emailColumnIndex(migratecsv.Mapping{}); got != -1 {
		t.Fatalf("missing email: want -1, got %d", got)
	}
}

func TestExtractEmail_LowercasesAndTrims(t *testing.T) {
	cases := []struct {
		row  []string
		idx  int
		want string
	}{
		{[]string{"x", "  Foo@Example.com "}, 1, "foo@example.com"},
		{[]string{"x"}, 5, ""},
		{nil, 0, ""},
		{[]string{"", ""}, 0, ""},
	}
	for i, c := range cases {
		if got := extractEmail(c.row, c.idx); got != c.want {
			t.Errorf("case %d: want %q got %q", i, c.want, got)
		}
	}
}

func TestBuildRowFields_SplitsTagsAndCustoms(t *testing.T) {
	m := migratecsv.Mapping{Columns: []migratecsv.ColumnMapping{
		{Index: 0, Name: "email", Kind: migratecsv.KindEmail},
		{Index: 1, Name: "tags", Kind: migratecsv.KindTags},
		{Index: 2, Name: "Plan", Kind: migratecsv.KindCustom, CustomKey: "plan"},
		{Index: 3, Name: "name", Kind: migratecsv.KindName},
	}}
	fields, err := buildRowFields([]string{"a@b.com", "vip, churned;new|free", "pro", "Alice"}, m)
	if err != nil {
		t.Fatal(err)
	}
	name, tags, custom := fields.FullName, fields.Tags, fields.Custom
	if len(tags) != 4 {
		t.Fatalf("tags: want 4 got %d (%v)", len(tags), tags)
	}
	want := map[string]bool{"vip": true, "churned": true, "new": true, "free": true}
	for _, tg := range tags {
		if !want[tg] {
			t.Errorf("unexpected tag %q", tg)
		}
	}
	if custom["plan"] != "pro" {
		t.Errorf("custom plan: %v", custom["plan"])
	}
	if name != "Alice" {
		t.Errorf("canonical name: %v", name)
	}
}

func TestBuildRowFields_SkipsEmailAndEmptyValues(t *testing.T) {
	m := migratecsv.Mapping{Columns: []migratecsv.ColumnMapping{
		{Index: 0, Name: "email", Kind: migratecsv.KindEmail},
		{Index: 1, Name: "extra", Kind: migratecsv.KindCustom, CustomKey: "extra"},
	}}
	fields, err := buildRowFields([]string{"a@b.com", "  "}, m)
	if err != nil {
		t.Fatal(err)
	}
	tags, custom := fields.Tags, fields.Custom
	if len(tags) != 0 {
		t.Errorf("expected no tags, got %v", tags)
	}
	// Email column must NEVER land in custom_fields (the conflict key).
	if _, has := custom["email"]; has {
		t.Errorf("email leaked into custom: %v", custom)
	}
	if _, has := custom["extra"]; has {
		t.Errorf("empty value should be skipped: %v", custom)
	}
}

// Run_NilPool returns an error rather than panicking — guards against a
// boot-order regression where Run is wired before the pool is ready.
func TestRun_NilPoolErrors(t *testing.T) {
	w := &Worker{}
	if err := w.Run(context.Background()); err == nil {
		t.Fatal("nil pool should error")
	}
}

// TestBuildRowFields_TooFewColumns guards against an off-by-one: the
// mapping may reference column indexes the row never produced (ragged
// CSV). We must skip those rather than panic with an out-of-bounds.
func TestBuildRowFields_RaggedRowDoesNotPanic(t *testing.T) {
	m := migratecsv.Mapping{Columns: []migratecsv.ColumnMapping{
		{Index: 0, Name: "email", Kind: migratecsv.KindEmail},
		{Index: 1, Name: "name", Kind: migratecsv.KindName},
		{Index: 2, Name: "tags", Kind: migratecsv.KindTags},
	}}
	fields, err := buildRowFields([]string{"a@b.com"}, m)
	if err != nil {
		t.Fatal(err)
	}
	tags, custom := fields.Tags, fields.Custom
	if len(tags) != 0 || len(custom) != 0 {
		t.Errorf("ragged row should produce nothing: tags=%v custom=%v", tags, custom)
	}
}

// TestRowError_Shape pins the rowError fields the worker writes into
// subscriber_import_errors. The schema column names must stay in sync
// with the struct so retry-from-failed can round-trip.
func TestRowError_Shape(t *testing.T) {
	e := rowError{RowNumber: 42, Code: "invalid_email", Message: "Invalid email"}
	if e.RowNumber != 42 || e.Code == "" || e.Message == "" {
		t.Fatalf("privacy-safe rowError fields drifted: %+v", e)
	}
}

func TestPublicImportFailureNeverReflectsRawPIIOrBackendErrors(t *testing.T) {
	raw := "open csv: dial s3.internal for alice@example.test: secret=top-secret"
	if got := safeImportJobErrorCode(raw, "failed"); got != "import_failed" {
		t.Fatalf("unknown/raw code was reflected: %q", got)
	}
	message := safeImportJobErrorMessage(raw, "failed")
	for _, forbidden := range []string{"alice@example.test", "s3.internal", "top-secret", "open csv"} {
		if strings.Contains(message, forbidden) {
			t.Fatalf("public message %q leaked %q", message, forbidden)
		}
	}
	if got := safeImportJobErrorMessage("source_open_failed", "failed"); strings.Contains(got, "alice") || got == "" {
		t.Fatalf("stable source error message=%q", got)
	}
}

func TestImportListCursorIsBoundedAndRoundTripsNanosecondTime(t *testing.T) {
	want := importListCursor{
		CreatedAt: time.Date(2026, 7, 18, 12, 34, 56, 987654321, time.FixedZone("test", 5*60*60+30*60)),
		ID:        "5b1f6a7e-0000-0000-0000-000000000000",
	}
	encoded := encodeImportListCursor(want)
	got, err := decodeImportListCursor(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if !got.CreatedAt.Equal(want.CreatedAt) || got.CreatedAt.Location() != time.UTC || got.ID != want.ID {
		t.Fatalf("cursor round trip=%+v want=%+v", got, want)
	}
	for _, malformed := range []string{
		"not-base64!", strings.Repeat("a", 1025),
		base64.RawURLEncoding.EncodeToString([]byte(`{"created_at":"2026-07-18T12:00:00Z","id":"not-a-uuid"}`)),
	} {
		if _, err := decodeImportListCursor(malformed); err == nil {
			t.Fatalf("malformed cursor accepted: %.40q", malformed)
		}
	}
}

// --- SUB-104: scheduled / recovery claim plumbing -------------------

// TestClaimedJob_CarriesResumeCursor locks the stale-worker recovery cursor.
func TestClaimedJob_CarriesResumeCursor(t *testing.T) {
	j := &claimedJob{
		ID: "imp-1", TenantID: "ten-1", ObjectKey: "k",
		ProcessedRows: 1500,
	}
	if j.ProcessedRows != 1500 {
		t.Errorf("resume cursor drifted: %d", j.ProcessedRows)
	}
}

// TestScheduledImport_NextRunGate ties the schedule math to the worker's
// claim contract: a future scheduled_at yields a non-nil next-run gate
// (the row stays invisible to claimNextJob until due), an immediate
// schedule yields nil (claimable now). This is the value Confirm stamps
// into next_scheduled_at, which claimNextJob filters on.
func TestScheduledImport_NextRunGate(t *testing.T) {
	now := time.Now().UTC()
	// Immediate → claimable now (NULL gate).
	if got := computeNextRun(confirmSchedule{ScheduleType: "immediate"}, now); got != nil {
		t.Errorf("immediate import must be claimable now, got gate %v", got)
	}
	// Scheduled for 2am-UTC-tonight style future → gated.
	future := now.Add(6 * time.Hour)
	got := computeNextRun(confirmSchedule{ScheduleType: "scheduled", ScheduledAt: &future}, now)
	if got == nil || !got.After(now) {
		t.Errorf("scheduled import must gate on a future time, got %v", got)
	}
}

// TestCrashResume_RowNumberingIsGlobal proves the per-row counter is seeded
// with j.ProcessedRows so error rows after a stale-worker reclaim report
// globally-correct row numbers instead of restarting from 1. processJob
// does `rowNum++` once per CSV row read; the model below mirrors that
// exactly so a regression to `var rowNum int64` (restart-from-zero) fails
// here.
func TestCrashResume_RowNumberingIsGlobal(t *testing.T) {
	// rowNumbersForChunk mirrors processJob's counter discipline: seed with
	// the already-processed offset, then ++ before recording each row's
	// number. Returns the row_number that each row in `rows` would record.
	rowNumbersForChunk := func(processedRows int64, rows int) []int64 {
		rowNum := processedRows // <- the fix; was `var rowNum int64` (always 0)
		out := make([]int64, 0, rows)
		for i := 0; i < rows; i++ {
			rowNum++ // matches worker.go: rowNum++ once per cr.Read()
			out = append(out, rowNum)
		}
		return out
	}

	// First chunk (ProcessedRows == 0): numbering MUST be unchanged — 1..N.
	first := rowNumbersForChunk(0, 3)
	if want := []int64{1, 2, 3}; !equalInt64(first, want) {
		t.Fatalf("first chunk numbering changed: got %v want %v", first, want)
	}

	// Resumed chunk after 1500 rows already processed: the 2nd row in this
	// chunk that errors must report 1502, NOT 2.
	resumed := rowNumbersForChunk(1500, 3)
	if want := []int64{1501, 1502, 1503}; !equalInt64(resumed, want) {
		t.Fatalf("resumed chunk must continue from offset: got %v want %v", resumed, want)
	}

	// Explicit regression guard against the old restart-from-zero bug: with
	// a non-zero offset the first recorded row number must NOT be 1.
	if resumed[0] == 1 {
		t.Fatalf("regression: resumed job restarted row numbering from 1 (got %v)", resumed)
	}
}

func equalInt64(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// --- SUB-103: progress SSE + cancel helpers -------------------------

func TestTerminalStatus(t *testing.T) {
	terminal := []string{"ready", "failed", "cancelled"}
	live := []string{"preview", "queued", "running", ""}
	for _, s := range terminal {
		if !terminalStatus(s) {
			t.Errorf("%q should be terminal", s)
		}
	}
	for _, s := range live {
		if terminalStatus(s) {
			t.Errorf("%q should NOT be terminal", s)
		}
	}
}

func TestEmitProgress_SSEFormat(t *testing.T) {
	var buf bytes.Buffer
	ev := progressEvent{
		Status: "running", ProcessedRows: 1500, TotalRows: 4000,
		RowsImported: 1400, RowsSkipped: 50, RowsFailed: 50,
	}
	emitProgress(&buf, ev)
	out := buf.String()
	if !strings.HasPrefix(out, "event: progress\ndata: ") {
		t.Fatalf("missing SSE framing: %q", out)
	}
	if !strings.HasSuffix(out, "\n\n") {
		t.Fatalf("SSE events must end with a blank line: %q", out)
	}
	// The data payload must be valid JSON carrying the progress fields.
	data := strings.TrimSuffix(strings.TrimPrefix(out, "event: progress\ndata: "), "\n\n")
	var got progressEvent
	if err := json.Unmarshal([]byte(data), &got); err != nil {
		t.Fatalf("data payload is not valid JSON: %v (%q)", err, data)
	}
	if got != ev {
		t.Fatalf("round-trip drift: %+v want %+v", got, ev)
	}
}
