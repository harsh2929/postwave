package campaigns

// feedback.go — Workstream 2 (B): per-campaign collaborative feedback.
// Mailchimp surfaces "Add a comment" on each draft so a reviewer can
// leave a note that the author marks resolved. Storage is
// campaign_feedback (migration 0228); the comment ledger is append-
// only with a nullable resolved_at flip so the UI can hide the
// resolved set without losing the audit trail.

import (
	"context"
	"errors"
	"net/http"
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

const feedbackJSONMaxBodyBytes int64 = 16 << 10 // 16 KiB — body is text-only

// Feedback is one comment row on a campaign draft. AuthorUserID may be
// empty for sandbox / API-key writers; AuthorLabel mirrors the email
// shown in the UI so historical entries stay readable after the user
// is deleted.
type Feedback struct {
	ID           string     `json:"id"`
	TenantID     string     `json:"tenant_id"`
	CampaignID   string     `json:"campaign_id"`
	AuthorUserID string     `json:"author_user_id,omitempty"`
	AuthorLabel  string     `json:"author_label,omitempty"`
	Body         string     `json:"body"`
	ResolvedAt   *time.Time `json:"resolved_at,omitempty"`
	ResolvedBy   string     `json:"resolved_by,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

// FeedbackInput is the request body for POST + PATCH. PATCH treats an
// empty body as a no-op so the resolve endpoint can reuse the type.
type FeedbackInput struct {
	Body string `json:"body"`
}

// ErrFeedbackNotFound is returned when a comment lookup misses.
var ErrFeedbackNotFound = errors.New("campaign feedback not found")

// MountFeedback wires the feedback CRUD + resolve action.
func MountFeedback(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/campaigns/{id}/feedback", d.ListFeedback)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/campaigns/{id}/feedback", d.CreateFeedback)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Patch("/api/v1/campaigns/{id}/feedback/{fid}", d.UpdateFeedback)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/campaigns/{id}/feedback/{fid}/resolve", d.ResolveFeedback)
}

// ---- handlers --------------------------------------------------------

func (d *Deps) ListFeedback(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	rows, err := d.Repo.ListFeedback(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rows})
}

func (d *Deps) CreateFeedback(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in FeedbackInput
	if err := httpbody.DecodeJSON(w, r, feedbackJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Body = strings.TrimSpace(in.Body)
	if in.Body == "" {
		httperror.WriteValidation(w, "validation_failed", "body is required")
		return
	}
	authorID, authorLabel := actorIdentity(r)
	row, err := d.Repo.CreateFeedback(r.Context(), t.ID, chi.URLParam(r, "id"), authorID, authorLabel, in.Body)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, row)
}

func (d *Deps) UpdateFeedback(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in FeedbackInput
	if err := httpbody.DecodeJSON(w, r, feedbackJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Body = strings.TrimSpace(in.Body)
	if in.Body == "" {
		httperror.WriteValidation(w, "validation_failed", "body is required")
		return
	}
	row, err := d.Repo.UpdateFeedback(r.Context(), t.ID, chi.URLParam(r, "id"), chi.URLParam(r, "fid"), in.Body)
	if err != nil {
		if errors.Is(err, ErrFeedbackNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "feedback not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, row)
}

func (d *Deps) ResolveFeedback(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	resolverID, _ := actorIdentity(r)
	row, err := d.Repo.ResolveFeedback(r.Context(), t.ID, chi.URLParam(r, "id"), chi.URLParam(r, "fid"), resolverID, time.Now().UTC())
	if err != nil {
		if errors.Is(err, ErrFeedbackNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "feedback not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, row)
}

// actorIdentity extracts the acting user id + display label from the
// request context. Falls back to ("", actor_label) when no session
// user is present (API key / dev slug auth).
func actorIdentity(r *http.Request) (string, string) {
	userID := ""
	label := ""
	if u, ok := middleware.UserFromContext(r.Context()); ok {
		userID = u.ID
		label = u.Email
	}
	if label == "" {
		_, label = middleware.ActorFromContext(r.Context())
	}
	return userID, label
}

// ---- repo methods ----------------------------------------------------

// ListFeedback returns every comment for a campaign newest-first. The
// UI groups resolved vs unresolved client-side.
func (r *Repo) ListFeedback(ctx context.Context, tenantID, campaignID string) ([]Feedback, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, feedbackSelectSQL+`
WHERE tenant_id = $1::uuid AND campaign_id::text = $2
ORDER BY created_at DESC`, tenantID, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Feedback{}
	for rows.Next() {
		row, err := scanFeedback(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// CreateFeedback appends a new comment. Returns ErrNotFound when the
// campaign doesn't exist for the tenant — caught via the FK constraint
// then disambiguated here so the handler can 404 cleanly.
func (r *Repo) CreateFeedback(ctx context.Context, tenantID, campaignID, authorID, authorLabel, body string) (*Feedback, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Pre-check the campaign exists so the FK violation doesn't leak as
	// a generic 500 to the operator.
	var ok bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM campaigns WHERE tenant_id = $1::uuid AND id::text = $2
)`, tenantID, campaignID).Scan(&ok); err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrNotFound
	}

	var id string
	err = tx.QueryRow(ctx, `
INSERT INTO campaign_feedback (tenant_id, campaign_id, author_user_id, author_label, body)
VALUES ($1::uuid, $2::uuid, NULLIF($3, '')::uuid, $4, $5)
RETURNING id::text`,
		tenantID, campaignID, authorID, authorLabel, body).Scan(&id)
	if err != nil {
		return nil, err
	}
	row, err := queryFeedbackTx(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return row, nil
}

// UpdateFeedback rewrites the body of an existing comment.
func (r *Repo) UpdateFeedback(ctx context.Context, tenantID, campaignID, feedbackID, body string) (*Feedback, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE campaign_feedback
   SET body = $4, updated_at = now()
 WHERE tenant_id = $1::uuid
   AND campaign_id::text = $2
   AND id::text = $3`,
		tenantID, campaignID, feedbackID, body)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrFeedbackNotFound
	}
	row, err := queryFeedbackTx(ctx, tx, tenantID, feedbackID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return row, nil
}

// ResolveFeedback stamps resolved_at + resolved_by. Idempotent: a
// repeated call returns the existing resolved row without mutating
// the original timestamp.
func (r *Repo) ResolveFeedback(ctx context.Context, tenantID, campaignID, feedbackID, resolverID string, now time.Time) (*Feedback, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE campaign_feedback
   SET resolved_at = COALESCE(resolved_at, $4),
       resolved_by = COALESCE(resolved_by, NULLIF($5, '')::uuid),
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND campaign_id::text = $2
   AND id::text = $3`,
		tenantID, campaignID, feedbackID, now, resolverID)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrFeedbackNotFound
	}
	row, err := queryFeedbackTx(ctx, tx, tenantID, feedbackID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return row, nil
}

const feedbackSelectSQL = `
SELECT id::text,
       tenant_id::text,
       campaign_id::text,
       COALESCE(author_user_id::text, ''),
       COALESCE(author_label, ''),
       body,
       resolved_at,
       COALESCE(resolved_by::text, ''),
       created_at,
       updated_at
  FROM campaign_feedback
`

func queryFeedbackTx(ctx context.Context, tx pgx.Tx, tenantID, id string) (*Feedback, error) {
	row := tx.QueryRow(ctx, feedbackSelectSQL+`
WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	out, err := scanFeedback(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrFeedbackNotFound
		}
		return nil, err
	}
	return out, nil
}

func scanFeedback(s scanner) (*Feedback, error) {
	var f Feedback
	if err := s.Scan(
		&f.ID,
		&f.TenantID,
		&f.CampaignID,
		&f.AuthorUserID,
		&f.AuthorLabel,
		&f.Body,
		&f.ResolvedAt,
		&f.ResolvedBy,
		&f.CreatedAt,
		&f.UpdatedAt,
	); err != nil {
		return nil, err
	}
	return &f, nil
}
