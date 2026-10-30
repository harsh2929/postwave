package privacy

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	stdsql "database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// Deps owns privacy workflow request endpoints. The fulfillment worker is
// intentionally separate; these handlers create the tenant-scoped audit record
// that ops can fulfill locally without cloud storage.
type Deps struct {
	Pool   *db.Pool
	Now    func() time.Time
	Logger *slog.Logger
}

const privacyWorkflowJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

type workflowRequest struct {
	Region string `json:"region"`
	Notes  string `json:"notes"`
}

type workflowResponse struct {
	RequestID        string    `json:"request_id"`
	Status           string    `json:"status"`
	RequestedAt      time.Time `json:"requested_at"`
	EstimatedReadyAt time.Time `json:"estimated_ready_at"`
}

type privacyRequestRow struct {
	RequestID      string     `json:"request_id"`
	Type           string     `json:"type"`
	Region         string     `json:"region"`
	Status         string     `json:"status"`
	SubjectType    string     `json:"subject_type"`
	SubjectEmail   string     `json:"subject_email,omitempty"`
	RequestedAt    time.Time  `json:"requested_at"`
	DueAt          time.Time  `json:"due_at"`
	CompletedAt    *time.Time `json:"completed_at,omitempty"`
	LegalHold      bool       `json:"legal_hold"`
	Notes          string     `json:"notes,omitempty"`
	Fulfillment    any        `json:"fulfillment"`
	RequesterEmail string     `json:"requester_email,omitempty"`
}

type exportTable struct {
	Name        string
	Where       string
	OmitColumns []string
}

type tableExport struct {
	Name  string          `json:"name"`
	Rows  int             `json:"rows"`
	Bytes int             `json:"bytes"`
	Data  json.RawMessage `json:"-"`
}

const exportMaxRowsPerTable = 100000

var tenantScopedWhere = "tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid"

var explicitExportTables = []exportTable{
	{Name: "tenants", Where: "id = NULLIF(current_setting('app.tenant_id', true), '')::uuid"},
}

var exportExcludedTables = map[string]struct{}{
	// Authentication/session material. Tenant exports include users and audit
	// events, but never password hashes, session verifiers, token hashes, TOTP
	// secrets, or OAuth/PKCE state.
	"auth_credentials":       {},
	"auth_sessions":          {},
	"auth_tokens":            {},
	"auth_totp_secrets":      {},
	"auth_oauth_state":       {},
	"commerce_oauth_states":  {},
	"migration_oauth_states": {},
	"migration_sessions":     {},
	// Transient replay/worker infrastructure. These rows are implementation
	// detail and may contain cached response bodies or side-effect payloads.
	"idempotency_records": {},
	"outbox_events":       {},
}

var exportOmitColumns = map[string][]string{
	"api_keys":                 {"key_hash"},
	"conversion_tracking_keys": {"key_hash"},
	"conversion_ingest_secrets": {
		"secret", "secret_envelope", "secret_kms_key_arn",
	},
	// Gift exports preserve purchaser/recipient, message, lifecycle, and
	// provider reconciliation data for portability. They never include URLs
	// or token material that can authorize or correlate a redemption flow.
	"gift_subscriptions":          {"stripe_payment_url", "redemption_token_sha256", "gifter_attribution_token"},
	"slack_integrations":          {"webhook_url_envelope"},
	"discord_integrations":        {"webhook_url_envelope"},
	"teams_integrations":          {"webhook_url_envelope"},
	"slack_workspace_connections": {"bot_token_encrypted"},
	"outbound_webhooks":           {"secret_envelope"},
}

// RequestExport records a tenant data-export request.
func (d *Deps) RequestExport(w http.ResponseWriter, r *http.Request) {
	d.recordWorkflow(w, r, "privacy.export_requested", "data_export", exportSLA)
}

// RequestDeletion records an account-deletion request. Deletion fulfillment is
// manual by design because billing, legal holds, and backup retention need a
// human review before irreversible removal.
func (d *Deps) RequestDeletion(w http.ResponseWriter, r *http.Request) {
	d.recordWorkflow(w, r, "privacy.deletion_requested", "account_deletion", deletionSLA)
}

// ListRequests returns the tenant's privacy-request lifecycle records. This
// is what web/mobile/desktop privacy centers use to show DSAR/deletion status
// instead of leaving users with a one-time toast and no auditable follow-up.
func (d *Deps) ListRequests(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	// Keyset pagination on (requested_at, id); default page size preserves the
	// prior LIMIT 100 so omitting ?limit= returns the same count as before.
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 100, pagination.MaxLimit)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_cursor", "cursor is malformed")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	// $1 tenant, $2 limit+1; the keyset bound (when paging) takes $3/$4.
	args := []any{tenant.ID, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		// privacy_requests.id is a TEXT primary key (prv_<type>_<hex>), not a
		// uuid — cast the cursor boundary to text to match.
		keyset = "AND (requested_at, id) < ($3::timestamptz, $4::text)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(r.Context(), `
SELECT id, request_type, region, status, subject_type,
       COALESCE(subject_email::text, ''), requested_at, due_at, completed_at,
       legal_hold, COALESCE(notes, ''), fulfillment,
       COALESCE(requester_email::text, '')
FROM privacy_requests
WHERE tenant_id = $1::uuid
`+keyset+`
ORDER BY requested_at DESC, id DESC
LIMIT $2`, args...)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := make([]privacyRequestRow, 0, 16)
	for rows.Next() {
		var row privacyRequestRow
		var fulfillmentBytes []byte
		if err := rows.Scan(
			&row.RequestID,
			&row.Type,
			&row.Region,
			&row.Status,
			&row.SubjectType,
			&row.SubjectEmail,
			&row.RequestedAt,
			&row.DueAt,
			&row.CompletedAt,
			&row.LegalHold,
			&row.Notes,
			&fulfillmentBytes,
			&row.RequesterEmail,
		); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		if len(fulfillmentBytes) > 0 {
			var decoded any
			if err := json.Unmarshal(fulfillmentBytes, &decoded); err == nil {
				row.Fulfillment = decoded
			}
		}
		if row.Fulfillment == nil {
			row.Fulfillment = map[string]any{}
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.RequestedAt, ID: last.RequestID})
	}
	resp := map[string]any{"requests": out}
	if next != "" {
		resp["nextCursor"] = next
	}
	writeJSON(w, http.StatusOK, resp)
}

// DownloadExport builds a local, tenant-scoped ZIP export for a previously
// queued export request. It deliberately avoids cloud storage so local Docker
// environments and one-off support workflows can fulfill GDPR/CCPA exports.
func (d *Deps) DownloadExport(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	requestID := strings.TrimSpace(chi.URLParam(r, "request_id"))
	if !strings.HasPrefix(requestID, "prv_data-export_") {
		httperror.Write(w, http.StatusBadRequest, "invalid_request_id", "data export request id required")
		return
	}
	now := d.now()
	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var requestType, status string
	var legalHold bool
	if err := tx.QueryRow(r.Context(), `
SELECT request_type, status, legal_hold
FROM privacy_requests
WHERE tenant_id = $1::uuid AND id = $2
FOR UPDATE`, tenant.ID, requestID).Scan(&requestType, &status, &legalHold); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "request_not_found", "data export request not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if requestType != "data_export" {
		httperror.Write(w, http.StatusBadRequest, "invalid_request_type", "request is not a data export")
		return
	}
	if legalHold || !exportDownloadStatusAllowed(status) {
		httperror.Write(w, http.StatusConflict, "export_not_downloadable", "this export cannot be downloaded in its current workflow state")
		return
	}

	tables, err := collectTenantExport(r.Context(), tx)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	bundle, err := buildExportZip(requestID, tenant.ID, now, tables)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := db.Audit(r.Context(), tx, auditMetaFromRequest(r, tenant.ID), "privacy.export_fulfilled", "data_export", requestID, map[string]any{
		"table_count": len(tables),
		"bytes":       len(bundle),
		"mode":        "local_zip",
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := markPrivacyRequestFulfilled(r.Context(), tx, tenant.ID, requestID, now, map[string]any{
		"table_count": len(tables),
		"bytes":       len(bundle),
		"mode":        "local_zip",
		"downloaded":  true,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	filename := exportFileName(requestID, now)
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("X-Postwave-Export-Request-ID", requestID)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(bundle)
}

func (d *Deps) recordWorkflow(
	w http.ResponseWriter,
	r *http.Request,
	action string,
	resourceType string,
	sla func(string) time.Duration,
) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}

	var req workflowRequest
	if r.Body != nil {
		if err := httpbody.DecodeJSONWith(w, r, privacyWorkflowJSONMaxBodyBytes, &req, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
	}
	region := normalizeRegion(req.Region)
	now := d.now()
	dueAt := now.Add(sla(region)).UTC()
	requestID, err := newRequestID(resourceType)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	if err := db.Audit(r.Context(), tx, auditMetaFromRequest(r, tenant.ID), action, resourceType, requestID, map[string]any{
		"region":             region,
		"notes":              strings.TrimSpace(req.Notes),
		"estimated_ready_at": dueAt.Format(time.RFC3339),
		"fulfillment_status": "queued",
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := insertPrivacyRequest(r.Context(), tx, tenant.ID, requestID, resourceType, region, strings.TrimSpace(req.Notes), now, dueAt, r); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	writeJSON(w, http.StatusAccepted, workflowResponse{
		RequestID:        requestID,
		Status:           "queued",
		RequestedAt:      now,
		EstimatedReadyAt: dueAt,
	})
}

func insertPrivacyRequest(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	requestID string,
	requestType string,
	region string,
	notes string,
	requestedAt time.Time,
	dueAt time.Time,
	r *http.Request,
) error {
	requesterUserID := any(nil)
	requesterEmail := any(nil)
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		if strings.TrimSpace(u.ID) != "" {
			requesterUserID = u.ID
		}
		if strings.TrimSpace(u.Email) != "" {
			requesterEmail = strings.TrimSpace(u.Email)
		}
	}
	_, err := tx.Exec(ctx, `
INSERT INTO privacy_requests (
    id, tenant_id, request_type, region, status, requester_user_id,
    requester_email, subject_type, requested_at, due_at, notes, fulfillment
) VALUES (
    $1, $2::uuid, $3, $4, 'queued', $5, $6, 'tenant_admin', $7, $8, NULLIF($9, ''), '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING`,
		requestID, tenantID, requestType, region, requesterUserID, requesterEmail,
		requestedAt, dueAt, notes,
	)
	if err != nil {
		return fmt.Errorf("insert privacy_requests: %w", err)
	}
	return nil
}

func markPrivacyRequestFulfilled(ctx context.Context, tx pgx.Tx, tenantID, requestID string, completedAt time.Time, fulfillment map[string]any) error {
	raw, err := json.Marshal(fulfillment)
	if err != nil {
		return fmt.Errorf("marshal fulfillment: %w", err)
	}
	result, err := tx.Exec(ctx, `
UPDATE privacy_requests
SET status = 'fulfilled',
    completed_at = $4,
    fulfillment = COALESCE(fulfillment, '{}'::jsonb) || $3::jsonb,
    updated_at = now()
WHERE tenant_id = $1::uuid
  AND id = $2
  AND request_type = 'data_export'
  AND legal_hold = false
  AND status IN ('queued', 'verifying', 'in_progress', 'fulfilled')`, tenantID, requestID, raw, completedAt)
	if err != nil {
		return fmt.Errorf("fulfill privacy_request: %w", err)
	}
	if result.RowsAffected() != 1 {
		return fmt.Errorf("fulfill privacy_request: request is no longer downloadable")
	}
	return nil
}

func exportDownloadStatusAllowed(status string) bool {
	switch status {
	case "queued", "verifying", "in_progress", "fulfilled":
		return true
	default:
		return false
	}
}

func collectTenantExport(ctx context.Context, tx pgx.Tx) ([]tableExport, error) {
	tables, err := tenantExportTables(ctx, tx)
	if err != nil {
		return nil, err
	}
	out := make([]tableExport, 0, len(tables))
	for _, table := range tables {
		if !safeIdentifier(table.Name) {
			return nil, fmt.Errorf("unsafe export table name %q", table.Name)
		}
		for _, col := range table.OmitColumns {
			if !safeIdentifier(col) {
				return nil, fmt.Errorf("unsafe export omit column %q on %s", col, table.Name)
			}
		}
		exists, err := tableExists(ctx, tx, table.Name)
		if err != nil {
			return nil, err
		}
		if !exists {
			continue
		}
		if table.Where == tenantScopedWhere {
			hasTenantID, err := tableHasColumn(ctx, tx, table.Name, "tenant_id")
			if err != nil {
				return nil, err
			}
			if !hasTenantID {
				continue
			}
		}
		raw, rows, err := readExportTable(ctx, tx, table)
		if err != nil {
			return nil, err
		}
		out = append(out, tableExport{
			Name:  table.Name,
			Rows:  rows,
			Bytes: len(raw),
			Data:  raw,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func tenantExportTables(ctx context.Context, tx pgx.Tx) ([]exportTable, error) {
	seen := map[string]bool{}
	out := make([]exportTable, 0, len(explicitExportTables)+64)
	for _, table := range explicitExportTables {
		table.OmitColumns = exportOmitColumns[table.Name]
		out = append(out, table)
		seen[table.Name] = true
	}

	rows, err := tx.Query(ctx, `
SELECT DISTINCT table_name
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND column_name = 'tenant_id'
 ORDER BY table_name`)
	if err != nil {
		return nil, fmt.Errorf("discover tenant export tables: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		if seen[name] || shouldExcludeExportTable(name) {
			continue
		}
		if !safeIdentifier(name) {
			return nil, fmt.Errorf("unsafe discovered export table name %q", name)
		}
		out = append(out, exportTable{
			Name:        name,
			Where:       tenantScopedWhere,
			OmitColumns: exportOmitColumns[name],
		})
		seen[name] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("discover tenant export tables: %w", err)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func shouldExcludeExportTable(name string) bool {
	_, ok := exportExcludedTables[name]
	return ok
}

func tableExists(ctx context.Context, tx pgx.Tx, name string) (bool, error) {
	var reg stdsql.NullString
	if err := tx.QueryRow(ctx, `SELECT to_regclass($1)::text`, "public."+name).Scan(&reg); err != nil {
		return false, fmt.Errorf("check table %s: %w", name, err)
	}
	return reg.Valid && reg.String != "", nil
}

func tableHasColumn(ctx context.Context, tx pgx.Tx, tableName, columnName string) (bool, error) {
	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			  FROM information_schema.columns
			 WHERE table_schema = 'public'
			   AND table_name = $1
			   AND column_name = $2
		)`, tableName, columnName).Scan(&exists); err != nil {
		return false, fmt.Errorf("check column %s.%s: %w", tableName, columnName, err)
	}
	return exists, nil
}

func readExportTable(ctx context.Context, tx pgx.Tx, table exportTable) (json.RawMessage, int, error) {
	query := fmt.Sprintf(
		`SELECT COALESCE(jsonb_agg(%s), '[]'::jsonb)
		   FROM (SELECT * FROM %s WHERE %s LIMIT $1) AS t`,
		exportJSONExpr(table),
		quoteIdent(table.Name),
		table.Where,
	)
	var raw []byte
	if err := tx.QueryRow(ctx, query, exportMaxRowsPerTable).Scan(&raw); err != nil {
		return nil, 0, fmt.Errorf("export table %s: %w", table.Name, err)
	}
	rows := 0
	if len(raw) > 0 {
		var arr []json.RawMessage
		if err := json.Unmarshal(raw, &arr); err != nil {
			return nil, 0, fmt.Errorf("count exported rows for %s: %w", table.Name, err)
		}
		rows = len(arr)
	}
	return json.RawMessage(raw), rows, nil
}

func exportJSONExpr(table exportTable) string {
	jsonExpr := "to_jsonb(t)"
	for _, col := range table.OmitColumns {
		jsonExpr += " - " + quoteLiteral(col)
	}
	return jsonExpr
}

func buildExportZip(requestID, tenantID string, generatedAt time.Time, tables []tableExport) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	manifestTables := make([]map[string]any, 0, len(tables))
	for _, table := range tables {
		manifestTables = append(manifestTables, map[string]any{
			"name":  table.Name,
			"rows":  table.Rows,
			"bytes": table.Bytes,
		})
	}
	manifest := map[string]any{
		"request_id":         requestID,
		"tenant_id":          tenantID,
		"generated_at":       generatedAt.UTC().Format(time.RFC3339),
		"format":             "postwave-tenant-export-v1",
		"max_rows_per_table": exportMaxRowsPerTable,
		"tables":             manifestTables,
	}
	if err := writeZipJSON(zw, "manifest.json", manifest); err != nil {
		return nil, err
	}
	if err := writeZipText(zw, "README.txt", "Moosewave tenant export. JSON files are grouped by database table under tables/. OAuth/session secrets and transient idempotency rows are intentionally excluded.\n"); err != nil {
		return nil, err
	}
	for _, table := range tables {
		if err := writeZipRaw(zw, "tables/"+table.Name+".json", table.Data); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeZipJSON(zw *zip.Writer, name string, value any) error {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return writeZipRaw(zw, name, append(b, '\n'))
}

func writeZipText(zw *zip.Writer, name, value string) error {
	return writeZipRaw(zw, name, []byte(value))
}

func writeZipRaw(zw *zip.Writer, name string, value []byte) error {
	f, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = f.Write(value)
	return err
}

var safeIdentPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

func safeIdentifier(value string) bool {
	return safeIdentPattern.MatchString(value)
}

func quoteIdent(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func quoteLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func exportFileName(requestID string, generatedAt time.Time) string {
	return fmt.Sprintf("postwave-export-%s-%s.zip", generatedAt.UTC().Format("20060102T150405Z"), sanitizeFilePart(requestID))
}

func sanitizeFilePart(value string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(value) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-_")
	if out == "" {
		return "request"
	}
	return out
}

func (d *Deps) now() time.Time {
	if d.Now != nil {
		return d.Now().UTC()
	}
	return time.Now().UTC()
}

func auditMetaFromRequest(r *http.Request, tenantID string) db.AuditMeta {
	meta := middleware.AuditMetaFromRequest(r)
	meta.TenantID = tenantID
	return meta
}

func newRequestID(prefix string) (string, error) {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("privacy request id: %w", err)
	}
	return "prv_" + strings.ReplaceAll(prefix, "_", "-") + "_" + hex.EncodeToString(b[:]), nil
}

func normalizeRegion(region string) string {
	region = strings.ToUpper(strings.TrimSpace(region))
	switch region {
	case "EU", "UK", "GB", "GDPR":
		return "GDPR"
	case "CA", "CALIFORNIA", "CCPA":
		return "CCPA"
	case "BR", "BRAZIL", "LGPD":
		return "LGPD"
	default:
		return "OTHER"
	}
}

// exportSLA returns the legal deadline by which the export must be
// fulfilled. GDPR audit HIGH #4: previously 14d for GDPR which
// under-promised the legal one-month window (Art. 12(3)). Aligned
// to the same value as deletionSLA below (30d for GDPR) so the
// dashboard / customer-facing copy doesn't quote two different
// deadlines for the same regulator.
func exportSLA(region string) time.Duration {
	switch normalizeRegion(region) {
	case "LGPD":
		return 15 * 24 * time.Hour
	case "GDPR":
		return 30 * 24 * time.Hour
	case "CCPA":
		return 45 * 24 * time.Hour
	default:
		return 30 * 24 * time.Hour
	}
}

func deletionSLA(region string) time.Duration {
	switch normalizeRegion(region) {
	case "LGPD":
		return 15 * 24 * time.Hour
	case "GDPR":
		return 30 * 24 * time.Hour
	case "CCPA":
		return 45 * 24 * time.Hour
	default:
		return 30 * 24 * time.Hour
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
