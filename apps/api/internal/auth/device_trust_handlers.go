// SPDX-License-Identifier: AGPL-3.0-only
//
// device_trust_handlers.go — AUTH#48 issuance + the visibility/revocation
// surface that makes issuing it defensible.
//
// ── ISSUANCE ───────────────────────────────────────────────────────────────
// Not a route of its own. Trust is minted as a side effect of a SUCCESSFUL
// TOTP challenge, opted into with `trust_device` on POST /auth/totp/challenge.
// That coupling is the security property: you can only ask to skip the second
// factor immediately after passing it.
//
// ── VISIBILITY ─────────────────────────────────────────────────────────────
//
//	GET    /api/v1/auth/trusted-devices             what can skip my 2FA
//	DELETE /api/v1/auth/trusted-devices/{id}        kill one
//	POST   /api/v1/auth/trusted-devices/revoke-all  kill everything
//
// A credential the user cannot see or kill is not acceptable, and these three
// routes are the reason the feature was allowed to ship. They sit in the
// authenticated, tenant-resolved group alongside /auth/sessions and carry the
// same authorization shape: session-only (no API key can enumerate or revoke
// somebody's MFA bypasses) at viewer minimum role, because these are the
// caller's OWN records — a viewer must be able to revoke their own trust.
// Both halves are enforced: the manifest row is the binding policy and
// MountTrustedDeviceRoutes places them behind routeauth.Middleware.
package auth

import (
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// trustedDeviceInfo is the wire shape of one trust record. The verifier hash
// is not in it and never will be.
type trustedDeviceInfo struct {
	ID        string    `json:"id"`
	TrustDays int       `json:"trust_days"`
	IssuedAt  time.Time `json:"issued_at"`
	ExpiresAt time.Time `json:"expires_at"`
	// LastUsedAt is OMITTED, not zeroed, when the record has never satisfied
	// MFA. Absence is not a timestamp: a client must render "not used yet",
	// and a zero time would render as 1 January year 1.
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	IP         string     `json:"ip,omitempty"`
	UserAgent  string     `json:"user_agent,omitempty"`
	// Current marks the record belonging to the device making this request,
	// so the UI can say "this device" instead of asking the user to guess
	// which of three iPhones they are holding.
	Current bool `json:"current"`
	DeviceIdentity
}

// trustedDevicesResponse also carries the POLICY, so no client has to
// hard-code the approved durations or guess whether their workspace allows the
// feature at all. Same reasoning as RecoveryCodesLowWatermark: the server owns
// the rule, the clients render it.
type trustedDevicesResponse struct {
	TrustedDevices []trustedDeviceInfo `json:"trusted_devices"`
	// Allowed is this tenant's allow_trusted_devices policy. When false the
	// list is still returned (existing records remain visible and revocable —
	// turning the policy off must not hide credentials that already exist)
	// but no new trust can be issued.
	Allowed bool `json:"allowed"`
	// AllowedDurations is EXACTLY [30, 90, 180]. Not a suggestion: a client
	// that offers anything else gets a 400 from the challenge endpoint.
	AllowedDurations []int `json:"allowed_durations"`
	MaxDays          int   `json:"max_days"`
	DefaultDays      int   `json:"default_days"`
}

// MountTrustedDeviceRoutes registers the three management endpoints. Caller
// wires these inside the authenticated, tenant-resolved group so both
// middleware.UserFromContext and MeContextLookup are populated — identical
// placement to MountSessionRoutes.
func (d *Deps) MountTrustedDeviceRoutes(r chi.Router) {
	if d == nil || d.Repo == nil {
		return
	}
	r.Get("/api/v1/auth/trusted-devices", d.ListTrustedDevices)
	r.Delete("/api/v1/auth/trusted-devices/{id}", d.RevokeTrustedDevice)
	r.Post("/api/v1/auth/trusted-devices/revoke-all", d.RevokeAllTrustedDevices)
}

// validateTrustRequest checks the opt-in trust parameters on a TOTP challenge
// BEFORE the code is verified. Returns false after writing an error response.
//
// Ordering matters: a 365-day request or a policy-disabled workspace must fail
// without consuming the user's TOTP code or (worse) a single-use recovery
// code. Callers therefore invoke this immediately after decoding the body.
func (d *Deps) validateTrustRequest(
	w http.ResponseWriter, r *http.Request, in totpChallengeInput, mc MeContext,
) bool {
	if !in.TrustDevice {
		return true
	}
	// THE CONSTRAINT. Exactly 30, 90 or 180 — enforced here on the server, not
	// only in the picker, because a UI-only constraint is not a constraint.
	if !IsAllowedTrustDays(in.TrustDays) {
		writeErr(w, http.StatusBadRequest, "invalid_trust_duration",
			"trust_days must be one of 30, 90 or 180")
		return false
	}
	allowed, err := d.Repo.DeviceTrustAllowed(r.Context(), mc.TenantID)
	if err != nil {
		// A policy we could not read is not a policy that said yes. Refuse the
		// request rather than default to permitting an MFA weakener; the user
		// can retry, or challenge without the trust box ticked.
		writeErr(w, http.StatusServiceUnavailable, "device_trust_policy_unavailable",
			"could not read this workspace's device-trust policy")
		return false
	}
	if !allowed {
		writeDeviceTrustDisabledDenial(w)
		return false
	}
	return true
}

// issueDeviceTrust mints the trust record + cookie after a challenge has
// already succeeded, and REPORTS the outcome into body.
//
// It never fails the request. The user's code is spent by the time we get
// here, so a failure to persist trust is a degraded success — 200 with
// device_trusted:false and a trust_error code — not a 500 that would strand
// them at the keypad with a burnt code.
func (d *Deps) issueDeviceTrust(
	w http.ResponseWriter, r *http.Request, mc MeContext, days int, body map[string]any,
) {
	ttl, ok := TrustDuration(days)
	if !ok {
		// Unreachable via the handler (validateTrustRequest ran first), but
		// this is the last gate before a duration reaches the database, so it
		// stays.
		body["trust_error"] = "invalid_trust_duration"
		return
	}
	tok, err := IssueTrustToken()
	if err != nil {
		body["trust_error"] = "trust_token_failed"
		return
	}
	ua := r.UserAgent()
	if len(ua) > 512 {
		ua = ua[:512]
	}
	stored, err := d.Repo.CreateTrustedDevice(r.Context(), TrustedDevice{
		ID:        tok.ID,
		TenantID:  mc.TenantID,
		UserID:    mc.UserID,
		TrustDays: days,
		Label:     IdentifyDevice(ua).Label,
		UserAgent: ua,
		IP:        bestEffortClientIP(r),
		// ABSOLUTE expiry, computed once, here. Nothing extends it.
		ExpiresAt: time.Now().Add(ttl),
	}, HashTrustVerifier(tok.Verifier, d.Repo.trustPepper()))
	if err != nil {
		d.logTrustFailure(r, "issue.store", err)
		body["trust_error"] = "trust_store_failed"
		return
	}
	SetTrustCookie(w, tok, d.CookieOptions, ttl)
	body["device_trusted"] = true
	body["trust_expires_at"] = stored.ExpiresAt
	body["trust_days"] = stored.TrustDays
}

// ListTrustedDevices GET /api/v1/auth/trusted-devices.
func (d *Deps) ListTrustedDevices(w http.ResponseWriter, r *http.Request) {
	mc, ok := d.trustedDeviceCaller(w, r)
	if !ok {
		return
	}
	rows, err := d.Repo.ListTrustedDevices(r.Context(), mc.TenantID, mc.UserID)
	if err != nil {
		// A SPECIFIC code, not a bare 500: "we could not read your trusted
		// devices" and "you have none" must not look the same on a screen
		// whose whole job is to tell you what can skip your second factor.
		d.logTrustFailure(r, "list.read", err)
		writeErr(w, http.StatusInternalServerError, "trusted_devices_list_failed",
			"could not read your trusted devices")
		return
	}
	allowed, err := d.Repo.DeviceTrustAllowed(r.Context(), mc.TenantID)
	if err != nil {
		d.logTrustFailure(r, "list.policy", err)
		writeErr(w, http.StatusInternalServerError, "device_trust_policy_unavailable",
			"could not read this workspace's device-trust policy")
		return
	}
	currentID := ""
	if tok, tokErr := ParseTrustCookie(r); tokErr == nil {
		currentID = tok.ID
	}
	out := make([]trustedDeviceInfo, 0, len(rows))
	for _, row := range rows {
		info := trustedDeviceInfo{
			ID:             row.ID,
			TrustDays:      row.TrustDays,
			IssuedAt:       row.IssuedAt,
			ExpiresAt:      row.ExpiresAt,
			LastUsedAt:     row.LastUsedAt,
			IP:             row.IP,
			UserAgent:      row.UserAgent,
			Current:        currentID != "" && row.ID == currentID,
			DeviceIdentity: IdentifyDevice(row.UserAgent),
		}
		out = append(out, info)
	}
	writeJSON(w, http.StatusOK, trustedDevicesResponse{
		TrustedDevices:   out,
		Allowed:          allowed,
		AllowedDurations: append([]int(nil), AllowedTrustDays...),
		MaxDays:          MaxTrustDays,
		DefaultDays:      DefaultTrustDays,
	})
}

// RevokeTrustedDevice DELETE /api/v1/auth/trusted-devices/{id}.
//
// 404 when the id does not exist OR belongs to someone else — the same
// non-disclosure the session revoke path uses, so an id-fishing attempt learns
// nothing.
func (d *Deps) RevokeTrustedDevice(w http.ResponseWriter, r *http.Request) {
	mc, ok := d.trustedDeviceCaller(w, r)
	if !ok {
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing_id", "a trusted device id is required")
		return
	}
	revoked, err := d.Repo.RevokeTrustedDevice(r.Context(), mc.TenantID, mc.UserID, id)
	if err != nil {
		d.logTrustFailure(r, "revoke.one", err)
		writeErr(w, http.StatusInternalServerError, "trusted_device_revoke_failed",
			"could not revoke that trusted device")
		return
	}
	if !revoked {
		writeErr(w, http.StatusNotFound, "not_found", "no such trusted device")
		return
	}
	// If the caller just revoked THIS device's own trust, drop the cookie too
	// so the client stops presenting a credential the server will refuse.
	if tok, tokErr := ParseTrustCookie(r); tokErr == nil && tok.ID == id {
		ClearTrustCookie(w, d.CookieOptions)
	}
	writeJSON(w, http.StatusOK, map[string]any{"revoked": true})
}

// RevokeAllTrustedDevices POST /api/v1/auth/trusted-devices/revoke-all.
//
// The panic button. After this returns, every device is back to a full second
// factor, including the one that called it — which is why the cookie is
// cleared unconditionally rather than only when a record matched.
func (d *Deps) RevokeAllTrustedDevices(w http.ResponseWriter, r *http.Request) {
	mc, ok := d.trustedDeviceCaller(w, r)
	if !ok {
		return
	}
	count, err := d.Repo.RevokeAllTrustedDevices(r.Context(), mc.TenantID, mc.UserID)
	if err != nil {
		d.logTrustFailure(r, "revoke.all", err)
		writeErr(w, http.StatusInternalServerError, "trusted_devices_revoke_failed",
			"could not revoke your trusted devices")
		return
	}
	ClearTrustCookie(w, d.CookieOptions)
	writeJSON(w, http.StatusOK, map[string]any{"revoked_count": count})
}

// trustedDeviceCaller resolves the caller's (tenant, user) for the three
// management routes. Uses the same MeContextLookup the /totp routes use, so
// the tenant scoping of the RLS-backed queries matches the session's tenant
// exactly rather than being re-derived from a second source that could drift.
func (d *Deps) trustedDeviceCaller(w http.ResponseWriter, r *http.Request) (MeContext, bool) {
	mc, ok := d.lookupMe(w, r)
	if !ok {
		return MeContext{}, false
	}
	if mc.TenantID == "" || mc.UserID == "" {
		writeErr(w, http.StatusUnauthorized, "no_user",
			"endpoint requires a session-resolved user")
		return MeContext{}, false
	}
	// Belt and braces: the mount site places these behind the tenant-resolving
	// middleware, so a missing middleware user means the route escaped its
	// group. Fail closed rather than operate on a half-resolved identity.
	if u, present := middleware.UserFromContext(r.Context()); !present || u == nil || u.ID == "" {
		writeErr(w, http.StatusUnauthorized, "no_user",
			"endpoint requires a session-resolved user")
		return MeContext{}, false
	}
	return mc, true
}

// logTrustFailure records a device-trust failure with enough context to
// investigate and nothing that could leak a credential (no ids, no verifiers).
// Paired with a SPECIFIC error code on the wire rather than the generic
// internal envelope: on a security screen, "we could not read this" and "you
// have none" must not be the same answer.
func (d *Deps) logTrustFailure(r *http.Request, stage string, err error) {
	log := d.Logger
	if log == nil {
		log = slog.Default()
	}
	log.ErrorContext(r.Context(), "auth: device-trust operation failed",
		"stage", stage, "err", err.Error())
}
