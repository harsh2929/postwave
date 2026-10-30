// SPDX-License-Identifier: AGPL-3.0-only
package campaigntemplates

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type TemplateReviewEvent struct {
	ID              string    `json:"id"`
	TemplateVersion int64     `json:"template_version"`
	ActorEmail      string    `json:"actor_email"`
	Kind            string    `json:"kind"`
	Body            string    `json:"body"`
	CreatedAt       time.Time `json:"created_at"`
}

type templateReviewInput struct {
	Version int64  `json:"version"`
	Kind    string `json:"kind"`
	Body    string `json:"body"`
}

func validateTemplateReviewInput(in templateReviewInput) bool {
	if in.Version < 1 || utf8.RuneCountInString(in.Body) > 4000 || strings.ContainsRune(in.Body, 0) {
		return false
	}
	switch in.Kind {
	case "comment", "request_changes":
		return strings.TrimSpace(in.Body) != ""
	case "approve":
		return strings.TrimSpace(in.Body) == ""
	default:
		return false
	}
}

// ListReviewEvents returns append-only notes and decisions for a tenant-owned
// editable template. The client groups them by immutable template version.
func (d *Deps) ListReviewEvents(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok || d.ReviewPool == nil {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		httperror.WriteValidation(w, "invalid_template_id", "template id is invalid")
		return
	}
	version, err := strconv.ParseInt(r.URL.Query().Get("version"), 10, 64)
	if err != nil || version < 1 {
		httperror.WriteValidation(w, "invalid_template_version", "a positive template version is required")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.ReviewPool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var kind string
	if err := tx.QueryRow(r.Context(), `
SELECT template_kind FROM campaign_templates
 WHERE id = $1::uuid AND tenant_id = $2::uuid`, id, tenant.ID).Scan(&kind); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "not_found", "")
		} else {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	if kind != templateKindEditable {
		httperror.Write(w, http.StatusNotFound, "not_found", "")
		return
	}
	rows, err := tx.Query(r.Context(), `
SELECT e.id::text, e.template_version, COALESCE(u.email, ''),
       e.kind, e.body, e.created_at
  FROM campaign_template_review_events e
  LEFT JOIN users u ON u.id = e.actor_user_id
 WHERE e.tenant_id = $1::uuid AND e.template_id = $2::uuid
   AND e.template_version = $3
 ORDER BY e.created_at DESC, e.id DESC LIMIT 101`, tenant.ID, id, version)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	items := []TemplateReviewEvent{}
	for rows.Next() {
		var event TemplateReviewEvent
		if err := rows.Scan(&event.ID, &event.TemplateVersion, &event.ActorEmail, &event.Kind, &event.Body, &event.CreatedAt); err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		items = append(items, event)
	}
	if err := rows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	truncated := len(items) > 100
	if truncated {
		items = items[:100]
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "truncated": truncated})
}

// AddReviewEvent binds the decision or comment to the exact strong template
// ETag under a row lock. A later template save cannot inherit this approval.
func (d *Deps) AddReviewEvent(w http.ResponseWriter, r *http.Request) {
	tenant, hasTenant := middleware.TenantFromContext(r.Context())
	actor, hasActor := middleware.UserFromContext(r.Context())
	if !hasTenant || !hasActor || actor.ID == "" || d.ReviewPool == nil {
		httperror.Write(w, http.StatusUnauthorized, "user_required", "A signed-in user is required")
		return
	}
	if actor.TenantID != tenant.ID {
		httperror.Write(w, http.StatusForbidden, "tenant_mismatch", "Review actor is not in this workspace")
		return
	}
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		httperror.WriteValidation(w, "invalid_template_id", "template id is invalid")
		return
	}
	ifMatch, ok := requireTemplateIfMatch(w, r)
	if !ok {
		return
	}
	var in templateReviewInput
	if err := httpbody.DecodeJSON(w, r, 24*1024, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if !validateTemplateReviewInput(in) {
		httperror.WriteValidation(w, "invalid_template_review", "version, kind, or body is invalid")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.ReviewPool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var version int64
	var kind string
	if err := tx.QueryRow(r.Context(), `
SELECT version, template_kind FROM campaign_templates
 WHERE id = $1::uuid AND tenant_id = $2::uuid AND archived_at IS NULL
 FOR SHARE`, id, tenant.ID).Scan(&version, &kind); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httperror.Write(w, http.StatusNotFound, "not_found", "")
		} else {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	if kind != templateKindEditable {
		httperror.Write(w, http.StatusNotFound, "not_found", "")
		return
	}
	if version != in.Version || templateETag(&Template{ID: id, Version: version}) != ifMatch {
		httpcache.WritePreconditionFailed(w)
		return
	}
	var event TemplateReviewEvent
	err = tx.QueryRow(r.Context(), `
INSERT INTO campaign_template_review_events
       (tenant_id, template_id, template_version, actor_user_id, kind, body)
VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6)
RETURNING id::text, template_version, kind, body, created_at`,
		tenant.ID, id, version, actor.ID, in.Kind, strings.TrimSpace(in.Body),
	).Scan(&event.ID, &event.TemplateVersion, &event.Kind, &event.Body, &event.CreatedAt)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	event.ActorEmail = actor.Email
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.Header().Set("ETag", ifMatch)
	w.Header().Set("X-Template-Version", strconv.FormatInt(version, 10))
	writeJSON(w, http.StatusCreated, event)
}
