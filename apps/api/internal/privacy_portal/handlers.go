// SPDX-License-Identifier: AGPL-3.0-only
//
// HTTP surface for the Privacy Portal. The portal is admin-only — the
// underlying data (DSAR fulfilment, suppression breakdown,
// per-subscriber GPC flag counts) is exactly what a regulator would
// subpoena, so we don't want it gated by anything weaker than the
// admin scope.

package privacy_portal

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// Deps wires the HTTP layer.
type Deps struct {
	Repo *Repo
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// the underlying error (with tenant_id + request_id) instead of
	// echoing err.Error() back to the client. Wired by the caller after
	// construction; nil-safe at the httperror call site.
	Logger *slog.Logger
}

const portalJSONMaxBodyBytes int64 = 16 << 10 // 16 KiB

// MountRoutes registers the admin surface. Everything is namespaced
// under `/api/v1/privacy/portal/` so the privacyPortalApi block in
// apps/desktop/src/lib/api-client.ts has a single, predictable prefix —
// the frontend type names (PrivacyPortal*) are the canonical signal
// and the backend follows.
//
//	GET    /api/v1/privacy/portal                       load summary
//	GET    /api/v1/privacy/portal/regions               list regions
//	POST   /api/v1/privacy/portal/regions               add region
//	DELETE /api/v1/privacy/portal/regions/{id}          remove region
//	GET    /api/v1/privacy/portal/double-optin/pending  list pending rows
//	POST   /api/v1/privacy/portal/double-optin/{id}/resend  extend pending row 60 days
//	POST   /api/v1/privacy/portal/double-optin/{id}/cancel  delete pending row
//	GET    /api/v1/privacy/portal/preference-center     read customization
//	PATCH  /api/v1/privacy/portal/preference-center     write customization
//	PUT    /api/v1/privacy/portal/preference-center     write customization
//
// PATCH and PUT both map to UpsertPreferenceCustomization so older
// frontend builds (which call PUT — see savePreferenceCustomization in
// api-client.ts) keep working alongside the canonical PATCH method
// documented in the route-contract test.
func (d *Deps) MountRoutes(r chi.Router) {
	if d == nil || d.Repo == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Get("/api/v1/privacy/portal", d.LoadPortal)
	r.With(admin).Get("/api/v1/privacy/portal/regions", d.ListRegions)
	r.With(admin).Post("/api/v1/privacy/portal/regions", d.CreateRegion)
	r.With(admin).Delete("/api/v1/privacy/portal/regions/{id}", d.DeleteRegion)
	r.With(admin).Get("/api/v1/privacy/portal/double-optin/pending", d.ListDoubleOptInPending)
	r.With(admin).Post("/api/v1/privacy/portal/double-optin/{id}/resend", d.ResendDoubleOptIn)
	r.With(admin).Post("/api/v1/privacy/portal/double-optin/{id}/cancel", d.CancelDoubleOptIn)
	r.With(admin).Get("/api/v1/privacy/portal/preference-center", d.GetPreferenceCustomization)
	r.With(admin).Patch("/api/v1/privacy/portal/preference-center", d.UpsertPreferenceCustomization)
	r.With(admin).Put("/api/v1/privacy/portal/preference-center", d.UpsertPreferenceCustomization)
}

// LoadPortal GET /api/v1/privacy/portal.
func (d *Deps) LoadPortal(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.LoadSummary(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ListRegions GET /api/v1/privacy/regions.
func (d *Deps) ListRegions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.ListRegions(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tenantId": t.ID, "regions": out, "count": len(out)})
}

// CreateRegion POST /api/v1/privacy/regions.
func (d *Deps) CreateRegion(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in RegionInput
	if err := httpbody.DecodeJSON(w, r, portalJSONMaxBodyBytes, &in); err != nil {
		// httpbody error codes (bad_json, payload_too_large) are in the
		// httperror safe-echo allowlist — the message text is
		// operator-authored by httpbody itself.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	rg, err := d.Repo.CreateRegion(r.Context(), t.ID, in, middleware.AuditMetaFromRequest(r))
	if err != nil {
		switch {
		case errors.Is(err, ErrRegionConflict):
			// Operator-authored sentinel — safe to echo verbatim.
			httperror.Write(w, http.StatusConflict, "region_conflict", err.Error())
		case errors.Is(err, ErrInvalidFramework), errors.Is(err, ErrInvalidRegionCode):
			// Our own validator strings — safe-echo allowlist.
			httperror.WriteValidation(w, "validation_failed", err.Error())
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusCreated, rg)
}

// DeleteRegion DELETE /api/v1/privacy/regions/{id}.
func (d *Deps) DeleteRegion(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id, valid := canonicalPortalUUID(chi.URLParam(r, "id"))
	if !valid {
		writeErr(w, http.StatusBadRequest, "invalid_id", "id must be a canonical UUID")
		return
	}
	if err := d.Repo.DeleteRegion(r.Context(), t.ID, id, middleware.AuditMetaFromRequest(r)); err != nil {
		if errors.Is(err, ErrRegionNotFound) {
			writeErr(w, http.StatusNotFound, "not_found", "region not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tenantId": t.ID, "id": id})
}

// PendingDoubleOptIn is the projection returned for ops review.
type PendingDoubleOptIn struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	ListID    string `json:"list_id,omitempty"`
	SentAt    string `json:"sent_at"`
	ExpiresAt string `json:"expires_at"`
}

// ListDoubleOptInPending GET /api/v1/privacy/double-optin/pending — the
// rows the 60-day TTL worker is watching. Tenant-scoped via RLS.
func (d *Deps) ListDoubleOptInPending(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	// Keyset pagination on (sent_at, id) DESC. Default page size preserves
	// the prior LIMIT 500 (no row-count regression); the ceiling is also
	// 500 so ?limit= can never clamp below the prior behavior.
	limit, cursor, err := pagination.ReadParamsWithDefault(r.URL.Query(), 500, 500)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_cursor", "cursor is malformed")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	// $1 = limit+1; the keyset bound (when paging) takes $2/$3. Tenant
	// scoping is enforced by RLS, so there is no tenant positional param.
	args := []any{limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (sent_at, id) < ($2::timestamptz, $3::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(r.Context(), `
SELECT id::text, email::text, COALESCE(list_id::text, ''),
       sent_at, expires_at
  FROM double_optin_pending
 WHERE confirmed_at IS NULL
`+keyset+`
 ORDER BY sent_at DESC, id DESC
	 LIMIT $1`, args...)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []PendingDoubleOptIn{}
	// Track each row's raw sent_at in parallel with out so the next cursor
	// uses the correct boundary timestamp after HasMore trims the +1 row.
	sentAts := []time.Time{}
	for rows.Next() {
		var p PendingDoubleOptIn
		var sent, expires time.Time
		if err := rows.Scan(&p.ID, &p.Email, &p.ListID, &sent, &expires); err != nil {
			continue
		}
		p.SentAt = sent.UTC().Format(time.RFC3339)
		p.ExpiresAt = expires.UTC().Format(time.RFC3339)
		out = append(out, p)
		sentAts = append(sentAts, sent)
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: sentAts[len(out)-1], ID: last.ID})
	}
	resp := map[string]any{"tenantId": t.ID, "pending": out, "count": len(out)}
	if next != "" {
		resp["nextCursor"] = next
	}
	writeJSON(w, http.StatusOK, resp)
}

// ResendDoubleOptIn POST /api/v1/privacy/portal/double-optin/{id}/resend.
//
// Bumps the row's `expires_at` to now+60d and updates `sent_at` to now. This
// endpoint does not send an email; the legacy `/resend` path is retained for
// desktop compatibility. Returns a 404 when the row is missing or already
// confirmed — operators only ever extend open rows from the UI.
func (d *Deps) ResendDoubleOptIn(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id, valid := canonicalPortalUUID(chi.URLParam(r, "id"))
	if !valid {
		writeErr(w, http.StatusBadRequest, "invalid_id", "id must be a canonical UUID")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(), `
UPDATE double_optin_pending
   SET sent_at    = now(),
       expires_at = now() + interval '60 days'
 WHERE id = $1::uuid
	   AND confirmed_at IS NULL`, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "pending row not found")
		return
	}
	if err := db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r), "privacy.portal.double_optin.extend", "double_optin_pending", id, map[string]any{
		"route_template": "/api/v1/privacy/portal/double-optin/{id}/resend",
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tenantId": t.ID, "id": id})
}

// CancelDoubleOptIn POST /api/v1/privacy/portal/double-optin/{id}/cancel.
//
// Hard-deletes the pending row. The subscriber stays unconfirmed and
// the sender continues to skip them (the double-optin policy in
// consent_records gates on `confirmed_at IS NOT NULL`), but the row
// won't appear in the operator queue anymore.
func (d *Deps) CancelDoubleOptIn(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id, valid := canonicalPortalUUID(chi.URLParam(r, "id"))
	if !valid {
		writeErr(w, http.StatusBadRequest, "invalid_id", "id must be a canonical UUID")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(),
		`DELETE FROM double_optin_pending WHERE id = $1::uuid`, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "pending row not found")
		return
	}
	if err := db.Audit(r.Context(), tx, middleware.AuditMetaFromRequest(r), "privacy.portal.double_optin.cancel", "double_optin_pending", id, map[string]any{
		"route_template": "/api/v1/privacy/portal/double-optin/{id}/cancel",
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tenantId": t.ID, "id": id})
}

func canonicalPortalUUID(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	parsed, err := uuid.Parse(trimmed)
	if err != nil || parsed.String() != trimmed {
		return "", false
	}
	return trimmed, true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}
