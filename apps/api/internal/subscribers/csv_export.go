// CSV export of the subscribers table. The corresponding import path is
// in bulk_import.go (already on main); this file adds only the streaming
// export.
//
// We stream row-by-row through encoding/csv flushing every line so a
// large export doesn't materialize the whole table in memory. The caller
// can pass `?limit=` to cap.

package subscribers

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// csvExportHardCap is the maximum number of data rows the export will
// stream in one response. SUB-108: the desktop Export action surfaces a
// "your export was truncated" warning toast when the X-Postwave-Truncated
// header is present, so an operator who hits the cap knows the file is not
// the full audience. The number mirrors the bulk-verb id-list ceiling so
// the export and the bulk surfaces share one mental model of "10k is the
// per-call batch size". Enforced in the repo's row loop (StreamCSVFiltered),
// never as a SQL LIMIT, so the cap survives any future server-side filter.
const csvExportHardCap = 10000

// MountCSVExportRoutes registers the CSV export endpoint.
func MountCSVExportRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/export.csv", d.ExportCSV)
	// Friendly alias matching the agent-coverage-gaps doc shape.
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers.csv", d.ExportCSV)
}

// ExportCSV streams subscribers as a CSV download.
//
// SUB-107: the desktop Export action sends the applied status/query/archive/
// sort contract, so the download mirrors the settled on-screen view instead
// of a live input draft or current page. Invalid scope is rejected before the
// database is touched; archived rows are excluded unless explicitly included.
//
// SUB-108: the export is hard-capped at csvExportHardCap data rows. When
// the cap truncates the result the handler sets X-Postwave-Truncated: true
// BEFORE the first CSV byte is written, which the desktop client reads to
// raise a warning toast. The header is set on the underlying ResponseWriter
// (not the csvDownloadWriter wrapper) so it lands in the header block ahead
// of the streamed body.
func (d *Deps) ExportCSV(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	opts, err := parseCSVExportOptions(r)
	if err != nil {
		httperror.WriteValidation(w, "invalid_export_scope", err.Error())
		return
	}

	csvw := &csvDownloadWriter{ResponseWriter: w}
	if err := d.Repo.StreamCSVFiltered(r.Context(), t.ID, csvw, opts); err != nil {
		if !csvw.wrote {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		}
		return
	}
}

func parseCSVExportOptions(r *http.Request) (CSVExportOptions, error) {
	query := r.URL.Query()
	opts := CSVExportOptions{
		Status: strings.TrimSpace(query.Get("status")),
		Q:      strings.TrimSpace(query.Get("q")),
		Sort:   strings.TrimSpace(query.Get("sort")),
		Order:  strings.TrimSpace(query.Get("order")),
	}
	if raw := strings.TrimSpace(query.Get("limit")); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit <= 0 {
			return opts, fmt.Errorf("limit must be a positive integer")
		}
		opts.Limit = limit
	}
	if opts.Status != "" && !strings.EqualFold(opts.Status, "all") {
		if _, _, ok := statusFilterClause(opts.Status); !ok {
			return opts, fmt.Errorf("status is not a supported subscriber status")
		}
	}
	if opts.Sort != "" && !validCSVExportSort(opts.Sort) {
		return opts, fmt.Errorf("sort is not a supported full-result column")
	}
	if opts.Order != "" &&
		!strings.EqualFold(opts.Order, "asc") &&
		!strings.EqualFold(opts.Order, "desc") {
		return opts, fmt.Errorf("order must be asc or desc")
	}
	switch strings.ToLower(strings.TrimSpace(query.Get("include_archived"))) {
	case "", "false":
	case "true":
		opts.IncludeArchived = true
	default:
		return opts, fmt.Errorf("include_archived must be true or false")
	}
	return opts, nil
}

func validCSVExportSort(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "updated_at", "created_at", "joined", "email", "status",
		"mailchimp_status", "engagement", "engagement_score", "first_name",
		"last_name", "churn", "churn_score", "rating":
		return true
	default:
		return false
	}
}

// csvDownloadWriter delays the CSV Content-Type / Content-Disposition
// headers until the first body byte so an early error path can still emit a
// JSON error envelope with the right Content-Type. SUB-108: it also carries
// a `truncated` flag the repo sets BEFORE its first Write; when set, the
// X-Postwave-Truncated header is emitted in the same header block as the
// CSV headers so the desktop client reads it ahead of the streamed body.
type csvDownloadWriter struct {
	http.ResponseWriter
	wrote           bool
	truncated       bool
	exportedRows    int
	hasExportedRows bool
}

func (w *csvDownloadWriter) Write(p []byte) (int, error) {
	if !w.wrote {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="subscribers.csv"`)
		if w.truncated {
			w.Header().Set("X-Postwave-Truncated", "true")
		}
		if w.hasExportedRows {
			w.Header().Set("X-Postwave-Exported-Rows", strconv.Itoa(w.exportedRows))
		}
		w.wrote = true
	}
	return w.ResponseWriter.Write(p)
}

// csvExportHeader is the column order the streaming export emits. Locked
// by TestCSVHeader_Order — downstream importers + the docs assume this
// exact order. SUB-106 extended the original 6-column set with the rich
// columns Klaviyo/Mailchimp expose on export: merge_fields, plus the
// derived scores (engagement / rating / churn) that live directly on the
// subscribers row.
var csvExportHeader = []string{
	"email", "name", "status", "tags",
	"custom_fields_json", "merge_fields_json",
	"engagement_score", "rating", "churn_score",
	"created_at",
}

// csvExportSelect is the SELECT list shared by StreamCSV + StreamCSVByIDs.
// All columns live on subscribers (merge_fields jsonb 0028; engagement_score
// 0061; rating 0226; churn_score 0180) so no JOIN is needed. Smallint scores
// are nullable — scanned into *int16 and rendered as "" when unset.
const csvExportSelect = `email::text, COALESCE(custom_fields->>'name', '') AS name, status,
       COALESCE(tags, ARRAY[]::text[]),
       COALESCE(custom_fields, '{}'::jsonb),
       COALESCE(merge_fields, '{}'::jsonb),
       engagement_score, rating, churn_score,
       created_at`

// scanCSVRow reads one export row and writes it through cw with the
// SUB-106 column order. Shared by StreamCSV + StreamCSVByIDs so the two
// surfaces never drift.
func scanCSVRow(rows interface {
	Scan(dest ...any) error
}, cw *csv.Writer) error {
	var email, name, status string
	var tags []string
	var cfBytes, mfBytes []byte
	var engagement, rating, churn *int16
	var createdAt time.Time
	if err := rows.Scan(&email, &name, &status, &tags, &cfBytes, &mfBytes,
		&engagement, &rating, &churn, &createdAt); err != nil {
		return err
	}
	if len(cfBytes) == 0 {
		cfBytes = []byte("{}")
	}
	if len(mfBytes) == 0 {
		mfBytes = []byte("{}")
	}
	return cw.Write([]string{
		csvCell(email),
		csvCell(name),
		csvCell(status),
		csvCell(strings.Join(tags, ",")),
		csvCell(string(cfBytes)),
		csvCell(string(mfBytes)),
		smallintCell(engagement),
		smallintCell(rating),
		smallintCell(churn),
		createdAt.Format(time.RFC3339),
	})
}

// smallintCell renders a nullable smallint score as a decimal string, or
// "" when the score has never been computed (NULL).
func smallintCell(v *int16) string {
	if v == nil {
		return ""
	}
	return strconv.Itoa(int(*v))
}

// CSVExportOptions carries the filter + cap knobs the desktop Export
// action sends. All fields are optional:
//
//   - Status — an engine status or exact Mailchimp lifecycle status;
//     "bounced" aliases "cleaned". The HTTP boundary rejects unknown values.
//   - Q      — free-text search, the same indexed predicate the list/search
//     endpoints use (subscriberFreeTextPredicate).
//   - IncludeArchived — opt-in parity with the directory toggle; false keeps
//     the safe active-only default.
//   - Sort / Order — the reviewed full-result ordering contract.
//   - Limit  — an explicit caller cap. A positive Limit below the
//     csvExportHardCap wins; otherwise the hard cap applies.
type CSVExportOptions struct {
	Status          string
	Q               string
	Sort            string
	Order           string
	Limit           int
	IncludeArchived bool
}

// truncationSignaler is implemented by csvDownloadWriter so the repo can
// flip the X-Postwave-Truncated header flag BEFORE the first CSV byte is
// written. Kept as an interface so StreamCSVFiltered stays testable with a
// plain bytes.Buffer (which simply doesn't carry the flag).
type truncationSignaler interface {
	signalTruncated()
}

func (w *csvDownloadWriter) signalTruncated() { w.truncated = true }

func (w *csvDownloadWriter) signalExportedRows(rows int) {
	w.exportedRows = rows
	w.hasExportedRows = true
}

func csvExportWhere(tenantID string, opts CSVExportOptions) (string, []any) {
	args := []any{tenantID}
	where := `WHERE tenant_id = $1::uuid`
	if q := strings.TrimSpace(opts.Q); q != "" {
		args = append(args, q)
		where += `
  AND ` + subscriberFreeTextPredicate(len(args))
	}
	if scol, sval, ok := statusFilterClause(opts.Status); ok {
		args = append(args, sval)
		where += fmt.Sprintf(`
  AND %s = $%d`, scol, len(args))
	}
	if !opts.IncludeArchived {
		where += `
  AND archived_at IS NULL`
	}
	return where, args
}

// StreamCSVFiltered is the SUB-107 / SUB-108 export path: it applies the
// optional status + q filters (SUB-107) and enforces the csvExportHardCap
// row ceiling (SUB-108), signalling truncation through w (if w implements
// truncationSignaler) BEFORE the CSV header row is written so the handler's
// X-Postwave-Truncated header lands ahead of the body.
//
// Truncation detection: we fetch up to effectiveCap+1 rows. If the (cap+1)th
// row exists the result was capped, so we mark the writer truncated and emit
// exactly effectiveCap data rows. The extra row is read from the cursor but
// never written.
func (r *Repo) StreamCSVFiltered(ctx context.Context, tenantID string, w io.Writer, opts CSVExportOptions) error {
	// Resolve the effective cap: the hard cap, narrowed by a smaller
	// positive caller Limit. A Limit at or above the hard cap (or <= 0)
	// leaves the hard cap in force.
	effectiveCap := csvExportHardCap
	if opts.Limit > 0 && opts.Limit < effectiveCap {
		effectiveCap = opts.Limit
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Shared WHERE: tenant scope + optional q + optional status, mirroring
	// ListWithOptions so the export filters byte-for-byte match the table.
	where, args := csvExportWhere(tenantID, opts)
	col, dir := normalizeSort(opts.Sort, opts.Order)

	// Fetch one extra row beyond the cap so we can tell "exactly cap" from
	// "more than cap". The $N is the integer cap+1, not user input.
	args = append(args, effectiveCap+1)
	q := `
SELECT ` + csvExportSelect + `
FROM subscribers
` + where + `
ORDER BY ` + col + ` ` + dir + `, id ` + dir + `
LIMIT $` + strconv.Itoa(len(args))

	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return err
	}

	// Drain the cursor first so we know the truncation verdict before any
	// byte is written. We buffer at most effectiveCap+1 scanned rows (<=
	// 10001) which is bounded and small relative to the table.
	type csvRow struct {
		email, name, status string
		tags                []string
		cf, mf              []byte
		engagement          *int16
		rating              *int16
		churn               *int16
		createdAt           time.Time
	}
	buffered := make([]csvRow, 0, effectiveCap)
	overflow := false
	for rows.Next() {
		if len(buffered) >= effectiveCap {
			// The (cap+1)th row exists — capped. Stop scanning further.
			overflow = true
			break
		}
		var rw csvRow
		if err := rows.Scan(&rw.email, &rw.name, &rw.status, &rw.tags,
			&rw.cf, &rw.mf, &rw.engagement, &rw.rating, &rw.churn, &rw.createdAt); err != nil {
			rows.Close()
			return err
		}
		buffered = append(buffered, rw)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	// SUB-108: signal truncation before the header row is written so the
	// X-Postwave-Truncated header lands in the same block as the CSV
	// Content-Type/Disposition. Only set when the user did NOT ask for a
	// smaller limit than the hard cap (an explicit small ?limit= is the
	// caller's own choice, not a silent cap) — i.e. overflow only counts as
	// truncation against the hard cap.
	if overflow && (opts.Limit <= 0 || opts.Limit >= csvExportHardCap) {
		if ts, ok := w.(truncationSignaler); ok {
			ts.signalTruncated()
		}
	}
	if signaler, ok := w.(interface{ signalExportedRows(int) }); ok {
		signaler.signalExportedRows(len(buffered))
	}

	cw := csv.NewWriter(w)
	defer cw.Flush()
	if err := cw.Write(csvExportHeader); err != nil {
		return err
	}
	for i := range buffered {
		rw := &buffered[i]
		cf := rw.cf
		if len(cf) == 0 {
			cf = []byte("{}")
		}
		mf := rw.mf
		if len(mf) == 0 {
			mf = []byte("{}")
		}
		if err := cw.Write([]string{
			csvCell(rw.email),
			csvCell(rw.name),
			csvCell(rw.status),
			csvCell(strings.Join(rw.tags, ",")),
			csvCell(string(cf)),
			csvCell(string(mf)),
			smallintCell(rw.engagement),
			smallintCell(rw.rating),
			smallintCell(rw.churn),
			rw.createdAt.Format(time.RFC3339),
		}); err != nil {
			return err
		}
		cw.Flush()
		if err := cw.Error(); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// StreamCSV writes the subscribers table as CSV to w. limit <= 0 means
// all rows.
func (r *Repo) StreamCSV(ctx context.Context, tenantID string, w io.Writer, limit int) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := `
SELECT ` + csvExportSelect + `
FROM subscribers
WHERE tenant_id = $1::uuid
ORDER BY created_at`
	args := []any{tenantID}
	if limit > 0 {
		q += " LIMIT $2"
		args = append(args, limit)
	}
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	cw := csv.NewWriter(w)
	defer cw.Flush()
	if err := cw.Write(csvExportHeader); err != nil {
		return err
	}
	for rows.Next() {
		if err := scanCSVRow(rows, cw); err != nil {
			return err
		}
		cw.Flush()
		if err := cw.Error(); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// StreamCSVByIDs writes only the supplied subscriber ids as CSV to w
// (SUB-100-bulk-verbs export-by-segment). Same column layout + injection
// guarding as StreamCSV; an empty id list writes just the header row so the
// download is well-formed. The id list is already audience-resolved (explicit
// ids OR segment members) by the caller.
func (r *Repo) StreamCSVByIDs(ctx context.Context, tenantID string, w io.Writer, ids []string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cw := csv.NewWriter(w)
	defer cw.Flush()
	if err := cw.Write(csvExportHeader); err != nil {
		return err
	}
	if len(ids) == 0 {
		cw.Flush()
		return tx.Commit(ctx)
	}
	rows, err := tx.Query(ctx, `
SELECT `+csvExportSelect+`
FROM subscribers
WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])
ORDER BY created_at`, tenantID, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := scanCSVRow(rows, cw); err != nil {
			return err
		}
		cw.Flush()
		if err := cw.Error(); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func csvCell(value string) string {
	formulaLike := false
	for _, r := range value {
		if csvFormulaIgnorable(r) {
			continue
		}
		formulaLike = r == '=' || r == '+' || r == '-' || r == '@'
		break
	}

	var visible strings.Builder
	for _, r := range value {
		if csvHiddenControl(r) {
			if r <= 0xffff {
				_, _ = fmt.Fprintf(&visible, `\u%04X`, r)
			} else {
				_, _ = fmt.Fprintf(&visible, `\u{%X}`, r)
			}
			continue
		}
		visible.WriteRune(r)
	}
	if formulaLike {
		return "'" + visible.String()
	}
	return visible.String()
}

func csvFormulaIgnorable(r rune) bool {
	return unicode.IsSpace(r) || unicode.IsControl(r) || unicode.Is(unicode.Cf, r)
}

func csvHiddenControl(r rune) bool {
	if r == '\t' || r == '\r' || r == '\n' {
		return false
	}
	return unicode.IsControl(r) || unicode.Is(unicode.Cf, r)
}
