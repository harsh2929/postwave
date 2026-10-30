package lists

import (
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

const (
	listImportMaxBodyBytes int64 = 32 << 20
	listImportMaxRows            = 10_000

	// listExportHardCap is the maximum number of data rows the list member
	// export streams in one response, mirroring subscribers' csvExportHardCap.
	// The two routes take the same PII off the platform, so they carry the same
	// ceiling: without it, GET /api/v1/lists/{id}/export.csv was the unbounded
	// way to obtain the entire audience that GET /api/v1/subscribers/export.csv
	// deliberately refuses to hand over in one call. Enforced in the row loop,
	// never as a SQL LIMIT, so it survives any future server-side filter.
	listExportHardCap = 10_000
)

var errListImportBodyTooLarge = errors.New("list CSV import body exceeds 32 MiB")

type listImportRowError struct {
	Row   int    `json:"row"`
	Email string `json:"email,omitempty"`
	// Code is set for failures a client should explain in its own words;
	// erasure_blocked matches the subscriber writers and the CSV importer.
	Code  string `json:"code,omitempty"`
	Error string `json:"error"`
}

const listImportErasureBlockedMessage = "This address was permanently erased by a contact deletion or privacy request and can't be re-added."

type listImportResponse struct {
	ListID   string               `json:"list_id"`
	Rows     int                  `json:"rows"`
	Imported int                  `json:"imported"`
	Errors   []listImportRowError `json:"errors,omitempty"`
}

func (d *Deps) MountImportExportRoutes(r chi.Router) {
	// p4d-recordsurface-wire-others: CSV import is a heavy operation
	// (up to 10k rows × 1 insert + 1 audit row), expected to land in
	// the 100ms–2.5s bucket range. RecordSurface wires both routes to
	// pw_lists_*.
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/lists/{id}/import", observability.RecordSurfaceFunc("lists", "import_csv", d.ImportMembersCSV))
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/lists/{id}/export.csv", d.ExportMembersCSV)
}

// ImportMembersCSV POST /api/v1/lists/{id}/import
//
// Accepts raw text/csv or multipart/form-data with a "file" part. The
// only required column is email; rows create fail-closed, unconfirmed
// identity shells when needed and attach them to the list using
// list_subscribers. Importing list membership does not grant consent.
func (d *Deps) ImportMembersCSV(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", listsUnavailableMessage))
		return
	}
	listUUID, err := d.Repo.resolveListUUID(r.Context(), t.ID, strings.TrimSpace(chi.URLParam(r, "id")))
	if err != nil {
		d.writeListIdentityError(w, r, err)
		return
	}
	body, err := readListImportBody(w, r)
	if err != nil {
		if errors.Is(err, errListImportBodyTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "bad_csv", errListImportBodyTooLarge.Error())
			return
		}
		httperror.Write(w, http.StatusBadRequest, "bad_form", "CSV request body could not be parsed")
		return
	}
	defer func() { _ = body.Close() }()

	reader := csv.NewReader(body)
	reader.FieldsPerRecord = -1
	header, err := reader.Read()
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_csv", "CSV must have a header row"))
		return
	}
	emailIdx := csvHeaderIndex(header, "email")
	if emailIdx < 0 {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_email", "CSV header must include an email column"))
		return
	}

	resp := listImportResponse{ListID: listUUID}
	for {
		record, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		resp.Rows++
		rowNum := resp.Rows + 1
		if resp.Rows > listImportMaxRows {
			resp.Errors = append(resp.Errors, listImportRowError{
				Row:   rowNum,
				Error: fmt.Sprintf("CSV exceeds the %d-row cap; use the migration service for larger imports", listImportMaxRows),
			})
			break
		}
		if err != nil {
			resp.Errors = append(resp.Errors, listImportRowError{Row: rowNum, Error: err.Error()})
			continue
		}
		email := strings.TrimSpace(csvValue(record, emailIdx))
		parsed, err := mail.ParseAddress(email)
		if err != nil {
			resp.Errors = append(resp.Errors, listImportRowError{Row: rowNum, Email: email, Error: "invalid email"})
			continue
		}
		email = parsed.Address
		if err := d.Repo.AddEmailToList(r.Context(), t.ID, listUUID, email, "csv"); err != nil {
			if errors.Is(err, ErrListIDNotMapped) {
				// The list was deleted while the file was being read. Its
				// deletion removed every row this import had added, so the
				// honest answer is the one a request after the delete gets.
				d.writeListIdentityError(w, r, err)
				return
			}
			if errors.Is(err, ErrErasureBlocked) {
				resp.Errors = append(resp.Errors, listImportRowError{
					Row: rowNum, Email: email, Code: "erasure_blocked", Error: listImportErasureBlockedMessage,
				})
				continue
			}
			resp.Errors = append(resp.Errors, listImportRowError{Row: rowNum, Email: email, Error: err.Error()})
			continue
		}
		resp.Imported++
	}
	audit.EmitOrLog(r.Context(), d.auditPool(), "list.import", "list", listUUID,
		nil, map[string]any{
			"rows":     resp.Rows,
			"imported": resp.Imported,
			"errors":   len(resp.Errors),
		}, nil)
	writeJSON(w, http.StatusOK, resp)
}

// ExportMembersCSV GET /api/v1/lists/{id}/export.csv
//
// Capped at listExportHardCap rows and audited. This route streams every
// member email, status and acquisition source of a list; it used to do so
// unbounded and without writing an audit_log row, while its sibling
// subscribers export was both capped and step-up gated — so the cheapest way
// past those controls was to ask for the same people one list at a time.
func (d *Deps) ExportMembersCSV(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", listsUnavailableMessage))
		return
	}
	listUUID, err := d.Repo.resolveListUUID(r.Context(), t.ID, strings.TrimSpace(chi.URLParam(r, "id")))
	if err != nil {
		d.writeListIdentityError(w, r, err)
		return
	}
	cw := &listExportWriter{ResponseWriter: w}
	if err := d.Repo.StreamMembersCSV(r.Context(), t.ID, listUUID, cw); err != nil {
		if !cw.wrote {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	// Emitted after the stream so the row count is real. An export that failed
	// mid-stream still writes its row: partial disclosure is disclosure.
	audit.EmitOrLog(r.Context(), d.auditPool(), "list.export", "list", listUUID,
		nil, map[string]any{
			"rows":      cw.rows,
			"truncated": cw.truncated,
		}, nil)
}

// listExportWriter delays the CSV headers until the first body byte so an
// early failure can still answer with a JSON envelope, and carries the
// truncation flag the repo sets before its first Write — same shape as
// subscribers' csvDownloadWriter, for the same reason: the header block must
// be complete before the streamed body starts.
type listExportWriter struct {
	http.ResponseWriter
	wrote     bool
	truncated bool
	rows      int
}

func (w *listExportWriter) Write(p []byte) (int, error) {
	if !w.wrote {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="list-members.csv"`)
		if w.truncated {
			w.Header().Set("X-Postwave-Truncated", "true")
		}
		w.wrote = true
	}
	return w.ResponseWriter.Write(p)
}

func (w *listExportWriter) signalTruncated() { w.truncated = true }

func (w *listExportWriter) countRow() { w.rows++ }

// listExportSignaler lets StreamMembersCSV report truncation and row count
// without depending on the HTTP layer: a plain bytes.Buffer simply does not
// implement it, which keeps the repo unit-testable.
type listExportSignaler interface {
	signalTruncated()
	countRow()
}

func readListImportBody(w http.ResponseWriter, r *http.Request) (io.ReadCloser, error) {
	if r.ContentLength > listImportMaxBodyBytes {
		return nil, errListImportBodyTooLarge
	}
	r.Body = http.MaxBytesReader(w, r.Body, listImportMaxBodyBytes)
	if strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "multipart/form-data") {
		if err := r.ParseMultipartForm(listImportMaxBodyBytes); err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				return nil, errListImportBodyTooLarge
			}
			return nil, err
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			return nil, fmt.Errorf("multipart form must include file field")
		}
		return file, nil
	}
	return r.Body, nil
}

func csvHeaderIndex(header []string, name string) int {
	for i, col := range header {
		if strings.EqualFold(strings.TrimSpace(col), name) {
			return i
		}
	}
	return -1
}

func csvValue(record []string, idx int) string {
	if idx < 0 || idx >= len(record) {
		return ""
	}
	return record[idx]
}

func (r *Repo) AddEmailToList(ctx context.Context, tenantID, listUUID, email, source string) error {
	source = normalizeListImportSource(source)
	_, err := r.AddEmailToListOwned(ctx, tenantID, listUUID, email, ListMembershipOwner{
		Source:   source,
		OwnerKey: "source:" + source,
		Metadata: map[string]any{"owner": "legacy_source"},
	})
	return err
}

func (r *Repo) RemoveEmailFromList(ctx context.Context, tenantID, listUUID, email, source string) (bool, error) {
	source = strings.ToLower(strings.TrimSpace(source))
	if source != "" {
		source = normalizeListImportSource(source)
	}
	if source == "" {
		source = "integration"
	}
	return r.RemoveEmailFromListOwned(ctx, tenantID, listUUID, email, "source:"+source)
}

func (r *Repo) StreamMembersCSV(ctx context.Context, tenantID, listUUID string, w io.Writer) error {
	if r == nil || r.Pool == nil {
		return fmt.Errorf("lists: repo not configured")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// cap+1 so the (cap+1)th row proves truncation without a second query.
	// The extra row is read from the cursor and never written.
	rows, err := tx.Query(ctx, `
SELECT s.email::text, COALESCE(s.status, ''), COALESCE(ls.source, ''), ls.added_at
  FROM list_subscribers ls
  JOIN subscribers s ON s.id = ls.subscriber_id
 WHERE ls.tenant_id = $1::uuid
   AND ls.list_id = $2::uuid
   AND ls.removed_at IS NULL
 ORDER BY ls.added_at DESC
 LIMIT $3`, tenantID, listUUID, listExportHardCap+1)
	if err != nil {
		return err
	}
	// Drain the cursor before writing a byte, so the truncation verdict is
	// known while the header block is still open. At most cap+1 rows are held,
	// which is bounded and small relative to the table.
	type memberRow struct {
		email, status, source string
		addedAt               time.Time
	}
	buffered := make([]memberRow, 0, listExportHardCap)
	overflow := false
	for rows.Next() {
		if len(buffered) >= listExportHardCap {
			overflow = true
			break
		}
		var row memberRow
		if err := rows.Scan(&row.email, &row.status, &row.source, &row.addedAt); err != nil {
			rows.Close()
			return err
		}
		buffered = append(buffered, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if signaler, ok := w.(listExportSignaler); ok {
		if overflow {
			signaler.signalTruncated()
		}
		for range buffered {
			signaler.countRow()
		}
	}

	cw := csv.NewWriter(w)
	if err := cw.Write([]string{"email", "status", "source", "added_at"}); err != nil {
		return err
	}
	for i := range buffered {
		row := &buffered[i]
		if err := cw.Write([]string{
			listCSVCell(row.email),
			listCSVCell(row.status),
			listCSVCell(row.source),
			row.addedAt.UTC().Format(time.RFC3339),
		}); err != nil {
			return err
		}
	}
	cw.Flush()
	if err := cw.Error(); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func normalizeListImportSource(source string) string {
	switch strings.ToLower(strings.TrimSpace(source)) {
	case "form", "api", "csv", "integration", "admin", "migration", "listmonk_event":
		return strings.ToLower(strings.TrimSpace(source))
	default:
		return "csv"
	}
}

func listCSVCell(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return value
	}
	switch value[0] {
	case '=', '+', '-', '@':
		return "'" + value
	default:
		return value
	}
}
