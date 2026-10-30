// SPDX-License-Identifier: AGPL-3.0-only
package handlers

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/auditsink"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// AuditHandlers serves the read-side of audit_log. It is tenant-scoped and
// supports filtering by actor identity so dashboards can answer "what did
// claude-code do in the last 24h?" without scanning every row.
type AuditHandlers struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal for structured server-side
	// logging of unexpected failures. nil-safe — when nil, internal errors
	// are still returned to the client as the generic envelope but no log
	// line is emitted. main.go wires the process-wide *slog.Logger here.
	Logger *slog.Logger
	// NLQ pipeline deps (natural-language-query feature). All optional —
	// when nil the handler returns 503 nlq_unavailable so the frontend
	// can hide the bar instead of half-rendering it.
	NLQLLM     audit.LLMClient
	NLQCache   *audit.NLQCache
	NLQTracker *audit.DailyCostTracker
	// signed-export-replay (Compliance, P0): ManifestWriter, when
	// non-nil, enables the ?include_manifest=true mode on Export — the
	// server records a signed manifest in audit_export_manifests
	// alongside streaming the CSV. nil-safe — when nil, the
	// include_manifest query param is silently ignored and the export
	// degrades to the historic CSV-only behaviour.
	ManifestWriter *auditsink.ExportManifestWriter
	// pii-redaction (Compliance, P0): envelope cipher used to decrypt
	// audit_log.metadata_encrypted on the Unmask handler. nil-safe — a
	// nil cipher degrades the Unmask endpoint to 503 unmask_unavailable
	// (the field-level encryption pipeline is configured but the read
	// path can't decrypt).
	Cipher audit.Cipher
}

// defaultAuditReadExclusionSQL is shared by the feed and its aggregate
// companions. Without an explicit action filter, meta-audit reads are hidden
// so polling the evidence surface cannot make its own totals grow.
//
// The `http.%` half hides the generic middleware trail. AuditMiddleware writes
// an `http.<method>.<path>` row for EVERY successful mutating request, in
// addition to whatever precise row the handler wrote — so at least half of all
// rows are plumbing. Every client that renders this feed already drops them
// (apps/web's dashboard-activity filters on the "http." prefix), which meant a
// request for 8 rows routinely yielded 0-3 renderable items and the dashboard's
// Recent-activity card read as empty on a busy workspace. Filtering server-side
// returns 8 rows a human can read instead of moving discarded rows over the
// wire. Compliance callers opt back in with an explicit ?action= filter, which
// disables this exclusion entirely.
//
// Parenthesised because both call sites splice it into a disjunction with the
// "caller named an action" test; AND binds tighter than OR so the meaning is
// the same either way, but the reader of the composed SQL should not have to
// work that out.
const defaultAuditReadExclusionSQL = "(action NOT LIKE 'audit.read.%' AND action NOT LIKE 'http.%')"

// auditAggregateWhere is shared by Stats and Count. Keeping one SQL fragment
// prevents their headline totals from drifting apart as filters evolve.
const auditAggregateWhere = `
WHERE tenant_id = $1::uuid
  AND ($2 = '' OR actor_type  = $2)
  AND ($3 = '' OR actor_label = $3)
  AND ($4 = '' OR action ILIKE '%' || $4 || '%')
  AND ($4 <> '' OR ` + defaultAuditReadExclusionSQL + `)
  AND ($5 = '' OR resource_type = $5)
  AND ($6::timestamptz IS NULL OR at >= $6::timestamptz)
  AND ($7 = '' OR resource_id ILIKE '%' || $7 || '%')`

// AuditRow mirrors the projected columns we return in the JSON response.
type AuditRow struct {
	ID           int64          `json:"id"`
	Action       string         `json:"action"`
	ResourceType *string        `json:"resourceType,omitempty"`
	ResourceID   *string        `json:"resourceId,omitempty"`
	ActorType    string         `json:"actorType"`
	ActorLabel   *string        `json:"actorLabel,omitempty"`
	UserID       *string        `json:"userId,omitempty"`
	IP           *string        `json:"ip,omitempty"`
	UserAgent    *string        `json:"userAgent,omitempty"`
	Metadata     map[string]any `json:"metadata"`
	At           time.Time      `json:"at"`
	// pii-redaction (Compliance, P0): dotted JSONPaths of fields the
	// redactor pulled from metadata at write time. The frontend renders
	// a "contains redacted fields" badge when this is non-empty. The
	// path strings are intentionally non-sensitive — they are the
	// names of redacted fields, not the values.
	RedactedFields []string `json:"redactedFields,omitempty"`
	// HasEncryptedMetadata is true when the row carries a non-NULL
	// metadata_encrypted side-blob. Gates the "Reveal PII" button
	// (which also requires the audit:read_pii scope server-side).
	HasEncryptedMetadata bool `json:"hasEncryptedMetadata,omitempty"`
	// retention-trail-archive (Compliance, P1): per-row legal hold and
	// retention override. Drives the "On hold" badge + the override
	// editor in AuditEventSlideover. Mutated through PATCH
	// /api/v1/audit/{id}/retention-override.
	LegalHold             bool `json:"legalHold,omitempty"`
	RetentionOverrideDays *int `json:"retentionOverrideDays,omitempty"`
	// aivs-bundles (Compliance, P2): session_id grouped agent events.
	// When non-empty AND actorType=='agent' the UI surfaces the
	// "Download AIVS bundle" button in the slideover.
	SessionID string `json:"sessionId,omitempty"`
}

// List GET /api/v1/audit?actor_type=&actor_label=&action=&resource_type=&resource_id=&since=&until=&limit=&cursor=
//
// Refined Audit PR 1: gains a `resource_id` filter for the common
// auditor question "what happened to <this id>?". The Go ILIKE on
// resource_id stays cheap because tenant scope + the id index keep
// the candidate set small per query.
func (h *AuditHandlers) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	q := r.URL.Query()
	limit := 50
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	var cursor int64
	if v := q.Get("cursor"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			cursor = n
		}
	}
	actorType := q.Get("actor_type")
	actorLabel := q.Get("actor_label")
	action := strings.TrimSpace(q.Get("action"))
	resourceType := strings.TrimSpace(q.Get("resource_type"))
	resourceID := strings.TrimSpace(q.Get("resource_id"))
	var since *time.Time
	if raw := strings.TrimSpace(q.Get("since")); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			parsed, err = time.Parse(time.RFC3339Nano, raw)
		}
		if err != nil {
			writeJSONErr(w, http.StatusBadRequest, "bad_since", "since must be an RFC3339 timestamp")
			return
		}
		since = &parsed
	}
	var until *time.Time
	if raw := strings.TrimSpace(q.Get("until")); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			parsed, err = time.Parse(time.RFC3339Nano, raw)
		}
		if err != nil {
			writeJSONErr(w, http.StatusBadRequest, "bad_until", "until must be an RFC3339 timestamp")
			return
		}
		until = &parsed
	}

	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	const sql = `
SELECT id, action, resource_type, resource_id,
       actor_type, actor_label, user_id::text,
       host(ip), user_agent, metadata, at,
       COALESCE(redacted_field_hashes, '{}'::jsonb),
       (metadata_encrypted IS NOT NULL),
       COALESCE(legal_hold, false),
       retention_override_days,
       COALESCE(session_id, '')
FROM audit_log
WHERE tenant_id = $1::uuid
  AND ($2 = '' OR actor_type  = $2)
  AND ($3 = '' OR actor_label = $3)
  AND ($4 = 0  OR id < $4)
  AND ($5 = '' OR action ILIKE '%' || $5 || '%')
  -- Hide the meta-audit read-trail (action 'audit.read.*') from the default
  -- feed. Every read of this endpoint records an audit.read.list row, so the
  -- Recent-activity bell (GET /api/v1/audit?limit=20, no action filter) would
  -- otherwise show nothing but its own self-referential polls. Compliance
  -- callers opt back in explicitly via ?action=audit.read.
  AND ($5 <> '' OR ` + defaultAuditReadExclusionSQL + `)
  AND ($6 = '' OR resource_type = $6)
  AND ($7::timestamptz IS NULL OR at >= $7::timestamptz)
  AND ($8::timestamptz IS NULL OR at < $8::timestamptz)
  AND ($10 = '' OR resource_id ILIKE '%' || $10 || '%')
ORDER BY id DESC
LIMIT $9`
	// Fetch one row beyond the caller-visible page. A full page alone does not
	// prove that another page exists; the look-ahead row does.
	rows, err := tx.Query(r.Context(), sql, t.ID, actorType, actorLabel, cursor, action, resourceType, since, until, limit+1, resourceID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer rows.Close()

	out := []AuditRow{}
	for rows.Next() {
		var ar AuditRow
		var meta map[string]any
		var hashes map[string]any
		var hasEnc bool
		var legalHold bool
		var overrideDays *int
		var sessionID string
		if err := rows.Scan(&ar.ID, &ar.Action, &ar.ResourceType, &ar.ResourceID,
			&ar.ActorType, &ar.ActorLabel, &ar.UserID,
			&ar.IP, &ar.UserAgent, &meta, &ar.At,
			&hashes, &hasEnc, &legalHold, &overrideDays, &sessionID); err != nil {
			httperror.WriteInternal(w, h.Logger, err, r.Context())
			return
		}
		if meta == nil {
			meta = map[string]any{}
		}
		ar.Metadata = meta
		ar.HasEncryptedMetadata = hasEnc
		ar.LegalHold = legalHold
		ar.RetentionOverrideDays = overrideDays
		ar.SessionID = sessionID
		// Hashes keys ARE the redacted path names (values are SHA-256
		// hex of the original — never returned to the wire). Expose
		// only the keys so the frontend can render the badge.
		if len(hashes) > 0 {
			paths := make([]string, 0, len(hashes))
			for k := range hashes {
				paths = append(paths, k)
			}
			ar.RedactedFields = paths
		}
		out = append(out, ar)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	var nextCursor string
	out, nextCursor = finalizeAuditListPage(out, limit)
	middleware.RowCounterFromContext(r.Context()).Store(int64(len(out)))

	resp := map[string]any{"rows": out}
	if nextCursor != "" {
		resp["nextCursor"] = nextCursor
	}
	writeJSON(w, http.StatusOK, resp)
}

// finalizeAuditListPage removes the look-ahead row and derives a cursor only
// when that extra row proved there is another page. An exactly full terminal
// page intentionally has no cursor.
func finalizeAuditListPage(rows []AuditRow, limit int) ([]AuditRow, string) {
	if limit <= 0 || len(rows) <= limit {
		return rows, ""
	}
	rows = rows[:limit]
	return rows, strconv.FormatInt(rows[len(rows)-1].ID, 10)
}

// Export streams the audit log as CSV given the same filter set as
// List. Caps at MaxExportRows (default 100k) so a misclicked
// "download" doesn't try to materialize a multi-million-row table.
// Auditors typically scope by date range + actor; the 100k cap is
// comfortably above what any single review window asks for.
//
// GET /api/v1/audit/export?actor_type=&actor_label=&action=&resource_type=&since=&until=&limit=
const MaxExportRows = 100_000

func (h *AuditHandlers) Export(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	q := r.URL.Query()
	limit := MaxExportRows
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= MaxExportRows {
			limit = n
		}
	}
	actorType := q.Get("actor_type")
	actorLabel := q.Get("actor_label")
	action := strings.TrimSpace(q.Get("action"))
	resourceType := strings.TrimSpace(q.Get("resource_type"))
	// Refined Audit PR 1: export honours the same resource_id filter
	// as List so the CSV the operator downloads matches what they see.
	resourceID := strings.TrimSpace(q.Get("resource_id"))
	var since *time.Time
	if raw := strings.TrimSpace(q.Get("since")); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			parsed, err = time.Parse(time.RFC3339Nano, raw)
		}
		if err != nil {
			httperror.Write(w, http.StatusBadRequest, "bad_since", "since must be an RFC3339 timestamp")
			return
		}
		since = &parsed
	}
	var until *time.Time
	if raw := strings.TrimSpace(q.Get("until")); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			parsed, err = time.Parse(time.RFC3339Nano, raw)
		}
		if err != nil {
			httperror.Write(w, http.StatusBadRequest, "bad_until", "until must be an RFC3339 timestamp")
			return
		}
		until = &parsed
	}

	// signed-export-replay: opt-in signed manifest sidecar. Server-side
	// the audit_export_manifests row is recorded after the CSV stream
	// completes; clients fetch the manifest body via
	// GET /api/v1/audit/export/manifests.
	includeManifest := strings.EqualFold(q.Get("include_manifest"), "true") && h.ManifestWriter != nil

	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// When include_manifest is on we also project row_hash + prev_hash
	// so the manifest carries the Merkle-chain bytes verifiers need.
	exportSQL := `
SELECT id, action, COALESCE(resource_type,''), COALESCE(resource_id,''),
       actor_type, COALESCE(actor_label,''), COALESCE(user_id::text,''),
       COALESCE(host(ip),''), COALESCE(user_agent,''), metadata, at,
       COALESCE(row_hash, ''::bytea), COALESCE(prev_hash, ''::bytea)
FROM audit_log
WHERE tenant_id = $1::uuid
  AND ($2 = '' OR actor_type  = $2)
  AND ($3 = '' OR actor_label = $3)
  AND ($4 = '' OR action ILIKE '%' || $4 || '%')
  AND ($5 = '' OR resource_type = $5)
  AND ($6::timestamptz IS NULL OR at >= $6::timestamptz)
  AND ($7::timestamptz IS NULL OR at < $7::timestamptz)
  AND ($9 = '' OR resource_id ILIKE '%' || $9 || '%')
ORDER BY id DESC
LIMIT $8`
	rows, err := tx.Query(r.Context(), exportSQL, t.ID, actorType, actorLabel,
		action, resourceType, since, until, limit, resourceID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer rows.Close()

	var manifestRows []auditsink.ManifestRow
	if includeManifest {
		manifestRows = make([]auditsink.ManifestRow, 0, limit)
	}

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		`attachment; filename="postwave-audit-`+time.Now().UTC().Format("20060102-150405")+`.csv"`)
	w.Header().Set("X-Postwave-Audit-Export-Limit", strconv.Itoa(limit))
	if includeManifest {
		w.Header().Set("X-Postwave-Audit-Export-Manifest", "true")
	}
	w.WriteHeader(http.StatusOK)

	// CSV header row. Order matches the SELECT for stability.
	_, _ = w.Write([]byte("id,at,action,resource_type,resource_id,actor_type,actor_label,user_id,ip,user_agent,metadata_json\n"))
	for rows.Next() {
		var (
			id                                                                   int64
			action, resType, resID, actorType, actorLabel, userID, ip, userAgent string
			metadata                                                             map[string]any
			at                                                                   time.Time
			rowHash, prevHash                                                    []byte
		)
		if err := rows.Scan(&id, &action, &resType, &resID, &actorType,
			&actorLabel, &userID, &ip, &userAgent, &metadata, &at,
			&rowHash, &prevHash); err != nil {
			// Stop streaming; the partial output is intentional —
			// reverse-proxy will close. Auditors notice truncated
			// CSV more reliably than a 500.
			return
		}
		metaJSON, _ := json.Marshal(metadata)
		if _, err := w.Write([]byte(csvJoin(
			strconv.FormatInt(id, 10),
			at.UTC().Format(time.RFC3339Nano),
			action, resType, resID, actorType, actorLabel,
			userID, ip, userAgent, string(metaJSON),
		) + "\n")); err != nil {
			return
		}
		middleware.RowCounterFromContext(r.Context()).Add(1)
		if includeManifest {
			manifestRows = append(manifestRows, auditsink.ManifestRow{
				ID:       id,
				At:       at.UTC().Format(time.RFC3339Nano),
				RowHash:  hex.EncodeToString(rowHash),
				PrevHash: hex.EncodeToString(prevHash),
			})
		}
	}

	if includeManifest && len(manifestRows) > 0 {
		filters := map[string]any{
			"actor_type":    actorType,
			"actor_label":   actorLabel,
			"action":        action,
			"resource_type": resourceType,
			"resource_id":   resourceID,
		}
		if since != nil {
			filters["since"] = since.UTC().Format(time.RFC3339Nano)
		}
		exportedBy := ""
		if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
			exportedBy = u.Email
		}
		_, _ = h.ManifestWriter.WriteManifest(r.Context(), auditsink.ExportManifestInput{
			TenantID:   t.ID,
			Filters:    filters,
			Rows:       manifestRows,
			ExportedBy: exportedBy,
		})
	}
}

// ListExportManifests GET /api/v1/audit/export/manifests
//
// signed-export-replay: returns the tenant's signed export manifests
// newest-first. The audit UI surfaces these in an "Export history"
// panel so an auditor can re-download the JSON sidecar for a specific
// bundle without re-running the original SQL.
func (h *AuditHandlers) ListExportManifests(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT export_id, filters_canonical,
       from_audit_id, to_audit_id, row_count,
       tree_size_at_export,
       COALESCE(root_hash, ''::bytea),
       COALESCE(signature, ''::bytea),
       COALESCE(signature_kid, ''),
       COALESCE(exported_by, ''),
       created_at
  FROM audit_export_manifests
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC
 LIMIT $2`, t.ID, limit)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	type manifestSummary struct {
		ExportID         string         `json:"export_id"`
		FiltersCanonical map[string]any `json:"filters_canonical"`
		FromAuditID      int64          `json:"from_audit_id"`
		ToAuditID        int64          `json:"to_audit_id"`
		RowCount         int64          `json:"row_count"`
		TreeSize         int64          `json:"tree_size_at_export"`
		RootHashHex      string         `json:"root_hash_hex"`
		SignatureHex     string         `json:"signature_hex,omitempty"`
		SignatureKid     string         `json:"signature_kid,omitempty"`
		ExportedBy       string         `json:"exported_by,omitempty"`
		CreatedAt        time.Time      `json:"created_at"`
	}
	out := []manifestSummary{}
	for rows.Next() {
		var (
			s        manifestSummary
			rootHash []byte
			sig      []byte
			filters  []byte
		)
		if err := rows.Scan(&s.ExportID, &filters,
			&s.FromAuditID, &s.ToAuditID, &s.RowCount,
			&s.TreeSize, &rootHash, &sig, &s.SignatureKid,
			&s.ExportedBy, &s.CreatedAt); err != nil {
			httperror.WriteInternal(w, h.Logger, err, r.Context())
			return
		}
		_ = json.Unmarshal(filters, &s.FiltersCanonical)
		if len(rootHash) > 0 {
			s.RootHashHex = hex.EncodeToString(rootHash)
		}
		if len(sig) > 0 {
			s.SignatureHex = hex.EncodeToString(sig)
		}
		out = append(out, s)
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"manifests": out})
}

// csvJoin neutralizes spreadsheet formulas, escapes each field per RFC 4180,
// and joins with commas. Audit exports routinely contain customer-controlled
// labels and metadata; opening one in a spreadsheet must never execute a cell
// as a formula.
func csvJoin(fields ...string) string {
	out := make([]byte, 0, 256)
	for i, f := range fields {
		if i > 0 {
			out = append(out, ',')
		}
		f = spreadsheetSafeCSVField(f)
		// Quote when the field contains comma, quote, or newline.
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

func spreadsheetSafeCSVField(field string) string {
	trimmed := strings.TrimLeft(field, " \t\r\n")
	if trimmed == "" {
		return field
	}
	switch trimmed[0] {
	case '=', '+', '-', '@':
		return "'" + field
	default:
		return field
	}
}

// AuditStatsResponse is the wire shape for GET /api/v1/audit/stats.
// Refined Audit PR 1 — drives the insights row at the top of the
// audit page. All three sections share the same filter set as List
// so the stats always reflect the operator's current view.
type AuditStatsResponse struct {
	Window      string             `json:"window,omitempty"`
	TotalEvents int64              `json:"totalEvents"`
	ByActorType []AuditCount       `json:"byActorType"`
	TopActions  []AuditCount       `json:"topActions"`
	Daily       []AuditDailyBucket `json:"daily"`
}

// AuditCount is a generic (label, count) pair — used by both actor
// distribution and top-actions list.
type AuditCount struct {
	Label string `json:"label"`
	Count int64  `json:"count"`
}

// AuditDailyBucket is one day's row in the events-per-day sparkline.
type AuditDailyBucket struct {
	Date  string `json:"date"`
	Count int64  `json:"count"`
}

// Stats GET /api/v1/audit/stats?actor_type=&actor_label=&action=&resource_type=&resource_id=&since=
//
// Three parallel COUNT queries (actor mix, top actions, per-day
// series). Sharing the WHERE clause with List means a filter change
// recomputes consistent numbers across the page. No cursor — stats
// always reflect the whole filtered window.
func (h *AuditHandlers) Stats(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	q := r.URL.Query()
	actorType := q.Get("actor_type")
	actorLabel := q.Get("actor_label")
	action := strings.TrimSpace(q.Get("action"))
	resourceType := strings.TrimSpace(q.Get("resource_type"))
	resourceID := strings.TrimSpace(q.Get("resource_id"))
	var since *time.Time
	if raw := strings.TrimSpace(q.Get("since")); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			parsed, err = time.Parse(time.RFC3339Nano, raw)
		}
		if err != nil {
			httperror.Write(w, http.StatusBadRequest, "bad_since", "since must be an RFC3339 timestamp")
			return
		}
		since = &parsed
	}

	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	args := []any{t.ID, actorType, actorLabel, action, resourceType, since, resourceID}

	resp := AuditStatsResponse{
		ByActorType: []AuditCount{},
		TopActions:  []AuditCount{},
		Daily:       []AuditDailyBucket{},
	}

	// Total — for the headline number above the cards.
	if err := tx.QueryRow(r.Context(),
		`SELECT COUNT(*) FROM audit_log`+auditAggregateWhere, args...,
	).Scan(&resp.TotalEvents); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	// Actor mix — counts grouped by actor_type. The set is small (4-5
	// values: user / api_key / agent / system / unknown) so no LIMIT.
	rows, err := tx.Query(r.Context(),
		`SELECT actor_type, COUNT(*)::bigint
		   FROM audit_log`+auditAggregateWhere+`
		  GROUP BY actor_type
		  ORDER BY 2 DESC`, args...)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	for rows.Next() {
		var c AuditCount
		if err := rows.Scan(&c.Label, &c.Count); err == nil {
			resp.ByActorType = append(resp.ByActorType, c)
		}
	}
	rows.Close()

	// Top actions — limit 10. Surfaces "subscriber.delete spiked"
	// without an operator needing to scroll.
	rows, err = tx.Query(r.Context(),
		`SELECT action, COUNT(*)::bigint
		   FROM audit_log`+auditAggregateWhere+`
		  GROUP BY action
		  ORDER BY 2 DESC
		  LIMIT 10`, args...)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	for rows.Next() {
		var c AuditCount
		if err := rows.Scan(&c.Label, &c.Count); err == nil {
			resp.TopActions = append(resp.TopActions, c)
		}
	}
	rows.Close()

	// Daily series — at most ~365 buckets. Drives the small
	// sparkline. We bucket by UTC date for consistency across
	// timezones (the dashboard is multi-region and a calendar-local
	// bucket would be ambiguous).
	rows, err = tx.Query(r.Context(),
		`SELECT to_char(date_trunc('day', at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
		         COUNT(*)::bigint
		   FROM audit_log`+auditAggregateWhere+`
		  GROUP BY day
		  ORDER BY day`, args...)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	for rows.Next() {
		var b AuditDailyBucket
		if err := rows.Scan(&b.Date, &b.Count); err == nil {
			resp.Daily = append(resp.Daily, b)
		}
	}
	rows.Close()

	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	middleware.RowCounterFromContext(r.Context()).Store(resp.TotalEvents)
	writeJSON(w, http.StatusOK, resp)
}

// AIVSBundle GET /api/v1/audit/ai-session/{session_id}/aivs-bundle
//
// aivs-bundles (Compliance, P2). Produces a downloadable .tar.gz proof
// bundle for an AI agent session — manifest.json + events.jsonl +
// chain.json + a stdlib-only verify.py. Tenant-scoped via RLS; the
// bundle includes only actor_type='agent' rows.
//
// EU AI Act Article 50 transparency support: the manifest carries the
// generator, version, and Ed25519 public key so an inspector can
// re-verify the chain offline. Returns 404 when the session has no
// agent events for this tenant.
func (h *AuditHandlers) AIVSBundle(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	sessionID := strings.TrimSpace(chi.URLParam(r, "session_id"))
	if sessionID == "" {
		writeJSONErr(w, http.StatusBadRequest, "bad_session_id", "session_id is required")
		return
	}
	if len(sessionID) > 128 {
		writeJSONErr(w, http.StatusBadRequest, "bad_session_id", "session_id too long")
		return
	}
	body, err := audit.BuildBundle(r.Context(), h.Pool, t.ID, sessionID)
	if err != nil {
		if errors.Is(err, audit.ErrNoSession) {
			writeJSONErr(w, http.StatusNotFound, "no_agent_events",
				"no agent events found for this session_id")
			return
		}
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	filename := "postwave-aivs-" + sessionFilenamePart(sessionID) + "-" +
		time.Now().UTC().Format("20060102-150405") + ".tar.gz"
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("X-Postwave-AIVS-Version", audit.AIVSVersion)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// sessionFilenamePart strips characters that would break the
// Content-Disposition filename — leaves alphanumerics, dash, underscore.
func sessionFilenamePart(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	out := b.String()
	if len(out) > 48 {
		out = out[:48]
	}
	return out
}

// SessionReplay GET /api/v1/audit/{id}/session-replay
//
// session-replay-deeplink (audit-2026 UX, P1). Returns the replay URL +
// scoped time window for the audit row, or a structured "not available"
// payload when no replay can be linked.
//
// We deliberately return HTTP 200 with {available:false} (instead of
// 404) for the unavailable path so the SPA can render the slideover
// section in a consistent shape; the operator sees "Replay not
// available" inline rather than hitting an error toast.
func (h *AuditHandlers) SessionReplay(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	idStr := chi.URLParam(r, "id")
	auditID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || auditID <= 0 {
		writeJSONErr(w, http.StatusBadRequest, "bad_id", "id must be a positive integer")
		return
	}
	resp, err := audit.SessionReplayLookup(r.Context(), h.Pool, t.ID, auditID)
	if err != nil {
		if errors.Is(err, audit.ErrNotAvailable) {
			writeJSON(w, http.StatusOK, map[string]any{
				"available": false,
				"reason":    "no_replay_for_session",
			})
			return
		}
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func writeJSONErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}
