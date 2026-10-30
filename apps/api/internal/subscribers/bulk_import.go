// SPDX-License-Identifier: AGPL-3.0-only
//
// Bulk CSV import: a small, focused alternative to the full migration
// service. The migration service handles platform imports (Mailchimp,
// ConvertKit, Substack, etc.) with verification + rollback. Bulk CSV
// is the simpler path: tenant uploads a flat CSV, we upsert rows.
//
// Why this isn't migration-service work:
//
//   - No source-platform translation (the CSV IS the source).
//   - No verification report — we return per-row outcomes inline.
//   - No 7-day rollback window — the audit log is enough since each
//     row goes through Repo.Upsert with custom-field validation.
//   - Synchronous (caps at 10k rows / call) so the UX is "upload,
//     see results in the same response". Larger imports use the
//     migration service.

package subscribers

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MaxBulkImportRows caps a single upload. Bigger sends use the
// migration service path. The cap is also memory-bounded — every
// row builds a CreateInput which carries custom_fields jsonb, so
// 10k×~1KB rows ≈ 10MB peak per request. Comfortable on the 256MB
// container budget the gateway runs on.
const MaxBulkImportRows = 10_000
const bulkImportMaxBodyBytes int64 = 32 << 20 // 32 MiB

var errBulkImportBodyTooLarge = errors.New("CSV import body exceeds 32 MiB")

// BulkImportRow is one accepted line in the CSV. Surfaces in the
// response so the UI can render per-row outcomes.
type BulkImportRow struct {
	RowNumber int    `json:"row_number"`
	Email     string `json:"email"`
	Status    string `json:"status"` // "created" | "updated" | "skipped" | "error"
	ErrorCode string `json:"error_code,omitempty"`
	Error     string `json:"error,omitempty"`
}

// BulkImportResponse is the body returned by POST /subscribers/import.
type BulkImportResponse struct {
	TotalRows int             `json:"total_rows"`
	Created   int             `json:"created"`
	Updated   int             `json:"updated"`
	Skipped   int             `json:"skipped"`
	Errored   int             `json:"errored"`
	Rows      []BulkImportRow `json:"rows"`
}

// ImportCSV POST /api/v1/subscribers/import
//
// Accepts:
//
//   - Content-Type: text/csv with the CSV body
//   - Content-Type: multipart/form-data with a "file" part (browser uploads)
//
// First non-empty line is the header row. Required column: "email".
// Optional columns: "name", "status", "tags" (comma-separated within
// the cell), and any custom-field column (column name = field key).
//
// Behaviour per row: upsert by email. Existing subscribers get the
// new fields merged in; the response distinguishes "created" from
// "updated" for the per-row UI.
//
// Validation: we accept malformed individual rows (record them in
// Rows[] with status="error") rather than rolling back the whole
// upload. The customer-visible failure is "you uploaded a 5000-row
// CSV and 3 rows had bad email; here are the 3."
func (d *Deps) ImportCSV(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}

	body, contentType, err := readImportBody(w, r)
	if err != nil {
		if errors.Is(err, errBulkImportBodyTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", err.Error())
			return
		}
		httperror.Write(w, http.StatusBadRequest, "bad_form", "CSV request body could not be parsed")
		return
	}
	defer func() { _ = body.Close() }()

	reader := csv.NewReader(body)
	reader.TrimLeadingSpace = true
	header, err := reader.Read()
	if err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("missing_header",
			"CSV must have a header row with an 'email' column"))
		return
	}
	headerIdx := indexHeader(header)
	if _, ok := headerIdx["email"]; !ok {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("missing_email_column",
			"CSV header must include an 'email' column"))
		return
	}

	resp := BulkImportResponse{}
	rowNum := 1 // header was 1
	for {
		rowNum++
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			resp.Rows = append(resp.Rows, BulkImportRow{
				RowNumber: rowNum, Status: "error",
				ErrorCode: "malformed_csv", Error: "CSV row could not be parsed",
			})
			resp.Errored++
			continue
		}
		if resp.TotalRows >= MaxBulkImportRows {
			writeJSON(w, http.StatusUnprocessableEntity, errEnv("too_many_rows",
				fmt.Sprintf("CSV exceeds the %d-row cap; use the migration service for larger imports",
					MaxBulkImportRows)))
			return
		}
		resp.TotalRows++
		row, err := buildCreateInput(record, headerIdx)
		if err != nil {
			rowErr := validationRowError(err)
			resp.Rows = append(resp.Rows, BulkImportRow{
				RowNumber: rowNum, Email: getCol(record, headerIdx, "email"),
				Status: "error", ErrorCode: rowErr.Code, Error: rowErr.Message,
			})
			resp.Errored++
			continue
		}
		if err := normalizeCreate(&row); err != nil {
			rowErr := validationRowError(err)
			resp.Rows = append(resp.Rows, BulkImportRow{
				RowNumber: rowNum, Email: row.Email,
				Status: "error", ErrorCode: rowErr.Code, Error: rowErr.Message,
			})
			resp.Errored++
			continue
		}
		// Upsert decides created-vs-updated by checking pre-existence
		// before the call. Cheap because of the (tenant_id, email) idx.
		existed, _ := d.Repo.ExistsByEmail(r.Context(), t.ID, row.Email)
		if _, err := d.Repo.Upsert(r.Context(), t.ID, row); err != nil {
			rowErr := persistenceRowError(err)
			resp.Rows = append(resp.Rows, BulkImportRow{
				RowNumber: rowNum, Email: row.Email,
				Status: "error", ErrorCode: rowErr.Code, Error: rowErr.Message,
			})
			resp.Errored++
			continue
		}
		status := "created"
		if existed {
			status = "updated"
			resp.Updated++
		} else {
			resp.Created++
		}
		resp.Rows = append(resp.Rows, BulkImportRow{
			RowNumber: rowNum, Email: row.Email, Status: status,
		})
	}
	_ = contentType // reserved for future use (e.g., logging the upload format)
	writeJSON(w, http.StatusOK, resp)
}

// readImportBody handles both raw text/csv and multipart/form-data
// "file" uploads, since browser <input type=file> goes through
// multipart and SDK / curl callers usually post raw CSV.
func readImportBody(w http.ResponseWriter, r *http.Request) (io.ReadCloser, string, error) {
	contentType := r.Header.Get("Content-Type")
	if r.ContentLength > bulkImportMaxBodyBytes {
		return nil, contentType, errBulkImportBodyTooLarge
	}
	r.Body = http.MaxBytesReader(w, r.Body, bulkImportMaxBodyBytes)
	if strings.HasPrefix(contentType, "multipart/form-data") {
		if err := r.ParseMultipartForm(bulkImportMaxBodyBytes); err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				return nil, contentType, errBulkImportBodyTooLarge
			}
			return nil, contentType, fmt.Errorf("parse multipart: %w", err)
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			return nil, contentType, errors.New("missing 'file' part in multipart upload")
		}
		return file, contentType, nil
	}
	if r.Body == nil {
		return nil, contentType, errors.New("empty request body")
	}
	return r.Body, contentType, nil
}

// indexHeader maps lowercase column name → column index. We
// lowercase so the upload is forgiving of "Email" vs "email" vs
// "EMAIL" — the most common cause of "my CSV import failed because
// of capitalisation" support tickets.
func indexHeader(header []string) map[string]int {
	out := map[string]int{}
	for i, h := range header {
		out[strings.ToLower(strings.TrimSpace(h))] = i
	}
	return out
}

func getCol(record []string, idx map[string]int, name string) string {
	i, ok := idx[name]
	if !ok || i >= len(record) {
		return ""
	}
	return strings.TrimSpace(record[i])
}

// buildCreateInput translates one CSV record into a CreateInput.
// Unknown columns become custom_fields entries — the validator will
// either accept (auto mode) or reject (strict mode) them based on
// the tenant's custom_fields_mode setting. Either way the per-row
// outcome lands in the response.
func buildCreateInput(record []string, idx map[string]int) (CreateInput, error) {
	email := getCol(record, idx, "email")
	if email == "" {
		return CreateInput{}, errors.New("email is required")
	}
	if _, err := mail.ParseAddress(email); err != nil {
		return CreateInput{}, fmt.Errorf("invalid email %q: %w", email, err)
	}
	in := CreateInput{
		Email:         email,
		Status:        defaultIfEmpty(getCol(record, idx, "status"), StatusUnconfirmed),
		ConsentSource: ConsentUnknown,
		Tags:          splitCommaList(getCol(record, idx, "tags")),
		CustomFields:  map[string]any{},
	}
	// Map every non-reserved column into custom_fields.
	for col, i := range idx {
		switch col {
		case "email", "status", "tags":
			continue
		}
		if i >= len(record) {
			continue
		}
		v := strings.TrimSpace(record[i])
		if v == "" {
			continue
		}
		in.CustomFields[col] = v
	}
	return in, nil
}

func defaultIfEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func splitCommaList(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// writeJSON / errEnv used here are package-locally defined in handlers.go.
// Reuse rather than duplicate.
var _ = json.Marshal
