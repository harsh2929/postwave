// SPDX-License-Identifier: AGPL-3.0-only

package lists

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The list member export streams every subscriber email, status and
// acquisition source of a list. Its sibling, GET /api/v1/subscribers/export.csv,
// caps at 10,000 rows and tells the client when it truncated; this one had no
// cap at all, so "export each list in turn" was the unbounded way to obtain the
// audience the capped route deliberately refuses to hand over in one call.
func TestListExportHardCapMatchesTheSubscribersExport(t *testing.T) {
	t.Parallel()
	// The subscribers export's csvExportHardCap lives in another package and is
	// unexported; 10_000 is the reviewed number both routes are held to, so it
	// is stated literally here rather than read from the code under test.
	if listExportHardCap != 10_000 {
		t.Fatalf("listExportHardCap = %d, want 10000 (parity with the subscribers export)",
			listExportHardCap)
	}
}

// The truncation flag has to reach the header block, which means it must be
// set before the first body byte. Pin the ordering, because a writer that
// stamps the header after the CSV starts streaming reports nothing at all.
func TestListExportWriterEmitsTruncationHeaderBeforeTheBody(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	w := &listExportWriter{ResponseWriter: rec}
	w.signalTruncated()
	if _, err := w.Write([]byte("email,status,source,added_at\n")); err != nil {
		t.Fatal(err)
	}

	if got := rec.Header().Get("X-Postwave-Truncated"); got != "true" {
		t.Fatalf("X-Postwave-Truncated = %q, want true", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "text/csv; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := rec.Header().Get("Content-Disposition"); got == "" {
		t.Fatal("Content-Disposition missing")
	}

	// An un-truncated export must not claim truncation, and a failure before
	// the first byte must leave the CSV headers unset so the handler can still
	// answer with a JSON error envelope.
	rec = httptest.NewRecorder()
	clean := &listExportWriter{ResponseWriter: rec}
	if clean.wrote {
		t.Fatal("writer reports having written before any Write")
	}
	if _, err := clean.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	if got := rec.Header().Get("X-Postwave-Truncated"); got != "" {
		t.Fatalf("X-Postwave-Truncated = %q on a complete export, want unset", got)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
}

// The audit row's row count comes from the writer, so the counter has to move.
func TestListExportWriterCountsRows(t *testing.T) {
	t.Parallel()
	w := &listExportWriter{ResponseWriter: httptest.NewRecorder()}
	for i := 0; i < 3; i++ {
		w.countRow()
	}
	if w.rows != 3 {
		t.Fatalf("rows = %d, want 3", w.rows)
	}
}
