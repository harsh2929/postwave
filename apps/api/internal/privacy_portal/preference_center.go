// SPDX-License-Identifier: AGPL-3.0-only
//
// preference_center.go — admin GET/PATCH for the per-tenant Preference
// Center theme + copy. Mounted at `/api/v1/privacy/portal/preference-
// center` under the privacy-portal namespace because the operator UI
// (apps/desktop/src/components/privacy/PreferenceCenterCustomization.tsx)
// lives on the Privacy Portal page — same RBAC surface (ScopeAdmin),
// same import shape (PrivacyPortal*) as the rest of this package.
//
// The customization columns drive the chrome of the hosted preference
// page in apps/api/internal/preferences (the path `/api/public/
// preferences/{token}` rendered to subscribers). Each tenant gets one
// row in `tenant_preference_customization` (migration 0330). Rows are
// created lazily by the PATCH/PUT upsert; the GET handler returns
// package defaults — `defaultPreferenceCustomization()` in
// api-client.ts — when no row exists, so a tenant that has never
// edited their theme still renders a sensible preference page.
//
// The wire shape mirrors `PreferenceCenterCustomization` in
// apps/desktop/src/lib/api-client.ts:
//
//	{
//	  "logo_url":            "https://...",
//	  "primary_color":       "#5B6CFF",
//	  "footer_text":         "...",
//	  "show_postwave_badge": true
//	}
//
// Validation rules enforce what the CHECK constraint in 0330 already
// guards (primary_color matches /^#[0-9A-Fa-f]{6}$/) plus a soft
// 4 KiB cap on footer_text to keep the page render bounded.

package privacy_portal

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Errors surfaced to handlers so HTTP layer can map status codes.
var (
	ErrInvalidPrimaryColor = errors.New("primary_color must match /^#[0-9A-Fa-f]{6}$/")
	ErrFooterTooLong       = errors.New("footer_text must be at most 4096 bytes")
	ErrInvalidFooterText   = errors.New("footer_text contains unsupported control or formatting characters")
	ErrInvalidLogoURL      = errors.New("logo_url must be empty or an https URL without credentials")
)

// hexColorRE mirrors the CHECK constraint in migration 0330.
var hexColorRE = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)

// footerMaxBytes is a soft cap on the footer copy so a malicious /
// runaway client can't blow up the preference-page render. The hosted
// preference page is rendered HTML-escaped, but we still want a finite
// upper bound on document size.
const footerMaxBytes = 4096
const logoURLMaxBytes = 2048

// preferenceCenterJSONMaxBodyBytes is the request body limit for the
// customization endpoints. The shape is four small fields; 8 KiB leaves
// headroom for the bounded HTTPS logo URL and footer copy.
const preferenceCenterJSONMaxBodyBytes int64 = 8 << 10

// PreferenceCustomization is the wire shape for GET/PATCH /api/v1/
// privacy/portal/preference-center. Mirrors `PreferenceCenterCustomization`
// in apps/desktop/src/lib/api-client.ts; the JSON tags are the
// contract.
type PreferenceCustomization struct {
	TenantID          string `json:"tenantId,omitempty"`
	LogoURL           string `json:"logo_url"`
	PrimaryColor      string `json:"primary_color"`
	FooterText        string `json:"footer_text"`
	ShowPostwaveBadge bool   `json:"show_postwave_badge"`
}

// defaultPreferenceCustomization mirrors
// `defaultPreferenceCustomization()` in api-client.ts so the empty-row
// case still renders the same theme the unauthenticated frontend
// would have chosen client-side.
func defaultPreferenceCustomization() PreferenceCustomization {
	return PreferenceCustomization{
		LogoURL:           "",
		PrimaryColor:      "#5B6CFF",
		FooterText:        "You're receiving this because you subscribed.",
		ShowPostwaveBadge: true,
	}
}

// validate normalises a PreferenceCustomization in place and returns
// the first validation error. Empty primary_color is treated as
// "reset to default" so a frontend that clears the input doesn't have
// to know the hex literal.
func (p *PreferenceCustomization) validate() error {
	p.LogoURL = strings.TrimSpace(p.LogoURL)
	if !validPreferenceLogoURL(p.LogoURL) {
		return ErrInvalidLogoURL
	}
	p.PrimaryColor = strings.TrimSpace(p.PrimaryColor)
	if p.PrimaryColor == "" {
		p.PrimaryColor = "#5B6CFF"
	}
	if !hexColorRE.MatchString(p.PrimaryColor) {
		return ErrInvalidPrimaryColor
	}
	if len(p.FooterText) > footerMaxBytes {
		return ErrFooterTooLong
	}
	for _, char := range p.FooterText {
		if char == '\n' || char == '\r' || char == '\t' {
			continue
		}
		if unicode.IsControl(char) || unicode.In(char, unicode.Cf, unicode.Cs) {
			return ErrInvalidFooterText
		}
	}
	return nil
}

func validPreferenceLogoURL(raw string) bool {
	if raw == "" {
		return true
	}
	if len(raw) > logoURLMaxBytes || strings.TrimSpace(raw) != raw {
		return false
	}
	parsed, err := url.ParseRequestURI(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || !safePreferenceLogoHost(parsed.Hostname()) {
		return false
	}
	return true
}

func safePreferenceLogoHost(raw string) bool {
	host := strings.ToLower(strings.TrimSuffix(raw, "."))
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return false
	}
	if ip := net.ParseIP(host); ip != nil {
		return !ip.IsUnspecified() && !ip.IsLoopback() && !ip.IsPrivate() &&
			!ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast() && !ip.IsMulticast()
	}
	// Reject single-label/intranet hostnames. Hosted-page assets must resolve
	// through a public fully-qualified domain.
	return strings.Contains(host, ".")
}

// LoadPreferenceCustomization reads the row for tenantID, returning
// the package default when no row exists. Missing-table errors are
// also treated as "default" so the portal still works on partially-
// migrated environments (the migration may lag the binary in dev).
func (r *Repo) LoadPreferenceCustomization(ctx context.Context, tenantID string) (PreferenceCustomization, error) {
	out := defaultPreferenceCustomization()
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
SELECT logo_url, primary_color, footer_text, show_postwave_badge
  FROM tenant_preference_customization
 WHERE tenant_id = $1::uuid`, tenantID).Scan(
		&out.LogoURL, &out.PrimaryColor, &out.FooterText, &out.ShowPostwaveBadge)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			out = defaultPreferenceCustomization()
			out.TenantID = tenantID
			return out, tx.Commit(ctx)
		}
		if isMissingRelation(err) {
			out = defaultPreferenceCustomization()
			out.TenantID = tenantID
			return out, nil
		}
		return out, err
	}
	// Legacy rows could contain data: SVG or another unsafe scheme because the
	// original writer only trimmed the value. Never project such a URL into an
	// operator preview or the public preference page; the next save replaces it.
	if !validPreferenceLogoURL(out.LogoURL) {
		out.LogoURL = ""
	}
	out.TenantID = tenantID
	return out, tx.Commit(ctx)
}

// UpsertPreferenceCustomization writes the row for tenantID, creating
// it on first save. The input is validated + normalised before the
// SQL fires so we never store a malformed `primary_color` that would
// trip the CHECK constraint.
func (r *Repo) UpsertPreferenceCustomization(ctx context.Context, tenantID string, in PreferenceCustomization, auditMeta db.AuditMeta) (PreferenceCustomization, error) {
	if err := (&in).validate(); err != nil {
		return PreferenceCustomization{}, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return PreferenceCustomization{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out PreferenceCustomization
	err = tx.QueryRow(ctx, `
INSERT INTO tenant_preference_customization
  (tenant_id, logo_url, primary_color, footer_text, show_postwave_badge)
VALUES ($1::uuid, $2, $3, $4, $5)
ON CONFLICT (tenant_id) DO UPDATE
   SET logo_url            = EXCLUDED.logo_url,
       primary_color       = EXCLUDED.primary_color,
       footer_text         = EXCLUDED.footer_text,
       show_postwave_badge = EXCLUDED.show_postwave_badge,
       updated_at          = now()
RETURNING logo_url, primary_color, footer_text, show_postwave_badge`,
		tenantID, in.LogoURL, in.PrimaryColor, in.FooterText, in.ShowPostwaveBadge).Scan(
		&out.LogoURL, &out.PrimaryColor, &out.FooterText, &out.ShowPostwaveBadge)
	if err != nil {
		return PreferenceCustomization{}, err
	}
	out.TenantID = tenantID
	if err := db.Audit(ctx, tx, auditMeta, "privacy.portal.preference_center.update", "tenant_preference_customization", tenantID, map[string]any{
		"route_template":      "/api/v1/privacy/portal/preference-center",
		"has_logo":            out.LogoURL != "",
		"show_postwave_badge": out.ShowPostwaveBadge,
	}); err != nil {
		return PreferenceCustomization{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return PreferenceCustomization{}, err
	}
	return out, nil
}

// GetPreferenceCustomization GET /api/v1/privacy/portal/preference-center.
func (d *Deps) GetPreferenceCustomization(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.LoadPreferenceCustomization(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// UpsertPreferenceCustomization PATCH/PUT
// /api/v1/privacy/portal/preference-center.
//
// PATCH semantics: the frontend always sends the full theme object so
// we treat PATCH as a full replace (same as PUT). A partial-update
// shape would require a sentinel for "unset", which the current UI
// doesn't need.
func (d *Deps) UpsertPreferenceCustomization(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in PreferenceCustomization
	if err := httpbody.DecodeJSON(w, r, preferenceCenterJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.TenantID != "" {
		httperror.WriteValidation(w, "validation_failed", "tenantId is response-only")
		return
	}
	out, err := d.Repo.UpsertPreferenceCustomization(r.Context(), t.ID, in, middleware.AuditMetaFromRequest(r))
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalidPrimaryColor), errors.Is(err, ErrFooterTooLong), errors.Is(err, ErrInvalidFooterText), errors.Is(err, ErrInvalidLogoURL):
			httperror.WriteValidation(w, "validation_failed", err.Error())
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusOK, out)
}
