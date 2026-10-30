package subscribers

// CSV export tests. The DB-backed StreamCSV needs postgres rows, so
// we test the encoding/csv shape directly via a small helper that
// mirrors the row-encoding loop — this catches the "unquoted comma"
// and "embedded quote" classes of bug without spinning up a database.
//
// The handler's tenant gate + Content-Type/Disposition headers are
// covered by the no-tenant 401 case (which short-circuits before any
// DB access).

import (
	"bytes"
	"encoding/csv"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// renderCSVRow re-implements the per-row write that StreamCSV does
// (encoding/csv with the same column order). Tests against this
// helper exercise the encoding contract that StreamCSV relies on.
// SUB-106 widened the column set: merge_fields + engagement/rating/churn
// scores. The legacy callers pass an empty merge_fields and nil scores so
// the original escaping assertions keep working against the same indexes.
func renderCSVRow(email, name, status string, tags []string, cf string, at time.Time) string {
	return renderCSVRowFull(email, name, status, tags, cf, "{}", nil, nil, nil, at)
}

// renderCSVRowFull mirrors scanCSVRow's write path with the full SUB-106
// column set so the rich-column tests can assert the new fields.
func renderCSVRowFull(email, name, status string, tags []string, cf, mf string, engagement, rating, churn *int16, at time.Time) string {
	var buf bytes.Buffer
	cw := csv.NewWriter(&buf)
	_ = cw.Write([]string{
		csvCell(email),
		csvCell(name),
		csvCell(status),
		csvCell(strings.Join(tags, ",")),
		csvCell(cf),
		csvCell(mf),
		smallintCell(engagement),
		smallintCell(rating),
		smallintCell(churn),
		at.Format(time.RFC3339),
	})
	cw.Flush()
	return buf.String()
}

func i16(v int16) *int16 { return &v }

// TestCSVRow_Plain — simplest case, no escaping required.
func TestCSVRow_Plain(t *testing.T) {
	row := renderCSVRow("a@b.co", "Alice", "enabled", []string{"vip"}, "{}",
		time.Date(2026, 5, 8, 0, 0, 0, 0, time.UTC))
	// email,name,status,tags,custom_fields,merge_fields,engagement,rating,churn,...
	if !strings.HasPrefix(row, "a@b.co,Alice,enabled,vip,{},{},,,,") {
		t.Errorf("row = %q", row)
	}
}

// TestCSVRow_RichColumns — SUB-106: merge_fields + the engagement /
// rating / churn scores land in their own columns. NULL scores render
// as empty cells; set scores render as decimals.
func TestCSVRow_RichColumns(t *testing.T) {
	row := renderCSVRowFull("a@b.co", "Alice", "enabled", []string{"vip"},
		`{"plan":"pro"}`, `{"FNAME":"Alice","COMPANY":"Acme"}`,
		i16(72), i16(5), i16(13),
		time.Date(2026, 5, 8, 0, 0, 0, 0, time.UTC))
	r := csv.NewReader(strings.NewReader(row))
	rec, err := r.Read()
	if err != nil {
		t.Fatalf("reader: %v\nrow=%q", err, row)
	}
	if len(rec) != 10 {
		t.Fatalf("want 10 columns, got %d: %v", len(rec), rec)
	}
	if rec[4] != `{"plan":"pro"}` {
		t.Errorf("custom_fields col = %q", rec[4])
	}
	if rec[5] != `{"FNAME":"Alice","COMPANY":"Acme"}` {
		t.Errorf("merge_fields col = %q", rec[5])
	}
	if rec[6] != "72" || rec[7] != "5" || rec[8] != "13" {
		t.Errorf("scores = engagement %q rating %q churn %q", rec[6], rec[7], rec[8])
	}
}

// TestCSVRow_NullScoresAreEmpty — an uncomputed score (NULL) must emit an
// empty cell, never "0" (which would mislead a downstream import).
func TestCSVRow_NullScoresAreEmpty(t *testing.T) {
	row := renderCSVRowFull("a@b.co", "", "enabled", nil, "{}", "{}",
		nil, nil, nil, time.Date(2026, 5, 8, 0, 0, 0, 0, time.UTC))
	r := csv.NewReader(strings.NewReader(row))
	rec, _ := r.Read()
	for _, idx := range []int{6, 7, 8} {
		if rec[idx] != "" {
			t.Errorf("col %d = %q, want empty for NULL score", idx, rec[idx])
		}
	}
}

// TestSmallintCell — nil → "", set → decimal.
func TestSmallintCell(t *testing.T) {
	if got := smallintCell(nil); got != "" {
		t.Errorf("nil score = %q, want empty", got)
	}
	if got := smallintCell(i16(0)); got != "0" {
		t.Errorf("zero score = %q, want 0", got)
	}
	if got := smallintCell(i16(100)); got != "100" {
		t.Errorf("100 score = %q", got)
	}
}

// TestCSVRow_EmailWithComma — encoding/csv must wrap the field in
// quotes. (Pathological email but the parser must still round-trip.)
func TestCSVRow_EmailWithComma(t *testing.T) {
	row := renderCSVRow(`"weird,email"@b.co`, "X", "enabled", nil, "{}",
		time.Date(2026, 5, 8, 0, 0, 0, 0, time.UTC))
	// Round-trip through a CSV reader to verify it parses back correctly.
	r := csv.NewReader(strings.NewReader(row))
	rec, err := r.Read()
	if err != nil {
		t.Fatalf("CSV reader rejected our output: %v\nrow=%q", err, row)
	}
	if rec[0] != `"weird,email"@b.co` {
		t.Errorf("round-trip email = %q, want preserved", rec[0])
	}
}

// TestCSVRow_TagsJoinedWithCommas — tags are comma-joined into one
// field; encoding/csv quotes the joined string when it contains commas.
func TestCSVRow_TagsJoinedWithCommas(t *testing.T) {
	row := renderCSVRow("a@b.co", "", "enabled", []string{"a", "b", "c"}, "{}",
		time.Date(2026, 5, 8, 0, 0, 0, 0, time.UTC))
	r := csv.NewReader(strings.NewReader(row))
	rec, _ := r.Read()
	if rec[3] != "a,b,c" {
		t.Errorf("tags field = %q, want a,b,c", rec[3])
	}
}

// TestCSVRow_QuotesInName — embedded `"` doubles per RFC 4180 and
// must round-trip through a CSV reader.
func TestCSVRow_QuotesInName(t *testing.T) {
	row := renderCSVRow("a@b.co", `Alice "the boss" Lee`, "enabled", nil, "{}",
		time.Date(2026, 5, 8, 0, 0, 0, 0, time.UTC))
	r := csv.NewReader(strings.NewReader(row))
	rec, err := r.Read()
	if err != nil {
		t.Fatalf("reader: %v\nrow=%q", err, row)
	}
	if rec[1] != `Alice "the boss" Lee` {
		t.Errorf("name = %q, want Alice \"the boss\" Lee", rec[1])
	}
}

func TestCSVRow_EscapesSpreadsheetFormulaCells(t *testing.T) {
	row := renderCSVRow("=cmd|evil@example.com", "+SUM(1,2)", "enabled", []string{"@vip"}, `{"note":"safe"}`,
		time.Date(2026, 5, 8, 0, 0, 0, 0, time.UTC))
	r := csv.NewReader(strings.NewReader(row))
	rec, err := r.Read()
	if err != nil {
		t.Fatalf("reader: %v\nrow=%q", err, row)
	}
	for i, wantPrefix := range map[int]string{0: "'=", 1: "'+", 3: "'@"} {
		if !strings.HasPrefix(rec[i], wantPrefix) {
			t.Fatalf("field %d = %q, want prefix %q", i, rec[i], wantPrefix)
		}
	}
}

func TestCSVCell_NeutralizesHiddenFormulaPrefixesAndEscapesControls(t *testing.T) {
	tests := map[string]string{
		"=1+1":                 "'=1+1",
		" +SUM(1,2)":           "' +SUM(1,2)",
		"\t@cmd":               "'\t@cmd",
		"\n-42":                "'\n-42",
		"\r=HYPERLINK(x)":      "'\r=HYPERLINK(x)",
		"\x00=cmd":             `'\u0000=cmd`,
		"\u202e+cmd":           `'\u202E+cmd`,
		"\ufeff@cmd":           `'\uFEFF@cmd`,
		"\u00a0-cmd":           "'\u00a0-cmd",
		"safe\x07value":        `safe\u0007value`,
		"safe\u202evalue":      `safe\u202Evalue`,
		"ordinary@example.com": "ordinary@example.com",
	}
	for input, want := range tests {
		if got := csvCell(input); got != want {
			t.Errorf("csvCell(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestParseCSVExportOptions_FreezesExactScope(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/subscribers/export.csv?limit=250&status=enabled&q=Ada+%26+Grace&include_archived=true&sort=created_at&order=asc", nil)
	opts, err := parseCSVExportOptions(req)
	if err != nil {
		t.Fatalf("parseCSVExportOptions: %v", err)
	}
	want := CSVExportOptions{
		Limit:           250,
		Status:          "enabled",
		Q:               "Ada & Grace",
		IncludeArchived: true,
		Sort:            "created_at",
		Order:           "asc",
	}
	if opts != want {
		t.Fatalf("options = %+v, want %+v", opts, want)
	}
}

func TestParseCSVExportOptions_RejectsScopeWideningInputs(t *testing.T) {
	tests := []string{
		"limit=0",
		"limit=not-a-number",
		"status=definitely-unknown",
		"include_archived=sometimes",
		"sort=private_payload",
		"order=sideways",
	}
	for _, query := range tests {
		req := httptest.NewRequest(http.MethodGet,
			"/api/v1/subscribers/export.csv?"+query, nil)
		if _, err := parseCSVExportOptions(req); err == nil {
			t.Errorf("query %q should be rejected", query)
		}
	}
}

func TestCSVExportWhere_DefaultsToActiveAndOnlyOptsIntoArchived(t *testing.T) {
	activeWhere, activeArgs := csvExportWhere("tenant-one", CSVExportOptions{
		Status: "enabled",
		Q:      "Ada",
	})
	if !strings.Contains(activeWhere, "archived_at IS NULL") {
		t.Fatalf("default export widened to archived rows: %s", activeWhere)
	}
	if len(activeArgs) != 3 || activeArgs[0] != "tenant-one" || activeArgs[1] != "Ada" || activeArgs[2] != "enabled" {
		t.Fatalf("active args = %#v", activeArgs)
	}

	archivedWhere, _ := csvExportWhere("tenant-one", CSVExportOptions{
		IncludeArchived: true,
	})
	if strings.Contains(archivedWhere, "archived_at IS NULL") {
		t.Fatalf("opted-in archived export was still filtered: %s", archivedWhere)
	}
}

// TestCSVHeader_Order — locks the column order. The downstream
// importers + the docs both assume this exact order. SUB-106 extended it
// with merge_fields_json + the engagement / rating / churn scores; the
// shared csvExportHeader (used by both StreamCSV and StreamCSVByIDs) is
// the single source of truth.
func TestCSVHeader_Order(t *testing.T) {
	var buf bytes.Buffer
	cw := csv.NewWriter(&buf)
	_ = cw.Write(csvExportHeader)
	cw.Flush()
	got := strings.TrimSpace(buf.String())
	want := "email,name,status,tags,custom_fields_json,merge_fields_json,engagement_score,rating,churn_score,created_at"
	if got != want {
		t.Errorf("header = %q, want %q", got, want)
	}
}

// TestExportCSV_NoTenantGate — the handler must 401 without a tenant
// before touching the pool. Lets us drive it with a nil Repo.
func TestExportCSV_NoTenantGate(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/subscribers/export.csv", nil)
	w := httptest.NewRecorder()
	d.ExportCSV(w, r)
	if w.Code != 401 {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
}

func TestExportCSV_RejectsInvalidScopeBeforeDatabaseAccess(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	req := subscriberTenantRequest(http.MethodGet,
		"/api/v1/subscribers/export.csv?sort=private_payload", "")
	rec := httptest.NewRecorder()
	d.ExportCSV(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("content-type = %q, want JSON", got)
	}
	if strings.Contains(rec.Body.String(), "private_payload") {
		t.Fatalf("response reflected untrusted scope: %s", rec.Body.String())
	}
}

func TestCSVDownloadWriterDelaysCSVHeadersUntilFirstWrite(t *testing.T) {
	rec := httptest.NewRecorder()
	w := &csvDownloadWriter{ResponseWriter: rec}

	if got := rec.Header().Get("Content-Type"); got != "" {
		t.Fatalf("content-type before write = %q, want empty", got)
	}
	if _, err := w.Write([]byte("email\n")); err != nil {
		t.Fatalf("write: %v", err)
	}

	if got := rec.Header().Get("Content-Type"); got != "text/csv; charset=utf-8" {
		t.Fatalf("content-type after write = %q, want csv", got)
	}
	if got := rec.Header().Get("Content-Disposition"); got != `attachment; filename="subscribers.csv"` {
		t.Fatalf("content-disposition = %q", got)
	}
}

func TestCSVDownloadWriterAllowsJSONBeforeFirstWrite(t *testing.T) {
	rec := httptest.NewRecorder()
	w := &csvDownloadWriter{ResponseWriter: rec}

	writeJSON(rec, http.StatusInternalServerError, errEnv("export_failed", "boom"))

	if w.wrote {
		t.Fatal("csv writer should not mark itself written when no CSV bytes were emitted")
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("content-type = %q, want JSON", got)
	}
	if !strings.Contains(rec.Body.String(), "export_failed") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// TestCSVDownloadWriter_TruncatedHeaderSetBeforeBody — SUB-108: when the
// repo flips the truncated flag (via signalTruncated) BEFORE the first
// Write, the X-Postwave-Truncated header lands in the same block as the CSV
// Content-Type, ahead of the streamed body.
func TestCSVDownloadWriter_TruncatedHeaderSetBeforeBody(t *testing.T) {
	rec := httptest.NewRecorder()
	w := &csvDownloadWriter{ResponseWriter: rec}

	// The repo would call this before writing the header row.
	w.signalTruncated()
	if got := rec.Header().Get("X-Postwave-Truncated"); got != "" {
		t.Fatalf("header set before first write = %q, want empty", got)
	}
	if _, err := w.Write([]byte("email\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := rec.Header().Get("X-Postwave-Truncated"); got != "true" {
		t.Fatalf("X-Postwave-Truncated after write = %q, want true", got)
	}
}

func TestCSVDownloadWriter_ReportsExactExportedRows(t *testing.T) {
	rec := httptest.NewRecorder()
	w := &csvDownloadWriter{ResponseWriter: rec}
	w.signalExportedRows(42)
	if _, err := w.Write([]byte("email\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := rec.Header().Get("X-Postwave-Exported-Rows"); got != "42" {
		t.Fatalf("X-Postwave-Exported-Rows = %q, want 42", got)
	}
}

// TestCSVDownloadWriter_NoTruncatedHeaderWhenNotSignalled — the default path
// (no truncation) must NOT emit the warning header.
func TestCSVDownloadWriter_NoTruncatedHeaderWhenNotSignalled(t *testing.T) {
	rec := httptest.NewRecorder()
	w := &csvDownloadWriter{ResponseWriter: rec}
	if _, err := w.Write([]byte("email\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := rec.Header().Get("X-Postwave-Truncated"); got != "" {
		t.Fatalf("X-Postwave-Truncated = %q, want empty when not truncated", got)
	}
}

// TestCSVDownloadWriter_ImplementsTruncationSignaler — guards the wiring the
// repo relies on: *csvDownloadWriter must satisfy truncationSignaler so
// StreamCSVFiltered can type-assert and flip the flag.
func TestCSVDownloadWriter_ImplementsTruncationSignaler(t *testing.T) {
	var w any = &csvDownloadWriter{}
	if _, ok := w.(truncationSignaler); !ok {
		t.Fatal("*csvDownloadWriter must implement truncationSignaler")
	}
}

// TestCSVExportHardCap_Is10k — SUB-108 pins the documented cap so a silent
// change to the constant trips a test (the desktop toast copy + OpenAPI both
// quote 10,000).
func TestCSVExportHardCap_Is10k(t *testing.T) {
	if csvExportHardCap != 10000 {
		t.Fatalf("csvExportHardCap = %d, want 10000", csvExportHardCap)
	}
}

// TestExportCSV_FilteredNoTenantGate — SUB-107 path still 401s without a
// tenant before touching the pool (nil Repo is safe).
func TestExportCSV_FilteredNoTenantGate(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/subscribers/export.csv?status=enabled&q=acme", nil)
	w := httptest.NewRecorder()
	d.ExportCSV(w, r)
	if w.Code != 401 {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
}
