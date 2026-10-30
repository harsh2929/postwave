// SPDX-License-Identifier: AGPL-3.0-only
//
// import_export.go — CSV import + export for the suppression list.
//
// Operational must-have: customers migrating IN bring a list of
// addresses they never want to email; customers migrating OUT want
// the same list back for portability.
//
// CSV format (header optional):
//
//   email,reason
//   bounced@example.com,hard_bounce
//   complained@example.com,complaint
//
// Lenient parsing — we accept any column count >= 1 (first column
// is email; second column when present is the reason). Header is
// auto-detected: if the first column of the first row is literally
// "email" (case-insensitive), it's a header and skipped.

package suppressions

import (
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MaxImportBytes caps the upload. 25 MB is comfortably above a
// 500k-row suppression list with reasons.
const MaxImportBytes int64 = 25 << 20

// MaxImportRows is independent of the byte ceiling: a highly compressed CSV
// made of tiny addresses must not turn one request into unbounded database
// work. The file is preflighted before the first write, so an over-limit
// upload cannot leave a partially imported list.
const MaxImportRows = 500_000

const (
	suppressionImportChunkSize = 1_000
	suppressionFormFieldBytes  = 4 << 10
)

var (
	errSuppressionImportTooManyRows   = errors.New("suppression import has too many rows")
	errSuppressionImportMissingFile   = errors.New("suppression import file is required")
	errSuppressionImportDuplicateFile = errors.New("suppression import contains more than one file")
	errSuppressionImportFieldTooLarge = errors.New("suppression import form field is too large")
)

// MountImportExportRoutes registers the CSV endpoints. Caller wires
// these alongside the existing MountRoutes / MountX1Routes.
//
//	POST /api/v1/suppressions/import   multipart CSV upload
//	GET  /api/v1/suppressions/export   streaming CSV download
func (d *Deps) MountImportExportRoutes(r chi.Router) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/suppressions/import", d.Import)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/suppressions/export", d.Export)
}

// importResponse is the wire shape.
type importResponse struct {
	Inserted  int      `json:"inserted"`
	Existing  int      `json:"existing"`
	Skipped   int      `json:"skipped"`
	Errors    int      `json:"errors"`
	BadRows   []string `json:"bad_rows,omitempty"` // first 10
	BytesRead int64    `json:"bytes_read"`
}

// Import POST /api/v1/suppressions/import (multipart).
func (d *Deps) Import(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	mediaType, _, mediaErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaErr != nil || mediaType != "multipart/form-data" {
		httperror.Write(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "Content-Type must be multipart/form-data")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxImportBytes)
	mr, err := r.MultipartReader()
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "bad_form", "multipart form could not be parsed")
		return
	}
	file, defaultReason, bytesRead, err := spoolSuppressionMultipart(mr)
	if err != nil {
		var maxErr *http.MaxBytesError
		switch {
		case errors.As(err, &maxErr):
			httpbody.WriteError(w, httpbody.ErrTooLarge)
		case errors.Is(err, errSuppressionImportMissingFile):
			writeJSON(w, http.StatusBadRequest, errEnv("missing_file", "upload field 'file' is required"))
		case errors.Is(err, errSuppressionImportDuplicateFile):
			httperror.Write(w, http.StatusBadRequest, "duplicate_file", "exactly one upload file is allowed")
		case errors.Is(err, errSuppressionImportFieldTooLarge):
			httperror.Write(w, http.StatusBadRequest, "field_too_large", "multipart form field exceeds 4 KiB")
		default:
			httperror.Write(w, http.StatusBadRequest, "bad_form", "multipart form could not be parsed")
		}
		return
	}
	defer func() {
		name := file.Name()
		_ = file.Close()
		_ = os.Remove(name)
	}()

	if defaultReason == "" {
		defaultReason = "imported"
	}
	resp, err := scanSuppressionCSV(file, MaxImportRows, nil)
	resp.BytesRead = bytesRead
	if errors.Is(err, errSuppressionImportTooManyRows) {
		httperror.Write(w, http.StatusRequestEntityTooLarge, "too_many_rows", "suppression CSV exceeds 500000 data rows")
		return
	}
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "bad_csv", "suppression CSV could not be parsed")
		return
	}

	bulkAdd := func(ctx context.Context, emails []string, reason string) (*BulkResult, error) {
		return d.Repo.BulkAdd(ctx, t.ID, emails, reason)
	}
	normalizeReason := normalizeBulkReason
	if d.CanonicalStore != nil {
		normalizeReason = func(raw string) string { return string(NormalizeReason(raw)) }
		bulkAdd = func(ctx context.Context, emails []string, reason string) (*BulkResult, error) {
			result, err := d.CanonicalStore.BulkImport(ctx, t.ID, emails, Reason(reason), ChannelEmail, ScopeMarketing)
			if err != nil {
				return nil, err
			}
			h := &StoreHandlers{Store: d.CanonicalStore, Audit: d.Audit, Logger: d.Logger}
			for _, email := range result.Emails {
				h.recordAudit(ctx, t.ID, email, AuditActionAdd, reason,
					map[string]any{"source": string(SourceImport), "csv": true})
			}
			return &BulkResult{Imported: result.Imported, Skipped: result.Skipped, Errors: result.Errors}, nil
		}
	}
	result, err := importSuppressionCSVWithNormalizer(r.Context(), file, MaxImportRows, defaultReason, bulkAdd, normalizeReason)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	resp.Inserted = result.Imported
	resp.Existing = result.Skipped
	resp.Errors += len(result.Errors)
	writeJSON(w, http.StatusOK, resp)
}

// spoolSuppressionMultipart streams the upload to a mode-0600 temporary file.
// ParseMultipartForm intentionally is not used: at the accepted 25 MiB ceiling
// it can retain the entire customer list in heap memory. Form fields may appear
// before or after the file and are still resolved before CSV processing begins.
func spoolSuppressionMultipart(mr *multipart.Reader) (*os.File, string, int64, error) {
	var (
		file          *os.File
		defaultReason string
		bytesRead     int64
	)
	cleanup := func() {
		if file == nil {
			return
		}
		name := file.Name()
		_ = file.Close()
		_ = os.Remove(name)
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			cleanup()
			return nil, "", 0, err
		}
		switch part.FormName() {
		case "file":
			if file != nil {
				_ = part.Close()
				cleanup()
				return nil, "", 0, errSuppressionImportDuplicateFile
			}
			file, err = os.CreateTemp("", "postwave-suppressions-*.csv")
			if err == nil {
				bytesRead, err = io.Copy(file, part)
			}
			_ = part.Close()
			if err != nil {
				cleanup()
				return nil, "", 0, err
			}
		case "default_reason":
			value, readErr := io.ReadAll(io.LimitReader(part, suppressionFormFieldBytes+1))
			_ = part.Close()
			if readErr != nil {
				cleanup()
				return nil, "", 0, readErr
			}
			if len(value) > suppressionFormFieldBytes {
				cleanup()
				return nil, "", 0, errSuppressionImportFieldTooLarge
			}
			defaultReason = strings.TrimSpace(string(value))
		default:
			_, err = io.Copy(io.Discard, part)
			_ = part.Close()
			if err != nil {
				cleanup()
				return nil, "", 0, err
			}
		}
	}
	if file == nil {
		return nil, "", 0, errSuppressionImportMissingFile
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		cleanup()
		return nil, "", 0, err
	}
	return file, defaultReason, bytesRead, nil
}

type suppressionCSVEntry struct {
	email  string
	reason string
}

// scanSuppressionCSV validates/counts one seekable CSV with O(1) memory.
// onEntry is nil for preflight; a non-nil callback is used on the second pass.
func scanSuppressionCSV(file io.ReadSeeker, maxRows int, onEntry func(suppressionCSVEntry) error) (importResponse, error) {
	var resp importResponse
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return resp, err
	}
	cr := csv.NewReader(file)
	cr.FieldsPerRecord = -1
	cr.LazyQuotes = true
	recordNumber := 0
	dataRows := 0
	for {
		row, readErr := cr.Read()
		if errors.Is(readErr, io.EOF) {
			return resp, nil
		}
		recordNumber++
		if readErr == nil && recordNumber == 1 && len(row) > 0 && strings.EqualFold(strings.TrimSpace(row[0]), "email") {
			continue
		}
		dataRows++
		if dataRows > maxRows {
			return resp, errSuppressionImportTooManyRows
		}
		if readErr != nil {
			resp.Errors++
			if len(resp.BadRows) < 10 {
				resp.BadRows = append(resp.BadRows, fmt.Sprintf("row %d: %v", recordNumber, readErr))
			}
			continue
		}
		if len(row) == 0 {
			continue
		}
		email := strings.ToLower(strings.TrimSpace(row[0]))
		if email == "" {
			resp.Skipped++
			continue
		}
		if !strings.Contains(email, "@") {
			resp.Skipped++
			if len(resp.BadRows) < 10 {
				resp.BadRows = append(resp.BadRows, fmt.Sprintf("row %d: invalid email %q", recordNumber, email))
			}
			continue
		}
		reason := ""
		if len(row) >= 2 {
			reason = strings.TrimSpace(row[1])
		}
		if onEntry != nil {
			if err := onEntry(suppressionCSVEntry{email: email, reason: reason}); err != nil {
				return resp, err
			}
		}
	}
}

// importSuppressionCSV applies the already-preflighted CSV in fixed-size,
// reason-grouped batches. Memory use is bounded by suppressionImportChunkSize;
// committed chunks are idempotent, so a client may safely retry a transport or
// database failure without duplicating suppression rows.
func importSuppressionCSV(
	ctx context.Context,
	file io.ReadSeeker,
	maxRows int,
	defaultReason string,
	bulkAdd func(context.Context, []string, string) (*BulkResult, error),
) (*BulkResult, error) {
	return importSuppressionCSVWithNormalizer(ctx, file, maxRows, defaultReason, bulkAdd, normalizeBulkReason)
}

func importSuppressionCSVWithNormalizer(
	ctx context.Context,
	file io.ReadSeeker,
	maxRows int,
	defaultReason string,
	bulkAdd func(context.Context, []string, string) (*BulkResult, error),
	normalizeReason func(string) string,
) (*BulkResult, error) {
	total := &BulkResult{Errors: []string{}}
	chunk := make([]suppressionCSVEntry, 0, suppressionImportChunkSize)
	flush := func() error {
		if len(chunk) == 0 {
			return nil
		}
		groups := make(map[string][]string)
		for _, entry := range chunk {
			reason := entry.reason
			if reason == "" {
				reason = defaultReason
			}
			reason = normalizeReason(reason)
			groups[reason] = append(groups[reason], entry.email)
		}
		reasons := make([]string, 0, len(groups))
		for reason := range groups {
			reasons = append(reasons, reason)
		}
		sort.Strings(reasons)
		for _, reason := range reasons {
			result, err := bulkAdd(ctx, groups[reason], reason)
			if err != nil {
				return err
			}
			total.Imported += result.Imported
			total.Skipped += result.Skipped
			total.Errors = append(total.Errors, result.Errors...)
		}
		chunk = chunk[:0]
		return nil
	}
	_, err := scanSuppressionCSV(file, maxRows, func(entry suppressionCSVEntry) error {
		chunk = append(chunk, entry)
		if len(chunk) == suppressionImportChunkSize {
			return flush()
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := flush(); err != nil {
		return nil, err
	}
	return total, nil
}

// Export GET /api/v1/suppressions/export — streaming CSV. Caps at
// MaxExportRows to keep the response bounded. Filtering by reason
// is supported via ?reason= for "give me only my unsubscribes" /
// "give me only my bounces" segmentation at export time.
const MaxExportRows = 500_000

func (d *Deps) Export(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	reason := strings.TrimSpace(r.URL.Query().Get("reason"))
	limit := MaxExportRows
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= MaxExportRows {
			limit = n
		}
	}

	// Use the existing Repo.List in pages — we don't want a single
	// 500k-row query in flight. Page size 1000 is conservative.
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		`attachment; filename="postwave-suppressions-`+time.Now().UTC().Format("20060102-150405")+`.csv"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("email,reason,created_at\n"))

	// Repo.List clamps its limit to 200, so the page size must match — the
	// old 1000 with `offset += 1000` skipped 800 rows per page and dropped
	// ~80% of the export (D05#3).
	const pageSize = 200
	offset := 0
	written := 0
	for written < limit {
		page, err := d.Repo.List(r.Context(), t.ID, "", pageSize, offset)
		if err != nil {
			// Cut off the response without rewriting headers; the
			// truncated CSV is more useful than a 500.
			return
		}
		if len(page) == 0 {
			return
		}
		for _, s := range page {
			if reason != "" && s.Reason != reason {
				continue
			}
			line := csvJoinSuppressions(s.Email, s.Reason,
				s.CreatedAt.UTC().Format(time.RFC3339)) + "\n"
			if _, err := w.Write([]byte(line)); err != nil {
				return
			}
			written++
			if written >= limit {
				return
			}
		}
		offset += pageSize
	}
}

// csvJoinSuppressions escapes per RFC 4180 + joins with commas.
func csvJoinSuppressions(fields ...string) string {
	out := make([]byte, 0, 128)
	for i, f := range fields {
		if i > 0 {
			out = append(out, ',')
		}
		needsQuote := strings.ContainsAny(f, ",\"\r\n")
		if needsQuote {
			out = append(out, '"')
			out = append(out, []byte(strings.ReplaceAll(f, `"`, `""`))...)
			out = append(out, '"')
		} else {
			out = append(out, []byte(f)...)
		}
	}
	return string(out)
}
