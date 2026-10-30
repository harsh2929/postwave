// SPDX-License-Identifier: AGPL-3.0-only
//
// Package paywall implements the member-only paid-content gate. It
// owns:
//
//   - paid_members CRUD (so tenants can see who has paid access and
//     manually grant/revoke without going through Stripe webhooks)
//   - A public Allowed(ctx, campaignID, subscriberEmail) function used
//     by the campaign archive renderer + the SDK serve endpoint.
//
// Stripe webhook ingestion (subscription.created / canceled) lands in
// services/billing — that handler upserts paid_members through this
// package so all paid-state transitions go through one code path.
package paywall

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

var ErrNotFound = errors.New("paid member not found")

const paywallJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

type Member struct {
	Email                string         `json:"subscriber_email"`
	Status               string         `json:"status"`
	StripeSubscriptionID *string        `json:"stripe_subscription_id,omitempty"`
	Tier                 *string        `json:"tier,omitempty"`
	StartedAt            *time.Time     `json:"started_at"`
	CancelledAt          *time.Time     `json:"cancelled_at,omitempty"`
	Metadata             map[string]any `json:"metadata"`
}

type Repo struct{ Pool *db.Pool }

// Allowed returns true if the subscriber currently has paid access.
// Used by the public campaign render path:
//
//	visibility=public  → always allowed (caller skips this check)
//	visibility=members → allowed when the email exists in subscribers
//	                     with consent='subscribed' (caller checks)
//	visibility=paid    → allowed only when paid_members.status='active'
//
// On any error we fail closed: assume not allowed and let the caller
// render the teaser. Better a few extra paywalls than a leaked post.
func (r *Repo) Allowed(ctx context.Context, tenantID, email string) (bool, error) {
	if email == "" {
		return false, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var status string
	err = tx.QueryRow(ctx,
		`SELECT status FROM paid_members
          WHERE tenant_id = $1::uuid AND subscriber_email = lower($2)`,
		tenantID, strings.TrimSpace(email)).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, tx.Commit(ctx)
	}
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return status == "active" || status == "past_due", nil
}

// List returns one page of paid members plus the exact filtered total.
func (r *Repo) List(ctx context.Context, tenantID, status, emailSearch string, limit, offset int) ([]Member, int, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}
	// SUB-050: server-side email search over the full registry (the admin
	// list can be large, so filtering only the loaded page was insufficient).
	// Empty search ($3 = '') matches everyone; otherwise a case-insensitive
	// substring match on subscriber_email.
	search := strings.TrimSpace(emailSearch)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var total int
	if err := tx.QueryRow(ctx, `
SELECT count(*)::int
FROM paid_members
WHERE tenant_id = $1::uuid
  AND ($2 = '' OR status = $2)
  AND ($3 = '' OR subscriber_email ILIKE '%' || $3 || '%')`, tenantID, status, search).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := tx.Query(ctx, `
SELECT subscriber_email, status, stripe_subscription_id, tier,
       started_at, cancelled_at, metadata
  FROM paid_members
 WHERE tenant_id = $1::uuid
   AND ($2 = '' OR status = $2)
   AND ($3 = '' OR subscriber_email ILIKE '%' || $3 || '%')
 ORDER BY started_at DESC
 LIMIT $4 OFFSET $5`, tenantID, status, search, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []Member{}
	for rows.Next() {
		var m Member
		var meta map[string]any
		if err := rows.Scan(&m.Email, &m.Status, &m.StripeSubscriptionID,
			&m.Tier, &m.StartedAt, &m.CancelledAt, &meta); err != nil {
			return nil, 0, err
		}
		if meta == nil {
			meta = map[string]any{}
		}
		m.Metadata = meta
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return out, total, tx.Commit(ctx)
}

// Upsert grants or updates paid access. Used both by the admin handler
// (manual grant) and by Stripe webhook ingestion. We accept any
// status string to allow Stripe's exact terminology to flow through.
func (r *Repo) Upsert(ctx context.Context, tenantID string, m Member) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	meta, err := json.Marshal(m.Metadata)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
INSERT INTO paid_members (
    tenant_id, subscriber_email, status, stripe_subscription_id, tier,
    started_at, cancelled_at, metadata)
VALUES ($1::uuid, lower($2), $3, $4, $5, COALESCE($6, now()), $7, $8::jsonb)
ON CONFLICT (tenant_id, subscriber_email) DO UPDATE SET
    status                 = EXCLUDED.status,
    stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, paid_members.stripe_subscription_id),
    tier                   = COALESCE(EXCLUDED.tier, paid_members.tier),
    cancelled_at           = EXCLUDED.cancelled_at,
    metadata               = paid_members.metadata || EXCLUDED.metadata`,
		tenantID, m.Email, m.Status, m.StripeSubscriptionID, m.Tier,
		m.StartedAt, m.CancelledAt, meta)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Revoke flips the member to canceled without deleting (so we keep
// the audit trail of who was paid and when).
func (r *Repo) Revoke(ctx context.Context, tenantID, email string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE paid_members
   SET status = 'canceled', cancelled_at = now()
 WHERE tenant_id = $1::uuid AND subscriber_email = lower($2)`,
		tenantID, email)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// HTTP handlers.

type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	page := queryPositiveInt(r, "page", 1, 1, 1_000_000)
	perPage := queryPositiveInt(r, "per_page", 50, 1, 100)
	// SUB-050: `email` (alias `q`) searches the whole registry server-side.
	emailSearch := r.URL.Query().Get("email")
	if emailSearch == "" {
		emailSearch = r.URL.Query().Get("q")
	}
	out, total, err := d.Repo.List(r.Context(), t.ID, r.URL.Query().Get("status"), emailSearch, perPage, (page-1)*perPage)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"members":  out,
		"total":    total,
		"page":     page,
		"per_page": perPage,
	})
}

func queryPositiveInt(r *http.Request, key string, fallback, min, max int) int {
	value := strings.TrimSpace(r.URL.Query().Get(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < min || parsed > max {
		return fallback
	}
	return parsed
}

func (d *Deps) Grant(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in Member
	if err := httpbody.DecodeJSON(w, r, paywallJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Email == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("email_required", ""))
		return
	}
	if in.Status == "" {
		in.Status = "active"
	}
	if in.Metadata == nil {
		in.Metadata = map[string]any{}
	}
	in.Metadata["granted_via"] = "admin"
	if err := d.Repo.Upsert(r.Context(), t.ID, in); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (d *Deps) Revoke(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	email := chi.URLParam(r, "email")
	if email == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("email_required", ""))
		return
	}
	if err := d.Repo.Revoke(r.Context(), t.ID, email); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
