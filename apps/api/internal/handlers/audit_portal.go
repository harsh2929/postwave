// SPDX-License-Identifier: AGPL-3.0-only
//
// audit_portal.go — HTTP surface for the embeddable audit portal
// (WorkOS Admin Portal pattern). audit-2026 (API, P1).
//
//	POST /api/v1/audit/portal/sessions    — mint a portal session
//	DELETE /api/v1/audit/portal/sessions/{id} — revoke a session
//	GET  /portal/audit                    — serve the slim portal SPA
//	POST /api/v1/audit/portal/exchange    — one-time bootstrap to HttpOnly cookie
//	GET  /api/v1/audit/portal/branding    — cookie-authenticated branding
//
// The mint endpoint requires the admin audit scope; the SPA serve
// endpoint is unauthenticated and credential-free. The bootstrap JWT exists
// only in the URL fragment, is scrubbed before network I/O, and is atomically
// exchanged for a distinct HttpOnly cookie.
package handlers

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"math"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// AuditPortalHandlers serves the customer-portal endpoints. Tenant
// resolution for mint goes through middleware.TenantFromContext; for
// the SPA + branding GETs, it goes through the JWT.
type AuditPortalHandlers struct {
	Pool *db.Pool
	// HMACSecret is the shared secret used to sign portal JWTs. When
	// empty the package falls back to POSTWAVE_PORTAL_JWT_SECRET.
	HMACSecret []byte
	// PortalOrigin is the origin used to build portal_url responses
	// (e.g. "https://app.postwave.io"). When empty the handler infers
	// it from the request scheme + Host header.
	PortalOrigin string
	// FrameAncestors is a whitespace-separated allowlist of exact HTTPS
	// origins permitted to embed the portal. Empty/invalid means 'none'.
	FrameAncestors string
	// TrustForwardedIPHeaders uses the shared trusted-proxy resolver when
	// recording the first exchange IP. Raw X-Forwarded-For is never trusted.
	TrustForwardedIPHeaders bool
	// SPADir is the absolute path to apps/audit-portal/dist (the
	// built SPA). When empty the GET handler falls back to a
	// minimal inline HTML shell so the route always returns
	// something useful in dev.
	SPADir string
	// Logger is the structured logger used by httperror.WriteInternal
	// to capture err.Error() server-side without leaking it to the
	// client. May be nil; httperror tolerates that.
	Logger *slog.Logger
}

const (
	portalCookieName    = "__Host-pw_audit_portal"
	portalDevCookieName = "pw_audit_portal_dev"
	portalExchangeLimit = 4 << 10
)

// deps assembles the audit.PortalSessionDeps the handler delegates
// to. We rebuild it per request so PortalOrigin can be overridden
// from the request when not configured statically.
func (h *AuditPortalHandlers) deps(r *http.Request) *audit.PortalSessionDeps {
	origin := strings.TrimSpace(h.PortalOrigin)
	if origin == "" && r != nil {
		scheme := "https"
		if r.TLS == nil {
			scheme = "http"
		}
		host := r.Host
		if host != "" {
			origin = scheme + "://" + host
		}
	}
	return &audit.PortalSessionDeps{
		Pool:      h.Pool,
		Secret:    h.HMACSecret,
		OriginURL: origin,
	}
}

// CreateSessionInput is the wire body for POST /portal/sessions.
type CreateSessionInput struct {
	SubTenantID string `json:"sub_tenant_id,omitempty"`
	// TTLSeconds lets the admin shorten the default 30-min window
	// (e.g. for a 5-minute customer support handoff). Clamped to
	// [60, audit.MaxSessionTTL].
	TTLSeconds int `json:"ttl_seconds,omitempty"`
}

// CreateSession POST /api/v1/audit/portal/sessions. Mints a portal
// JWT for the calling tenant, persists the (token_hash, expiry)
// metadata, and returns {portal_url, expires_at, session_id} for the
// admin UI to copy-to-clipboard.
func (h *AuditPortalHandlers) CreateSession(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if h.Pool == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "portal_unavailable", "")
		return
	}
	var in CreateSessionInput
	if r.Body != nil {
		// Body is optional — POST with no payload is fine — but malformed,
		// oversized, trailing, and unknown-field payloads fail closed.
		if err := httpbody.DecodeJSONWith(w, r, portalExchangeLimit, &in, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httpbody.WriteError(w, err)
			return
		}
	}
	if strings.TrimSpace(in.SubTenantID) != "" {
		writeJSONErr(w, http.StatusBadRequest, "sub_tenant_not_supported",
			"sub-tenant audit filtering is not available; mint a tenant-scoped portal session")
		return
	}
	var ttl time.Duration
	if in.TTLSeconds < 0 {
		writeJSONErr(w, http.StatusBadRequest, "invalid_request", "ttl_seconds cannot be negative")
		return
	}
	if in.TTLSeconds > 0 {
		if in.TTLSeconds >= int(audit.MaxSessionTTL/time.Second) {
			ttl = audit.MaxSessionTTL
		} else {
			ttl = time.Duration(in.TTLSeconds) * time.Second
		}
		if ttl < time.Minute {
			ttl = time.Minute
		}
	}
	var createdBy string
	if u, ok := middleware.UserFromContext(r.Context()); ok {
		createdBy = u.ID
	}
	out, err := audit.CreatePortalSession(r.Context(), h.deps(r), audit.CreatePortalSessionInput{
		TenantID:    t.ID,
		SubTenantID: in.SubTenantID,
		CreatedBy:   createdBy,
		TTL:         ttl,
	})
	if err != nil {
		if errors.Is(err, audit.ErrSecretUnset) {
			writeJSONErr(w, http.StatusServiceUnavailable, "portal_unavailable",
				"portal JWT secret not configured (set POSTWAVE_PORTAL_JWT_SECRET)")
			return
		}
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	// Audit the mint so admins can answer "who shared a portal link
	// with this customer and when?". Best-effort — failure here must
	// not block the response (the mint already happened).
	if h.Pool != nil {
		meta := middleware.AuditMetaFromRequest(r)
		expiresAt := out.ExpiresAt.UTC()
		sessionID := out.SessionID
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			tx, err := db.WithTenant(ctx, h.Pool, t.ID)
			if err != nil {
				return
			}
			defer func() { _ = tx.Rollback(ctx) }()
			_ = db.Audit(ctx, tx, meta, "audit.portal.session_create",
				"audit_portal_sessions", sessionID,
				map[string]any{
					"expires_at": expiresAt,
				},
			)
			_ = tx.Commit(ctx)
		}()
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"session_id": out.SessionID,
		"portal_url": out.PortalURL,
		"expires_at": out.ExpiresAt.UTC(),
	})
}

// RevokeSession DELETE /api/v1/audit/portal/sessions/{id}. Marks
// revoked_at on the row so subsequent SPA loads bounce.
func (h *AuditPortalHandlers) RevokeSession(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeJSONErr(w, http.StatusBadRequest, "missing_id", "")
		return
	}
	if err := audit.RevokePortalSession(r.Context(), h.deps(r), t.ID, id); err != nil {
		if errors.Is(err, audit.ErrStoreUnavailable) {
			writeJSONErr(w, http.StatusServiceUnavailable, "portal_unavailable", "")
			return
		}
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id})
}

// ListSessions GET /api/v1/audit/portal/sessions. Returns the
// tenant's recent sessions (excluding raw JWTs).
func (h *AuditPortalHandlers) ListSessions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	if h.Pool == nil {
		writeJSONErr(w, http.StatusServiceUnavailable, "portal_unavailable", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, scope, COALESCE(sub_tenant_id::text, ''), expires_at,
       created_at, accessed_at, revoked_at
  FROM audit_portal_sessions
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC
 LIMIT 50`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	type sessionView struct {
		ID          string     `json:"id"`
		Scope       string     `json:"scope"`
		SubTenantID string     `json:"subTenantId,omitempty"`
		ExpiresAt   time.Time  `json:"expiresAt"`
		CreatedAt   time.Time  `json:"createdAt"`
		AccessedAt  *time.Time `json:"accessedAt,omitempty"`
		RevokedAt   *time.Time `json:"revokedAt,omitempty"`
	}
	out := []sessionView{}
	for rows.Next() {
		var sv sessionView
		if err := rows.Scan(&sv.ID, &sv.Scope, &sv.SubTenantID, &sv.ExpiresAt,
			&sv.CreatedAt, &sv.AccessedAt, &sv.RevokedAt); err != nil {
			continue
		}
		out = append(out, sv)
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
}

// ServeSPA GET /portal/audit serves a credential-free shell. The bootstrap
// credential is a URL fragment and therefore never reaches this handler.
func (h *AuditPortalHandlers) ServeSPA(w http.ResponseWriter, r *http.Request) {
	setPortalNoStoreHeaders(w)
	w.Header().Set("Content-Security-Policy", portalCSP(h.FrameAncestors))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if h.SPADir != "" {
		indexPath := filepath.Join(h.SPADir, "index.html")
		if data, err := os.ReadFile(indexPath); err == nil {
			_, _ = w.Write(data)
			return
		}
	}
	_, _ = w.Write([]byte(inlinePortalShell()))
}

// ServeAsset serves only the Vite content-addressed asset directory.
//
// Directory requests are refused rather than delegated. http.FileServer renders
// a browsable index for a directory with no index.html, so GET
// /portal/audit/assets/ returned the complete file list of the bundle — while
// the nginx deployment of the identical URL answers 404 (`try_files $uri =404`).
// The build's own threat model names that artifact index as the mechanism by
// which a hidden source map stops needing a guessed content hash, so the two
// documented deployment modes must not disagree here.
func (h *AuditPortalHandlers) ServeAsset(w http.ResponseWriter, r *http.Request) {
	if h.SPADir == "" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.StripPrefix("/portal/audit/", http.FileServer(noDirListingFS{http.Dir(h.SPADir)})).ServeHTTP(w, r)
}

// noDirListingFS is http.Dir with directory opens refused. FileServer asks for
// the directory itself before it decides to render an index, so returning
// fs.ErrNotExist at that point turns the listing into the same 404 a missing
// file gets — the standard way to match nginx's `try_files $uri =404`. Files
// are served exactly as before, including the index.html redirect suppression
// that FileServer applies on its own.
type noDirListingFS struct {
	fs http.FileSystem
}

func (d noDirListingFS) Open(name string) (http.File, error) {
	f, err := d.fs.Open(name)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	if info.IsDir() {
		_ = f.Close()
		return nil, fs.ErrNotExist
	}
	return f, nil
}

type portalExchangeInput struct {
	Bootstrap string `json:"bootstrap"`
}

// Exchange consumes the fragment bootstrap exactly once and returns a
// distinct cookie credential that JavaScript cannot read.
func (h *AuditPortalHandlers) Exchange(w http.ResponseWriter, r *http.Request) {
	setPortalNoStoreHeaders(w)
	if !h.validPortalOrigin(r) {
		// Deliberately NOT routed through internal/entitlement: an origin check is
		// a request-integrity control, and dressing a rejected origin in a
		// remedy vocabulary invites a client to offer the attacker a next step.
		//
		// It does need a MESSAGE, though. This sent "", which renders as a blank
		// refusal — a legitimate operator on a misconfigured portal host sees an
		// empty dialog and has nothing to act on. The wording says what was
		// wrong without confirming anything about what would be accepted.
		writeJSONErr(w, http.StatusForbidden, "portal_origin_rejected",
			"this request did not come from an approved audit-portal origin")
		return
	}
	var in portalExchangeInput
	if err := httpbody.DecodeJSON(w, r, portalExchangeLimit, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if strings.TrimSpace(in.Bootstrap) == "" || len(in.Bootstrap) > 2048 {
		writeJSONErr(w, http.StatusBadRequest, "invalid_bootstrap", "")
		return
	}
	ip := middleware.ResolveClientIPString(r, h.TrustForwardedIPHeaders)
	token, payload, err := audit.ExchangePortalBootstrap(r.Context(), h.deps(r), strings.TrimSpace(in.Bootstrap), ip)
	if err != nil {
		if errors.Is(err, audit.ErrBootstrapUsed) || errors.Is(err, audit.ErrInvalidToken) || errors.Is(err, audit.ErrSessionRevoked) {
			writeJSONErr(w, http.StatusUnauthorized, "invalid_bootstrap", "")
			return
		}
		if errors.Is(err, audit.ErrSecretUnset) || errors.Is(err, audit.ErrStoreUnavailable) {
			writeJSONErr(w, http.StatusServiceUnavailable, "portal_unavailable", "")
			return
		}
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	http.SetCookie(w, h.portalCookie(token, payload.ExpiresAt))
	h.recordPortalAccess(r, payload, ip)
	w.WriteHeader(http.StatusNoContent)
}

// RequirePortalSession resolves only the dedicated portal cookie and mounts
// it on a deliberately narrow read-only router. Authorization headers are
// rejected to prevent credential smuggling between auth schemes.
func (h *AuditPortalHandlers) RequirePortalSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setPortalNoStoreHeaders(w)
		if strings.TrimSpace(r.Header.Get("Authorization")) != "" {
			writeJSONErr(w, http.StatusUnauthorized, "conflicting_credentials", "")
			return
		}
		cookie, err := r.Cookie(h.portalCookieName())
		if err != nil || cookie == nil || strings.TrimSpace(cookie.Value) == "" {
			writeJSONErr(w, http.StatusUnauthorized, "portal_session_required", "")
			return
		}
		payload, err := audit.ValidatePortalCookie(r.Context(), h.deps(r), cookie.Value)
		if err != nil {
			h.clearPortalCookie(w)
			writeJSONErr(w, http.StatusUnauthorized, "portal_session_invalid", "")
			return
		}
		ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: payload.TenantID})
		ctx = middleware.WithActor(ctx, "system", "audit-portal:"+payload.SessionID)
		ctx = audit.WithPortalSession(ctx, payload)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// EvidenceReleaseHold is the fail-closed response for portal evidence reads.
//
// The portal session and branding lifecycle remains mounted so already-issued
// links can be invalidated and operators can finish qualifying the surface.
// Raw events and proof bundles, however, must not cross this boundary until the
// external-auditor projection has its own reviewed field-level contract. Keep
// this handler deliberately dependency-free: an authorized request receives the
// same response regardless of tenant, path parameter, query, or database state.
func (*AuditPortalHandlers) EvidenceReleaseHold(w http.ResponseWriter, _ *http.Request) {
	setPortalNoStoreHeaders(w)
	writeJSONErr(
		w,
		http.StatusServiceUnavailable,
		"service_unavailable",
		"audit portal evidence is not available in this release",
	)
}

// Branding reads a bounded tenant projection after RequirePortalSession has
// resolved the HttpOnly cookie to an exact tenant. The stored external logo is
// intentionally neither selected nor emitted, so an auditor's browser cannot
// be directed to an operator-controlled origin.
func (h *AuditPortalHandlers) Branding(w http.ResponseWriter, r *http.Request) {
	setPortalNoStoreHeaders(w)
	payload, ok := audit.PortalSessionFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "portal_session_required", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, payload.TenantID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var (
		brandName, primary, supportEmail *string
		enabled                          bool
	)
	if err := tx.QueryRow(r.Context(), `
SELECT whitelabel_enabled, whitelabel_brand_name,
       whitelabel_primary_color, whitelabel_support_email
  FROM tenants
 WHERE id = $1::uuid
 LIMIT 1`, payload.TenantID,
	).Scan(&enabled, &brandName, &primary, &supportEmail); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	branding := portalBrandingProjection(enabled, brandName, primary, supportEmail)
	writeJSON(w, http.StatusOK, map[string]any{
		"brand_name":    branding.brandName,
		"logo_url":      branding.logoURL,
		"primary_color": branding.primaryColor,
		"support_email": branding.supportEmail,
		"tenant_id":     payload.TenantID,
		"scope":         payload.Scope,
		"expires_at":    payload.ExpiresAt.UTC(),
	})
}

// ----------------- helpers -------------------------------------------

// stringOr dereferences a *string, falling back to def when nil/empty.
func stringOr(s *string, def string) string {
	if s == nil {
		return def
	}
	if v := strings.TrimSpace(*s); v != "" {
		return v
	}
	return def
}

func (h *AuditPortalHandlers) portalCookieName() string {
	if h.portalCookieSecure() {
		return portalCookieName
	}
	return portalDevCookieName
}

func (h *AuditPortalHandlers) portalCookieSecure() bool {
	u, err := url.Parse(strings.TrimSpace(h.PortalOrigin))
	return err == nil && strings.EqualFold(u.Scheme, "https")
}

func (h *AuditPortalHandlers) portalCookie(token string, expiresAt time.Time) *http.Cookie {
	secure := h.portalCookieSecure()
	maxAge := int(time.Until(expiresAt).Seconds())
	if maxAge < 1 {
		maxAge = 1
	}
	return &http.Cookie{
		Name:        h.portalCookieName(),
		Value:       token,
		Path:        "/",
		Expires:     expiresAt.UTC(),
		MaxAge:      maxAge,
		HttpOnly:    true,
		Secure:      secure,
		SameSite:    map[bool]http.SameSite{true: http.SameSiteNoneMode, false: http.SameSiteLaxMode}[secure],
		Partitioned: secure,
	}
}

func (h *AuditPortalHandlers) clearPortalCookie(w http.ResponseWriter) {
	cookie := h.portalCookie("", time.Unix(1, 0))
	cookie.MaxAge = -1
	http.SetCookie(w, cookie)
}

func (h *AuditPortalHandlers) validPortalOrigin(r *http.Request) bool {
	expected := strings.TrimRight(strings.TrimSpace(h.PortalOrigin), "/")
	if expected == "" {
		scheme := "https"
		if r.TLS == nil {
			scheme = "http"
		}
		expected = scheme + "://" + r.Host
	}
	expectedURL, err := url.Parse(expected)
	if err != nil || expectedURL.User != nil || expectedURL.RawQuery != "" || expectedURL.Fragment != "" ||
		(expectedURL.Path != "" && expectedURL.Path != "/") {
		return false
	}
	originURL, err := url.Parse(strings.TrimSpace(r.Header.Get("Origin")))
	if err != nil || originURL.User != nil || originURL.RawQuery != "" || originURL.Fragment != "" ||
		(originURL.Path != "" && originURL.Path != "/") {
		return false
	}
	return strings.EqualFold(originURL.Scheme, expectedURL.Scheme) &&
		strings.EqualFold(originURL.Host, expectedURL.Host)
}

func (h *AuditPortalHandlers) recordPortalAccess(r *http.Request, payload *audit.SessionPayload, ip string) {
	if h.Pool == nil || payload == nil {
		return
	}
	meta := middleware.AuditMetaFromRequest(r)
	tenantID := payload.TenantID
	sessionID := payload.SessionID
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		tx, err := db.WithTenant(ctx, h.Pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()
		meta.ActorType = "system"
		meta.ActorLabel = "audit-portal:" + sessionID
		_ = db.Audit(ctx, tx, meta, "audit.portal.session_access",
			"audit_portal_sessions", sessionID, map[string]any{"ip": ip})
		_ = tx.Commit(ctx)
	}()
}

func setPortalNoStoreHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store, private, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func normalizePortalFrameAncestors(rawAncestors string) ([]string, error) {
	ancestors := make([]string, 0)
	seen := make(map[string]struct{})
	for _, candidate := range strings.Fields(rawAncestors) {
		if candidate == "'none'" {
			if len(strings.Fields(rawAncestors)) != 1 {
				return nil, errors.New("'none' cannot be combined with other frame ancestors")
			}
			return []string{"'none'"}, nil
		}
		if candidate == "'self'" {
			if _, ok := seen[candidate]; !ok {
				ancestors = append(ancestors, candidate)
				seen[candidate] = struct{}{}
			}
			continue
		}
		if strings.Contains(candidate, "*") {
			return nil, errors.New("wildcard frame ancestors are not allowed")
		}
		u, err := url.Parse(candidate)
		if err != nil || !strings.EqualFold(u.Scheme, "https") || u.Host == "" || u.Hostname() == "" || u.User != nil ||
			u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
			return nil, errors.New("frame ancestors must be exact HTTPS origins")
		}
		normalized := "https://" + strings.ToLower(u.Host)
		if _, ok := seen[normalized]; !ok {
			ancestors = append(ancestors, normalized)
			seen[normalized] = struct{}{}
		}
	}
	if len(ancestors) == 0 {
		ancestors = []string{"'none'"}
	}
	return ancestors, nil
}

// ValidatePortalFrameAncestors is the production startup gate shared by the
// API configuration. Invalid entries must never degrade silently into a portal
// that clients discover cannot be embedded after deployment.
func ValidatePortalFrameAncestors(rawAncestors string) error {
	_, err := normalizePortalFrameAncestors(rawAncestors)
	return err
}

func portalCSP(rawAncestors string) string {
	ancestors, err := normalizePortalFrameAncestors(rawAncestors)
	if err != nil {
		ancestors = []string{"'none'"}
	}
	return "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors " + strings.Join(ancestors, " ")
}

var portalColorPattern = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)

type portalBrandingValues struct {
	brandName    string
	logoURL      string
	primaryColor string
	supportEmail string
}

func portalBrandingProjection(
	enabled bool,
	brandName, primaryColor, supportEmail *string,
) portalBrandingValues {
	neutral := portalBrandingValues{
		brandName:    "Audit Portal",
		primaryColor: "#1d4ed8",
	}
	if !enabled {
		return neutral
	}
	neutral.brandName = safePortalBrandName(stringOr(brandName, "Audit Portal"))
	neutral.primaryColor = safePortalColor(stringOr(primaryColor, "#1d4ed8"))
	neutral.supportEmail = safePortalSupportEmail(stringOr(supportEmail, ""))
	return neutral
}

func safePortalBrandName(candidate string) string {
	candidate = strings.TrimSpace(candidate)
	if candidate == "" || utf8.RuneCountInString(candidate) > 120 {
		return "Audit Portal"
	}
	for _, r := range candidate {
		if unicode.IsControl(r) || r == '\u061c' || r == '\u200e' || r == '\u200f' ||
			r == '\u200b' || r == '\u200c' || r == '\u200d' ||
			r == '\ufeff' || (r >= '\u202a' && r <= '\u202e') ||
			(r >= '\u2060' && r <= '\u206f') {
			return "Audit Portal"
		}
	}
	return candidate
}

func safePortalColor(candidate string) string {
	candidate = strings.TrimSpace(candidate)
	if !portalColorPattern.MatchString(candidate) || !portalColorHasWhiteContrast(candidate) {
		return "#1d4ed8"
	}
	return candidate
}

func portalColorHasWhiteContrast(candidate string) bool {
	component := func(raw string) float64 {
		n, err := strconv.ParseUint(raw, 16, 8)
		if err != nil {
			return 1
		}
		value := float64(n) / 255
		if value <= 0.04045 {
			return value / 12.92
		}
		return math.Pow((value+0.055)/1.055, 2.4)
	}
	luminance := 0.2126*component(candidate[1:3]) +
		0.7152*component(candidate[3:5]) +
		0.0722*component(candidate[5:7])
	return 1.05/(luminance+0.05) >= 4.5
}

func safePortalSupportEmail(candidate string) string {
	candidate = strings.TrimSpace(candidate)
	if candidate == "" {
		return ""
	}
	if len(candidate) > 254 || strings.Count(candidate, "@") != 1 {
		return ""
	}
	address, err := mail.ParseAddress(candidate)
	if err != nil || address.Name != "" || address.Address != candidate {
		return ""
	}
	return candidate
}

// writePortalErrorHTML serves a human-readable 401/410 page when the
// JWT is invalid or expired. Avoids the bare "401 Unauthorized" the
// chi default would emit — customers landing on a stale link should
// see a branded "this link has expired" page.
func writePortalErrorHTML(w http.ResponseWriter, err error) {
	status := http.StatusUnauthorized
	reason := "This audit portal link is invalid."
	if errors.Is(err, audit.ErrSessionRevoked) {
		status = http.StatusGone
		reason = "This audit portal link has expired or been revoked. Please request a new link from your account administrator."
	}
	setPortalNoStoreHeaders(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", portalCSP("'none'"))
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`<!doctype html>
<html><head><meta charset="utf-8"><title>Audit portal</title>
<style>body{font-family:system-ui,Arial,sans-serif;max-width:480px;margin:80px auto;padding:0 16px;color:#1f2937}h1{font-size:20px;margin:0 0 8px}p{font-size:14px;line-height:1.55;color:#4b5563}</style>
</head><body><h1>Audit portal unavailable</h1><p>` + reason + `</p></body></html>`))
}

// inlinePortalShell returns a minimal HTML stub for the GET when no
// built SPA is present (e.g. local dev before running `pnpm build`).
// The stub kicks the browser to the SPA's index.html via a meta
// refresh; in dev this gives an immediate, usable response.
func inlinePortalShell() string {
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>Moosewave audit portal</title>
<style>body{font-family:system-ui,Arial,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#1f2937}h1{font-size:20px}small{color:#6b7280}</style>
</head><body><div id="root"><h1>Moosewave audit portal</h1>
<p>The audit portal frontend is not installed on this server.</p>
<small>Build apps/audit-portal and configure POSTWAVE_PORTAL_SPA_DIR.</small>
</div></body></html>`
}
