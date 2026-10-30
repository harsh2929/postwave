// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_access.go — desktop-audit gaps A21 + A14.
//
//	EventsByIDs        — GET  /api/v1/audit/events?ids=1,2,3
//	                     Fetch audit rows by id so the desktop's
//	                     investigation timeline stops cursor-walking
//	                     the main list with a 5×500 budget. Returns
//	                     {"items": [...]} where each item is the same
//	                     AuditRow shape List serves.
//	CreateAccessRequest — POST /api/v1/audit/access-requests
//	ListAccessRequests  — GET  /api/v1/audit/access-requests
//	                     Persisted "Request access" flow for users who
//	                     lack audit:read. See
//	                     internal/audit/access_requests.go for why this
//	                     is persist + owner-visible list (there is no
//	                     in-app notification-create mechanism today).
package handlers

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// EventsByIDs GET /api/v1/audit/events?ids=1,2,3 (cap 100 ids).
//
// Same projection, scan, and AuditRow wire shape as List — only the
// WHERE clause differs (id = ANY instead of the filter set). Rows the
// tenant doesn't own (or that were trimmed) are silently absent from
// items; callers diff the returned ids against what they asked for.
func (h *AuditHandlers) EventsByIDs(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	ids, err := audit.ParseEventIDs(r.URL.Query().Get("ids"))
	if err != nil {
		writeJSONErr(w, http.StatusBadRequest, "bad_ids", err.Error())
		return
	}

	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Projection kept byte-identical to List's so the scan below stays
	// in lockstep with the AuditRow shape the desktop already parses.
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
  AND id = ANY($2::bigint[])
ORDER BY id DESC`
	rows, err := tx.Query(r.Context(), sql, t.ID, ids)
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
	middleware.RowCounterFromContext(r.Context()).Store(int64(len(out)))
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// CreateAccessRequest POST /api/v1/audit/access-requests
// Body: {"note"?: string}.
//
// Mounted WITHOUT the audit:read gate on purpose — the whole point is
// that the caller lacks audit access. Tenant context is still required
// (session cookie or API key). Idempotent per user: re-posting while a
// request is pending returns the existing row with 200 instead of
// piling up duplicates (201 on first create).
func (h *AuditHandlers) CreateAccessRequest(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var body struct {
		Note string `json:"note"`
	}
	if err := httpbody.DecodeJSONWith(w, r, 16<<10, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httpbody.WriteError(w, err)
		return

	}

	in := audit.CreateAccessRequestInput{TenantID: t.ID, Note: body.Note}
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		in.UserID = u.ID
		in.UserEmail = u.Email
	}
	_, actorLabel := middleware.ActorFromContext(r.Context())
	in.ActorLabel = actorLabel

	req, created, err := audit.CreateAccessRequest(r.Context(), h.Pool, in)
	if err != nil {
		if strings.Contains(err.Error(), "note too long") {
			writeJSONErr(w, http.StatusBadRequest, "bad_note", err.Error())
			return
		}
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	if created {
		// Owner visibility: there is no in-app notification bus to
		// push through (internal/notifications is a pref gate only),
		// so the request surfaces via the owner list endpoint AND as
		// an audit row in the trail / SSE live tail.
		audit.EmitOrLog(r.Context(), h.Pool,
			"audit.access_request.created", "audit_access_request", req.ID,
			nil, req, nil)
	}

	status := http.StatusCreated
	if !created {
		status = http.StatusOK
	}
	writeJSON(w, status, map[string]any{"request": req})
}

// ListAccessRequests GET /api/v1/audit/access-requests?status=&limit=
//
// Owner/admin review surface (gated at the route with admin scope —
// session-cookie path requires the owner/admin role via RequireScope's
// admin-tier check). Defaults to pending-only, newest first; pass
// status=all for the full history.
func (h *AuditHandlers) ListAccessRequests(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	q := r.URL.Query()
	status := strings.TrimSpace(q.Get("status"))
	switch status {
	case "":
		status = "pending"
	case "all":
		status = ""
	case "pending", "approved", "denied", "dismissed":
		// pass through
	default:
		writeJSONErr(w, http.StatusBadRequest, "bad_status",
			"status must be one of pending|approved|denied|dismissed|all")
		return
	}
	limit := 50
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	items, err := audit.ListAccessRequests(r.Context(), h.Pool, t.ID, status, limit)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// ResolveAccessRequest PATCH /api/v1/audit/access-requests/{id}
//
// Records an owner/admin review decision without silently changing a teammate's
// role. An approval is accepted only after the requester's CURRENT active
// workspace role independently resolves to both audit:read and audit:read_pii;
// the Team surface remains the one authority for access grants. The request row
// is locked and every client-observed identity field is rechecked before the
// pending -> terminal transition, so two reviewers cannot resolve the same
// request differently and a stale dialog cannot decide a replaced target.
func (h *AuditHandlers) ResolveAccessRequest(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if _, err := uuid.Parse(id); err != nil {
		writeJSONErr(w, http.StatusBadRequest, "bad_id", "request id must be a UUID")
		return
	}
	var body struct {
		Status               string `json:"status"`
		ExpectedStatus       string `json:"expectedStatus"`
		ExpectedRequesterKey string `json:"expectedRequesterKey"`
		ExpectedCreatedAt    string `json:"expectedCreatedAt"`
	}
	if err := httpbody.DecodeJSON(w, r, 8<<10, &body); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	body.Status = strings.ToLower(strings.TrimSpace(body.Status))
	body.ExpectedStatus = strings.ToLower(strings.TrimSpace(body.ExpectedStatus))
	body.ExpectedRequesterKey = strings.TrimSpace(body.ExpectedRequesterKey)
	body.ExpectedCreatedAt = strings.TrimSpace(body.ExpectedCreatedAt)
	if body.Status != "approved" && body.Status != "denied" && body.Status != "dismissed" {
		writeJSONErr(w, http.StatusBadRequest, "bad_status", "status must be approved, denied, or dismissed")
		return
	}
	if body.ExpectedStatus != "pending" {
		writeJSONErr(w, http.StatusBadRequest, "bad_expected_status", "expectedStatus must be pending")
		return
	}
	if body.ExpectedRequesterKey == "" || len(body.ExpectedRequesterKey) > 1024 ||
		strings.ContainsAny(body.ExpectedRequesterKey, "\x00\r\n") {
		writeJSONErr(w, http.StatusBadRequest, "bad_requester_key", "expectedRequesterKey is invalid")
		return
	}
	expectedCreatedAt, err := time.Parse(time.RFC3339Nano, body.ExpectedCreatedAt)
	if err != nil {
		writeJSONErr(w, http.StatusBadRequest, "bad_created_at", "expectedCreatedAt must be an RFC3339 timestamp")
		return
	}

	tx, err := db.WithTenant(r.Context(), h.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var current audit.AccessRequest
	err = tx.QueryRow(r.Context(), `
SELECT id::text, requested_by::text, COALESCE(requested_by_email, ''),
       COALESCE(actor_label, ''), note, status, created_at, resolved_at
  FROM audit_access_requests
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, tenant.ID, id).Scan(
		&current.ID, &current.UserID, &current.UserEmail, &current.ActorLabel,
		&current.Note, &current.Status, &current.CreatedAt, &current.ResolvedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSONErr(w, http.StatusNotFound, "not_found", "audit-access request not found")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if current.Status != body.ExpectedStatus || current.ResolvedAt != nil ||
		!current.CreatedAt.Equal(expectedCreatedAt) ||
		accessRequestRequesterKey(current) != body.ExpectedRequesterKey {
		writeJSONErr(w, http.StatusConflict, "access_request_changed",
			"the request changed after this review opened; refresh before deciding")
		return
	}

	grantVerified := false
	if body.Status == "approved" {
		if current.UserID == nil || strings.TrimSpace(*current.UserID) == "" {
			writeJSONErr(w, http.StatusConflict, "approval_unverifiable",
				"API-key requests have no durable workspace member whose grant can be verified; deny or dismiss this request")
			return
		}
		var memberStatus string
		var hasRead, hasPII bool
		err = tx.QueryRow(r.Context(), `
SELECT u.status,
       COALESCE(bool_or(rp.scope = 'audit:read'), false),
       COALESCE(bool_or(rp.scope = 'audit:read_pii'), false)
  FROM users u
  LEFT JOIN roles role_def
    ON role_def.tenant_id = u.tenant_id
   AND lower(role_def.name) = lower(u.role)
  LEFT JOIN roles_permissions rp ON rp.role_id = role_def.id
 WHERE u.tenant_id = $1::uuid AND u.id = $2::uuid
 GROUP BY u.status`, tenant.ID, *current.UserID).Scan(&memberStatus, &hasRead, &hasPII)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			httperror.WriteInternal(w, h.Logger, err, r.Context())
			return
		}
		if errors.Is(err, pgx.ErrNoRows) || memberStatus != "active" || !hasRead || !hasPII {
			writeJSONErr(w, http.StatusConflict, "grant_not_verified",
				"grant audit:read and audit:read_pii to the active workspace member in Team before recording approval")
			return
		}
		grantVerified = true
	}

	var resolved audit.AccessRequest
	err = tx.QueryRow(r.Context(), `
UPDATE audit_access_requests
   SET status = $3, resolved_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status = 'pending'
   AND resolved_at IS NULL
   AND created_at = $4
RETURNING id::text, requested_by::text, COALESCE(requested_by_email, ''),
          COALESCE(actor_label, ''), note, status, created_at, resolved_at`,
		tenant.ID, id, body.Status, current.CreatedAt,
	).Scan(&resolved.ID, &resolved.UserID, &resolved.UserEmail,
		&resolved.ActorLabel, &resolved.Note, &resolved.Status,
		&resolved.CreatedAt, &resolved.ResolvedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSONErr(w, http.StatusConflict, "access_request_changed",
			"the request changed before the decision committed; refresh and retry")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r),
		"audit.access_request."+body.Status, "audit_access_request", resolved.ID,
		map[string]any{
			"previous_status": "pending",
			"decision":        body.Status,
			"requester_key":   body.ExpectedRequesterKey,
			"requested_at":    current.CreatedAt.UTC().Format(time.RFC3339Nano),
			"grant_verified":  grantVerified,
		},
	); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"request":       resolved,
		"grantVerified": grantVerified,
	})
}

func accessRequestRequesterKey(request audit.AccessRequest) string {
	if request.UserID != nil && strings.TrimSpace(*request.UserID) != "" {
		return "user:" + strings.TrimSpace(*request.UserID)
	}
	if strings.TrimSpace(request.ActorLabel) != "" {
		return "actor:" + strings.TrimSpace(request.ActorLabel)
	}
	return "unidentified"
}
