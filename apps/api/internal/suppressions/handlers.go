// Handlers for the X1 deliverability surface — read + write against
// the new subscriber_suppressions table (migration 0081). The legacy
// admin-list handlers in suppressions.go target the older table; both
// surfaces ship side-by-side until the dashboard cuts over.
//
// Route paths:
//   GET    /api/v1/suppressions                — paginated list
//   POST   /api/v1/suppressions                — manual add
//   DELETE /api/v1/suppressions/{email}        — manual remove
//
// Note: the legacy Deps struct in suppressions.go also mounts
// `POST /api/v1/suppressions` and `POST /api/v1/suppressions/bulk`
// against the older table. To avoid clobbering the legacy admin UI
// during the cutover, the X1 routes are registered ONLY by main.go's
// dedicated deliverability section (and not via Deps.MountRoutes).

package suppressions

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// StoreHandlers wraps the Store with HTTP entrypoints. Constructed in
// main.go and mounted with explicit chi.Router.Method calls so the
// deliverability section in main.go owns the path scoping.
//
// Logger is optional; when set, internal_error responses are logged with
// tenant_id+request_id+err via httperror.WriteInternal. Nil is safe.
//
// Audit is optional; when set, every mutation through this surface
// (add / remove / patch / bulk / mirror import) records a
// suppression_audit row best-effort — a failed audit write is logged
// but never fails the mutation (see AuditLogger.Record contract).
type StoreHandlers struct {
	Store   *Store
	Mirrors *MirrorClients
	Audit   *AuditLogger
	Logger  *slog.Logger
}

// recordAudit writes one best-effort audit row for a mutation on the
// X1 table, attributing the actor from the request context (session
// user id and/or API key id). No-op when h.Audit is nil.
func (h *StoreHandlers) recordAudit(ctx context.Context, tenantID, email string, action AuditAction, reason string, payload map[string]any) {
	if h == nil || h.Audit == nil {
		return
	}
	e := AuditEntry{
		TenantID:    tenantID,
		Email:       strings.ToLower(strings.TrimSpace(email)),
		Action:      action,
		Reason:      reason,
		SourceTable: "subscriber_suppressions",
		Payload:     payload,
	}
	if u, ok := middleware.UserFromContext(ctx); ok {
		e.ActorUserID = u.ID
	}
	e.ActorAPIKeyID = middleware.APIKeyIDFromContext(ctx)
	if err := h.Audit.Record(ctx, e); err != nil && h.Logger != nil {
		h.Logger.Warn("suppressions: audit write failed",
			"tenant_id", tenantID, "action", string(action), "err", err.Error())
	}
}

// MountX1Routes registers the X1 admin routes. Caller is responsible
// for wrapping in apikeys.RequireScope(ScopeAdmin).
func (h *StoreHandlers) MountX1Routes(r chi.Router) {
	r.Get("/api/v1/deliverability/suppressions", h.List)
	r.Post("/api/v1/deliverability/suppressions", h.Add)
	r.Delete("/api/v1/deliverability/suppressions/{email}", h.Remove)
}

// MountX1ReadRoutes registers the read-shaped X1 routes. Caller wraps
// in apikeys.RequireScope(ScopeReadSubscribers) at the main.go mount.
//
//	GET /api/v1/suppressions/trend                              (A5)
//	GET /api/v1/suppressions/{id}/timeline                      (GAP-LS-008 v1)
//	GET /api/v1/suppressions/{id}/audit                         (A3; {id} = row uuid OR email)
//	GET /api/v1/deliverability/suppressions/{email}/audit       (A3; alias the desktop client targets)
func (h *StoreHandlers) MountX1ReadRoutes(r chi.Router) {
	r.Get("/api/v1/suppressions/trend", h.Trend)
	r.Get("/api/v1/suppressions/{id}/timeline", h.Timeline)
	r.Get("/api/v1/suppressions/{id}/audit", h.AuditList)
	r.Get("/api/v1/deliverability/suppressions/{email}/audit", h.AuditList)
}

// List GET /api/v1/deliverability/suppressions?page=1&size=50&email=&q=
//
// A20: `email` filters to one address exactly (case-insensitive,
// citext-indexed); `q` filters by case-insensitive email prefix. Both
// optional; `total` reflects the filtered count.
func (h *StoreHandlers) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	email := strings.TrimSpace(r.URL.Query().Get("email"))
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	out, total, err := h.Store.ListPagedFiltered(r.Context(), t.ID, email, q, page, size)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": out,
		"total": total,
		"page":  page,
		"size":  size,
	})
}

// Trend GET /api/v1/suppressions/trend?days=30
//
// Desktop audit A5. Daily suppression-growth points over the trailing
// `days` window (default 30, clamped to 1..365). `window` is accepted
// as an alias for `days` because the pre-audit desktop client shipped
// with ?window=. Response:
//
//	{"points":[{"date":"YYYY-MM-DD","count":n,"by_reason":{...}}],"days":30}
//
// Dates are UTC days, zero-filled, oldest first.
func (h *StoreHandlers) Trend(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days == 0 {
		days, _ = strconv.Atoi(r.URL.Query().Get("window"))
	}
	if days <= 0 {
		days = 30
	}
	if days > 365 {
		days = 365
	}
	points, err := h.Store.Trend(r.Context(), t.ID, days)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"points": points,
		"days":   days,
	})
}

// looksLikeUUID is the cheap disambiguator for the {email-or-id} path
// param on the audit route. Real emails always contain '@'; a v4 uuid
// is 36 chars with 4 hyphens and never contains '@'.
func looksLikeUUID(s string) bool {
	return len(s) == 36 && !strings.Contains(s, "@") && strings.Count(s, "-") == 4
}

// AuditList GET /api/v1/suppressions/{id}/audit?page=&size=
//
// A3 / GAP-LS-008. {id} is either a subscriber_suppressions row uuid
// (resolved to its email first) or an email address directly — audit
// rows are keyed by email so the trail survives row deletion (the
// whole point of an audit log). Also mounted at
// /api/v1/deliverability/suppressions/{email}/audit for the path the
// desktop client already targets.
func (h *StoreHandlers) AuditList(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	key, err := suppressionPathParam(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_path", ""))
		return
	}
	key = strings.TrimSpace(key)
	if key == "" {
		key, err = suppressionPathParam(r, "email")
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_path", ""))
			return
		}
		key = strings.TrimSpace(key)
	}
	if key == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", ""))
		return
	}
	email := key
	if looksLikeUUID(key) {
		row, err := h.Store.FetchByID(r.Context(), t.ID, key)
		if err != nil {
			httperror.WriteInternal(w, h.Logger, err, r.Context())
			return
		}
		if row == nil {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		email = row.Email
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	size, _ := strconv.Atoi(r.URL.Query().Get("size"))
	if page < 1 {
		page = 1
	}
	items, total, err := h.Store.AuditForEmailPaged(r.Context(), t.ID, email, page, size)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": items,
		"total": total,
		"page":  page,
		"email": strings.ToLower(strings.TrimSpace(email)),
	})
}

// Chi matches RawPath when it is present. Decode that representation once;
// URL.Path is already decoded, and decoding it again corrupts literal percent
// sequences in valid email local parts.
func suppressionPathParam(r *http.Request, name string) (string, error) {
	value := chi.URLParam(r, name)
	if r.URL.RawPath != "" {
		return url.PathUnescape(value)
	}
	return value, nil
}

// addInput is the body of POST /api/v1/deliverability/suppressions.
// Operators can attach an optional expires_at when adding a transient
// hold (e.g. while a customer's mailbox provider issue resolves).
type x1AddInput struct {
	Email     string         `json:"email"`
	Reason    Reason         `json:"reason,omitempty"`
	Source    Source         `json:"source,omitempty"`
	ExpiresAt *time.Time     `json:"expires_at,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
	// GOV-031: operator-chosen channel + scope. Empty defaults to
	// email/marketing in the store.
	Channel Channel `json:"channel,omitempty"`
	Scope   Scope   `json:"scope,omitempty"`
}

// Add POST /api/v1/deliverability/suppressions
func (h *StoreHandlers) Add(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in x1AddInput
	if err := httpbody.DecodeJSON(w, r, suppressionJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Email == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_email", ""))
		return
	}
	if in.Reason == "" {
		// Manual operator adds default to list_manual so they're
		// distinguishable from API-driven and webhook-driven adds.
		in.Reason = ReasonListManual
	}
	if in.Source == "" {
		in.Source = SourceManual
	}
	// GOV-031: route through AddWithChannel so an operator-selected channel/
	// scope is written to the columns (and stashed in metadata for the
	// converger). Empty values default to email/marketing in the store.
	out, err := h.Store.AddWithChannel(r.Context(), t.ID, in.Email, in.Reason, in.Source, "", in.ExpiresAt, in.Metadata, in.Channel, in.Scope)
	if err != nil {
		// Store.Add validation errors (invalid reason/source/email) are
		// operator-safe; db errors come through the same return path so
		// we lean on a generic 400 message rather than echoing raw err.
		httperror.WriteValidation(w, "invalid_input", err.Error())
		return
	}
	h.recordAudit(r.Context(), t.ID, out.Email, AuditActionAdd, string(out.Reason),
		map[string]any{"id": out.ID, "source": string(out.Source)})
	writeJSON(w, http.StatusCreated, out)
}

// Remove DELETE /api/v1/deliverability/suppressions/{email}
func (h *StoreHandlers) Remove(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	email, err := suppressionPathParam(r, "email")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_path", ""))
		return
	}
	if strings.TrimSpace(email) == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_email", ""))
		return
	}
	// Capture the exact row and its opaque database version. The store uses
	// this same snapshot for compare-and-delete after the policy review below,
	// so a concurrent upsert cannot turn a reviewed manual suppression into an
	// unreviewed complaint/DSAR deletion.
	prior, err := h.Store.FetchByEmail(r.Context(), t.ID, email)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if prior == nil {
		// Do not issue an email-keyed delete after a miss: a suppression may be
		// created between the lookup and mutation and was never reviewed by this
		// request. Missing is an idempotent success.
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":                        true,
			"deleted":                   false,
			"subscriber_status_changed": false,
		})
		return
	}
	// Enforce the same per-reason reversibility gate the bulk endpoint
	// applies (D05#9) — otherwise this single-row DELETE lets an operator
	// silently un-suppress a DSAR-erasure or admin-only (hard-bounce/
	// complaint) row that bulk delete would 409 on.
	force := r.URL.Query().Get("force") == "1" ||
		r.URL.Query().Get("force") == "true"
	requiresReviewedResubscribe := false
	switch ReversibilityFor(prior.Reason) {
	case ReversibilityPermanent:
		writeJSON(w, http.StatusConflict, errEnv("not_reversible",
			string(prior.Reason)+" suppressions cannot be removed"))
		return
	case ReversibilityNeedsAdmin:
		if !force {
			writeJSON(w, http.StatusConflict, errEnv("force_required",
				string(prior.Reason)+" requires force=1 to remove"))
			return
		}
		// Force authorizes deletion of this reviewed suppression record only.
		// It never restores subscriber eligibility; that remains a separate
		// reviewed resubscribe/consent flow.
		requiresReviewedResubscribe = true
	}
	deleted, err := h.Store.RemoveSelected(r.Context(), t.ID, prior)
	if errors.Is(err, ErrSuppressionChanged) {
		writeJSON(w, http.StatusConflict, errEnv("suppression_changed",
			"suppression changed after review; refresh and review it again"))
		return
	}
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if deleted {
		h.recordAudit(r.Context(), t.ID, prior.Email, AuditActionRemove, string(prior.Reason),
			map[string]any{
				"id": prior.ID, "source": string(prior.Source),
				"subscriber_reactivated":        false,
				"reviewed_resubscribe_required": requiresReviewedResubscribe,
			})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":                            true,
		"deleted":                       deleted,
		"subscriber_status_changed":     false,
		"reviewed_resubscribe_required": requiresReviewedResubscribe,
	})
}

// patchExpiresAtInput is the body of PATCH /api/v1/suppressions/{id}.
// expires_at: nil clears the column (permanent). Sending the field as
// JSON `null` is the canonical clear; omitting it is rejected so the
// admin has to make the intent explicit.
type patchExpiresAtInput struct {
	ExpiresAt    *time.Time `json:"expires_at"`
	HasExpiresAt bool       `json:"-"`
}

// UnmarshalJSON tracks presence so a caller can distinguish "field
// missing" (reject) from "field = null" (clear). Without this we'd
// silently treat both as "set to nil" which would let a malformed body
// accidentally permanent-ify a row.
func (p *patchExpiresAtInput) UnmarshalJSON(b []byte) error {
	type alias struct {
		ExpiresAt *time.Time `json:"expires_at"`
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	if _, ok := raw["expires_at"]; ok {
		p.HasExpiresAt = true
	}
	var a alias
	if err := json.Unmarshal(b, &a); err != nil {
		return err
	}
	p.ExpiresAt = a.ExpiresAt
	return nil
}

// PatchExpiresAt PATCH /api/v1/suppressions/{id}
//
// GAP-LS-016. Admin-only — the route is mounted under
// apikeys.RequireScope(ScopeAdmin) at the main.go layer. Lets an
// operator extend or clear the auto-expiration on a soft-bounce-
// threshold row without re-creating it (which would lose the
// source_event_id audit trail).
func (h *StoreHandlers) PatchExpiresAt(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if strings.TrimSpace(id) == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", ""))
		return
	}
	var in patchExpiresAtInput
	if err := httpbody.DecodeJSON(w, r, suppressionJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if !in.HasExpiresAt {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_expires_at",
			"body must include expires_at (null to clear)"))
		return
	}
	out, err := h.Store.UpdateExpiresAt(r.Context(), t.ID, id, in.ExpiresAt)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if out == nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
		return
	}
	h.recordAudit(r.Context(), t.ID, out.Email, AuditActionUpdate, string(out.Reason),
		map[string]any{"id": out.ID, "expires_at": out.ExpiresAt})
	writeJSON(w, http.StatusOK, out)
}

// Timeline GET /api/v1/suppressions/{id}/timeline
//
// Returns the suppression row plus its recent audit log. Used by the
// dashboard slideover to render a "what's happened to this address"
// strip. Read-scoped — caller mounts under ScopeReadSubscribers.
//
// Bounce/complaint event correlation is deferred — the audit row carries
// the action + source attribution which is enough for the v1 UI; a
// future iteration can join in subscriber_events for richer context.
func (h *StoreHandlers) Timeline(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if strings.TrimSpace(id) == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", ""))
		return
	}
	row, err := h.Store.FetchByID(r.Context(), t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if row == nil {
		writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
		return
	}
	audit, aerr := h.Store.RecentAuditForEmail(r.Context(), t.ID, row.Email, 50)
	if aerr != nil {
		// Audit-fetch failure is non-fatal — return the row with an
		// empty audit array rather than 500. The dashboard surfaces
		// the row and we log the audit miss separately.
		audit = []AuditEntry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"suppression": row,
		"audit":       audit,
	})
}

// decodeJSON is a forgiving jsonb-bytes → map decoder. Returns nil on
// malformed input (callers default to nil-Metadata), matching how
// existing internal repos elsewhere absorb metadata-decode failures.
func decodeJSON(raw []byte) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}
