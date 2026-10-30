// SPDX-License-Identifier: AGPL-3.0-only
//
// Package settings owns the per-tenant + per-user settings surfaces wired
// into the dashboard's /settings/* pages: workspace defaults
// (workspace.go), notification preferences (notifications.go), and
// retention policy (privacy.go). All three are tenant-scoped via RLS;
// notification_preferences is keyed on the acting user.
package settings

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"regexp"
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

// Workspace is the public projection of one workspace_settings row. Empty
// pointer fields render as JSON null so the frontend can distinguish
// "unset" from "empty string".
type Workspace struct {
	TenantID        string    `json:"tenant_id"`
	DisplayName     *string   `json:"display_name,omitempty"`
	DefaultReplyTo  *string   `json:"default_reply_to,omitempty"`
	Timezone        string    `json:"timezone"`
	DateFormat      string    `json:"date_format"`
	BrandColor      *string   `json:"brand_color,omitempty"`
	LogoURL         *string   `json:"logo_url,omitempty"`
	UpdatedByUserID *string   `json:"updated_by_user_id,omitempty"`
	UpdatedAt       time.Time `json:"updated_at"`
}

// WorkspaceRepo wraps the workspace_settings table.
type WorkspaceRepo struct{ Pool *db.Pool }

// ErrWorkspaceNotFound is returned when no row exists yet.
var ErrWorkspaceNotFound = errors.New("settings: workspace not found")

// brandColorRe matches the validated 6-digit hex form (with leading #).
// Anchored on both ends so trailing junk is rejected.
var brandColorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// emailLooksValid is the same forgiving regex other Moosewave packages use
// for "is this an addressable email" — exactly one @, dot in the domain,
// no whitespace. We don't try to be RFC 5321 here.
var emailLooksValid = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

var allowedDateFormats = map[string]struct{}{
	"YYYY-MM-DD":  {},
	"MMM D, YYYY": {},
	"D MMM YYYY":  {},
	"MM/DD/YYYY":  {},
}

// Get loads the workspace row for tenant. ErrWorkspaceNotFound when absent.
func (r *WorkspaceRepo) Get(ctx context.Context, tenantID string) (*Workspace, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	const q = `
SELECT tenant_id::text,
       display_name,
       default_reply_to::text,
       timezone,
       date_format,
       brand_color,
       logo_url,
       updated_by_user_id::text,
       updated_at
FROM workspace_settings
WHERE tenant_id = $1::uuid`
	var ws Workspace
	var (
		displayName   *string
		replyTo       *string
		brandColor    *string
		logoURL       *string
		updatedByUser *string
	)
	err = tx.QueryRow(ctx, q, tenantID).Scan(
		&ws.TenantID, &displayName, &replyTo, &ws.Timezone, &ws.DateFormat,
		&brandColor, &logoURL, &updatedByUser, &ws.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWorkspaceNotFound
		}
		return nil, err
	}
	if displayName != nil && *displayName != "" {
		ws.DisplayName = displayName
	}
	if replyTo != nil && *replyTo != "" {
		ws.DefaultReplyTo = replyTo
	}
	if brandColor != nil && *brandColor != "" {
		ws.BrandColor = brandColor
	}
	if logoURL != nil && *logoURL != "" {
		ws.LogoURL = logoURL
	}
	if updatedByUser != nil && *updatedByUser != "" {
		ws.UpdatedByUserID = updatedByUser
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &ws, nil
}

// WorkspacePatch is the wire-shape for PATCH. All fields are pointers so
// the caller can distinguish "leave alone" from "set to empty".
type WorkspacePatch struct {
	DisplayName    *string `json:"display_name,omitempty"`
	DefaultReplyTo *string `json:"default_reply_to,omitempty"`
	Timezone       *string `json:"timezone,omitempty"`
	DateFormat     *string `json:"date_format,omitempty"`
	BrandColor     *string `json:"brand_color,omitempty"`
	LogoURL        *string `json:"logo_url,omitempty"`
}

// Upsert applies a patch by upserting onto the tenant row. Missing fields
// in the patch are kept at their current values via a single SQL statement
// using COALESCE on the EXCLUDED row. Returns the resulting projection.
func (r *WorkspaceRepo) Upsert(ctx context.Context, tenantID, userID string, patch WorkspacePatch) (*Workspace, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tz := "UTC"
	if patch.Timezone != nil && *patch.Timezone != "" {
		tz = *patch.Timezone
	}
	dateFormat := "MMM D, YYYY"
	if patch.DateFormat != nil && *patch.DateFormat != "" {
		dateFormat = *patch.DateFormat
	}
	// We use COALESCE on UPDATE so a partial PATCH doesn't overwrite columns
	// the caller didn't send. Timezone/date_format use the raw bind parameter
	// in the conflict clause so an insert can receive defaults while an update
	// keeps the existing value when the patch omits the field.
	const q = `
INSERT INTO workspace_settings
    (tenant_id, display_name, default_reply_to, timezone, date_format, brand_color, logo_url, updated_by_user_id, updated_at)
VALUES
    ($1::uuid, NULLIF($2,''), NULLIF($3,'')::citext, COALESCE($4::text, 'UTC'), COALESCE($5::text, 'MMM D, YYYY'), NULLIF($6,''), NULLIF($7,''), NULLIF($8,'')::uuid, now())
ON CONFLICT (tenant_id) DO UPDATE SET
    display_name       = CASE WHEN $9  THEN EXCLUDED.display_name     ELSE workspace_settings.display_name END,
    default_reply_to   = CASE WHEN $10 THEN EXCLUDED.default_reply_to ELSE workspace_settings.default_reply_to END,
    timezone           = COALESCE($4::text,                    workspace_settings.timezone),
    date_format        = COALESCE($5::text,                    workspace_settings.date_format),
    brand_color        = CASE WHEN $11 THEN EXCLUDED.brand_color      ELSE workspace_settings.brand_color END,
    logo_url           = CASE WHEN $12 THEN EXCLUDED.logo_url         ELSE workspace_settings.logo_url END,
    updated_by_user_id = COALESCE(EXCLUDED.updated_by_user_id, workspace_settings.updated_by_user_id),
    updated_at         = now()
RETURNING tenant_id::text,
          display_name,
          default_reply_to::text,
          timezone,
          date_format,
          brand_color,
          logo_url,
          updated_by_user_id::text,
          updated_at`
	// Convert *string fields to db params: nil → SQL NULL, *p → value.
	var (
		displayName *string
		replyTo     *string
		brandColor  *string
		logoURL     *string
		out         Workspace
		outDisplay  *string
		outReply    *string
		outTimezone *string
		outDateFmt  *string
		outBrand    *string
		outLogo     *string
		outUpdater  *string
	)
	if patch.DisplayName != nil {
		v := *patch.DisplayName
		displayName = &v
	}
	if patch.DefaultReplyTo != nil {
		v := strings.TrimSpace(*patch.DefaultReplyTo)
		replyTo = &v
	}
	if patch.BrandColor != nil {
		v := strings.TrimSpace(*patch.BrandColor)
		brandColor = &v
	}
	if patch.LogoURL != nil {
		v := strings.TrimSpace(*patch.LogoURL)
		logoURL = &v
	}
	replyToStr := ""
	if replyTo != nil {
		replyToStr = *replyTo
	}
	if patch.Timezone != nil {
		v := strings.TrimSpace(tz)
		outTimezone = &v
	}
	if patch.DateFormat != nil {
		v := strings.TrimSpace(dateFormat)
		outDateFmt = &v
	}
	err = tx.QueryRow(ctx, q,
		tenantID, displayName, replyToStr, outTimezone, outDateFmt, brandColor, logoURL, userID,
		patch.DisplayName != nil, patch.DefaultReplyTo != nil, patch.BrandColor != nil, patch.LogoURL != nil,
	).Scan(
		&out.TenantID, &outDisplay, &outReply, &out.Timezone, &out.DateFormat,
		&outBrand, &outLogo, &outUpdater, &out.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if outDisplay != nil && *outDisplay != "" {
		out.DisplayName = outDisplay
	}
	if outReply != nil && *outReply != "" {
		out.DefaultReplyTo = outReply
	}
	if outBrand != nil && *outBrand != "" {
		out.BrandColor = outBrand
	}
	if outLogo != nil && *outLogo != "" {
		out.LogoURL = outLogo
	}
	if outUpdater != nil && *outUpdater != "" {
		out.UpdatedByUserID = outUpdater
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

// WorkspaceDeps mounts the workspace settings HTTP surface.
type WorkspaceDeps struct {
	Repo   *WorkspaceRepo
	Logger *slog.Logger
}

// MountRoutes wires GET/PATCH /api/v1/settings/workspace.
//
// Reads are open to any authenticated tenant member (operators need
// to see the current values to render the dashboard). Writes are
// admin-only — workspace defaults govern every campaign's from
// identity + brand surface, and a viewer-role mutation here is the
// audit's #1 security gap.
func (d *WorkspaceDeps) MountRoutes(r chi.Router) {
	r.Get("/api/v1/settings/workspace", d.Get)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Patch("/api/v1/settings/workspace", d.Patch)
}

// Get GET /api/v1/settings/workspace.
func (d *WorkspaceDeps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	ws, err := d.Repo.Get(r.Context(), t.ID)
	if err != nil {
		if errors.Is(err, ErrWorkspaceNotFound) {
			// Empty defaults (timezone=UTC) so the page renders cleanly
			// before the first save lands.
			writeJSON(w, http.StatusOK, Workspace{
				TenantID:   t.ID,
				Timezone:   "UTC",
				DateFormat: "MMM D, YYYY",
				UpdatedAt:  time.Time{},
			})
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, ws)
}

// Patch PATCH /api/v1/settings/workspace.
func (d *WorkspaceDeps) Patch(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	userID := ""
	if u, _ := middleware.UserFromContext(r.Context()); u != nil {
		userID = u.ID
	}
	var in WorkspacePatch
	if err := httpbody.DecodeJSON(w, r, settingsJSONMaxBodyBytes, &in); err != nil {
		// httpbody returns either "bad_json" or "payload_too_large" — both are
		// in httperror.IsValidationCode allowlist (operator-authored text).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Timezone != nil && *in.Timezone != "" {
		if _, err := time.LoadLocation(*in.Timezone); err != nil {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_timezone",
				"timezone must be a valid IANA name (e.g. America/Los_Angeles)"))
			return
		}
	}
	if in.DateFormat != nil && strings.TrimSpace(*in.DateFormat) != "" {
		if _, ok := allowedDateFormats[strings.TrimSpace(*in.DateFormat)]; !ok {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_date_format",
				"date_format must be one of YYYY-MM-DD, MMM D, YYYY, D MMM YYYY, MM/DD/YYYY"))
			return
		}
	}
	if in.DefaultReplyTo != nil && strings.TrimSpace(*in.DefaultReplyTo) != "" {
		if !emailLooksValid.MatchString(strings.TrimSpace(*in.DefaultReplyTo)) {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_reply_to",
				"default_reply_to must look like an email address"))
			return
		}
	}
	if in.BrandColor != nil && strings.TrimSpace(*in.BrandColor) != "" {
		if !brandColorRe.MatchString(strings.TrimSpace(*in.BrandColor)) {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_brand_color",
				"brand_color must be a #rrggbb hex string"))
			return
		}
	}
	if in.LogoURL != nil && strings.TrimSpace(*in.LogoURL) != "" {
		if err := validateLogoURL(strings.TrimSpace(*in.LogoURL)); err != nil {
			// validateLogoURL returns operator-authored errors.New(...) strings
			// — safe to echo. Route through validation_failed so the message
			// is allowed by the safe-echo allowlist.
			httperror.WriteValidation(w, "validation_failed", err.Error())
			return
		}
	}
	// Snapshot the pre-write state so the audit row captures a diff.
	// best-effort — a missing row (first write) audit shows before=nil.
	before, _ := d.Repo.Get(r.Context(), t.ID)
	out, err := d.Repo.Upsert(r.Context(), t.ID, userID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	emitSettingsAudit(r.Context(), d.Repo.Pool, r, t.ID,
		"settings.workspace.updated", "workspace_settings", t.ID, before, out)
	writeJSON(w, http.StatusOK, out)
}

// validateLogoURL rejects a URL that the server should refuse to fetch
// or persist on a tenant's behalf. The threat model: an admin pastes
// in a `http://169.254.169.254/...` (cloud metadata) or `file://`
// path; any downstream rendering surface that proxies the URL — image
// optimiser, OG-card composer, email-block renderer — could leak
// internal data.
//
// Rules:
//   - scheme must be https (http allowed only for explicit localhost
//     hosts so the dev loop on http://localhost:5173/... works);
//   - parse must succeed;
//   - host must be non-empty + not contain userinfo;
//   - hostname (if it parses as an IP literal) must not be loopback,
//     unspecified, multicast, link-local, or in a private RFC 1918
//     range;
//   - length capped at 2048 — beyond that is operator typo territory
//     and the column has no length cap.
func validateLogoURL(raw string) error {
	if len(raw) > 2048 {
		return errors.New("logo_url is too long (max 2048 chars)")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("logo_url must be a valid URL")
	}
	if u.User != nil {
		return errors.New("logo_url must not include userinfo (user:pass@)")
	}
	host := u.Hostname()
	if host == "" {
		return errors.New("logo_url must include a host")
	}
	scheme := strings.ToLower(u.Scheme)
	switch scheme {
	case "https":
		// always allowed
	case "http":
		// allow only the local-dev loop
		if !isLoopbackHost(host) {
			return errors.New("logo_url must use https (http is reserved for localhost)")
		}
	default:
		return errors.New("logo_url scheme must be https")
	}
	if ip := net.ParseIP(host); ip != nil {
		if ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsPrivate() {
			return errors.New("logo_url must not point at a private, loopback, or metadata address")
		}
	}
	return nil
}

func isLoopbackHost(h string) bool {
	h = strings.Trim(strings.ToLower(h), "[]")
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// writeJSON / errEnv are shared with notifications.go and privacy.go via
// the package-level helpers in helpers.go.
