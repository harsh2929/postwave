// SPDX-License-Identifier: AGPL-3.0-only

// Package agency exposes tenant-parent administration and the legacy
// whitelabel configuration consumed by the authenticated audit-portal
// preview. Custom-domain publication and a consolidated billing processor do
// not exist in this release; handlers must not imply that either is live.
package agency

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// MountRoutes registers the tenant-resolved agency routes. ProtectResponses
// is repeated here for standalone composition; main mounts it before auth for
// early refusals.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(ProtectResponses, admin).Get("/api/v1/agency/children", d.ListChildren)
	r.With(ProtectResponses, admin).Post("/api/v1/agency/children", d.CreateChild)
	r.With(ProtectResponses, admin).Delete("/api/v1/agency/children/{id}", d.UnlinkChild)
	r.With(ProtectResponses, admin).Get("/api/v1/agency/branding", d.GetBranding)
	r.With(ProtectResponses, admin).Patch("/api/v1/agency/branding", d.UpdateBranding)
	r.With(ProtectResponses, admin).Post("/api/v1/agency/billing-mode", d.SetBillingMode)
	r.With(ProtectResponses, admin).Get("/api/v1/agency/invoice-preview", d.InvoicePreview)
}

func (d *Deps) requireAgencyTenant(ctx context.Context, tenantID string) error {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var isAgency bool
	if err := tx.QueryRow(ctx,
		`SELECT is_agency_account FROM tenants WHERE id = $1::uuid`, tenantID,
	).Scan(&isAgency); err != nil {
		return err
	}
	if !isAgency {
		return errNotAgency
	}
	return nil
}

var errNotAgency = errors.New("tenant is not an agency account")

type brandingFields struct {
	Enabled      bool      `json:"whitelabel_enabled"`
	BrandName    string    `json:"brand_name"`
	CustomDomain string    `json:"custom_domain"`
	LogoURL      string    `json:"logo_url"`
	PrimaryColor string    `json:"primary_color"`
	SupportEmail string    `json:"support_email"`
	LegalEntity  string    `json:"legal_entity"`
	UpdatedAt    time.Time `json:"updated_at"`
	ETag         string    `json:"etag"`
	revision     int64
}

type brandingPatch struct {
	Enabled      *bool   `json:"whitelabel_enabled"`
	BrandName    *string `json:"brand_name"`
	CustomDomain *string `json:"custom_domain"`
	LogoURL      *string `json:"logo_url"`
	PrimaryColor *string `json:"primary_color"`
	SupportEmail *string `json:"support_email"`
	LegalEntity  *string `json:"legal_entity"`
}

func scanBranding(row pgx.Row) (brandingFields, error) {
	var b brandingFields
	var tenantID string
	var brand, domain, logo, color, support, legal *string
	err := row.Scan(&tenantID, &b.Enabled, &brand, &domain, &logo, &color, &support,
		&legal, &b.UpdatedAt, &b.revision)
	if err != nil {
		return brandingFields{}, err
	}
	b.BrandName = derefStr(brand)
	b.CustomDomain = derefStr(domain)
	b.LogoURL = derefStr(logo)
	b.PrimaryColor = derefStr(color)
	b.SupportEmail = derefStr(support)
	b.LegalEntity = derefStr(legal)
	sanitizeBrandingProjection(&b)
	b.ETag = httpcache.ETagStrong("agency-branding", tenantID, b.revision)
	return b, nil
}

// sanitizeBrandingProjection contains legacy rows at the API boundary without
// rewriting operator data. Those columns predate bounded validation, so a raw
// read could otherwise break strict clients or turn an old URL into an
// accidental browser request. Empty means "stored value is not safe to
// project"; whitelabel_enabled, updated_at, and the revision validator retain
// their exact database truth.
func sanitizeBrandingProjection(b *brandingFields) {
	if b == nil {
		return
	}
	if b.BrandName != "" && !validBoundedText(b.BrandName, 1, 120) {
		b.BrandName = ""
	}
	if b.LegalEntity != "" && !validBoundedText(b.LegalEntity, 1, 200) {
		b.LegalEntity = ""
	}
	if domain, ok := normalizeCustomDomain(b.CustomDomain); ok {
		b.CustomDomain = domain
	} else {
		b.CustomDomain = ""
	}
	if logo, ok := normalizeLogoURL(b.LogoURL); ok {
		b.LogoURL = logo
	} else {
		b.LogoURL = ""
	}
	if email, ok := normalizeSupportEmail(b.SupportEmail); ok {
		b.SupportEmail = email
	} else {
		b.SupportEmail = ""
	}
	if b.PrimaryColor != "" {
		color, ok := normalizeHexColor(b.PrimaryColor)
		if !ok || !colorHasWhiteTextContrast(color) {
			b.PrimaryColor = ""
		} else {
			b.PrimaryColor = color
		}
	}
}

const selectBrandingSQL = `
SELECT id::text,
       whitelabel_enabled,
       whitelabel_brand_name,
       whitelabel_custom_domain,
       whitelabel_logo_url,
       whitelabel_primary_color,
       whitelabel_support_email,
       whitelabel_legal_entity,
       agency_branding_updated_at,
       agency_branding_revision
  FROM tenants
 WHERE id = $1::uuid`

func (d *Deps) readBranding(ctx context.Context, tenantID string) (brandingFields, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return brandingFields{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	b, err := scanBranding(tx.QueryRow(ctx, selectBrandingSQL, tenantID))
	if err != nil {
		return brandingFields{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return brandingFields{}, err
	}
	return b, nil
}

func derefStr(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (d *Deps) GetBranding(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	b, err := d.readBranding(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.Header().Set("ETag", b.ETag)
	writeJSON(w, http.StatusOK, b)
}

func (d *Deps) UpdateBranding(w http.ResponseWriter, r *http.Request) {
	_, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeNotCommitted(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var patch brandingPatch
	raw, err := httpbody.DecodeJSONBytes(r, agencyJSONMaxBytes, &patch, httpbody.Options{})
	if err != nil {
		setMutationOutcome(w, mutationOutcomeNotCommitted)
		httpbody.WriteError(w, err)
		return
	}
	if err := decodeAgencyJSON(raw); err != nil {
		code, message := "bad_json", "request body is not valid JSON"
		if errors.Is(err, errDuplicateJSONKey) {
			code, message = "duplicate_json_key", "request body contains a duplicate JSON object key"
		}
		writeNotCommitted(w, http.StatusBadRequest, code, message)
		return
	}
	var members map[string]json.RawMessage
	if err := json.Unmarshal(raw, &members); err != nil {
		writeNotCommitted(w, http.StatusBadRequest, "bad_json", "request body is not valid JSON")
		return
	}
	if len(members) == 0 {
		writeNotCommitted(w, http.StatusBadRequest, "empty_patch", "at least one branding field is required")
		return
	}
	for field, value := range members {
		if strings.TrimSpace(string(value)) == "null" {
			writeNotCommitted(w, http.StatusBadRequest, "null_field", field+" cannot be null; use an empty string to clear it")
			return
		}
	}
	_, present, wildcard := httpcache.ParseIfMatch(r)
	if !present || wildcard {
		setMutationOutcome(w, mutationOutcomeNotCommitted)
		httpcache.WritePreconditionRequired(w)
		return
	}

	// Validate the submitted fields even while the capability is contained, so
	// clients cannot come to depend on an unsafe shape that a later release
	// would reject. We deliberately do not read or mutate state until branding
	// has one canonical publication scope, owned logo delivery, and verified
	// custom-domain ownership.
	var candidate brandingFields
	if patch.Enabled != nil {
		candidate.Enabled = *patch.Enabled
	}
	if patch.BrandName != nil {
		candidate.BrandName = *patch.BrandName
	}
	if patch.CustomDomain != nil {
		candidate.CustomDomain = strings.TrimSpace(*patch.CustomDomain)
	}
	if patch.LogoURL != nil {
		candidate.LogoURL = strings.TrimSpace(*patch.LogoURL)
	}
	if patch.PrimaryColor != nil {
		candidate.PrimaryColor = strings.TrimSpace(*patch.PrimaryColor)
	}
	if patch.SupportEmail != nil {
		candidate.SupportEmail = strings.TrimSpace(*patch.SupportEmail)
	}
	if patch.LegalEntity != nil {
		candidate.LegalEntity = *patch.LegalEntity
	}
	if code, message := normalizeBranding(&candidate); code != "" {
		writeNotCommitted(w, http.StatusBadRequest, code, message)
		return
	}
	writeHeldMutation(w, "agency_branding_update_release_hold",
		"branding updates are unavailable until canonical publication scope, owned logo delivery, and custom-domain ownership verification are implemented; no branding was changed")
}

func normalizeBranding(b *brandingFields) (code, message string) {
	if b == nil {
		return "invalid_branding", "branding is required"
	}
	if b.BrandName != "" && !validBoundedText(b.BrandName, 1, 120) {
		return "invalid_brand_name", "brand_name must be 1 to 120 visible characters"
	}
	if b.LegalEntity != "" && !validBoundedText(b.LegalEntity, 1, 200) {
		return "invalid_legal_entity", "legal_entity must be 1 to 200 visible characters"
	}
	if domain, ok := normalizeCustomDomain(b.CustomDomain); !ok {
		return "invalid_custom_domain", "custom_domain must be a public DNS hostname without a scheme, path, port, wildcard, or reserved suffix"
	} else {
		b.CustomDomain = domain
	}
	if logo, ok := normalizeLogoURL(b.LogoURL); !ok {
		return "invalid_logo_url", "logo_url must be an HTTPS URL on a public DNS hostname without credentials, query, fragment, or port"
	} else {
		b.LogoURL = logo
	}
	if email, ok := normalizeSupportEmail(b.SupportEmail); !ok {
		return "invalid_support_email", "support_email must be one mailbox address of at most 254 characters"
	} else {
		b.SupportEmail = email
	}
	if b.PrimaryColor != "" {
		color, ok := normalizeHexColor(b.PrimaryColor)
		if !ok {
			return "invalid_color", "primary_color must be a six-digit hex colour like #1D4ED8"
		}
		if !colorHasWhiteTextContrast(color) {
			return "insufficient_color_contrast", "primary_color must have at least 4.5:1 contrast with white text"
		}
		b.PrimaryColor = color
	}
	return "", ""
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func errEnv(code, message string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": message}}
}
