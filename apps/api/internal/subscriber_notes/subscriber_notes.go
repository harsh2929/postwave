// SPDX-License-Identifier: AGPL-3.0-only
//
// Package subscriber_notes provides per-subscriber operator memos.
//
// Notes are NOT subscriber-visible data — they're internal
// metadata: "qualified at trade show", "needs invoice resent",
// "appears to be a competitor". Distinct from custom_fields
// (which the subscriber might see in SAR / data exports) — notes
// are operator-only context.
//
// Design choices:
//
//   * append-only edit model    no UPDATE; only INSERT + DELETE.
//                               Operators add a NEW note rather than
//                               revising an old one, which preserves
//                               the audit trail.
//   * author attribution        we stamp the requesting user's id +
//                               email at insert time
//   * pinned flag               one or two important notes can be
//                               "stickied" so the operator's first
//                               glance at a subscriber surfaces them
//
// SUB-097 extends the pane to a 2026-SOTA notes surface: markdown source,
// inline @-mentions of teammates, and file attachments. The note row gains
// markdown_body (the rich source the composer round-trips, with mentions
// stored as inline @[Name](user:id) tokens) and mentions_json (the extracted
// mention set, for "notes that mention me"); files live in the object store
// and are tracked in subscriber_note_attachments. See mentions.go and
// attachments.go.
//
// Surfaces:
//
//   GET    /api/v1/subscribers/{id}/notes
//   POST   /api/v1/subscribers/{id}/notes        body: {body|markdown_body, pinned?}
//   PATCH  /api/v1/subscribers/{id}/notes/{note} body: {pinned?, markdown_body?}
//   DELETE /api/v1/subscribers/{id}/notes/{note}
//   POST   /api/v1/subscribers/{id}/notes/{note}/attachments
//   DELETE /api/v1/subscribers/{id}/notes/{note}/attachments/{file_key}

package subscriber_notes

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/uploads"
)

const requestJSONMaxBodyBytes int64 = 8 << 10

// markdownBodyMax bounds the rich source so a runaway composer can't store
// an unbounded blob. Generous (markdown + mention tokens) vs the legacy
// plain-text `body` (4000) it supersedes.
const markdownBodyMax = 20000

// Deps wires the HTTP surface.
type Deps struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal to record server-side
	// detail (tenant_id+request_id+err) without echoing the raw error
	// text in the HTTP response. May be nil in tests; httperror tolerates
	// a nil logger and still writes the sanitized response.
	Logger *slog.Logger
	// Store backs reads and removals for existing note attachments. New
	// attachment registration is fail-closed until a verified upload-session
	// and quarantine service exists. When nil, List omits download URLs and
	// removal answers 503, while the core notes CRUD still works.
	Store uploads.Store
}

// Note is the API projection.
type Note struct {
	ID              string       `json:"id"`
	SubscriberID    string       `json:"subscriber_id"`
	SubscriberEmail string       `json:"subscriber_email"`
	Body            string       `json:"body"`
	MarkdownBody    string       `json:"markdown_body"`
	Mentions        []Mention    `json:"mentions"`
	Attachments     []Attachment `json:"attachments"`
	AuthorUserID    string       `json:"author_user_id,omitempty"`
	AuthorEmail     string       `json:"author_email,omitempty"`
	Pinned          bool         `json:"pinned"`
	CreatedAt       time.Time    `json:"created_at"`
}

type createReq struct {
	Body         string `json:"body"`
	MarkdownBody string `json:"markdown_body"`
	Pinned       bool   `json:"pinned"`
}

type updateReq struct {
	Pinned       *bool   `json:"pinned"`
	MarkdownBody *string `json:"markdown_body"`
}

// resolveBodies derives the (plainBody, markdownBody) pair to persist from
// the create/update inputs. markdown_body is the rich source when given;
// otherwise we fall back to the legacy plain `body`. The plain `body`
// column is always kept in sync as the mention-stripped projection of the
// markdown so search + old clients keep working. Pure (no DB/HTTP) for
// unit coverage. Returns an error message string ("" == ok) on a length /
// emptiness violation.
func resolveBodies(plain, markdown string) (outPlain, outMarkdown string, errMsg string) {
	markdown = strings.TrimSpace(markdown)
	plain = strings.TrimSpace(plain)
	if markdown == "" {
		markdown = plain
	}
	if markdown == "" {
		return "", "", "body or markdown_body required"
	}
	if len(markdown) > markdownBodyMax {
		return "", "", "markdown_body too long"
	}
	// The legacy plain column has a 1..4000 CHECK; clamp the derived
	// projection so a long markdown note never violates it.
	outPlain = stripMentionTokens(markdown)
	if len(outPlain) > 4000 {
		outPlain = outPlain[:4000]
	}
	if strings.TrimSpace(outPlain) == "" {
		// Markdown that is only mention tokens still needs a non-empty
		// plain projection for the CHECK; fall back to the raw markdown.
		outPlain = markdown
		if len(outPlain) > 4000 {
			outPlain = outPlain[:4000]
		}
	}
	return outPlain, markdown, ""
}

// MountRoutes registers the admin endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Get("/api/v1/subscribers/{id}/notes", d.List)
	r.With(admin).Post("/api/v1/subscribers/{id}/notes", d.Create)
	r.With(admin).Patch("/api/v1/subscribers/{id}/notes/{note}", d.Update)
	r.With(admin).Delete("/api/v1/subscribers/{id}/notes/{note}", d.Delete)
	// Creation stays mounted as an explicit, stable fail-closed capability
	// response. {file_key:.+} preserves removal of existing legacy keys.
	r.With(admin).Post("/api/v1/subscribers/{id}/notes/{note}/attachments", d.AddAttachment)
	r.With(admin).Delete("/api/v1/subscribers/{id}/notes/{note}/attachments/{file_key:.+}", d.DeleteAttachment)
}

// List GET /api/v1/subscribers/{id}/notes — pinned first.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	subID := chi.URLParam(r, "id")
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, subscriber_id::text, subscriber_email::text, body,
       COALESCE(markdown_body, body), COALESCE(mentions_json, '[]'::jsonb),
       COALESCE(author_user_id::text, ''), COALESCE(author_email::text, ''),
       pinned, created_at
  FROM subscriber_notes
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
 ORDER BY pinned DESC, created_at DESC`, t.ID, subID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []Note{}
	noteIDs := []string{}
	for rows.Next() {
		var n Note
		var mentionsRaw []byte
		if err := rows.Scan(&n.ID, &n.SubscriberID, &n.SubscriberEmail, &n.Body,
			&n.MarkdownBody, &mentionsRaw,
			&n.AuthorUserID, &n.AuthorEmail, &n.Pinned, &n.CreatedAt); err == nil {
			n.Mentions = decodeMentions(mentionsRaw)
			n.Attachments = []Attachment{}
			out = append(out, n)
			noteIDs = append(noteIDs, n.ID)
		}
	}
	rows.Close()
	// We're done with this tx; release it before the (separate) attachment
	// query so we don't hold the connection across the presign round-trips.
	_ = tx.Rollback(r.Context())

	// Inline attachments (with freshly-presigned download URLs) per note.
	byNote := d.loadAttachments(r, t.ID, noteIDs)
	for i := range out {
		if att, ok := byNote[out[i].ID]; ok {
			out[i].Attachments = att
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"notes": out, "count": len(out)})
}

// decodeMentions parses the mentions_json column into the API shape,
// tolerating null / malformed payloads by returning an empty slice.
func decodeMentions(raw []byte) []Mention {
	out := []Mention{}
	if len(raw) == 0 {
		return out
	}
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		return []Mention{}
	}
	return out
}

// Create POST /api/v1/subscribers/{id}/notes.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	subID := chi.URLParam(r, "id")
	var body createReq
	if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	plainBody, markdownBody, msg := resolveBodies(body.Body, body.MarkdownBody)
	if msg != "" {
		writeErr(w, http.StatusBadRequest, "bad_body", msg)
		return
	}
	mentions := extractMentions(markdownBody)
	mentionsJSON, _ := json.Marshal(mentions)

	var authorUserID, authorEmail any
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		if u.ID != "" {
			authorUserID = u.ID
		}
		if u.Email != "" {
			authorEmail = strings.ToLower(strings.TrimSpace(u.Email))
		}
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Resolve the subscriber's email so we can stamp it for the
	// per-email index.
	var subEmail string
	err = tx.QueryRow(r.Context(),
		`SELECT email::text FROM subscribers WHERE id = $1::uuid AND tenant_id = $2::uuid`,
		subID, t.ID).Scan(&subEmail)
	if err != nil {
		httperror.Write(w, http.StatusNotFound, "subscriber_not_found", "subscriber not found")
		return
	}

	var id string
	err = tx.QueryRow(r.Context(), `
INSERT INTO subscriber_notes
   (tenant_id, subscriber_id, subscriber_email, body, markdown_body,
    mentions_json, author_user_id, author_email, pinned)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::uuid, $8, $9)
RETURNING id::text`,
		t.ID, subID, subEmail, plainBody, markdownBody,
		string(mentionsJSON), authorUserID, authorEmail, body.Pinned).Scan(&id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

// Update PATCH /api/v1/subscribers/{id}/notes/{note} — pin/unpin and/or
// edit the markdown body. At least one of {pinned, markdown_body} must be
// present. Editing markdown_body re-syncs the plain `body` projection and
// the extracted mentions_json so the row stays self-consistent.
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	subID := chi.URLParam(r, "id")
	noteID := chi.URLParam(r, "note")
	var body updateReq
	if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if body.Pinned == nil && body.MarkdownBody == nil {
		writeErr(w, http.StatusBadRequest, "nothing_to_update", "pinned and/or markdown_body required")
		return
	}

	// Build a partial UPDATE: each field is updated only when supplied
	// (COALESCE keeps the existing value when the bound param is NULL).
	var pinnedArg any
	if body.Pinned != nil {
		pinnedArg = *body.Pinned
	}
	var plainArg, markdownArg, mentionsArg any
	if body.MarkdownBody != nil {
		plain, markdown, msg := resolveBodies("", *body.MarkdownBody)
		if msg != "" {
			writeErr(w, http.StatusBadRequest, "bad_body", msg)
			return
		}
		mentionsJSON, _ := json.Marshal(extractMentions(markdown))
		plainArg = plain
		markdownArg = markdown
		mentionsArg = string(mentionsJSON)
	}

	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(), `
UPDATE subscriber_notes SET
       pinned        = COALESCE($3::boolean, pinned),
       body          = COALESCE($5, body),
       markdown_body = COALESCE($6, markdown_body),
       mentions_json = COALESCE($7::jsonb, mentions_json)
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND id = $4::uuid`,
		t.ID, subID, pinnedArg, noteID, plainArg, markdownArg, mentionsArg)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	resp := map[string]any{}
	if body.Pinned != nil {
		resp["pinned"] = *body.Pinned
	}
	if markdownArg != nil {
		resp["markdown_body"] = markdownArg
	}
	writeJSON(w, http.StatusOK, resp)
}

// Delete DELETE /api/v1/subscribers/{id}/notes/{note}.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	subID := chi.URLParam(r, "id")
	noteID := chi.URLParam(r, "note")
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(),
		`DELETE FROM subscriber_notes
		   WHERE tenant_id = $1::uuid
		     AND subscriber_id = $2::uuid
		     AND id = $3::uuid`, t.ID, subID, noteID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

var _ = errors.New
