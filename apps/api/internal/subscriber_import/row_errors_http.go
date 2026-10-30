// SPDX-License-Identifier: AGPL-3.0-only
//
// row_errors_http.go — GET /api/v1/subscriber-imports/{id}/errors: the
// privacy-safe per-row failures the worker records, as JSON or CSV.

package subscriber_import

import (
	"encoding/csv"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// rowErrorItem is one failed row, in the privacy-safe shape the worker records.
//
// Deliberately no email and no raw row. `recordRowOutcomes` writes those columns
// as NULL and calls the result a "privacy-safe row outcome"; this endpoint
// exposes what is there and must not become the reason someone starts filling
// them in. A row number, a code and a message are enough to fix a CSV.
type rowErrorItem struct {
	RowNumber int    `json:"row_number"`
	ErrorCode string `json:"error_code"`
	Error     string `json:"error"`
	CreatedAt string `json:"created_at"`
}

const (
	rowErrorsDefaultLimit = 200
	rowErrorsMaxLimit     = 1000
)

func rowErrorsIntegerParam(values url.Values, name string, fallback, min, max int) (int, bool) {
	rawValues, present := values[name]
	if !present {
		return fallback, true
	}
	if len(rawValues) != 1 {
		return 0, false
	}
	raw := rawValues[0]
	if raw == "" || strings.TrimSpace(raw) != raw {
		return 0, false
	}
	for _, character := range raw {
		if character < '0' || character > '9' {
			return 0, false
		}
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed < min || parsed > max || strconv.Itoa(parsed) != raw {
		return 0, false
	}
	return parsed, true
}

// RowErrors GET /api/v1/subscriber-imports/{id}/errors.
//
// The worker has always written per-row failures to `subscriber_import_errors`
// — its comment at worker.go:259 says "so the UI can offer" — and nothing read
// them. A user importing 10,000 contacts was told 42 rows failed and had no way
// to learn which, while the answer sat in the table until the 30-day prune.
func (d *Deps) RowErrors(w http.ResponseWriter, r *http.Request) {
	// Failed-row details are derived from a tenant upload. Apply the policy
	// before every early return so authentication, validation, not-found, and
	// successful responses cannot be cached by a browser or shared proxy.
	w.Header().Set("Cache-Control", "no-store")
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeJSONErr(w, http.StatusBadRequest, "invalid_id", "import id is required")
		return
	}
	parsedID, err := uuid.Parse(id)
	if err != nil {
		writeJSONErr(w, http.StatusBadRequest, "invalid_id", "import id must be a UUID")
		return
	}
	id = parsedID.String()
	query := r.URL.Query()
	if len(query["format"]) > 1 {
		writeJSONErr(w, http.StatusBadRequest, "invalid_format", "format must be json or csv")
		return
	}
	format := query.Get("format")
	if format != "" && format != "json" && format != "csv" {
		writeJSONErr(w, http.StatusBadRequest, "invalid_format", "format must be json or csv")
		return
	}
	limit, valid := rowErrorsIntegerParam(query, "limit", rowErrorsDefaultLimit, 1, rowErrorsMaxLimit)
	if !valid {
		writeJSONErr(w, http.StatusBadRequest, "invalid_limit",
			"limit must be one canonical integer between 1 and 1000")
		return
	}
	offset, valid := rowErrorsIntegerParam(query, "offset", 0, 0, int(MaxImportRows))
	if !valid {
		writeJSONErr(w, http.StatusBadRequest, "invalid_offset",
			"offset must be one canonical integer between 0 and 250000")
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Prove the parent import is visible under the same tenant transaction before
	// returning its child rows. Cross-tenant and nonexistent ids deliberately
	// converge on the same 404, avoiding both a misleading empty success and an
	// import-existence oracle.
	var total int
	var visible bool
	if scanErr := tx.QueryRow(r.Context(), `
SELECT EXISTS (
           SELECT 1 FROM subscriber_imports
            WHERE tenant_id = $1::uuid AND id = $2::uuid
       ),
       (SELECT count(*) FROM subscriber_import_errors
         WHERE tenant_id = $1::uuid AND import_id = $2::uuid)`, t.ID, id).Scan(&visible, &total); scanErr != nil {
		writeSubscriberImportInternal(w, d.Logger, scanErr, r.Context())
		return
	}
	if !visible {
		writeJSONErr(w, http.StatusNotFound, "import_not_found", "subscriber import not found")
		return
	}

	rows, err := tx.Query(r.Context(), `
SELECT row_number, COALESCE(error_code,''), COALESCE(error,''), created_at
  FROM subscriber_import_errors
 WHERE tenant_id = $1::uuid AND import_id = $2::uuid
 ORDER BY row_number
 LIMIT $3 OFFSET $4`, t.ID, id, limit, offset)
	if err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	items := []rowErrorItem{}
	for rows.Next() {
		var it rowErrorItem
		var created time.Time
		if err := rows.Scan(&it.RowNumber, &it.ErrorCode, &it.Error, &created); err != nil {
			writeSubscriberImportInternal(w, d.Logger, err, r.Context())
			return
		}
		it.CreatedAt = created.UTC().Format(time.RFC3339)
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		writeSubscriberImportInternal(w, d.Logger, err, r.Context())
		return
	}
	// CSV is the shape the FIX happens in. The JSON list answers "which rows
	// failed" for a program; the person who has to open their spreadsheet, find
	// those rows and correct them needs a file. Both formats run the SAME query
	// above — a second endpoint with its own SQL would be a second place for the
	// tenant predicate to be wrong.
	if format == "csv" {
		writeRowErrorsCSV(w, id, items)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": items, "total": total, "limit": limit, "offset": offset,
	})
}

// writeRowErrorsCSV renders the failures as a downloadable file.
func writeRowErrorsCSV(w http.ResponseWriter, importID string, items []rowErrorItem) {
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition",
		`attachment; filename="import-`+csvSafeFilename(importID)+`-errors.csv"`)
	// Explicit: this file is derived from an upload and must never be cached by
	// a shared proxy on the way back.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)

	out := csv.NewWriter(w)
	// row_number first: it is the column someone sorts their spreadsheet by.
	_ = out.Write([]string{"row_number", "error_code", "error", "detected_at"})
	for _, it := range items {
		_ = out.Write([]string{
			strconv.Itoa(it.RowNumber),
			csvSafeCell(it.ErrorCode),
			csvSafeCell(it.Error),
			it.CreatedAt,
		})
	}
	out.Flush()
}

// csvSafeCell neutralises spreadsheet formula injection.
//
// A cell beginning `=`, `+`, `-`, `@`, or a control character that leads into
// one, is EXECUTED when the file is opened. These messages are
// attacker-influenced — an error can carry a value from the uploaded row — so a
// CSV export of import failures is the textbook version of this: the attacker
// supplies the file, and the victim is the person cleaning up after it.
//
// Prefixed with an apostrophe rather than stripped: the operator still needs to
// see what was in the row to fix it, and silently altering the text would make
// the export lie about the data.
func csvSafeCell(value string) string {
	if value == "" {
		return value
	}
	switch value[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + value
	}
	return value
}

// csvSafeFilename keeps a caller-supplied id out of the Content-Disposition
// header's quoting. Ids are uuids; anything else is reduced to a safe stub
// rather than trusted into a header.
func csvSafeFilename(id string) string {
	for _, r := range id {
		if r != '-' && (r < '0' || r > '9') && (r < 'a' || r > 'f') && (r < 'A' || r > 'F') {
			return "export"
		}
	}
	if id == "" {
		return "export"
	}
	return id
}
