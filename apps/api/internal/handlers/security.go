// SPDX-License-Identifier: AGPL-3.0-only
//
// Tenant security settings handlers. Moosewave delegates auth to an
// upstream IdP, so this surface controls *policy* the platform
// enforces (require MFA, session timeout) rather than storing TOTP
// secrets. Backed by tenant_security_settings (migration 0053).
package handlers

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type SecurityHandlers struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal for structured server-side
	// logging of unexpected failures. nil-safe — when nil, internal errors
	// are still returned to the client as the generic envelope but no log
	// line is emitted. main.go wires the process-wide *slog.Logger here.
	Logger *slog.Logger
}

const securityJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

type SecuritySettings struct {
	Require2FAForAdmins bool    `json:"require_2fa_for_admins"`
	Require2FAForAll    bool    `json:"require_2fa_for_all"`
	SSOProvider         *string `json:"sso_provider,omitempty"`
	SSOMetadataURL      *string `json:"sso_metadata_url,omitempty"`
	SessionMaxMinutes   *int    `json:"session_max_minutes,omitempty"`
	// AllowTrustedDevices is the AUTH#48 device-trust opt-out. Default TRUE
	// (device trust is an approved feature); a workspace that considers
	// "remember this device" incompatible with its require_2fa_* posture sets
	// it false, and the server then refuses BOTH to issue new trust records
	// and to let existing ones satisfy MFA.
	//
	// A POINTER, unlike the two booleans above, and deliberately so. Update is
	// a full-replace PUT: a plain bool would decode a client that simply does
	// not know about this field yet as `false`, silently disabling the feature
	// for that workspace on the next unrelated settings save. nil therefore
	// means "leave it alone"; only an explicitly sent value changes it.
	AllowTrustedDevices *bool `json:"allow_trusted_devices,omitempty"`
}

// Get GET /api/v1/security/settings
func (h *SecurityHandlers) Get(w http.ResponseWriter, r *http.Request) {
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

	var s SecuritySettings
	err = tx.QueryRow(r.Context(), `
SELECT require_2fa_for_admins, require_2fa_for_all,
       sso_provider, sso_metadata_url, session_max_minutes,
       allow_trusted_devices
FROM tenant_security_settings WHERE tenant_id = $1::uuid`, t.ID).
		Scan(&s.Require2FAForAdmins, &s.Require2FAForAll,
			&s.SSOProvider, &s.SSOMetadataURL, &s.SessionMaxMinutes,
			&s.AllowTrustedDevices)
	if err == pgx.ErrNoRows {
		// Lazy default row — keeps the UI consistent for tenants
		// that haven't visited security settings yet. Device trust reads TRUE
		// here because that is what the absent row means server-side; a nil
		// would make the toggle render indeterminate for the ~all tenants who
		// have never opened this screen.
		s = SecuritySettings{}
		allowed := true
		s.AllowTrustedDevices = &allowed
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

// Update PUT /api/v1/security/settings
func (h *SecurityHandlers) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in SecuritySettings
	if err := httpbody.DecodeJSON(w, r, securityJSONMaxBodyBytes, &in); err != nil {
		// httpbody.DecodeJSON returns operator-authored, non-sensitive text
		// (bad_json / payload_too_large), which httperror's safe-echo
		// allowlist permits to be surfaced verbatim.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}

	// Refuse SSO configuration while nothing enforces it.
	//
	// `sso_provider` and `sso_metadata_url` are written and read by this file and
	// by nothing else: there is no ACS route, no SAML or OIDC provider beyond the
	// single hard-coded "google" in internal/auth/oauth.go, and
	// scim.SAMLJITProvision has zero callers. Accepting the value returned 200
	// and left the workspace exactly as unprotected as before, while the settings
	// screen showed SSO as configured — an operator believing they had mandated
	// federated sign-in when they had not.
	//
	// This file already states the principle a few lines below, about
	// allow_trusted_devices: "A settings screen that echoes back a field the
	// server actually ignored is how a policy silently diverges from what the
	// operator believes they saved." This is that, with the stakes raised.
	//
	// ReasonRuntime, not a plan or permission problem: the capability's
	// execution is contained in this deployment and nothing the caller does
	// changes it. Storing the intent and enforcing nothing is the one option
	// that is not honest.
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Only a CHANGE is refused — echoing back what is already stored is not.
	//
	// The first version of this gate refused any request carrying a non-empty
	// SSO field, which locked out every tenant that had saved one BEFORE the
	// gate existed: this endpoint is a full replace, so all three clients send
	// the complete settings object on every save, and a persisted
	// `sso_provider` therefore rode along on requests that were only trying to
	// change the 2FA policy or the session timeout. The refusal was correct
	// about SSO and wrong about everything else on the screen, and it took the
	// rest of the security settings down with it.
	//
	// Clearing is always allowed: it is the one action that makes the stored
	// state match reality, so refusing it would leave the operator with no way
	// out of a value they can no longer change.
	var currentProvider, currentMetadataURL string
	if err := tx.QueryRow(r.Context(), `
SELECT COALESCE(sso_provider, ''), COALESCE(sso_metadata_url, '')
  FROM tenant_security_settings
 WHERE tenant_id = $1::uuid`, t.ID).Scan(&currentProvider, &currentMetadataURL); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			httperror.WriteInternal(w, h.Logger, err, r.Context())
			return
		}
		// No row yet: nothing is stored, so any non-empty value is a change.
		currentProvider, currentMetadataURL = "", ""
	}
	if changesSSO(in.SSOProvider, currentProvider) ||
		changesSSO(in.SSOMetadataURL, currentMetadataURL) {
		entitlement.Write(w, entitlement.Denial{
			Subject: "sso",
			Reason:  entitlement.ReasonRuntime,
			Code:    "sso_not_available",
			Message: "Single sign-on is not available in this deployment. " +
				"Saving a provider here would not change how anyone signs in.",
		})
		return
	}

	var userID *string
	if u, ok := middleware.UserFromContext(r.Context()); ok && u.ID != "" {
		id := u.ID
		userID = &id
	}

	// QueryRow, not Exec: the RETURNING clause hands back the RESOLVED
	// allow_trusted_devices so the echoed response states the stored policy
	// rather than the client's (possibly absent) input. A settings screen that
	// echoes back a field the server actually ignored is how a policy silently
	// diverges from what the operator believes they saved.
	var storedAllowTrustedDevices bool
	err = tx.QueryRow(r.Context(), `
INSERT INTO tenant_security_settings (
    tenant_id, require_2fa_for_admins, require_2fa_for_all,
    sso_provider, sso_metadata_url, session_max_minutes,
    allow_trusted_devices, updated_at, updated_by)
VALUES ($1::uuid, $2, $3, $4, $5, $6, COALESCE($7, true), now(), $8)
ON CONFLICT (tenant_id) DO UPDATE SET
    require_2fa_for_admins = EXCLUDED.require_2fa_for_admins,
    require_2fa_for_all    = EXCLUDED.require_2fa_for_all,
    sso_provider           = EXCLUDED.sso_provider,
    sso_metadata_url       = EXCLUDED.sso_metadata_url,
    session_max_minutes    = EXCLUDED.session_max_minutes,
    -- COALESCE on the SENT value, not on EXCLUDED: an omitted
    -- allow_trusted_devices must preserve whatever the workspace already
    -- chose. Writing EXCLUDED unconditionally would let any client that
    -- predates AUTH#48 reset the policy to the default on every save.
    allow_trusted_devices  = COALESCE($7, tenant_security_settings.allow_trusted_devices),
    updated_at             = now(),
    updated_by             = EXCLUDED.updated_by
RETURNING allow_trusted_devices`,
		t.ID, in.Require2FAForAdmins, in.Require2FAForAll,
		nullStr(in.SSOProvider), nullStr(in.SSOMetadataURL),
		nullInt(in.SessionMaxMinutes), nullBool(in.AllowTrustedDevices), userID).
		Scan(&storedAllowTrustedDevices)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	in.AllowTrustedDevices = &storedAllowTrustedDevices
	writeJSON(w, http.StatusOK, in)
}

// changesSSO reports whether an incoming field would CONFIGURE single sign-on
// to something other than what is already stored.
//
// Three inputs, three answers:
//
//   - nil (field omitted): not a change. An older client that does not know
//     about the field must not be refused for what it did not send.
//   - empty / whitespace: not a change, whatever is stored. Clearing is the
//     remedy, and blanking an already-blank field is a no-op.
//   - non-empty and different from stored: a change, and the only case refused.
//
// Compared on the TRIMMED value because that is what the write path stores
// (`nullStr` maps "" to NULL) and what every client sends after its own trim.
// Comparing raw would make a stray trailing space read as a new configuration
// and refuse a save that changes nothing.
func changesSSO(in *string, stored string) bool {
	if in == nil {
		return false
	}
	next := strings.TrimSpace(*in)
	if next == "" {
		return false
	}
	return next != strings.TrimSpace(stored)
}

func nullStr(p *string) any {
	if p == nil || *p == "" {
		return nil
	}
	return *p
}

func nullInt(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

// nullBool keeps a tri-state boolean tri-state on the way to Postgres:
// nil means "the client did not send this", which the UPSERT turns into
// "keep the stored value", NOT into false.
func nullBool(p *bool) any {
	if p == nil {
		return nil
	}
	return *p
}
