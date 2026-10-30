// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_extras.go — Refined Audit log PRs 2-4.
//
//   Stream             — SSE live tail of audit_log rows. Operators
//                         flip a toggle and get incremental events
//                         without polling.
//   Saved views        — named filter sets so compliance reviewers
//                         can re-run the same query on a cadence.
//   Retention          — read + update the per-tenant retention
//                         window the trim worker enforces.

package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/sse"
)

// ---------------------------------------------------------------------
// SSE live tail
// ---------------------------------------------------------------------

// Stream GET /api/v1/audit/stream
//
// Server-Sent Events handler. Polls audit_log every 2s for rows newer
// than the last delivered id and writes any new rows as `data:` lines.
// Same admin gate as List + Export.
//
// Why polling-over-SSE rather than LISTEN/NOTIFY: the audit emitter
// runs in N services; wiring NOTIFY across all of them is a separate
// project. Polling on the read side with a tight id cursor stays
// cheap (LIMIT 50 against the (tenant_id, id DESC) index) and keeps
// the wire protocol simple. PR 5 candidate: switch to a NOTIFY
// channel for sub-second delivery.
func (h *AuditHandlers) Stream(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	stream, canFlush := sse.Open(w)
	if !canFlush {
		writeJSONErr(w, http.StatusInternalServerError, "no_flusher", "server lacks streaming")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	// Seed cursor from the highest current id so the operator only
	// sees rows that happen *after* they opened the stream. (A fresh
	// tail with weeks of history would dump everything in one go.)
	var sinceID int64
	if err := h.lookupMaxAuditID(r.Context(), t.ID, &sinceID); err != nil {
		// Non-fatal — start at 0.
		sinceID = 0
	}
	// Initial hello so the client knows the stream is alive.
	if stream.Sendf("event: hello\ndata: {\"sinceId\":%d}\n\n", sinceID) != nil {
		return
	}

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			// Comment frames keep proxies from closing idle connections.
			// A failed write means the client is gone.
			if stream.Sendf(": heartbeat\n\n") != nil {
				return
			}
		case <-ticker.C:
			rows, err := h.fetchNewerAuditRows(r.Context(), t.ID, sinceID)
			if err != nil {
				// Don't terminate the stream on a transient db error —
				// the client will resume on the next tick.
				continue
			}
			for _, row := range rows {
				blob, err := json.Marshal(row)
				if err != nil {
					continue
				}
				_, _ = fmt.Fprintf(stream, "event: audit\ndata: %s\n\n", blob)
				if row.ID > sinceID {
					sinceID = row.ID
				}
			}
			if len(rows) > 0 && stream.Flush() != nil {
				return
			}
		}
	}
}

func (h *AuditHandlers) lookupMaxAuditID(ctx context.Context, tenantID string, out *int64) error {
	tx, err := db.WithTenant(ctx, h.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return tx.QueryRow(ctx,
		`SELECT COALESCE(MAX(id), 0) FROM audit_log WHERE tenant_id = $1::uuid`,
		tenantID,
	).Scan(out)
}

func (h *AuditHandlers) fetchNewerAuditRows(ctx context.Context, tenantID string, sinceID int64) ([]AuditRow, error) {
	tx, err := db.WithTenant(ctx, h.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id, action, resource_type, resource_id,
       actor_type, actor_label, user_id::text,
       host(ip), user_agent, metadata, at,
       COALESCE(redacted_field_hashes, '{}'::jsonb),
       (metadata_encrypted IS NOT NULL)
  FROM audit_log
 WHERE tenant_id = $1::uuid AND id > $2
 ORDER BY id ASC
 LIMIT 50`, tenantID, sinceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditRow{}
	for rows.Next() {
		var ar AuditRow
		var meta map[string]any
		var hashes map[string]any
		var hasEnc bool
		if err := rows.Scan(&ar.ID, &ar.Action, &ar.ResourceType, &ar.ResourceID,
			&ar.ActorType, &ar.ActorLabel, &ar.UserID,
			&ar.IP, &ar.UserAgent, &meta, &ar.At,
			&hashes, &hasEnc); err != nil {
			return nil, err
		}
		if meta == nil {
			meta = map[string]any{}
		}
		ar.Metadata = meta
		ar.HasEncryptedMetadata = hasEnc
		if len(hashes) > 0 {
			paths := make([]string, 0, len(hashes))
			for k := range hashes {
				paths = append(paths, k)
			}
			ar.RedactedFields = paths
		}
		out = append(out, ar)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------
// Saved views (CRUD)
// ---------------------------------------------------------------------

// AuditSavedView is one named filter set. `Filters` is the JSON blob
// the frontend stores arbitrary keys in; the Go side treats it
// opaquely so adding a new filter doesn't require a backend change.
type AuditSavedView struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Filters     map[string]any `json:"filters"`
	CreatedAt   time.Time      `json:"createdAt"`
	UpdatedAt   time.Time      `json:"updatedAt"`
	CreatedBy   *string        `json:"createdBy,omitempty"`
}

type createSavedViewInput struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Filters     map[string]any `json:"filters"`
}

type updateSavedViewInput struct {
	Name              *string        `json:"name"`
	Description       *string        `json:"description"`
	Filters           map[string]any `json:"filters"`
	ExpectedUpdatedAt string         `json:"expectedUpdatedAt"`
}

const (
	maxAuditSavedViews         = 250
	maxAuditSavedViewNameBytes = 256
	maxAuditSavedViewDescBytes = 2_048
)

func normalizeSavedViewText(value string, maxBytes int, required bool) (string, error) {
	value = strings.TrimSpace(value)
	if required && value == "" {
		return "", fmt.Errorf("value is required")
	}
	if len(value) > maxBytes {
		return "", fmt.Errorf("value exceeds %d UTF-8 bytes", maxBytes)
	}
	if strings.ContainsAny(value, "\x00\r\n") {
		return "", fmt.Errorf("value contains unsupported control characters")
	}
	return value, nil
}

func scanAuditSavedView(row pgx.Row) (AuditSavedView, error) {
	var view AuditSavedView
	var raw []byte
	var createdBy *string
	err := row.Scan(&view.ID, &view.Name, &view.Description, &raw,
		&view.CreatedAt, &view.UpdatedAt, &createdBy)
	if err != nil {
		return AuditSavedView{}, err
	}
	view.CreatedBy = createdBy
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &view.Filters); err != nil {
			return AuditSavedView{}, err
		}
	}
	if view.Filters == nil {
		view.Filters = map[string]any{}
	}
	return view, nil
}

// ListSavedViews GET /api/v1/audit/saved-views.
func (h *AuditHandlers) ListSavedViews(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, name, description, filters, created_at, updated_at, created_by::text
  FROM audit_saved_views
 WHERE tenant_id = $1::uuid
 ORDER BY updated_at DESC`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []AuditSavedView{}
	for rows.Next() {
		var v AuditSavedView
		var raw []byte
		var createdBy *string
		if err := rows.Scan(&v.ID, &v.Name, &v.Description, &raw,
			&v.CreatedAt, &v.UpdatedAt, &createdBy); err != nil {
			httperror.WriteInternal(w, h.Logger, err, r.Context())
			return
		}
		v.CreatedBy = createdBy
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &v.Filters); err != nil {
				httperror.WriteInternal(w, h.Logger, err, r.Context())
				return
			}
		}
		if v.Filters == nil {
			v.Filters = map[string]any{}
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	middleware.RowCounterFromContext(r.Context()).Store(int64(len(out)))
	writeJSON(w, http.StatusOK, map[string]any{"views": out})
}

// CreateSavedView POST /api/v1/audit/saved-views.
func (h *AuditHandlers) CreateSavedView(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in createSavedViewInput
	if err := httpbody.DecodeJSON(w, r, 32<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	name, err := normalizeSavedViewText(in.Name, maxAuditSavedViewNameBytes, true)
	if err != nil {
		writeJSONErr(w, http.StatusBadRequest, "bad_name", err.Error())
		return
	}
	description, err := normalizeSavedViewText(in.Description, maxAuditSavedViewDescBytes, false)
	if err != nil {
		writeJSONErr(w, http.StatusBadRequest, "bad_description", err.Error())
		return
	}
	if in.Filters == nil {
		in.Filters = map[string]any{}
	}
	filtersJSON, err := json.Marshal(in.Filters)
	if err != nil || len(filtersJSON) > 24<<10 {
		writeJSONErr(w, http.StatusBadRequest, "bad_filters", "filters must be a bounded JSON object")
		return
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	// Serialize the per-tenant limit check with all other creates. Without the
	// tenant-row lock, two concurrent "250th" creates could both pass count(*).
	if _, err := tx.Exec(r.Context(),
		`SELECT 1 FROM tenants WHERE id = $1::uuid FOR UPDATE`, t.ID); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	var count int
	if err := tx.QueryRow(r.Context(),
		`SELECT count(*) FROM audit_saved_views WHERE tenant_id = $1::uuid`, t.ID,
	).Scan(&count); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if count >= maxAuditSavedViews {
		writeJSONErr(w, http.StatusConflict, "saved_view_limit",
			"remove a saved view before creating another (maximum 250)")
		return
	}
	createdBy := ""
	if user, ok := middleware.UserFromContext(r.Context()); ok && user != nil {
		if _, parseErr := uuid.Parse(user.ID); parseErr == nil {
			createdBy = user.ID
		}
	}
	view, err := scanAuditSavedView(tx.QueryRow(r.Context(), `
INSERT INTO audit_saved_views (tenant_id, name, description, filters, created_by)
VALUES ($1::uuid, $2, $3, $4::jsonb, NULLIF($5, '')::uuid)
RETURNING id::text, name, description, filters, created_at, updated_at, created_by::text`,
		t.ID, name, description, filtersJSON, createdBy,
	))
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeJSONErr(w, http.StatusConflict, "saved_view_name_conflict",
				"a saved view with this name already exists")
			return
		}
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r),
		"audit.saved_view.created", "audit_saved_view", view.ID,
		map[string]any{"name": view.Name}); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, view)
}

// UpdateSavedView PATCH /api/v1/audit/saved-views/{id}.
func (h *AuditHandlers) UpdateSavedView(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if _, err := uuid.Parse(id); err != nil {
		writeJSONErr(w, http.StatusBadRequest, "bad_id", "saved-view id must be a UUID")
		return
	}
	var in updateSavedViewInput
	if err := httpbody.DecodeJSON(w, r, 32<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if in.Name == nil && in.Description == nil && in.Filters == nil {
		writeJSONErr(w, http.StatusBadRequest, "empty_patch", "provide name, description, or filters")
		return
	}
	var normalizedName *string
	if in.Name != nil {
		name, err := normalizeSavedViewText(*in.Name, maxAuditSavedViewNameBytes, true)
		if err != nil {
			writeJSONErr(w, http.StatusBadRequest, "bad_name", err.Error())
			return
		}
		normalizedName = &name
	}
	var normalizedDescription *string
	if in.Description != nil {
		description, err := normalizeSavedViewText(*in.Description, maxAuditSavedViewDescBytes, false)
		if err != nil {
			writeJSONErr(w, http.StatusBadRequest, "bad_description", err.Error())
			return
		}
		normalizedDescription = &description
	}
	var expectedUpdatedAt *time.Time
	if strings.TrimSpace(in.ExpectedUpdatedAt) != "" {
		parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(in.ExpectedUpdatedAt))
		if err != nil {
			writeJSONErr(w, http.StatusBadRequest, "bad_expected_updated_at",
				"expectedUpdatedAt must be an RFC3339 timestamp")
			return
		}
		expectedUpdatedAt = &parsed
	}
	var filtersJSON []byte
	if in.Filters != nil {
		var err error
		filtersJSON, err = json.Marshal(in.Filters)
		if err != nil || len(filtersJSON) > 24<<10 {
			writeJSONErr(w, http.StatusBadRequest, "bad_filters", "filters must be a bounded JSON object")
			return
		}
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	current, err := scanAuditSavedView(tx.QueryRow(r.Context(), `
SELECT id::text, name, description, filters, created_at, updated_at, created_by::text
  FROM audit_saved_views
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, t.ID, id))
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSONErr(w, http.StatusNotFound, "not_found", "saved view not found")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if expectedUpdatedAt != nil && !current.UpdatedAt.Equal(*expectedUpdatedAt) {
		writeJSONErr(w, http.StatusConflict, "saved_view_changed",
			"the saved view changed after editing began; refresh before saving")
		return
	}
	name := current.Name
	if normalizedName != nil {
		name = *normalizedName
	}
	description := current.Description
	if normalizedDescription != nil {
		description = *normalizedDescription
	}
	// filtersJSON already carries the caller's filters when they were supplied
	// (validated above); otherwise keep the stored ones.
	if in.Filters == nil {
		filtersJSON, err = json.Marshal(current.Filters)
		if err != nil {
			httperror.WriteInternal(w, h.Logger, err, r.Context())
			return
		}
	}
	updated, err := scanAuditSavedView(tx.QueryRow(r.Context(), `
UPDATE audit_saved_views
   SET name = $3, description = $4, filters = $5::jsonb, updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING id::text, name, description, filters, created_at, updated_at, created_by::text`,
		t.ID, id, name, description, filtersJSON))
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeJSONErr(w, http.StatusConflict, "saved_view_name_conflict",
				"a saved view with this name already exists")
			return
		}
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r),
		"audit.saved_view.updated", "audit_saved_view", updated.ID,
		map[string]any{
			"previous_name":       current.Name,
			"new_name":            updated.Name,
			"previous_updated_at": current.UpdatedAt.UTC().Format(time.RFC3339Nano),
		}); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// DeleteSavedView DELETE /api/v1/audit/saved-views/{id}.
//
// Returns 404 when the id doesn't exist for this tenant. Earlier
// revisions ignored the rowcount and always returned 200 — the
// frontend then optimistically cleared the dropdown, leaving the
// operator believing they had deleted a view that was either gone
// already or never belonged to them. Surfacing the 404 lets the
// frontend keep the dropdown selection until the delete actually
// commits.
func (h *AuditHandlers) DeleteSavedView(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if _, err := uuid.Parse(id); err != nil {
		writeJSONErr(w, http.StatusBadRequest, "bad_id", "saved-view id must be a UUID")
		return
	}
	var expectedUpdatedAt *time.Time
	if raw := strings.TrimSpace(r.URL.Query().Get("expected_updated_at")); raw != "" {
		parsed, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			writeJSONErr(w, http.StatusBadRequest, "bad_expected_updated_at",
				"expected_updated_at must be an RFC3339 timestamp")
			return
		}
		expectedUpdatedAt = &parsed
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	current, err := scanAuditSavedView(tx.QueryRow(r.Context(), `
SELECT id::text, name, description, filters, created_at, updated_at, created_by::text
  FROM audit_saved_views
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, t.ID, id))
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSONErr(w, http.StatusNotFound, "not_found", "saved view not found")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if expectedUpdatedAt != nil && !current.UpdatedAt.Equal(*expectedUpdatedAt) {
		writeJSONErr(w, http.StatusConflict, "saved_view_changed",
			"the saved view changed after deletion was opened; refresh before deleting")
		return
	}
	if _, err := tx.Exec(r.Context(),
		`DELETE FROM audit_saved_views WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		t.ID, id); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r),
		"audit.saved_view.deleted", "audit_saved_view", current.ID,
		map[string]any{
			"name":                current.Name,
			"previous_updated_at": current.UpdatedAt.UTC().Format(time.RFC3339Nano),
		}); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------

// GetRetention GET /api/v1/audit/retention.
//
// Returns the per-tenant `audit_retention_days` override (null when
// the tenant is using the deployment default). The trim worker reads
// the column on each tick — no separate worker config needed.
func (h *AuditHandlers) GetRetention(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var days *int
	if err := tx.QueryRow(r.Context(),
		`SELECT audit_retention_days FROM tenants WHERE id = $1::uuid`,
		t.ID,
	).Scan(&days); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	middleware.RowCounterFromContext(r.Context()).Store(1)
	writeJSON(w, http.StatusOK, map[string]any{
		"retentionDays": days,
		"defaultDays":   90,
	})
}

type retentionReq struct {
	RetentionDays *int `json:"retentionDays"`
}

// SetRetention PUT /api/v1/audit/retention.
//
// Accepts an integer in [1, 3650] or null (use deployment default).
// Auditors typically pick 90 (standard), 365 (SOC 2), or 2555 (7yr
// HIPAA). We clamp to 10 years as a sanity cap.
func (h *AuditHandlers) SetRetention(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in retentionReq
	if err := httpbody.DecodeJSON(w, r, 1<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if in.RetentionDays != nil {
		d := *in.RetentionDays
		if d < 1 || d > 3650 {
			writeJSONErr(w, http.StatusBadRequest, "bad_days",
				"retentionDays must be 1..3650 (10 years) or null")
			return
		}
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(),
		`UPDATE tenants SET audit_retention_days = $2 WHERE id = $1::uuid`,
		t.ID, in.RetentionDays,
	); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	_ = tx.Commit(r.Context())
	out := map[string]any{"ok": true}
	if in.RetentionDays != nil {
		out["retentionDays"] = *in.RetentionDays
	}
	writeJSON(w, http.StatusOK, out)
}

// Reference imports kept alive if the build mode strictly checks.
var (
	_ = strconv.Itoa
)

// ---------------------------------------------------------------------
// Retention activity + per-row retention overrides
// (retention-trail-archive — Compliance, P1)
// ---------------------------------------------------------------------

// AuditPurgeEvent is the wire shape returned by the retention-activity
// endpoint. Mirrors the audit_retention_purge_events view.
type AuditPurgeEvent struct {
	ID             int64     `json:"id"`
	TenantID       string    `json:"tenant_id"`
	Action         string    `json:"action"`
	DeletedIDRange string    `json:"deleted_id_range"`
	DeletedCount   int       `json:"deleted_count"`
	RetentionDays  int       `json:"retention_days"`
	BeforeRootHash string    `json:"before_root_hash"`
	At             time.Time `json:"at"`
}

// RetentionActivityResponse is the envelope for ListRetentionActivity.
type RetentionActivityResponse struct {
	Events             []AuditPurgeEvent `json:"events"`
	Count              int               `json:"count"`
	TotalPurgedLast30d int               `json:"total_purged_last_30d"`
}

// ListRetentionActivity GET /api/v1/audit/retention-activity?limit=&since=
//
// Returns the most-recent audit.retention.purge events for the
// calling tenant. Backs the Compliance > Retention activity tab.
func (h *AuditHandlers) ListRetentionActivity(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	q := r.URL.Query()
	limit := 100
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
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
SELECT id, tenant_id::text, action,
       COALESCE(deleted_id_range, ''),
       COALESCE(deleted_count, 0),
       COALESCE(retention_days, 0),
       COALESCE(before_root_hash, ''),
       at
  FROM audit_retention_purge_events
 LIMIT $1`, limit)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	events := []AuditPurgeEvent{}
	for rows.Next() {
		var ev AuditPurgeEvent
		if err := rows.Scan(&ev.ID, &ev.TenantID, &ev.Action,
			&ev.DeletedIDRange, &ev.DeletedCount, &ev.RetentionDays,
			&ev.BeforeRootHash, &ev.At); err != nil {
			httperror.WriteInternal(w, h.Logger, err, r.Context())
			return
		}
		events = append(events, ev)
	}
	// Roll-up stat: total rows purged in the last 30d. Cheap aggregate
	// over the same view.
	var total30d int
	_ = tx.QueryRow(r.Context(), `
SELECT COALESCE(SUM(deleted_count), 0)::int
  FROM audit_retention_purge_events
 WHERE at >= now() - interval '30 days'`).Scan(&total30d)
	writeJSON(w, http.StatusOK, RetentionActivityResponse{
		Events:             events,
		Count:              len(events),
		TotalPurgedLast30d: total30d,
	})
}

// retentionOverrideReq is the body for PATCH /api/v1/audit/{id}/retention-override.
type retentionOverrideReq struct {
	RetentionOverrideDays *int  `json:"retention_override_days"`
	LegalHold             *bool `json:"legal_hold"`
}

// SetRetentionOverride PATCH /api/v1/audit/{id}/retention-override.
//
// Sets retention_override_days and/or legal_hold for a specific
// audit_log row. Tenant-scoped via RLS. At least one field must be
// supplied. Emits a meta-audit row capturing the operator + delta.
func (h *AuditHandlers) SetRetentionOverride(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	idRaw := strings.TrimSpace(chi.URLParam(r, "id"))
	if idRaw == "" {
		writeJSONErr(w, http.StatusBadRequest, "missing_id", "id required")
		return
	}
	id, err := strconv.ParseInt(idRaw, 10, 64)
	if err != nil {
		writeJSONErr(w, http.StatusBadRequest, "invalid_id", "id must be an integer")
		return
	}
	var in retentionOverrideReq
	if err := httpbody.DecodeJSON(w, r, 1<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if in.RetentionOverrideDays == nil && in.LegalHold == nil {
		writeJSONErr(w, http.StatusBadRequest, "no_changes",
			"at least one of retention_override_days or legal_hold must be supplied")
		return
	}
	if in.RetentionOverrideDays != nil {
		d := *in.RetentionOverrideDays
		if d < 1 || d > 3650 {
			writeJSONErr(w, http.StatusBadRequest, "bad_days",
				"retention_override_days must be 1..3650")
			return
		}
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	sets := []string{}
	args := []any{t.ID, id}
	next := 3
	if in.RetentionOverrideDays != nil {
		sets = append(sets, fmt.Sprintf("retention_override_days = $%d", next))
		args = append(args, *in.RetentionOverrideDays)
		next++
	}
	if in.LegalHold != nil {
		sets = append(sets, fmt.Sprintf("legal_hold = $%d", next))
		args = append(args, *in.LegalHold)
	}
	q := fmt.Sprintf(`UPDATE audit_log SET %s
	   WHERE tenant_id = $1::uuid AND id = $2`, strings.Join(sets, ", "))
	tag, err := tx.Exec(r.Context(), q, args...)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		writeJSONErr(w, http.StatusNotFound, "not_found", "audit row not found")
		return
	}
	// Meta-audit: capture who flipped the hold / override.
	meta := map[string]any{"target_audit_id": id}
	if in.RetentionOverrideDays != nil {
		meta["retention_override_days"] = *in.RetentionOverrideDays
	}
	if in.LegalHold != nil {
		meta["legal_hold"] = *in.LegalHold
	}
	actorType, actorLabel := middleware.ActorFromContext(r.Context())
	var userID *string
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil && u.ID != "" {
		v := u.ID
		userID = &v
	}
	_ = db.Audit(r.Context(), tx, db.AuditMeta{
		TenantID:   t.ID,
		UserID:     userID,
		ActorType:  actorType,
		ActorLabel: actorLabel,
	}, "audit.retention.override_set", "audit_log", idRaw, meta)
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":                      id,
		"retention_override_days": in.RetentionOverrideDays,
		"legal_hold":              in.LegalHold,
	})
}

// ---------------------------------------------------------------------
// PII redaction policy + Reveal-PII (pii-redaction — Compliance, P0)
// ---------------------------------------------------------------------

// auditRedactionPolicyDTO is the wire shape for the policy endpoints.
// Field names use camelCase to match the dashboard's other audit types.
type auditRedactionPolicyDTO struct {
	DefaultRedactedFields []string     `json:"defaultRedactedFields"`
	JSONPathRules         []audit.Rule `json:"jsonpathRules"`
	UpdatedAt             time.Time    `json:"updatedAt"`
}

// GetRedactionPolicy GET /api/v1/audit/redaction-policies.
//
// Returns the tenant's effective redaction policy (default-deny field
// list + JSONPath rules). Settings > Compliance reads this to render
// the rule editor; the rule editor itself is a future PR (this PR ships
// the data path + Reveal-PII).
func (h *AuditHandlers) GetRedactionPolicy(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var (
		defaultsRaw string
		rulesRaw    []byte
		updatedAt   time.Time
	)
	row := tx.QueryRow(r.Context(), `
SELECT default_redacted_fields, jsonpath_rules, updated_at
  FROM audit_redaction_policies
 WHERE tenant_id = $1::uuid`, t.ID)
	if err := row.Scan(&defaultsRaw, &rulesRaw, &updatedAt); err != nil {
		// No row yet — return the floor + empty rules so the editor
		// still has something to render. The first save inserts.
		writeJSON(w, http.StatusOK, auditRedactionPolicyDTO{
			DefaultRedactedFields: audit.DefaultRedactedFields,
			JSONPathRules:         []audit.Rule{},
			UpdatedAt:             time.Time{},
		})
		return
	}
	defaults := splitCSV(defaultsRaw)
	rules := []audit.Rule{}
	if len(rulesRaw) > 0 {
		_ = json.Unmarshal(rulesRaw, &rules)
	}
	// The initialiser above is not enough: unmarshalling a stored JSON `null`
	// over a non-nil slice sets it back to nil, so a policy saved with no rules
	// answered {"jsonpathRules": null}.
	if rules == nil {
		rules = []audit.Rule{}
	}
	writeJSON(w, http.StatusOK, auditRedactionPolicyDTO{
		DefaultRedactedFields: defaults,
		JSONPathRules:         rules,
		UpdatedAt:             updatedAt,
	})
}

// PutRedactionPolicy PUT /api/v1/audit/redaction-policies.
//
// Upserts the tenant's redaction policy. The default-deny floor is
// enforced server-side — a caller cannot drop the built-in sensitive
// field list (password, token, etc.) even by submitting an empty
// defaultRedactedFields. Emits an audit.redaction_policy_update event
// so the change is itself auditable.
func (h *AuditHandlers) PutRedactionPolicy(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in auditRedactionPolicyDTO
	if err := httpbody.DecodeJSON(w, r, 64<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	// Validate every rule shape before we touch the database.
	for i, rule := range in.JSONPathRules {
		if strings.TrimSpace(rule.Path) == "" {
			writeJSONErr(w, http.StatusBadRequest, "bad_rule",
				fmt.Sprintf("rule %d: path is required", i))
			return
		}
		switch rule.Action {
		case audit.ActionMask, audit.ActionEncrypt, audit.ActionHash:
		default:
			writeJSONErr(w, http.StatusBadRequest, "bad_rule",
				fmt.Sprintf("rule %d: action must be mask|encrypt|hash", i))
			return
		}
	}
	// Enforce the floor: union with DefaultRedactedFields so an
	// operator can never accidentally weaken the protection.
	combined := append([]string{}, in.DefaultRedactedFields...)
	combined = append(combined, audit.DefaultRedactedFields...)
	floor := dedupeLowerCSV(combined)
	rulesJSON, _ := json.Marshal(in.JSONPathRules)
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(), `
INSERT INTO audit_redaction_policies (tenant_id, default_redacted_fields, jsonpath_rules, updated_at)
VALUES ($1::uuid, $2, $3::jsonb, now())
ON CONFLICT (tenant_id) DO UPDATE
   SET default_redacted_fields = EXCLUDED.default_redacted_fields,
       jsonpath_rules          = EXCLUDED.jsonpath_rules,
       updated_at              = now()`,
		t.ID, floor, rulesJSON,
	); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	// Meta-audit: who changed the policy + new rule count.
	actorType, actorLabel := middleware.ActorFromContext(r.Context())
	var userID *string
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil && u.ID != "" {
		v := u.ID
		userID = &v
	}
	_ = db.Audit(r.Context(), tx, db.AuditMeta{
		TenantID:   t.ID,
		UserID:     userID,
		ActorType:  actorType,
		ActorLabel: actorLabel,
	}, "audit.redaction_policy_update", "audit_redaction_policy", t.ID, map[string]any{
		"rule_count":      len(in.JSONPathRules),
		"floor_field_cnt": len(floor),
	})
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, auditRedactionPolicyDTO{
		DefaultRedactedFields: splitCSV(floor),
		JSONPathRules:         in.JSONPathRules,
		UpdatedAt:             time.Now().UTC(),
	})
}

// unmaskReq is the body of POST /api/v1/audit/{id}/unmask. Reason is
// stored verbatim in audit_pii_unmask_history.unmasked_reason so a
// compliance reviewer can see the justification a quarter later.
type unmaskReq struct {
	Reason string `json:"reason"`
}

// unmaskResp is the wire shape returned on a successful unmask.
type unmaskResp struct {
	ID             int64          `json:"id"`
	Metadata       map[string]any `json:"metadata"`
	UnmaskedFields []string       `json:"unmaskedFields"`
	UnmaskedAt     time.Time      `json:"unmaskedAt"`
}

// UnmaskPII POST /api/v1/audit/{id}/unmask.
//
// Decrypts audit_log.metadata_encrypted for one row and returns the
// fully-restored metadata. Gates:
//
//   - audit:read_pii scope required (or admin); otherwise 403.
//   - Cipher must be configured server-side; otherwise 503.
//   - The unmask itself is logged into audit_pii_unmask_history AND
//     emits an audit.pii_unmask audit_log row so PII access is itself
//     auditable. SOC 2 CC6.1 + GDPR Art. 32 both require this trail.
func (h *AuditHandlers) UnmaskPII(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if !apikeys.HasScope(r.Context(), apikeys.ScopeAuditReadPII) {
		writeAuditPIIScopeDenial(w)
		return
	}
	if h.Cipher == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "unmask_unavailable",
			"envelope cipher not configured; cannot decrypt metadata")
		return
	}
	idRaw := strings.TrimSpace(chi.URLParam(r, "id"))
	id, err := strconv.ParseInt(idRaw, 10, 64)
	if err != nil || id <= 0 {
		writeJSONErr(w, http.StatusBadRequest, "bad_id", "id must be a positive integer")
		return
	}
	var in unmaskReq
	if r.ContentLength > 0 {
		if err := httpbody.DecodeJSONWith(w, r, 4<<10, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httpbody.WriteError(w, err)
			return
		}
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var (
		meta    map[string]any
		encBlob []byte
		hashes  map[string]any
	)
	if err := tx.QueryRow(r.Context(), `
SELECT metadata, metadata_encrypted, COALESCE(redacted_field_hashes, '{}'::jsonb)
  FROM audit_log
 WHERE tenant_id = $1::uuid AND id = $2`, t.ID, id,
	).Scan(&meta, &encBlob, &hashes); err != nil {
		writeJSONErr(w, http.StatusNotFound, "not_found", "audit row not found")
		return
	}
	if meta == nil {
		meta = map[string]any{}
	}
	side, err := audit.DecryptSideBlob(r.Context(), h.Cipher, encBlob)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	audit.MergeDecrypted(meta, side)
	// Snapshot which paths actually came back unmasked — the union of
	// the encrypted side-blob keys + the hash keys. This is the field
	// list the frontend re-renders the badge from.
	unmasked := make([]string, 0, len(side)+len(hashes))
	for k := range side {
		unmasked = append(unmasked, k)
	}
	for k := range hashes {
		// Avoid duplicates if the same path appeared in both.
		dup := false
		for _, u := range unmasked {
			if u == k {
				dup = true
				break
			}
		}
		if !dup {
			unmasked = append(unmasked, k)
		}
	}
	now := time.Now().UTC()
	// Append to audit_pii_unmask_history — the durable "who unmasked
	// what when" ledger. Used by the SOC 2 access-review report.
	actorType, actorLabel := middleware.ActorFromContext(r.Context())
	var userID *string
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil && u.ID != "" {
		v := u.ID
		userID = &v
	}
	if _, err := tx.Exec(r.Context(), `
INSERT INTO audit_pii_unmask_history
    (tenant_id, audit_log_id, unmasked_by_user_id, unmasked_by_actor_label, unmasked_at, unmasked_reason)
VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6)`,
		t.ID, id, userID, actorLabel, now, strings.TrimSpace(in.Reason),
	); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	// Emit a first-class audit row for the unmask itself. Cannot be
	// redacted (the action key audit.pii_unmask is the canonical answer
	// to "who has ever decrypted this row").
	_ = db.Audit(r.Context(), tx, db.AuditMeta{
		TenantID:   t.ID,
		UserID:     userID,
		ActorType:  actorType,
		ActorLabel: actorLabel,
	}, "audit.pii_unmask", "audit_log", idRaw, map[string]any{
		"target_audit_id": id,
		"reason":          strings.TrimSpace(in.Reason),
		"field_count":     len(unmasked),
	})
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, unmaskResp{
		ID:             id,
		Metadata:       meta,
		UnmaskedFields: unmasked,
		UnmaskedAt:     now,
	})
}

// splitCSV splits a comma-separated string into trimmed lowercase
// tokens, dropping empties. Used to project the stored CSV column.
func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(strings.ToLower(p))
		if p == "" {
			continue
		}
		out = append(out, p)
	}
	return out
}

// dedupeLowerCSV lower-cases, dedupes, and re-joins as a comma-separated
// list. Used to enforce the redaction floor before writing.
func dedupeLowerCSV(in []string) string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		s = strings.TrimSpace(strings.ToLower(s))
		if s == "" {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return strings.Join(out, ",")
}
