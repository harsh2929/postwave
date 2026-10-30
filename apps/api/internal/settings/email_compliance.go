package settings

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/mail"
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

// EmailComplianceProfile is the workspace-level commercial email compliance
// profile. It is deliberately operational, not just legal copy: campaign send
// paths use it as a hard gate before commercial fan-out.
type EmailComplianceProfile struct {
	TenantID                   string    `json:"tenant_id"`
	LegalSenderName            string    `json:"legal_sender_name"`
	PhysicalAddressLine1       string    `json:"physical_address_line1"`
	PhysicalAddressLine2       string    `json:"physical_address_line2"`
	PhysicalAddressCity        string    `json:"physical_address_city"`
	PhysicalAddressRegion      string    `json:"physical_address_region"`
	PhysicalAddressPostalCode  string    `json:"physical_address_postal_code"`
	PhysicalAddressCountry     string    `json:"physical_address_country"`
	ComplianceContactEmail     string    `json:"compliance_contact_email,omitempty"`
	DefaultFooterText          string    `json:"default_footer_text"`
	ListUnsubscribeEnabled     bool      `json:"list_unsubscribe_enabled"`
	OneClickUnsubscribeEnabled bool      `json:"one_click_unsubscribe_enabled"`
	VerifiedSenderDomain       bool      `json:"verified_sender_domain"`
	UpdatedByUserID            *string   `json:"updated_by_user_id,omitempty"`
	CreatedAt                  time.Time `json:"created_at"`
	UpdatedAt                  time.Time `json:"updated_at"`
}

// IsReady returns whether the minimum CAN-SPAM/ePrivacy send identity gate is
// satisfied. Verified sender domain remains a separate deliverability gate.
func (p EmailComplianceProfile) IsReady() bool {
	return strings.TrimSpace(p.LegalSenderName) != "" &&
		strings.TrimSpace(p.PhysicalAddressLine1) != "" &&
		strings.TrimSpace(p.PhysicalAddressCity) != "" &&
		strings.TrimSpace(p.PhysicalAddressCountry) != "" &&
		strings.TrimSpace(p.ComplianceContactEmail) != "" &&
		p.ListUnsubscribeEnabled &&
		p.OneClickUnsubscribeEnabled
}

// EmailCompliancePatch is the PUT/PATCH body for the profile. A full PUT is
// easier for clients than partial PATCH because this profile is edited as one
// legal block.
type EmailCompliancePatch struct {
	LegalSenderName            string `json:"legal_sender_name"`
	PhysicalAddressLine1       string `json:"physical_address_line1"`
	PhysicalAddressLine2       string `json:"physical_address_line2"`
	PhysicalAddressCity        string `json:"physical_address_city"`
	PhysicalAddressRegion      string `json:"physical_address_region"`
	PhysicalAddressPostalCode  string `json:"physical_address_postal_code"`
	PhysicalAddressCountry     string `json:"physical_address_country"`
	ComplianceContactEmail     string `json:"compliance_contact_email"`
	DefaultFooterText          string `json:"default_footer_text"`
	ListUnsubscribeEnabled     bool   `json:"list_unsubscribe_enabled"`
	OneClickUnsubscribeEnabled bool   `json:"one_click_unsubscribe_enabled"`
	VerifiedSenderDomain       bool   `json:"verified_sender_domain"`
}

type EmailComplianceRepo struct{ Pool *db.Pool }

var ErrEmailComplianceNotFound = errors.New("settings: email compliance profile not found")

func defaultEmailComplianceProfile(tenantID string) EmailComplianceProfile {
	return EmailComplianceProfile{
		TenantID:                   tenantID,
		ListUnsubscribeEnabled:     true,
		OneClickUnsubscribeEnabled: true,
		CreatedAt:                  time.Time{},
		UpdatedAt:                  time.Time{},
	}
}

func (r *EmailComplianceRepo) Get(ctx context.Context, tenantID string) (*EmailComplianceProfile, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	const q = `
SELECT tenant_id::text, legal_sender_name, physical_address_line1,
       physical_address_line2, physical_address_city, physical_address_region,
       physical_address_postal_code, physical_address_country,
       COALESCE(compliance_contact_email::text, ''), default_footer_text,
       list_unsubscribe_enabled, one_click_unsubscribe_enabled,
       verified_sender_domain, updated_by_user_id::text, created_at, updated_at
FROM email_compliance_profiles
WHERE tenant_id = $1::uuid`
	var out EmailComplianceProfile
	var updater *string
	if err := tx.QueryRow(ctx, q, tenantID).Scan(
		&out.TenantID,
		&out.LegalSenderName,
		&out.PhysicalAddressLine1,
		&out.PhysicalAddressLine2,
		&out.PhysicalAddressCity,
		&out.PhysicalAddressRegion,
		&out.PhysicalAddressPostalCode,
		&out.PhysicalAddressCountry,
		&out.ComplianceContactEmail,
		&out.DefaultFooterText,
		&out.ListUnsubscribeEnabled,
		&out.OneClickUnsubscribeEnabled,
		&out.VerifiedSenderDomain,
		&updater,
		&out.CreatedAt,
		&out.UpdatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrEmailComplianceNotFound
		}
		return nil, err
	}
	if updater != nil && *updater != "" {
		out.UpdatedByUserID = updater
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

func (r *EmailComplianceRepo) Upsert(ctx context.Context, tenantID, userID string, patch EmailCompliancePatch) (*EmailComplianceProfile, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	const q = `
INSERT INTO email_compliance_profiles (
    tenant_id, legal_sender_name, physical_address_line1,
    physical_address_line2, physical_address_city, physical_address_region,
    physical_address_postal_code, physical_address_country,
    compliance_contact_email, default_footer_text,
    list_unsubscribe_enabled, one_click_unsubscribe_enabled,
    verified_sender_domain, updated_by_user_id, updated_at
) VALUES (
    $1::uuid, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, '')::citext, $10,
    $11, $12, $13, NULLIF($14, '')::uuid, now()
)
ON CONFLICT (tenant_id) DO UPDATE SET
    legal_sender_name = EXCLUDED.legal_sender_name,
    physical_address_line1 = EXCLUDED.physical_address_line1,
    physical_address_line2 = EXCLUDED.physical_address_line2,
    physical_address_city = EXCLUDED.physical_address_city,
    physical_address_region = EXCLUDED.physical_address_region,
    physical_address_postal_code = EXCLUDED.physical_address_postal_code,
    physical_address_country = EXCLUDED.physical_address_country,
    compliance_contact_email = EXCLUDED.compliance_contact_email,
    default_footer_text = EXCLUDED.default_footer_text,
    list_unsubscribe_enabled = EXCLUDED.list_unsubscribe_enabled,
    one_click_unsubscribe_enabled = EXCLUDED.one_click_unsubscribe_enabled,
    verified_sender_domain = EXCLUDED.verified_sender_domain,
    updated_by_user_id = COALESCE(EXCLUDED.updated_by_user_id, email_compliance_profiles.updated_by_user_id),
    updated_at = now()
RETURNING tenant_id::text, legal_sender_name, physical_address_line1,
          physical_address_line2, physical_address_city, physical_address_region,
          physical_address_postal_code, physical_address_country,
          COALESCE(compliance_contact_email::text, ''), default_footer_text,
          list_unsubscribe_enabled, one_click_unsubscribe_enabled,
          verified_sender_domain, updated_by_user_id::text, created_at, updated_at`
	var out EmailComplianceProfile
	var updater *string
	if err := tx.QueryRow(ctx, q,
		tenantID,
		patch.LegalSenderName,
		patch.PhysicalAddressLine1,
		patch.PhysicalAddressLine2,
		patch.PhysicalAddressCity,
		patch.PhysicalAddressRegion,
		patch.PhysicalAddressPostalCode,
		patch.PhysicalAddressCountry,
		patch.ComplianceContactEmail,
		patch.DefaultFooterText,
		patch.ListUnsubscribeEnabled,
		patch.OneClickUnsubscribeEnabled,
		patch.VerifiedSenderDomain,
		userID,
	).Scan(
		&out.TenantID,
		&out.LegalSenderName,
		&out.PhysicalAddressLine1,
		&out.PhysicalAddressLine2,
		&out.PhysicalAddressCity,
		&out.PhysicalAddressRegion,
		&out.PhysicalAddressPostalCode,
		&out.PhysicalAddressCountry,
		&out.ComplianceContactEmail,
		&out.DefaultFooterText,
		&out.ListUnsubscribeEnabled,
		&out.OneClickUnsubscribeEnabled,
		&out.VerifiedSenderDomain,
		&updater,
		&out.CreatedAt,
		&out.UpdatedAt,
	); err != nil {
		return nil, err
	}
	if updater != nil && *updater != "" {
		out.UpdatedByUserID = updater
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

type EmailComplianceDeps struct {
	Repo   *EmailComplianceRepo
	Logger *slog.Logger
}

// MountRoutes wires GET/PUT /api/v1/settings/email-compliance.
//
// The PUT carries the CAN-SPAM physical address + sender identity +
// the kill-switch booleans for list-unsubscribe + the
// verified_sender_domain flag (server-validated below — admins can no
// longer self-certify domain verification by setting this true).
// Admin-only.
func (d *EmailComplianceDeps) MountRoutes(r chi.Router) {
	r.Get("/api/v1/settings/email-compliance", d.Get)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Put("/api/v1/settings/email-compliance", d.Put)
}

func (d *EmailComplianceDeps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	p, err := d.Repo.Get(r.Context(), t.ID)
	if err != nil {
		if errors.Is(err, ErrEmailComplianceNotFound) {
			writeJSON(w, http.StatusOK, defaultEmailComplianceProfile(t.ID))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (d *EmailComplianceDeps) Put(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in EmailCompliancePatch
	if err := httpbody.DecodeJSON(w, r, settingsJSONMaxBodyBytes, &in); err != nil {
		// httpbody.ErrorCode returns codes like bad_json / payload_too_large
		// whose messages are operator-authored and safe to echo verbatim.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	normalizeEmailCompliancePatch(&in)
	if err := validateEmailCompliancePatch(in); err != nil {
		// validateEmailCompliancePatch returns our own operator-authored
		// error strings — safe to surface verbatim via WriteValidation.
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	userID := ""
	if u, _ := middleware.UserFromContext(r.Context()); u != nil {
		userID = u.ID
	}
	// verified_sender_domain is a server-computed flag (it reflects the
	// DKIM/DNS verification state of the sending domain). Accepting it
	// from the client is a self-certification vulnerability — an admin
	// could PUT verified=true and bypass downstream send gates that
	// rely on the flag. Read the persisted value here and preserve it
	// across the write, regardless of what the client sent.
	if existing, err := d.Repo.Get(r.Context(), t.ID); err == nil && existing != nil {
		in.VerifiedSenderDomain = existing.VerifiedSenderDomain
	} else {
		// No prior row → can't have been verified yet.
		in.VerifiedSenderDomain = false
	}
	before, _ := d.Repo.Get(r.Context(), t.ID)
	out, err := d.Repo.Upsert(r.Context(), t.ID, userID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	emitSettingsAudit(r.Context(), d.Repo.Pool, r, t.ID,
		"settings.email_compliance.updated", "email_compliance_profile", t.ID, before, out)
	writeJSON(w, http.StatusOK, out)
}

func normalizeEmailCompliancePatch(in *EmailCompliancePatch) {
	in.LegalSenderName = strings.TrimSpace(in.LegalSenderName)
	in.PhysicalAddressLine1 = strings.TrimSpace(in.PhysicalAddressLine1)
	in.PhysicalAddressLine2 = strings.TrimSpace(in.PhysicalAddressLine2)
	in.PhysicalAddressCity = strings.TrimSpace(in.PhysicalAddressCity)
	in.PhysicalAddressRegion = strings.TrimSpace(in.PhysicalAddressRegion)
	in.PhysicalAddressPostalCode = strings.TrimSpace(in.PhysicalAddressPostalCode)
	in.PhysicalAddressCountry = strings.ToUpper(strings.TrimSpace(in.PhysicalAddressCountry))
	in.ComplianceContactEmail = strings.ToLower(strings.TrimSpace(in.ComplianceContactEmail))
	in.DefaultFooterText = strings.TrimSpace(in.DefaultFooterText)
}

func validateEmailCompliancePatch(in EmailCompliancePatch) error {
	if in.LegalSenderName == "" {
		return errors.New("legal_sender_name is required")
	}
	if in.PhysicalAddressLine1 == "" || in.PhysicalAddressCity == "" || in.PhysicalAddressCountry == "" {
		return errors.New("physical address line 1, city, and country are required")
	}
	if in.ComplianceContactEmail == "" {
		return errors.New("compliance_contact_email is required")
	}
	if _, err := mail.ParseAddress(in.ComplianceContactEmail); err != nil {
		return errors.New("compliance_contact_email must be a valid email address")
	}
	if !in.ListUnsubscribeEnabled || !in.OneClickUnsubscribeEnabled {
		return errors.New("list-unsubscribe and one-click unsubscribe must remain enabled for commercial sending")
	}
	return nil
}
