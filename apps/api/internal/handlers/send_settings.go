// SPDX-License-Identifier: AGPL-3.0-only
//
// Tenant-level send defaults. Backed by tenant_send_settings (migration
// 0299). sto-strategy-persistence (P2). Mirrors the security settings
// handler pattern (lazy-default row, single UPSERT on PUT).
//
// Purpose: lets an operator pin a workspace-wide default send-time
// strategy ("modal_hour" / "per_recipient" / "none") so that the
// /campaigns/{id}/schedule-by-best-time handler picks it up when the
// request body omits `strategy`. Matches the Klaviyo / Braze /
// MoEngage / Iterable convention of a workspace-level STO default.
//
// The handler is intentionally narrow — no admin-only validation
// beyond the CHECK constraint pinned in the DB; the desktop settings
// surface gates the UI to admins via the existing useCanWrite hook,
// and the apikeys.RequireScope on the route in main.go pins the API
// surface to ScopeAdmin.

package handlers

import (
	"log/slog"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// SendSettingsHandlers wraps the tenant_send_settings GET/PUT surface.
// Constructed in main.go with the same pgxpool other handlers use.
type SendSettingsHandlers struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal for structured server-side
	// logging of unexpected failures. nil-safe — when nil, internal errors
	// are still returned to the client as the generic envelope but no log
	// line is emitted. main.go wires the process-wide *slog.Logger here.
	Logger *slog.Logger
}

// sendSettingsJSONMaxBodyBytes bounds the PUT body. Small payload
// (one enum + one bool), so 16 KiB is plenty.
const sendSettingsJSONMaxBodyBytes int64 = 16 << 10

// SendSettings is the JSON shape on the wire. Empty default_sto_strategy
// in a GET means "tenant has no default yet"; the desktop renders this
// as the "Use the global default" radio option.
type SendSettings struct {
	// DefaultSTOStrategy: one of "none" | "modal_hour" | "per_recipient".
	// CHECK constraint pins the vocabulary at the DB layer.
	DefaultSTOStrategy string `json:"default_sto_strategy"`
	// NewslettersForcePerRecipient: when true, the API auto-flips
	// send_time_strategy to "per_recipient" for any campaign whose
	// campaign_type is "newsletter" at create / schedule time. Mirrors
	// the audit sketch's "always use per_recipient for newsletters"
	// rule. The enforcement code lives in the campaigns package; this
	// handler only stores the boolean.
	NewslettersForcePerRecipient bool `json:"newsletters_force_per_recipient"`
}

// validStrategy is in lockstep with the DB CHECK constraint shipped in
// migration 0299. We keep it here (rather than reaching into the
// campaigns package) so the handlers layer stays import-cycle-free.
func validStrategy(s string) bool {
	switch s {
	case "", "none", "modal_hour", "per_recipient":
		return true
	}
	return false
}

// Get GET /api/v1/send-settings.
//
// Returns the persisted row, or a zero-value default ("none", false)
// when no row exists yet. Lazy-row pattern mirrors SecurityHandlers.Get.
func (h *SendSettingsHandlers) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var s SendSettings
	err = tx.QueryRow(r.Context(), `
SELECT default_sto_strategy, newsletters_force_per_recipient
  FROM tenant_send_settings
 WHERE tenant_id = $1::uuid`, t.ID).
		Scan(&s.DefaultSTOStrategy, &s.NewslettersForcePerRecipient)
	if err == pgx.ErrNoRows {
		// Lazy default — never-touched tenants get "none" + false so
		// the desktop renders the "no default pinned yet" state.
		s = SendSettings{DefaultSTOStrategy: "none"}
	} else if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// Update PUT /api/v1/send-settings.
//
// UPSERTs the row. Rejects unknown strategy values up-front with a 400
// so the operator gets a clear error instead of a DB CHECK violation.
func (h *SendSettingsHandlers) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in SendSettings
	if err := httpbody.DecodeJSON(w, r, sendSettingsJSONMaxBodyBytes, &in); err != nil {
		// httpbody.DecodeJSON returns operator-safe text (bad_json,
		// payload_too_large, etc.) — safe to echo verbatim.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if !validStrategy(in.DefaultSTOStrategy) {
		httperror.Write(w, http.StatusBadRequest, "bad_strategy",
			"default_sto_strategy must be one of: none, modal_hour, per_recipient")
		return
	}
	if in.DefaultSTOStrategy == "" {
		in.DefaultSTOStrategy = "none"
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var userID *string
	if u, ok := middleware.UserFromContext(r.Context()); ok && u.ID != "" {
		id := u.ID
		userID = &id
	}

	_, err = tx.Exec(r.Context(), `
INSERT INTO tenant_send_settings (
    tenant_id, default_sto_strategy, newsletters_force_per_recipient,
    updated_at, updated_by)
VALUES ($1::uuid, $2, $3, now(), $4)
ON CONFLICT (tenant_id) DO UPDATE SET
    default_sto_strategy            = EXCLUDED.default_sto_strategy,
    newsletters_force_per_recipient = EXCLUDED.newsletters_force_per_recipient,
    updated_at                      = now(),
    updated_by                      = EXCLUDED.updated_by`,
		t.ID, in.DefaultSTOStrategy, in.NewslettersForcePerRecipient, userID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, in)
}
