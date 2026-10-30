// SPDX-License-Identifier: AGPL-3.0-only
//
// gift_edit.go — the read + edit half of the gift-subscriptions admin
// surface. list/create/cancel/stats already shipped (gifts.go, paid_subs.go);
// this adds GET /{id} (detail) and PATCH /{id} (edit) so an operator can
// inspect and correct a pending gift before it's claimed.
//
// Edits are deliberately constrained to message / recipient_email /
// expires_at and ONLY while status='pending' — mirroring CancelGift's
// pending-only guard so a successful redemption can never be silently
// rewritten.

package paid_tiers

import (
	"context"

	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// GetGift re-reads one gift row for the detail endpoint. Exported wrapper
// over the internal lookupGiftByID; returns ErrNotFound for a missing or
// cross-tenant id (RLS).
func (r *Repo) GetGift(ctx context.Context, tenantID, id string) (*GiftSub, error) {
	return r.lookupGiftByID(ctx, tenantID, id)
}

// GiftUpdate carries the editable fields. Nil pointers leave the column
// untouched, so PATCH only writes what the operator supplied.
type GiftUpdate struct {
	Message        *string
	RecipientEmail *string
	ExpiresAt      *time.Time
}

// UpdateGift edits a pending gift's message / recipient_email / expires_at.
// Returns ErrGiftNotPending if the row exists but is not pending, ErrNotFound
// if it does not exist (or is cross-tenant).
func (r *Repo) UpdateGift(ctx context.Context, tenantID, id string, in GiftUpdate) (*GiftSub, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE gift_subscriptions
   SET message         = COALESCE($3, message),
       recipient_email = COALESCE($4, recipient_email),
       expires_at      = COALESCE($5, expires_at)
 WHERE id = $1::uuid AND tenant_id = $2::uuid AND status = 'pending'`,
		id, tenantID, in.Message, in.RecipientEmail, in.ExpiresAt)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		// Zero rows: the id is missing/cross-tenant OR not pending.
		// Distinguish so the handler can return 404 vs 409.
		if _, gerr := r.lookupGiftByID(ctx, tenantID, id); errors.Is(gerr, ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, ErrGiftNotPending
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.lookupGiftByID(ctx, tenantID, id)
}

// Detail handles GET /api/v1/gift-subscriptions/{id}. The mounted read path
// returns the same sanitized projection as the list and never serializes the
// internal GiftSub row.
func (h *GiftHandlers) Detail(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		giftWriteErr(w, http.StatusUnauthorized, "missing_tenant", "")
		return
	}
	id, err := canonicalGiftHistoryID(chi.URLParam(r, "id"))
	if err != nil {
		giftWriteErr(w, http.StatusBadRequest, "invalid_id", "gift record identifier is invalid")
		return
	}
	g, err := h.Repo.GetGiftHistoryRecord(r.Context(), tenant.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			giftWriteErr(w, http.StatusNotFound, "not_found", "gift not found")
			return
		}
		httperror.WriteInternal(w, h.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	giftWriteJSON(w, http.StatusOK, g)
}

func canonicalGiftHistoryID(value string) (string, error) {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil {
		return "", err
	}
	return parsed.String(), nil
}

type giftUpdateInput struct {
	Message        *string    `json:"message"`
	RecipientEmail *string    `json:"recipient_email"`
	ExpiresAt      *time.Time `json:"expires_at"`
}

// Update handles PATCH /api/v1/gift-subscriptions/{id}.
func (h *GiftHandlers) Update(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		giftWriteErr(w, http.StatusUnauthorized, "missing_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		giftWriteErr(w, http.StatusBadRequest, "missing_id", "")
		return
	}
	var in giftUpdateInput
	if err := httpbody.DecodeJSON(w, r, 8<<10, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if in.Message == nil && in.RecipientEmail == nil && in.ExpiresAt == nil {
		giftWriteErr(w, http.StatusUnprocessableEntity, "validation_failed",
			"supply at least one of message, recipient_email, expires_at")
		return
	}
	if in.RecipientEmail != nil {
		e := strings.TrimSpace(*in.RecipientEmail)
		if e == "" || !strings.Contains(e, "@") {
			giftWriteErr(w, http.StatusUnprocessableEntity, "validation_failed",
				"recipient_email must be a valid email")
			return
		}
		in.RecipientEmail = &e
	}
	if in.Message != nil {
		m := strings.TrimSpace(*in.Message)
		in.Message = &m
	}
	g, err := h.Repo.UpdateGift(r.Context(), tenant.ID, id, GiftUpdate{
		Message:        in.Message,
		RecipientEmail: in.RecipientEmail,
		ExpiresAt:      in.ExpiresAt,
	})
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			giftWriteErr(w, http.StatusNotFound, "not_found", "gift not found")
		case errors.Is(err, ErrGiftNotPending):
			giftWriteErr(w, http.StatusConflict, "not_pending", "only pending gifts can be edited")
		default:
			httperror.WriteInternal(w, h.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		}
		return
	}
	audit.EmitOrLog(r.Context(), h.Repo.Pool,
		"gift_subscription.update", "gift_subscription", g.ID,
		nil, map[string]any{
			"id":     g.ID,
			"status": g.Status,
		}, map[string]any{
			"fields_changed": changedFields(in),
		})
	giftWriteJSON(w, http.StatusOK, g)
}

func changedFields(in giftUpdateInput) []string {
	out := []string{}
	if in.Message != nil {
		out = append(out, "message")
	}
	if in.RecipientEmail != nil {
		out = append(out, "recipient_email")
	}
	if in.ExpiresAt != nil {
		out = append(out, "expires_at")
	}
	return out
}
