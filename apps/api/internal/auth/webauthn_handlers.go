// SPDX-License-Identifier: AGPL-3.0-only
//
// AUTH-023 — WebAuthn / passkey HTTP handlers. Two public ceremonies for
// discoverable (usernameless) login and four authenticated handlers for
// enrollment + management. Challenge state lives in a short-lived signed cookie
// (see webauthn.go); nothing here trusts client-supplied challenge material.
package auth

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

const (
	regChallengeCookie   = "pw_wa_reg"
	loginChallengeCookie = "pw_wa_login"
	webauthnCookiePath   = "/api/v1/auth/webauthn"
	maxPasskeyNameLen    = 100
	maxCeremonyBody      = 1 << 16 // 64 KiB — attestation/assertion JSON

	// Fixed public texts for the 5xx ceremony-setup failures. The underlying
	// library / signer error is logged server-side and never echoed: it can
	// name the RP configuration or the signing key state.
	webauthnBeginFailedMessage       = "the passkey ceremony could not be started"
	webauthnChallengeUnsignedMessage = "the passkey challenge could not be issued"
)

// logWebauthnFailure records a ceremony-setup failure server-side before the
// handler answers with a fixed public message. Nil-safe for Deps built without
// a logger.
func (d *Deps) logWebauthnFailure(msg string, err error) {
	if d.Logger == nil || err == nil {
		return
	}
	d.Logger.Error(msg, "err", err.Error())
}

func (d *Deps) setChallengeCookie(w http.ResponseWriter, name, value string) {
	http.SetCookie(w, &http.Cookie{ // #nosec G124 -- challenge cookie is HttpOnly/SameSite and inherits production-safe Secure options
		Name:     name,
		Value:    value,
		Path:     webauthnCookiePath,
		Domain:   d.CookieOptions.Domain,
		MaxAge:   int(challengeCookieTTL.Seconds()),
		Secure:   d.CookieOptions.Secure,
		HttpOnly: true,
		SameSite: d.CookieOptions.SameSite,
	})
}

func (d *Deps) clearChallengeCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{ // #nosec G124 -- deletion mirrors the challenge cookie's hardened attributes
		Name:     name,
		Value:    "",
		Path:     webauthnCookiePath,
		Domain:   d.CookieOptions.Domain,
		MaxAge:   -1,
		Secure:   d.CookieOptions.Secure,
		HttpOnly: true,
		SameSite: d.CookieOptions.SameSite,
	})
}

// WebauthnRegisterBegin POST /api/v1/auth/webauthn/register/begin (authenticated).
func (d *Deps) WebauthnRegisterBegin(w http.ResponseWriter, r *http.Request) {
	mc, ok := d.lookupMe(w, r)
	if !ok {
		return
	}
	if d.WebAuthn == nil {
		writeErr(w, http.StatusInternalServerError, "webauthn_unwired", "")
		return
	}
	existing, err := d.Repo.ListWebauthnCredentials(r.Context(), mc.TenantID, mc.UserID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	creds := make([]webauthn.Credential, 0, len(existing))
	exclude := make([]protocol.CredentialDescriptor, 0, len(existing))
	for i := range existing {
		c := toWebauthnCredential(existing[i])
		creds = append(creds, c)
		exclude = append(exclude, c.Descriptor())
	}
	user := &webauthnUser{id: []byte(mc.UserID), name: mc.UserEmail, displayName: mc.UserEmail, creds: creds}

	creation, session, err := d.WebAuthn.BeginRegistration(user,
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationPreferred,
		}),
		webauthn.WithExclusions(exclude),
	)
	if err != nil {
		d.logWebauthnFailure("webauthn: begin registration failed", err)
		writeErr(w, http.StatusInternalServerError, "webauthn_begin_failed", webauthnBeginFailedMessage)
		return
	}
	now := time.Now()
	token, err := signChallenge(d.AuthLinkSigningKey, "reg", mc.UserID, mc.TenantID, session, now)
	if err != nil {
		d.logWebauthnFailure("webauthn: sign registration challenge failed", err)
		writeErr(w, http.StatusInternalServerError, "webauthn_unwired", webauthnChallengeUnsignedMessage)
		return
	}
	// Record the nonce so finish can enforce single-use. Hard-fail if it can't
	// be stored — otherwise finish would reject a legitimate ceremony.
	if err := d.Repo.StoreWebauthnChallenge(r.Context(), challengeNonceHash(session.Challenge), "reg", now.Add(challengeCookieTTL)); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	d.setChallengeCookie(w, regChallengeCookie, token)
	writeJSON(w, http.StatusOK, creation)
}

// WebauthnRegisterFinish POST /api/v1/auth/webauthn/register/finish (authenticated).
func (d *Deps) WebauthnRegisterFinish(w http.ResponseWriter, r *http.Request) {
	mc, ok := d.lookupMe(w, r)
	if !ok {
		return
	}
	if d.WebAuthn == nil {
		writeErr(w, http.StatusInternalServerError, "webauthn_unwired", "")
		return
	}
	cookie, cerr := r.Cookie(regChallengeCookie)
	if cerr != nil {
		writeErr(w, http.StatusBadRequest, "missing_challenge", "no registration ceremony in progress")
		return
	}
	session, boundUser, boundTenant, verr := verifyChallenge(d.AuthLinkSigningKey, "reg", cookie.Value, time.Now())
	if verr != nil {
		writeErr(w, http.StatusBadRequest, "invalid_challenge", "")
		return
	}
	// The cookie must belong to THIS session's user, not a replayed one.
	if boundUser != mc.UserID || boundTenant != mc.TenantID {
		writeErr(w, http.StatusBadRequest, "challenge_mismatch", "")
		return
	}
	// Single-use: consume the nonce. A replay (or an expired challenge) finds
	// nothing to consume and is rejected before any attestation work.
	consumed, cerr := d.Repo.ConsumeWebauthnChallenge(r.Context(), challengeNonceHash(session.Challenge), "reg", time.Now())
	if cerr != nil {
		httperror.WriteInternal(w, d.Logger, cerr, r.Context())
		return
	}
	if !consumed {
		writeErr(w, http.StatusBadRequest, "invalid_challenge", "")
		return
	}

	name, credentialJSON, perr := splitPasskeyRegisterBody(r)
	if perr != nil {
		writeErr(w, http.StatusBadRequest, "invalid_body", perr.Error())
		return
	}
	parsed, err := protocol.ParseCredentialCreationResponseBody(bytes.NewReader(credentialJSON))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_attestation", "")
		return
	}
	user := &webauthnUser{id: []byte(mc.UserID), name: mc.UserEmail, displayName: mc.UserEmail}
	cred, err := d.WebAuthn.CreateCredential(user, *session, parsed)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "attestation_failed", "")
		return
	}
	d.clearChallengeCookie(w, regChallengeCookie)

	row := credentialToRow(mc.UserID, name, cred)
	stored, serr := d.Repo.StoreWebauthnCredential(r.Context(), mc.TenantID, row)
	if serr != nil {
		if errors.Is(serr, ErrCredentialExists) {
			writeErr(w, http.StatusConflict, "already_registered", "this passkey is already enrolled")
			return
		}
		httperror.WriteInternal(w, d.Logger, serr, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, passkeySummary(*stored))
}

// WebauthnLoginBegin POST /api/v1/auth/webauthn/login/begin (public).
func (d *Deps) WebauthnLoginBegin(w http.ResponseWriter, r *http.Request) {
	if d.WebAuthn == nil {
		writeErr(w, http.StatusInternalServerError, "webauthn_unwired", "")
		return
	}
	assertion, session, err := d.WebAuthn.BeginDiscoverableLogin(
		webauthn.WithUserVerification(protocol.VerificationPreferred),
	)
	if err != nil {
		d.logWebauthnFailure("webauthn: begin login failed", err)
		writeErr(w, http.StatusInternalServerError, "webauthn_begin_failed", webauthnBeginFailedMessage)
		return
	}
	now := time.Now()
	token, err := signChallenge(d.AuthLinkSigningKey, "login", "", "", session, now)
	if err != nil {
		d.logWebauthnFailure("webauthn: sign login challenge failed", err)
		writeErr(w, http.StatusInternalServerError, "webauthn_unwired", webauthnChallengeUnsignedMessage)
		return
	}
	if err := d.Repo.StoreWebauthnChallenge(r.Context(), challengeNonceHash(session.Challenge), "login", now.Add(challengeCookieTTL)); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	d.setChallengeCookie(w, loginChallengeCookie, token)
	writeJSON(w, http.StatusOK, assertion)
}

// WebauthnLoginFinish POST /api/v1/auth/webauthn/login/finish (public).
func (d *Deps) WebauthnLoginFinish(w http.ResponseWriter, r *http.Request) {
	if d.WebAuthn == nil {
		writeErr(w, http.StatusInternalServerError, "webauthn_unwired", "")
		return
	}
	cookie, cerr := r.Cookie(loginChallengeCookie)
	if cerr != nil {
		writeErr(w, http.StatusBadRequest, "missing_challenge", "no login ceremony in progress")
		return
	}
	session, _, _, verr := verifyChallenge(d.AuthLinkSigningKey, "login", cookie.Value, time.Now())
	if verr != nil {
		writeErr(w, http.StatusBadRequest, "invalid_challenge", "")
		return
	}
	// Single-use: consume the nonce so a captured cookie+assertion can't be
	// replayed within the TTL (the dominant zero-signCount passkey case has no
	// counter-based clone defense).
	consumed, cerr := d.Repo.ConsumeWebauthnChallenge(r.Context(), challengeNonceHash(session.Challenge), "login", time.Now())
	if cerr != nil {
		httperror.WriteInternal(w, d.Logger, cerr, r.Context())
		return
	}
	if !consumed {
		writeErr(w, http.StatusUnauthorized, "assertion_failed", "")
		return
	}
	body, berr := httpbody.ReadAtMost(r.Body, maxCeremonyBody)
	if berr != nil {
		writeErr(w, http.StatusBadRequest, "invalid_body", "")
		return
	}
	parsed, perr := protocol.ParseCredentialRequestResponseBody(bytes.NewReader(body))
	if perr != nil {
		writeErr(w, http.StatusBadRequest, "invalid_assertion", "")
		return
	}

	// The discoverable handler resolves the account from the credential id, so
	// there's no username step. Capture the resolved identity for session issue.
	// infraErr distinguishes a DB/infrastructure failure inside the callback
	// (→ 500) from an unknown-credential / inactive-account outcome (→ 401), so
	// a transient outage isn't reported to the user as a failed assertion.
	var resolved *User
	var infraErr error
	handler := func(rawID, userHandle []byte) (webauthn.User, error) {
		cred, err := d.Repo.WebauthnCredentialByRawID(r.Context(), rawID)
		if err != nil {
			if !errors.Is(err, ErrNotFound) {
				infraErr = err
			}
			return nil, err
		}
		u, err := d.Repo.UserByIDResolver(r.Context(), cred.UserID)
		if err != nil {
			if !errors.Is(err, ErrNotFound) {
				infraErr = err
			}
			return nil, err
		}
		if u.Status == "suspended" || u.Status == "deleted" {
			return nil, errors.New("account not active")
		}
		all, err := d.Repo.WebauthnCredentialsForUserResolver(r.Context(), cred.UserID)
		if err != nil {
			infraErr = err
			return nil, err
		}
		creds := make([]webauthn.Credential, 0, len(all))
		for i := range all {
			creds = append(creds, toWebauthnCredential(all[i]))
		}
		resolved = u
		return &webauthnUser{id: []byte(u.ID), name: u.Email, displayName: u.Email, creds: creds}, nil
	}

	cred, err := d.WebAuthn.ValidateDiscoverableLogin(handler, *session, parsed)
	if err != nil || resolved == nil {
		if infraErr != nil {
			httperror.WriteInternal(w, d.Logger, infraErr, r.Context())
			return
		}
		writeErr(w, http.StatusUnauthorized, "assertion_failed", "")
		return
	}
	d.clearChallengeCookie(w, loginChallengeCookie)

	// A signature-counter regression means the authenticator may be cloned. The
	// dominant synced-passkey case reports 0 and never trips this, but when the
	// library does flag it we surface a security signal rather than swallow it.
	if cred.Authenticator.CloneWarning {
		d.Logger.Warn("webauthn: possible cloned authenticator on passkey login",
			"user_id", resolved.ID, "tenant_id", resolved.TenantID)
	}
	// Persist the post-assertion signature counter (clone-detection state). A
	// failure here doesn't void an already-valid assertion, but it must be
	// observable rather than silently dropped.
	if err := d.Repo.UpdateWebauthnSignCount(r.Context(), resolved.TenantID, cred.ID, int64(cred.Authenticator.SignCount)); err != nil {
		d.Logger.Warn("webauthn: sign-count update failed", "err", err.Error(), "user_id", resolved.ID)
	}

	if err := d.issueSessionWithLifetime(w, r, resolved.TenantID, resolved.ID, "webauthn", true); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"tenant_id":   resolved.TenantID,
		"tenant_slug": resolved.TenantSlug,
	})
}

// WebauthnListPasskeys GET /api/v1/auth/webauthn/credentials (authenticated).
func (d *Deps) WebauthnListPasskeys(w http.ResponseWriter, r *http.Request) {
	mc, ok := d.lookupMe(w, r)
	if !ok {
		return
	}
	rows, err := d.Repo.ListWebauthnCredentials(r.Context(), mc.TenantID, mc.UserID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	items := make([]passkeyView, 0, len(rows))
	for _, c := range rows {
		items = append(items, passkeySummary(c))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// WebauthnRenamePasskey PATCH /api/v1/auth/webauthn/credentials/{id} (authenticated).
func (d *Deps) WebauthnRenamePasskey(w http.ResponseWriter, r *http.Request) {
	mc, ok := d.lookupMe(w, r)
	if !ok {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := decodeAuthJSON(w, r, &body); err != nil {
		return
	}
	name := clampPasskeyName(body.Name)
	updated, err := d.Repo.RenameWebauthnCredential(r.Context(), mc.TenantID, mc.UserID, chi.URLParam(r, "id"), name)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if !updated {
		writeErr(w, http.StatusNotFound, "not_found", "passkey not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": name})
}

// WebauthnDeletePasskey DELETE /api/v1/auth/webauthn/credentials/{id} (authenticated).
func (d *Deps) WebauthnDeletePasskey(w http.ResponseWriter, r *http.Request) {
	mc, ok := d.lookupMe(w, r)
	if !ok {
		return
	}
	deleted, err := d.Repo.DeleteWebauthnCredential(r.Context(), mc.TenantID, mc.UserID, chi.URLParam(r, "id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if !deleted {
		writeErr(w, http.StatusNotFound, "not_found", "passkey not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- helpers ---

type passkeyView struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	BackedUp   bool       `json:"backed_up"`
}

func passkeySummary(c WebauthnCredential) passkeyView {
	return passkeyView{
		ID: c.ID, Name: c.Name, CreatedAt: c.CreatedAt,
		LastUsedAt: c.LastUsedAt, BackedUp: c.BackupState,
	}
}

func credentialToRow(userID, name string, cred *webauthn.Credential) WebauthnCredential {
	transports := make([]string, 0, len(cred.Transport))
	for _, t := range cred.Transport {
		transports = append(transports, string(t))
	}
	return WebauthnCredential{
		UserID:         userID,
		CredentialID:   cred.ID,
		PublicKey:      cred.PublicKey,
		SignCount:      int64(cred.Authenticator.SignCount),
		AAGUID:         cred.Authenticator.AAGUID,
		Transports:     transports,
		BackupEligible: cred.Flags.BackupEligible,
		BackupState:    cred.Flags.BackupState,
		Name:           clampPasskeyName(name),
	}
}

func clampPasskeyName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "Passkey"
	}
	if len(name) > maxPasskeyNameLen {
		name = name[:maxPasskeyNameLen]
	}
	return name
}

// splitPasskeyRegisterBody reads {name, credential} where credential is the raw
// attestation object. Returns (name, credentialJSON, err).
func splitPasskeyRegisterBody(r *http.Request) (string, []byte, error) {
	raw, err := httpbody.ReadAtMost(r.Body, maxCeremonyBody)
	if err != nil {
		return "", nil, err
	}
	var body struct {
		Name       string          `json:"name"`
		Credential json.RawMessage `json:"credential"`
	}
	if err := httpbody.DecodeJSONValue(raw, &body, httpbody.Options{AllowUnknownFields: true}); err != nil {
		return "", nil, err
	}
	if len(body.Credential) == 0 {
		return "", nil, errors.New("missing credential")
	}
	return body.Name, body.Credential, nil
}
