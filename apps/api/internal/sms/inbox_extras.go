// SPDX-License-Identifier: AGPL-3.0-only
//
// inbox_extras.go — Refined SMS Inbox PRs 2-4 endpoints.
//
//   Snooze / Archive    — per-conversation lifecycle stamps on the
//                          existing sms_conversation_state row.
//   Tags / Notes        — per-conversation taxonomy + internal
//                          operator-only notes.
//   Assignee            — operator assignment for team triage.
//   Quick replies       — saved canned-response templates with a
//                          usage counter so the picker ranks most-
//                          used at top.
//   Bulk actions        — apply the same lifecycle change (read /
//                          archive / snooze) to N conversations in
//                          one round-trip.
//   Search              — server-side ILIKE/trigram filter across
//                          message bodies + phone + subscriber email.
//   Activity feed       — bounded consent evidence plus current subscription
//                          state. It does not claim complete suppression/state
//                          mutation history.
//   Cost preview        — read-only "what would this cost?" hint for
//                          the composer.
//
// Mount via MountInboxExtraRoutes; same admin gate as the rest of the
// inbox.

package sms

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MountInboxExtraRoutes wires the PR 2-4 endpoints. Called from main.go
// alongside MountInboxRoutes — split to keep the PR 1 file unmodified
// where possible.
func (d *Deps) MountInboxExtraRoutes(r chi.Router) {
	admin := []func(http.Handler) http.Handler{protectSMSInboxResponse, apikeys.RequireExactTenantAdmin}
	r.With(admin...).Post("/api/v1/sms/conversations/{phone}/snooze", d.SnoozeConversation)
	r.With(admin...).Post("/api/v1/sms/conversations/{phone}/unsnooze", d.UnsnoozeConversation)
	r.With(admin...).Post("/api/v1/sms/conversations/{phone}/archive", d.ArchiveConversation)
	r.With(admin...).Post("/api/v1/sms/conversations/{phone}/unarchive", d.UnarchiveConversation)
	r.With(admin...).Post("/api/v1/sms/conversations/{phone}/assign", d.AssignConversation)
	r.With(admin...).Post("/api/v1/sms/conversations/{phone}/notes", d.SetConversationNotes)
	r.With(admin...).Get("/api/v1/sms/conversations/{phone}/tags", d.ListConversationTags)
	r.With(admin...).Post("/api/v1/sms/conversations/{phone}/tags", d.AddConversationTag)
	r.With(admin...).Delete("/api/v1/sms/conversations/{phone}/tags", d.RemoveConversationTag)
	r.With(admin...).Delete("/api/v1/sms/conversations/{phone}/tags/{tag}", d.RetiredConversationTagPath)
	r.With(admin...).Get("/api/v1/sms/conversations/{phone}/activity", d.GetConversationActivity)
	r.With(admin...).Post("/api/v1/sms/conversations/bulk", d.BulkConversationAction)
	r.With(admin...).Get("/api/v1/sms/conversations/search", d.SearchConversationsGETGone)
	r.With(admin...).Post("/api/v1/sms/conversations/search", d.SearchConversations)
	r.With(admin...).Get("/api/v1/sms/conversations.csv", d.ExportConversationsCSV)
	r.With(admin...).Get("/api/v1/sms/quick-replies", d.ListQuickReplies)
	r.With(admin...).Post("/api/v1/sms/quick-replies", d.CreateQuickReply)
	r.With(admin...).Patch("/api/v1/sms/quick-replies/{id}", d.UpdateQuickReply)
	r.With(admin...).Delete("/api/v1/sms/quick-replies/{id}", d.DeleteQuickReply)
	r.With(admin...).Post("/api/v1/sms/quick-replies/{id}/use", d.RecordQuickReplyUse)
}

// ---------------------------------------------------------------------
// Snooze / Archive / Assign / Notes
// ---------------------------------------------------------------------

type snoozeReq struct {
	Until time.Time `json:"until"`
	lifecycleCASReq
}

type lifecycleCASReq struct {
	// RawMessage preserves the required distinction between an omitted field
	// and an explicit null (the authoritative version for a conversation whose
	// operator lifecycle has never been mutated).
	ExpectedUpdatedAt json.RawMessage `json:"expectedUpdatedAt"`
}

type conversationStateMutationResponse struct {
	OK             bool       `json:"ok"`
	TenantID       string     `json:"tenantId"`
	PhoneE164      string     `json:"phoneE164"`
	Action         string     `json:"action"`
	SnoozeUntil    *time.Time `json:"snoozeUntil,omitempty"`
	ArchivedAt     *time.Time `json:"archivedAt,omitempty"`
	AssigneeUserID *string    `json:"assigneeUserId,omitempty"`
	StateUpdatedAt time.Time  `json:"stateUpdatedAt"`
}

func parseLifecycleExpectedUpdatedAt(raw json.RawMessage) (*time.Time, error) {
	if len(raw) == 0 {
		return nil, errors.New("expectedUpdatedAt is required (use null only when the loaded row has no stateUpdatedAt)")
	}
	trimmed := bytes.TrimSpace(raw)
	if bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil || value == "" || strings.TrimSpace(value) != value {
		return nil, errors.New("expectedUpdatedAt must be null or the exact RFC3339 stateUpdatedAt value")
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || !validProjectionTime(parsed) {
		return nil, errors.New("expectedUpdatedAt must be null or the exact RFC3339 stateUpdatedAt value")
	}
	return &parsed, nil
}

// SnoozeConversation stamps snooze_until on the conversation state.
// "Stop showing this in Active for N hours" — the conversation
// reappears once the snooze elapses.
func (d *Deps) SnoozeConversation(w http.ResponseWriter, r *http.Request) {
	var req snoozeReq
	d.upsertConversationState(w, r, "snooze", &req, false, func() (string, []any, error) {
		now := time.Now().UTC()
		if req.Until.IsZero() || !req.Until.After(now) || req.Until.After(now.Add(366*24*time.Hour)) {
			return "", nil, errors.New("until must be in the future and no more than 366 days away")
		}
		return `snooze_until = $3, updated_at = now()`, []any{req.Until}, nil
	})
}

// UnsnoozeConversation clears snooze_until.
func (d *Deps) UnsnoozeConversation(w http.ResponseWriter, r *http.Request) {
	d.upsertConversationState(w, r, "unsnooze", &lifecycleCASReq{}, false, func() (string, []any, error) {
		return `snooze_until = NULL, updated_at = now()`, nil, nil
	})
}

// ArchiveConversation stamps archived_at = now(). Archived
// conversations are hidden from the default Active list but still
// available via the Archived filter chip.
func (d *Deps) ArchiveConversation(w http.ResponseWriter, r *http.Request) {
	d.upsertConversationState(w, r, "archive", &lifecycleCASReq{}, false, func() (string, []any, error) {
		return `archived_at = now(), updated_at = now()`, nil, nil
	})
}

// UnarchiveConversation clears archived_at.
func (d *Deps) UnarchiveConversation(w http.ResponseWriter, r *http.Request) {
	d.upsertConversationState(w, r, "unarchive", &lifecycleCASReq{}, false, func() (string, []any, error) {
		return `archived_at = NULL, updated_at = now()`, nil, nil
	})
}

type assignReq struct {
	UserID string `json:"userId"`
	lifecycleCASReq
}

// AssignConversation sets assignee_user_id. Empty userId unassigns.
func (d *Deps) AssignConversation(w http.ResponseWriter, r *http.Request) {
	var req assignReq
	d.upsertConversationState(w, r, "assign", &req, false, func() (string, []any, error) {
		req.UserID = strings.TrimSpace(req.UserID)
		if req.UserID == "" {
			return `assignee_user_id = NULL, updated_at = now()`, nil, nil
		}
		if !validCanonicalUUIDV4(req.UserID) {
			return "", nil, errors.New("userId must be a canonical lowercase UUIDv4")
		}
		return `assignee_user_id = $3::uuid, updated_at = now()`, []any{req.UserID}, nil
	})
}

type notesReq struct {
	Notes string `json:"notes"`
	lifecycleCASReq
}

// SetConversationNotes overwrites the free-text internal notes.
func (d *Deps) SetConversationNotes(w http.ResponseWriter, r *http.Request) {
	var req notesReq
	d.upsertConversationState(w, r, "notes", &req, false, func() (string, []any, error) {
		if strings.TrimSpace(req.Notes) != req.Notes || !validInboxText(req.Notes, 4000) {
			return "", nil, errors.New("notes must be at most 4,000 safe Unicode characters without leading/trailing whitespace")
		}
		return `notes = $3, updated_at = now()`, []any{req.Notes}, nil
	})
}

// upsertConversationState is the shared INSERT … ON CONFLICT pipeline
// used by snooze / archive / assign / notes. Each caller returns a
// fragment of the UPDATE clause + the extra args ($3..).
func (d *Deps) upsertConversationState(
	w http.ResponseWriter, r *http.Request,
	action string,
	input any, allowEmpty bool,
	fn func() (string, []any, error),
) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_tenant", ""))
		return
	}
	phone := normalizePhoneE164ForLookup(chi.URLParam(r, "phone"))
	if phone == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_phone", "phone required"))
		return
	}
	if err := httpbody.DecodeJSONWith(w, r, 8<<10, input, httpbody.Options{AllowEmptyBody: allowEmpty}); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	updateClause, extraArgs, err := fn()
	if err != nil {
		httperror.WriteValidation(w, "invalid_input", err.Error())
		return
	}
	var expectedRaw json.RawMessage
	switch value := input.(type) {
	case *snoozeReq:
		expectedRaw = value.ExpectedUpdatedAt
	case *lifecycleCASReq:
		expectedRaw = value.ExpectedUpdatedAt
	case *assignReq:
		expectedRaw = value.ExpectedUpdatedAt
	case *notesReq:
		expectedRaw = value.ExpectedUpdatedAt
	default:
		writeJSON(w, http.StatusInternalServerError, errEnv("invalid_lifecycle_contract", ""))
		return
	}
	expectedUpdatedAt, err := parseLifecycleExpectedUpdatedAt(expectedRaw)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_expected_updated_at", err.Error()))
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Store.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, tenant.ID+"|"+phone); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	var exists bool
	if err := tx.QueryRow(r.Context(), `SELECT EXISTS (
  SELECT 1 FROM sms_messages WHERE tenant_id = $1::uuid AND phone_e164 = $2
)`, tenant.ID, phone).Scan(&exists); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if !exists {
		writeJSON(w, http.StatusNotFound, errEnv("conversation_not_found", "conversation not found"))
		return
	}
	if action == "assign" && len(extraArgs) == 1 {
		var memberExists bool
		if err := tx.QueryRow(r.Context(), `SELECT EXISTS (
  SELECT 1 FROM users
   WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'active'
)`, tenant.ID, extraArgs[0]).Scan(&memberExists); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		if !memberExists {
			writeJSON(w, http.StatusUnprocessableEntity, errEnv("assignee_not_active_tenant_member", "assignee must be an active member of this tenant"))
			return
		}
	}

	// Ensure the state row exists, then apply the authoritative mutation. A
	// single INSERT ... ON CONFLICT with only an UPDATE fragment would silently
	// lose the requested value on the first state mutation for a conversation.
	if _, err := tx.Exec(r.Context(), `
INSERT INTO sms_conversation_state (tenant_id, phone_e164)
VALUES ($1::uuid, $2)
ON CONFLICT (tenant_id, phone_e164) DO NOTHING`, tenant.ID, phone); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	args := []any{tenant.ID, phone}
	args = append(args, extraArgs...)
	args = append(args, expectedUpdatedAt)
	expectedArg := "$" + strconv.Itoa(len(args))
	q := `
UPDATE sms_conversation_state
	SET ` + updateClause + `,
	    lifecycle_updated_at = GREATEST(
	      clock_timestamp(),
	      COALESCE(lifecycle_updated_at, '-infinity'::timestamptz) + interval '1 microsecond'
	    )
	WHERE tenant_id = $1::uuid AND phone_e164 = $2
	  AND lifecycle_updated_at IS NOT DISTINCT FROM ` + expectedArg + `::timestamptz
	RETURNING snooze_until, archived_at, assignee_user_id::text, lifecycle_updated_at`
	response := conversationStateMutationResponse{
		OK: true, TenantID: tenant.ID, PhoneE164: phone, Action: action,
	}
	err = tx.QueryRow(r.Context(), q, args...).Scan(
		&response.SnoozeUntil, &response.ArchivedAt,
		&response.AssigneeUserID, &response.StateUpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusConflict, errEnv("conversation_state_conflict", "conversation state changed; refresh before retrying"))
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if !validProjectionTime(response.StateUpdatedAt) {
		httperror.WriteInternal(w, d.Logger, errSMSProjectionOutsideContract, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r), "sms.conversation."+action, "sms_conversation_state", "", map[string]any{
		"route_template": "/api/v1/sms/conversations/{phone}/" + action,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, response)
}

// ---------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------

type ConversationTag struct {
	Tag       string    `json:"tag"`
	CreatedAt time.Time `json:"createdAt"`
}

type conversationTagsResponse struct {
	TenantID  string            `json:"tenantId"`
	PhoneE164 string            `json:"phoneE164"`
	Tags      []ConversationTag `json:"tags"`
	Snapshot  time.Time         `json:"snapshotAt"`
	Truncated bool              `json:"truncated"`
}

func (d *Deps) ListConversationTags(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_tenant", ""))
		return
	}
	phone := normalizePhoneE164ForLookup(chi.URLParam(r, "phone"))
	if phone == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_phone", "phone required"))
		return
	}
	if r.URL.RawQuery != "" {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_query", "conversation tags do not accept query parameters"))
		return
	}
	tx, err := db.WithTenantOptions(r.Context(), d.Store.Pool, tenant.ID, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var snapshotAt time.Time
	var exists bool
	if err := tx.QueryRow(r.Context(), `
SELECT clock_timestamp(), EXISTS (
  SELECT 1 FROM sms_messages WHERE tenant_id = $1::uuid AND phone_e164 = $2
)`, tenant.ID, phone).Scan(&snapshotAt, &exists); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if !exists {
		writeJSON(w, http.StatusNotFound, errEnv("conversation_not_found", "conversation not found"))
		return
	}
	rows, err := tx.Query(r.Context(), `
SELECT tag, created_at
  FROM sms_conversation_tags
 WHERE tenant_id = $1::uuid AND phone_e164 = $2
 ORDER BY created_at ASC, tag ASC
 LIMIT 101`, tenant.ID, phone)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	defer rows.Close()
	out := []ConversationTag{}
	for rows.Next() {
		var t ConversationTag
		if err := rows.Scan(&t.Tag, &t.CreatedAt); err != nil {
			rows.Close()
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		if strings.TrimSpace(t.Tag) != t.Tag || t.Tag == "" || !validInboxText(t.Tag, 64) ||
			!validProjectionTime(t.CreatedAt) {
			rows.Close()
			httperror.WriteInternal(w, d.Logger, errors.New("invalid historical SMS conversation tag"), httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	rows.Close()
	truncated := len(out) > 100
	if truncated {
		out = out[:100]
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := d.auditSMSInboxRead(r, "sms.conversation.tags.read", "/api/v1/sms/conversations/{phone}/tags", len(out), snapshotAt, truncated); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, conversationTagsResponse{
		TenantID: tenant.ID, PhoneE164: phone, Tags: out,
		Snapshot: snapshotAt, Truncated: truncated,
	})
}

type addTagReq struct {
	Tag            string `json:"tag"`
	ExpectedAbsent bool   `json:"expectedAbsent"`
}

func (d *Deps) AddConversationTag(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_tenant", ""))
		return
	}
	phone := normalizePhoneE164ForLookup(chi.URLParam(r, "phone"))
	if phone == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_phone", ""))
		return
	}
	var req addTagReq
	if err := httpbody.DecodeJSONWith(w, r, 4<<10, &req, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	tag := strings.TrimSpace(req.Tag)
	if tag == "" || tag != req.Tag || !validInboxText(tag, 64) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_tag", "tag must be 1 to 64 visible Unicode characters without leading/trailing whitespace"))
		return
	}
	if !req.ExpectedAbsent {
		writeJSON(w, http.StatusBadRequest, errEnv("tag_precondition_required", "expectedAbsent must be true after loading the current tag inventory"))
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Store.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, tenant.ID+"|"+phone); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	var exists bool
	if err := tx.QueryRow(r.Context(), `SELECT EXISTS (
  SELECT 1 FROM sms_messages WHERE tenant_id = $1::uuid AND phone_e164 = $2
)`, tenant.ID, phone).Scan(&exists); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if !exists {
		writeJSON(w, http.StatusNotFound, errEnv("conversation_not_found", "conversation not found"))
		return
	}
	var count int
	if err := tx.QueryRow(r.Context(), `SELECT COUNT(*)::int FROM sms_conversation_tags WHERE tenant_id = $1::uuid AND phone_e164 = $2`, tenant.ID, phone).Scan(&count); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if count >= 100 {
		writeJSON(w, http.StatusConflict, errEnv("tag_limit_reached", "a conversation may have at most 100 tags"))
		return
	}
	var alreadyExists bool
	if err := tx.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM sms_conversation_tags WHERE tenant_id = $1::uuid AND phone_e164 = $2 AND tag = $3)`, tenant.ID, phone, tag).Scan(&alreadyExists); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if alreadyExists {
		writeJSON(w, http.StatusConflict, errEnv("tag_state_conflict", "conversation tags changed; refresh before retrying"))
		return
	}
	var createdAt time.Time
	if err := tx.QueryRow(r.Context(), `
INSERT INTO sms_conversation_tags (tenant_id, phone_e164, tag)
VALUES ($1::uuid, $2, $3)
RETURNING created_at`, tenant.ID, phone, tag).Scan(&createdAt); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	auditMeta := middleware.AuditMetaFromRequest(r)
	if err := db.Audit(r.Context(), tx, auditMeta, "sms.conversation.tag.add", "sms_conversation_tag", "", map[string]any{"route": "/api/v1/sms/conversations/{phone}/tags"}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tenantId": tenant.ID, "phoneE164": phone, "tag": tag, "createdAt": createdAt, "action": "add"})
}

func (d *Deps) RemoveConversationTag(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_tenant", ""))
		return
	}
	phone := normalizePhoneE164ForLookup(chi.URLParam(r, "phone"))
	if err := validateInboxQuery(r.URL.Query()); err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_query", err.Error()))
		return
	}
	var req struct {
		Tag               string `json:"tag"`
		ExpectedCreatedAt string `json:"expectedCreatedAt"`
	}
	if err := httpbody.DecodeJSON(w, r, 4<<10, &req); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	tag := req.Tag
	if phone == "" || tag == "" || strings.TrimSpace(tag) != tag || !validInboxText(tag, 64) {
		writeJSON(w, http.StatusBadRequest, errEnv("missing", "phone + tag required"))
		return
	}
	expectedCreatedAt, err := time.Parse(time.RFC3339Nano, req.ExpectedCreatedAt)
	if err != nil || req.ExpectedCreatedAt == "" || strings.TrimSpace(req.ExpectedCreatedAt) != req.ExpectedCreatedAt || !validProjectionTime(expectedCreatedAt) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_expected_created_at", "expectedCreatedAt must be the exact RFC3339 createdAt value from the loaded tag"))
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Store.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, tenant.ID+"|"+phone); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	var deletedID string
	if err := tx.QueryRow(r.Context(),
		`DELETE FROM sms_conversation_tags WHERE tenant_id = $1::uuid AND phone_e164 = $2 AND tag = $3 AND created_at = $4 RETURNING id::text`,
		tenant.ID, phone, tag, expectedCreatedAt).Scan(&deletedID); errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusConflict, errEnv("tag_state_conflict", "conversation tags changed; refresh before retrying"))
		return
	} else if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	auditMeta := middleware.AuditMetaFromRequest(r)
	if err := db.Audit(r.Context(), tx, auditMeta, "sms.conversation.tag.remove", "sms_conversation_tag", deletedID, map[string]any{"route": "/api/v1/sms/conversations/{phone}/tags"}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tenantId": tenant.ID, "phoneE164": phone, "tag": tag, "createdAt": expectedCreatedAt, "action": "remove"})
}

func (d *Deps) RetiredConversationTagPath(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusGone, errEnv("sms_tag_path_retired", "send the tag in the private JSON request body"))
}

// ---------------------------------------------------------------------
// Quick replies (CRUD + use counter)
// ---------------------------------------------------------------------

type QuickReply struct {
	ID         string     `json:"id"`
	Label      string     `json:"label"`
	Body       string     `json:"body"`
	UseCount   int        `json:"useCount"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
}

type quickRepliesResponse struct {
	TenantID  string       `json:"tenantId"`
	Replies   []QuickReply `json:"replies"`
	Snapshot  time.Time    `json:"snapshotAt"`
	Truncated bool         `json:"truncated"`
}

type quickReplyMutationResponse struct {
	TenantID string     `json:"tenantId"`
	Reply    QuickReply `json:"reply"`
}

func validQuickReply(q QuickReply) bool {
	if !validCanonicalUUIDV4(q.ID) || strings.TrimSpace(q.Label) != q.Label || q.Label == "" ||
		!validInboxText(q.Label, 80) || !validSMSInboxBody(q.Body, false) || q.UseCount < 0 ||
		!validProjectionTime(q.CreatedAt) || !validProjectionTime(q.UpdatedAt) || q.UpdatedAt.Before(q.CreatedAt) {
		return false
	}
	if q.LastUsedAt != nil && (!validProjectionTime(*q.LastUsedAt) || q.LastUsedAt.Before(q.CreatedAt)) {
		return false
	}
	return true
}

func (d *Deps) ListQuickReplies(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_tenant", ""))
		return
	}
	if r.URL.RawQuery != "" {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_query", "quick replies do not accept query parameters"))
		return
	}
	tx, err := db.WithTenantOptions(r.Context(), d.Store.Pool, tenant.ID, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var snapshotAt time.Time
	if err := tx.QueryRow(r.Context(), `SELECT clock_timestamp()`).Scan(&snapshotAt); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	rows, err := tx.Query(r.Context(), `
SELECT id::text, label, body, use_count, last_used_at, created_at, updated_at
  FROM sms_quick_replies
 WHERE tenant_id = $1::uuid
 ORDER BY use_count DESC, last_used_at DESC NULLS LAST, label COLLATE "C" ASC, id ASC
 LIMIT 501`, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	defer rows.Close()
	out := []QuickReply{}
	for rows.Next() {
		var q QuickReply
		if err := rows.Scan(&q.ID, &q.Label, &q.Body, &q.UseCount, &q.LastUsedAt, &q.CreatedAt, &q.UpdatedAt); err != nil {
			rows.Close()
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		if !validQuickReply(q) {
			rows.Close()
			httperror.WriteInternal(w, d.Logger, errors.New("invalid historical SMS quick reply"), httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		out = append(out, q)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	rows.Close()
	truncated := len(out) > 500
	if truncated {
		out = out[:500]
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := d.auditSMSInboxRead(r, "sms.quick_replies.read", "/api/v1/sms/quick-replies", len(out), snapshotAt, truncated); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, quickRepliesResponse{TenantID: tenant.ID, Replies: out, Snapshot: snapshotAt, Truncated: truncated})
}

type quickReplyInput struct {
	Label string `json:"label"`
	Body  string `json:"body"`
}

type quickReplyPatch struct {
	Label *string `json:"label"`
	Body  *string `json:"body"`
}

func normalizeQuickReplyInput(label, body string) (string, string, error) {
	if strings.TrimSpace(label) != label || label == "" || !validInboxText(label, 80) {
		return "", "", errors.New("label must be 1 to 80 safe Unicode characters without leading/trailing whitespace")
	}
	if !validSMSInboxBody(body, false) {
		return "", "", ErrSMSBodyOutsideContract
	}
	return label, body, nil
}

func (d *Deps) CreateQuickReply(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_tenant", ""))
		return
	}
	var in quickReplyInput
	if err := httpbody.DecodeJSON(w, r, 32<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	label, body, err := normalizeQuickReplyInput(in.Label, in.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_quick_reply", err.Error()))
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Store.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, tenant.ID+"|sms-quick-replies"); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	var count int
	if err := tx.QueryRow(r.Context(), `SELECT COUNT(*)::int FROM sms_quick_replies WHERE tenant_id = $1::uuid`, tenant.ID).Scan(&count); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if count >= 500 {
		writeJSON(w, http.StatusConflict, errEnv("quick_reply_limit_reached", "a tenant may have at most 500 quick replies"))
		return
	}
	var out QuickReply
	err = tx.QueryRow(r.Context(), `
INSERT INTO sms_quick_replies (tenant_id, label, body)
VALUES ($1::uuid, $2, $3)
RETURNING id::text, label, body, use_count, last_used_at, created_at, updated_at`,
		tenant.ID, label, body,
	).Scan(&out.ID, &out.Label, &out.Body, &out.UseCount, &out.LastUsedAt, &out.CreatedAt, &out.UpdatedAt)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r), "sms.quick_reply.create", "sms_quick_reply", out.ID, map[string]any{"route_template": "/api/v1/sms/quick-replies"}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusCreated, quickReplyMutationResponse{TenantID: tenant.ID, Reply: out})
}

func (d *Deps) UpdateQuickReply(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if !validCanonicalUUIDV4(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_id", "id must be a canonical lowercase UUIDv4"))
		return
	}
	var in quickReplyPatch
	if err := httpbody.DecodeJSON(w, r, 32<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if in.Label == nil && in.Body == nil {
		writeJSON(w, http.StatusBadRequest, errEnv("empty_patch", "label or body is required"))
		return
	}
	var label any
	if in.Label != nil {
		if strings.TrimSpace(*in.Label) != *in.Label || *in.Label == "" || !validInboxText(*in.Label, 80) {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_quick_reply", "label must be 1 to 80 safe Unicode characters without leading/trailing whitespace"))
			return
		}
		label = *in.Label
	}
	var body any
	if in.Body != nil {
		if !validSMSInboxBody(*in.Body, false) {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_quick_reply", ErrSMSBodyOutsideContract.Error()))
			return
		}
		body = *in.Body
	}
	tx, err := db.WithTenant(r.Context(), d.Store.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var out QuickReply
	err = tx.QueryRow(r.Context(), `
UPDATE sms_quick_replies
   SET label = COALESCE($3::text, label),
       body  = COALESCE($4::text, body),
       updated_at = now()
	WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING id::text, label, body, use_count, last_used_at, created_at, updated_at`,
		tenant.ID, id, label, body).Scan(&out.ID, &out.Label, &out.Body, &out.UseCount, &out.LastUsedAt, &out.CreatedAt, &out.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, errEnv("quick_reply_not_found", "quick reply not found"))
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r), "sms.quick_reply.update", "sms_quick_reply", id, map[string]any{"route_template": "/api/v1/sms/quick-replies/{id}"}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, quickReplyMutationResponse{TenantID: tenant.ID, Reply: out})
}

func (d *Deps) DeleteQuickReply(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if !validCanonicalUUIDV4(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_id", "id must be a canonical lowercase UUIDv4"))
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Store.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var deletedID string
	err = tx.QueryRow(r.Context(),
		`DELETE FROM sms_quick_replies WHERE tenant_id = $1::uuid AND id = $2::uuid RETURNING id::text`,
		tenant.ID, id).Scan(&deletedID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, errEnv("quick_reply_not_found", "quick reply not found"))
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r), "sms.quick_reply.delete", "sms_quick_reply", deletedID, map[string]any{"route_template": "/api/v1/sms/quick-replies/{id}"}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tenantId": tenant.ID, "id": deletedID})
}

// RecordQuickReplyUse bumps use_count + last_used_at so the picker
// can rank most-used at top. Fired by the composer after a successful
// send when a quick reply was the source of the body.
func (d *Deps) RecordQuickReplyUse(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if !validCanonicalUUIDV4(id) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_id", "id must be a canonical lowercase UUIDv4"))
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Store.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var useCount int
	var lastUsedAt time.Time
	err = tx.QueryRow(r.Context(), `
UPDATE sms_quick_replies
   SET use_count = use_count + 1,
       last_used_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING use_count, last_used_at`, tenant.ID, id).Scan(&useCount, &lastUsedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, errEnv("quick_reply_not_found", "quick reply not found"))
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r), "sms.quick_reply.use", "sms_quick_reply", id, map[string]any{"route_template": "/api/v1/sms/quick-replies/{id}/use"}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tenantId": tenant.ID, "id": id, "useCount": useCount, "lastUsedAt": lastUsedAt})
}

// ---------------------------------------------------------------------
// Bulk action
// ---------------------------------------------------------------------

type bulkConversationTarget struct {
	PhoneE164         string          `json:"phoneE164"`
	ExpectedUpdatedAt json.RawMessage `json:"expectedUpdatedAt"`
}

type bulkReq struct {
	Conversations []bulkConversationTarget `json:"conversations"`
	Action        string                   `json:"action"` // archive | unarchive | snooze | unsnooze
	Until         *time.Time               `json:"until,omitempty"`
}

// BulkConversationAction applies the same lifecycle change to N
// conversations in one round-trip. The target array is clamped to 200 so the
// HTTP body stays predictable.
func (d *Deps) BulkConversationAction(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_tenant", ""))
		return
	}
	var req bulkReq
	if err := httpbody.DecodeJSON(w, r, 64<<10, &req); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if len(req.Conversations) == 0 {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_conversations", ""))
		return
	}
	if len(req.Conversations) > 200 {
		writeJSON(w, http.StatusRequestEntityTooLarge, errEnv("too_many_phones", "bulk actions accept at most 200 conversations"))
		return
	}
	phones := make([]string, 0, len(req.Conversations))
	expectedVersions := make([]*time.Time, 0, len(req.Conversations))
	seen := make(map[string]struct{}, len(req.Conversations))
	for _, target := range req.Conversations {
		n := normalizePhoneE164ForLookup(target.PhoneE164)
		if n == "" {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_phone", "every phone must be a valid US/Canada number"))
			return
		}
		if _, duplicate := seen[n]; duplicate {
			writeJSON(w, http.StatusBadRequest, errEnv("duplicate_phone", "bulk action phones must be unique"))
			return
		}
		seen[n] = struct{}{}
		expected, err := parseLifecycleExpectedUpdatedAt(target.ExpectedUpdatedAt)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_expected_updated_at", err.Error()))
			return
		}
		phones = append(phones, n)
		expectedVersions = append(expectedVersions, expected)
	}

	var update string
	switch req.Action {
	case "mark_read":
		writeJSON(w, http.StatusBadRequest, errEnv("bulk_mark_read_requires_message_boundaries", "mark read requires exact inbound message_ids per conversation"))
		return
	case "archive":
		update = `archived_at = now()`
	case "unarchive":
		update = `archived_at = NULL`
	case "snooze":
		if req.Until == nil || req.Until.IsZero() || !req.Until.After(time.Now()) || req.Until.After(time.Now().Add(366*24*time.Hour)) {
			writeJSON(w, http.StatusBadRequest, errEnv("missing_until", "until required for snooze"))
			return
		}
		update = `snooze_until = $4`
	case "unsnooze":
		update = `snooze_until = NULL`
	default:
		writeJSON(w, http.StatusBadRequest, errEnv("bad_action", "action must be archive|unarchive|snooze|unsnooze"))
		return
	}

	tx, err := db.WithTenant(r.Context(), d.Store.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	// Acquire locks in one deterministic order so two overlapping bulk
	// requests cannot deadlock while still serializing every phone with the
	// single-conversation and tag mutation paths.
	lockPhones := append([]string(nil), phones...)
	sort.Strings(lockPhones)
	for _, phone := range lockPhones {
		if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, tenant.ID+"|"+phone); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
	}
	var conversationCount int
	if err := tx.QueryRow(r.Context(), `
SELECT COUNT(DISTINCT phone_e164)::int
  FROM sms_messages
 WHERE tenant_id = $1::uuid AND phone_e164 = ANY($2::text[])`, tenant.ID, phones).Scan(&conversationCount); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if conversationCount != len(phones) {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("conversation_not_found", "every phone must identify an existing tenant conversation"))
		return
	}

	if _, err := tx.Exec(r.Context(), `
INSERT INTO sms_conversation_state (tenant_id, phone_e164)
SELECT $1::uuid, unnest($2::text[])
	ON CONFLICT (tenant_id, phone_e164) DO NOTHING`, tenant.ID, phones); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	receipts := make([]conversationStateMutationResponse, 0, len(phones))
	for index, phone := range phones {
		args := []any{tenant.ID, phone, expectedVersions[index]}
		if req.Action == "snooze" {
			args = append(args, *req.Until)
		}
		q := `
UPDATE sms_conversation_state
	SET ` + update + `,
		updated_at = now(),
		lifecycle_updated_at = GREATEST(
		  clock_timestamp(),
		  COALESCE(lifecycle_updated_at, '-infinity'::timestamptz) + interval '1 microsecond'
		)
	WHERE tenant_id = $1::uuid AND phone_e164 = $2
	  AND lifecycle_updated_at IS NOT DISTINCT FROM $3::timestamptz
	RETURNING snooze_until, archived_at, assignee_user_id::text, lifecycle_updated_at`
		receipt := conversationStateMutationResponse{
			OK: true, TenantID: tenant.ID, PhoneE164: phone, Action: req.Action,
		}
		err := tx.QueryRow(r.Context(), q, args...).Scan(
			&receipt.SnoozeUntil, &receipt.ArchivedAt,
			&receipt.AssigneeUserID, &receipt.StateUpdatedAt,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			// Do not name the stale target or disclose whether it exists in this
			// tenant. The entire transaction rolls back.
			writeJSON(w, http.StatusConflict, errEnv("bulk_action_conflict", "conversation state changed; refresh the selection before retrying"))
			return
		}
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		if !validProjectionTime(receipt.StateUpdatedAt) {
			httperror.WriteInternal(w, d.Logger, errSMSProjectionOutsideContract, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		receipts = append(receipts, receipt)
	}
	if err := db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r), "sms.inbox.bulk."+req.Action, "sms_conversations", "", map[string]any{
		"route_template":     "/api/v1/sms/conversations/bulk",
		"conversation_count": len(phones),
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"tenantId": tenant.ID,
		"action":   req.Action,
		"applied":  len(receipts),
		"receipts": receipts,
	})
}

// ---------------------------------------------------------------------
// Server-side search
// ---------------------------------------------------------------------

type searchConversationsRequest struct {
	Query  string `json:"query"`
	Cursor string `json:"cursor,omitempty"`
	Limit  *int   `json:"limit,omitempty"`
}

type searchConversationsResponse struct {
	TenantID      string                `json:"tenantId"`
	Conversations []ConversationSummary `json:"conversations"`
	NextCursor    string                `json:"nextCursor,omitempty"`
	SnapshotAt    time.Time             `json:"snapshotAt"`
}

// SearchConversationsGETGone permanently retires the query-string search
// shape. Search terms frequently contain phone numbers, email addresses, or
// message text; putting them in the URL exposes them to edge access logs.
func (d *Deps) SearchConversationsGETGone(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusGone, errEnv("search_query_in_url_retired", "use POST /api/v1/sms/conversations/search with a JSON body"))
}

func escapeInboxSearch(value string) string {
	return strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(value)
}

// SearchConversations is a private, no-store read operation. It uses POST so
// sensitive search text never enters a URL, binds an encrypted keyset cursor
// to the tenant and normalized query, and deliberately does not echo the
// query in its response.
func (d *Deps) SearchConversations(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_tenant", ""))
		return
	}
	if r.URL.RawQuery != "" {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_query", "search parameters belong in the JSON body"))
		return
	}
	var req searchConversationsRequest
	if err := httpbody.DecodeJSON(w, r, 8<<10, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_json", httpbody.PublicMessage(err)))
		return
	}
	q := strings.TrimSpace(req.Query)
	if len([]rune(q)) < 3 || !validInboxText(q, 128) {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_search_query", "query must be 3 to 128 safe Unicode characters"))
		return
	}
	limit := 50
	if req.Limit != nil {
		limit = *req.Limit
	}
	if limit < 1 || limit > 200 {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_limit", "limit must be between 1 and 200"))
		return
	}
	if !validInboxCursorKey(d.InboxCursorKey) {
		writeInboxCursorError(w, errInboxCursorUnavailable)
		return
	}
	dbNow, err := d.store().InboxDatabaseNow(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	binding := inboxCursorBinding(tenant.ID, "admin", strings.ToLower(q))
	cursor, err := decodeInboxCursor(d.inboxCursorKeys(), req.Cursor, tenant.ID, "search", binding, dbNow)
	if err != nil {
		writeInboxCursorError(w, err)
		return
	}
	if cursor.KeyID != "" {
		if normalized, err := NormalizePhoneUSCA(cursor.KeyID); err != nil || normalized != cursor.KeyID || cursor.KeyAt.IsZero() {
			writeInboxCursorError(w, errInboxInvalidCursor)
			return
		}
	}
	tx, err := db.WithTenantOptions(r.Context(), d.Store.Pool, tenant.ID, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var keyAt any
	if cursor.KeyID != "" {
		keyAt = cursor.KeyAt
	}
	rows, err := tx.Query(r.Context(), `
WITH matched_phones AS (
  SELECT DISTINCT phone_e164
    FROM sms_messages
   WHERE tenant_id = $1::uuid
     AND created_at <= $3
     AND (body ILIKE '%' || $2 || '%' ESCAPE E'\\'
       OR phone_e164 ILIKE '%' || $2 || '%' ESCAPE E'\\')
  UNION
  SELECT DISTINCT phone_e164
    FROM sms_subscriptions
   WHERE tenant_id = $1::uuid
     AND subscriber_email::text ILIKE '%' || $2 || '%' ESCAPE E'\\'
), agg AS (
  SELECT phone_e164, MAX(created_at) AS last_at, COUNT(*)::int AS msg_count
    FROM sms_messages
   WHERE tenant_id = $1::uuid AND created_at <= $3
     AND phone_e164 IN (SELECT phone_e164 FROM matched_phones)
   GROUP BY phone_e164
)
SELECT agg.phone_e164,
       COALESCE(latest.body, '')             AS preview,
       agg.last_at,
       COALESCE(latest.direction, 'inbound') AS last_direction,
       agg.msg_count,
       COALESCE(unread.cnt, 0)::int AS unread_count,
       unread.oldest_at AS oldest_unread_at,
       COALESCE(sub.subscriber_email, '') AS subscriber_email,
       COALESCE(sub.identity_count, 0) > 1 AS identity_ambiguous,
		 st.snooze_until, st.archived_at, st.assignee_user_id::text,
		 st.lifecycle_updated_at
  FROM agg
  LEFT JOIN sms_conversation_state st
    ON st.tenant_id = $1::uuid AND st.phone_e164 = agg.phone_e164
  LEFT JOIN LATERAL (
    SELECT body, direction
      FROM sms_messages
     WHERE tenant_id = $1::uuid AND phone_e164 = agg.phone_e164 AND created_at <= $3
     ORDER BY created_at DESC, id DESC LIMIT 1
  ) AS latest ON true
  LEFT JOIN LATERAL (
    SELECT CASE WHEN COUNT(DISTINCT subscriber_email) = 1
                THEN MIN(subscriber_email)::text ELSE '' END AS subscriber_email,
           COUNT(DISTINCT subscriber_email)::int AS identity_count
      FROM sms_subscriptions
     WHERE tenant_id = $1::uuid AND phone_e164 = agg.phone_e164
       AND subscriber_email IS NOT NULL
  ) AS sub ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS cnt, MIN(m.created_at) AS oldest_at
      FROM sms_messages m
     WHERE m.tenant_id = $1::uuid AND m.phone_e164 = agg.phone_e164
       AND m.direction = 'inbound' AND m.created_at <= $3
       AND NOT EXISTS (
         SELECT 1 FROM sms_message_read_receipts rr
          WHERE rr.tenant_id = m.tenant_id AND rr.message_id = m.id
            AND rr.read_at <= $3
       )
  ) AS unread ON true
 WHERE ($4::timestamptz IS NULL OR agg.last_at < $4 OR (agg.last_at = $4 AND agg.phone_e164 > $5))
 ORDER BY agg.last_at DESC, agg.phone_e164 ASC
 LIMIT $6`, tenant.ID, escapeInboxSearch(q), cursor.SnapshotAt, keyAt, cursor.KeyID, limit+1)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	defer rows.Close()
	out := searchConversationsResponse{TenantID: tenant.ID, Conversations: []ConversationSummary{}, SnapshotAt: cursor.SnapshotAt}
	for rows.Next() {
		var c ConversationSummary
		if err := rows.Scan(&c.PhoneE164, &c.LastMessagePreview, &c.LastMessageAt,
			&c.LastDirection, &c.MessageCount, &c.UnreadCount, &c.OldestUnreadAt,
			&c.SubscriberEmail, &c.IdentityAmbiguous, &c.SnoozeUntil, &c.ArchivedAt,
			&c.AssigneeUserID, &c.StateUpdatedAt); err != nil {
			rows.Close()
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		applyConversationPreviewContract(&c)
		if !validConversationSummaryProjection(c) {
			rows.Close()
			httperror.WriteInternal(w, d.Logger, errSMSProjectionOutsideContract, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		out.Conversations = append(out.Conversations, c)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	rows.Close()
	if len(out.Conversations) > limit {
		out.Conversations = out.Conversations[:limit]
		last := out.Conversations[len(out.Conversations)-1]
		out.NextCursor, err = encodeInboxCursor(d.InboxCursorKey, tenant.ID, "search", binding, inboxCursorPosition{
			SnapshotAt: cursor.SnapshotAt,
			KeyAt:      last.LastMessageAt,
			KeyID:      last.PhoneE164,
		})
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := d.auditSMSInboxRead(r, "sms.inbox.search", "/api/v1/sms/conversations/search", len(out.Conversations), out.SnapshotAt, out.NextCursor != ""); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------

type ActivityEvent struct {
	Kind  string         `json:"kind"`
	At    time.Time      `json:"at"`
	Title string         `json:"title"`
	Meta  map[string]any `json:"meta,omitempty"`
}

type conversationActivityResponse struct {
	TenantID        string          `json:"tenantId"`
	PhoneE164       string          `json:"phoneE164"`
	Events          []ActivityEvent `json:"events"`
	SnapshotAt      time.Time       `json:"snapshotAt"`
	Truncated       bool            `json:"truncated"`
	SourcePlanes    []string        `json:"sourcePlanes"`
	HistoryComplete bool            `json:"historyComplete"`
}

// GetConversationActivity exposes immutable consent evidence plus the current
// per-list subscription state for one phone. It intentionally does not claim
// operator-state or suppression-history completeness.
// The frontend renders it in a small panel inside the thread.
//
// Tables consulted (all fail closed):
//
//	sms_consent_events      — opt-in / opt-out history
//	sms_subscriptions       — subscription lifecycle
func (d *Deps) GetConversationActivity(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_tenant", ""))
		return
	}
	if err := validateInboxQuery(r.URL.Query()); err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_query", "conversation activity does not accept query parameters"))
		return
	}
	phone := normalizePhoneE164ForLookup(chi.URLParam(r, "phone"))
	if phone == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_phone", ""))
		return
	}
	tx, err := db.WithTenantOptions(r.Context(), d.store().Pool, tenant.ID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var asOf time.Time
	if err := tx.QueryRow(r.Context(), `SELECT clock_timestamp()`).Scan(&asOf); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	out := make([]ActivityEvent, 0, 150)
	truncated := false

	// Immutable consent evidence. Provider payload/proof text stays in the
	// governed evidence plane; the inbox emits only controlled enums.
	rows, err := tx.Query(r.Context(), `
	SELECT id::text, action, created_at, COALESCE(source, '')
	  FROM sms_consent_events
	 WHERE tenant_id = $1::uuid AND phone_e164 = $2
	   AND created_at <= $3
	 ORDER BY created_at DESC, id DESC LIMIT 101`, tenant.ID, phone, asOf)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	for rows.Next() {
		var id, action, source string
		var at time.Time
		if err := rows.Scan(&id, &action, &at, &source); err != nil {
			rows.Close()
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		if len(out) == 100 {
			truncated = true
			continue
		}
		title := map[string]string{
			"granted": "Consent granted", "revoked": "Consent revoked",
			"help_requested": "Help requested", "imported": "Consent imported",
		}[action]
		if title == "" {
			rows.Close()
			httperror.WriteInternal(w, d.Logger, errors.New("invalid SMS consent action in activity projection"), httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		if !validCanonicalUUIDV4(id) || !validProjectionTime(at) || at.After(asOf) ||
			!oneOf(source, "keyword", "form", "import", "api", "manual", "twilio", "telnyx", "bandwidth", "product") {
			rows.Close()
			httperror.WriteInternal(w, d.Logger, errors.New("invalid SMS consent evidence token in activity projection"), httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		out = append(out, ActivityEvent{
			Kind: "consent", At: at, Title: title,
			Meta: map[string]any{"evidenceId": id, "source": source},
		})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	rows.Close()

	// Current per-list lifecycle evidence. This is explicitly not a complete
	// mutation history; consent events above remain the immutable chronology.
	subs, err := tx.Query(r.Context(), `
SELECT list_id::text, status, COALESCE(consent_source, ''), updated_at
  FROM sms_subscriptions
 WHERE tenant_id = $1::uuid AND phone_e164 = $2
 ORDER BY updated_at DESC, list_id DESC
	 LIMIT 51`, tenant.ID, phone)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	subscriptionRows := 0
	for subs.Next() {
		var listID, status, source string
		var observedAt time.Time
		if err := subs.Scan(&listID, &status, &source, &observedAt); err != nil {
			subs.Close()
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		if subscriptionRows == 50 {
			truncated = true
			continue
		}
		subscriptionRows++
		if !validCanonicalUUIDV4(listID) || !oneOf(status, "pending", "opted_in", "opted_out") ||
			!oneOf(source, "keyword", "form", "import", "api", "manual", "unknown") ||
			!validProjectionTime(observedAt) || observedAt.After(asOf) {
			subs.Close()
			httperror.WriteInternal(w, d.Logger, errors.New("invalid SMS subscription token in activity projection"), httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		title := map[string]string{"pending": "Current list consent: Pending", "opted_in": "Current list consent: Opted in", "opted_out": "Current list consent: Opted out"}[status]
		out = append(out, ActivityEvent{Kind: "subscription", At: observedAt, Title: title, Meta: map[string]any{"listId": listID, "source": source}})
	}
	if err := subs.Err(); err != nil {
		subs.Close()
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	subs.Close()

	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	sortDescByAt(out)
	if err := d.auditSMSInboxRead(r, "sms.inbox.activity.read", "/api/v1/sms/conversations/{phone}/activity", len(out), asOf, truncated); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, conversationActivityResponse{
		TenantID: tenant.ID, PhoneE164: phone, Events: out, SnapshotAt: asOf,
		Truncated:       truncated,
		SourcePlanes:    []string{"sms_consent_events", "sms_subscriptions_current"},
		HistoryComplete: false,
	})
}

func sortDescByAt(events []ActivityEvent) {
	sort.SliceStable(events, func(i, j int) bool {
		if !events[i].At.Equal(events[j].At) {
			return events[i].At.After(events[j].At)
		}
		if events[i].Kind != events[j].Kind {
			return events[i].Kind < events[j].Kind
		}
		return activityTieID(events[i]) > activityTieID(events[j])
	})
}

func activityTieID(event ActivityEvent) string {
	if id, ok := event.Meta["evidenceId"].(string); ok {
		return id
	}
	id, _ := event.Meta["listId"].(string)
	return id
}

// ---------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------

// ExportConversationsCSV streams the conversation list (latest message
// per phone) as CSV. Capped at 10k rows — auditors typically scope by
// date range; the cap protects against accidental full-tenant exports.
func (d *Deps) ExportConversationsCSV(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("missing_tenant", ""))
		return
	}
	if err := validateInboxQuery(r.URL.Query(), "limit"); err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_query", err.Error()))
		return
	}
	limit, err := parseInboxLimit(r.URL.Query().Get("limit"), 10_000, 10_000)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_limit", "limit must be between 1 and 10000"))
		return
	}
	reason := strings.TrimSpace(r.Header.Get("X-Postwave-Audit-Reason"))
	if reason == "" || !validInboxText(reason, 160) {
		writeJSON(w, http.StatusBadRequest, errEnv("audit_reason_required", "X-Postwave-Audit-Reason is required for a bulk SMS export"))
		return
	}
	tx, err := db.WithTenantOptions(r.Context(), d.Store.Pool, tenant.ID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var asOf time.Time
	if err := tx.QueryRow(r.Context(), `SELECT clock_timestamp()`).Scan(&asOf); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	rows, err := tx.Query(r.Context(), `
SELECT phone_e164,
       MAX(created_at)                                       AS last_at,
       COUNT(*)                                              AS msg_count,
       MAX(created_at) FILTER (WHERE direction = 'inbound') AS last_inbound_at
 FROM sms_messages
 WHERE tenant_id = $1::uuid
   AND created_at <= $2
   AND phone_e164 ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'
 GROUP BY phone_e164
 ORDER BY last_at DESC, phone_e164 ASC
 LIMIT $3`, tenant.ID, asOf, limit+1)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	type exportRow struct {
		phone        string
		lastAt       time.Time
		messageCount int
		lastInbound  *time.Time
	}
	exported := make([]exportRow, 0, limit+1)
	for rows.Next() {
		var row exportRow
		if err := rows.Scan(&row.phone, &row.lastAt, &row.messageCount, &row.lastInbound); err != nil {
			rows.Close()
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		normalized, normalizeErr := NormalizePhoneUSCA(row.phone)
		if normalizeErr != nil || normalized != row.phone || row.messageCount < 1 ||
			!validProjectionTime(row.lastAt) || row.lastAt.After(asOf) ||
			!validOptionalProjectionTime(row.lastInbound) ||
			row.lastInbound != nil && (row.lastInbound.After(row.lastAt) || row.lastInbound.After(asOf)) {
			rows.Close()
			httperror.WriteInternal(w, d.Logger, errSMSProjectionOutsideContract, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		exported = append(exported, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	rows.Close()
	truncated := len(exported) > limit
	if truncated {
		exported = exported[:limit]
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	var body bytes.Buffer
	csvWriter := csv.NewWriter(&body)
	if err := csvWriter.Write([]string{"phone_e164", "last_message_at", "message_count", "last_inbound_at"}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	for _, row := range exported {
		lastInbound := ""
		if row.lastInbound != nil {
			lastInbound = row.lastInbound.UTC().Format(time.RFC3339Nano)
		}
		if err := csvWriter.Write([]string{
			spreadsheetSafeCSVCell(row.phone),
			row.lastAt.UTC().Format(time.RFC3339Nano),
			strconv.Itoa(row.messageCount),
			lastInbound,
		}); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
	}
	csvWriter.Flush()
	if err := csvWriter.Error(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	if err := d.auditSMSInboxRead(r, "sms.inbox.export", "/api/v1/sms/conversations.csv", len(exported), asOf, truncated); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="postwave-sms-conversations-`+asOf.UTC().Format("20060102-150405")+`.csv"`)
	w.Header().Set("X-Postwave-Export-Limit", strconv.Itoa(limit))
	w.Header().Set("X-Postwave-Export-As-Of", asOf.UTC().Format(time.RFC3339Nano))
	w.Header().Set("X-Postwave-Export-Row-Count", strconv.Itoa(len(exported)))
	w.Header().Set("X-Postwave-Truncated", strconv.FormatBool(truncated))
	w.Header().Set("Content-Length", strconv.Itoa(body.Len()))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body.Bytes())
}

func spreadsheetSafeCSVCell(value string) string {
	if value != "" && strings.ContainsRune("=+-@\t\r", rune(value[0])) {
		return "'" + value
	}
	return value
}
