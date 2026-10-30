// SPDX-License-Identifier: AGPL-3.0-only
//
// HTTP handlers for the TOTP MFA flow.
//
// Routes (mount under the tenant-scoped group; all four require an
// authenticated session cookie):
//
//   - POST   /api/v1/auth/totp/enroll     → returns otpauth_uri + recovery_codes
//   - POST   /api/v1/auth/totp/verify     → first-time confirmation, flips session.mfa_satisfied
//   - POST   /api/v1/auth/totp/challenge  → step-up flow when session is enrolled but not yet MFA-satisfied
//   - DELETE /api/v1/auth/totp            → wipe enrollment
//
// Why both /verify and /challenge: /verify is the first-confirmation
// step that *also* enrolls the user (we want a known-good code before
// trusting the secret). /challenge is the per-session step-up: the
// user has already enrolled, but their CURRENT session was minted
// without MFA (e.g. they signed in fresh) and the policy requires it.
//
// The split keeps the state machine explicit in the API surface
// rather than tucked inside one handler that switches on whether
// enrollment is complete.
package auth

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// totpEnrollResponse is the one-shot payload returned by /totp/enroll.
// recovery_codes is shown to the user exactly once; the server only
// stores hashes from this point forward.
type totpEnrollResponse struct {
	OtpauthURI    string   `json:"otpauth_uri"`
	RecoveryCodes []string `json:"recovery_codes"`
}

// TOTPEnroll mints a fresh TOTP secret + recovery codes for the
// authenticated user. An unfinished enrollment may be restarted, while an
// existing confirmed factor can only be rotated by an MFA-satisfied session.
// The session is NOT marked MFA-satisfied here — the user must
// call /totp/verify with a known-good code first, which proves they
// actually have the secret on a device.
func (d *Deps) TOTPEnroll(w http.ResponseWriter, r *http.Request) {
	mc, ok := d.lookupMe(w, r)
	if !ok {
		return
	}
	if d.SecretCipher == nil {
		writeErr(w, http.StatusInternalServerError, "totp_unwired",
			"secret cipher not configured")
		return
	}
	// The enroll route must be reachable for a policy-locked user who has no
	// factor yet, but a stolen password/pre-MFA session must not be able to
	// rotate an existing confirmed factor. Unfinished enrollment rows may be
	// restarted because their recovery codes/URI may have been lost on reload.
	if d.Repo != nil {
		_, confirmed, err := d.Repo.TOTPSecretState(r.Context(), mc.UserID)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, r.Context())
			return
		}
		if confirmed && !mc.MFASatisfied {
			writeMFAChallengeDenial(w, "complete a TOTP challenge before rotating the existing factor")
			return
		}
	}

	rawSecret, base32Secret, err := GenerateSecret()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "secret_gen_failed", "")
		return
	}
	plainCodes, codeHashes, err := GenerateRecoveryCodes(RecoveryCodeCount)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "recovery_gen_failed", "")
		return
	}
	encrypted, err := d.SecretCipher.Encrypt(r.Context(), rawSecret)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "encrypt_failed", "")
		return
	}
	if err := d.Repo.UpsertTOTPSecret(
		r.Context(), mc.TenantID, mc.UserID, encrypted, codeHashes,
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	writeJSON(w, http.StatusOK, totpEnrollResponse{
		OtpauthURI:    BuildOtpauthURI(mc.UserEmail, base32Secret),
		RecoveryCodes: plainCodes,
	})
}

// totpCodeInput is the body of /totp/verify. The challenge handler
// uses a richer struct; we keep them split so the JSON contract is
// obvious from the type definitions.
type totpCodeInput struct {
	Code string `json:"code"`
}

// TOTPVerify confirms first-time enrollment. On success: marks the
// row as enrolled (last_used_at = now()), flips the current session's
// mfa_satisfied = true, returns 200 {verified: true}. On failure:
// 401 invalid_code (no row update, no session bump).
func (d *Deps) TOTPVerify(w http.ResponseWriter, r *http.Request) {
	mc, ok := d.lookupMe(w, r)
	if !ok {
		return
	}
	if d.SecretCipher == nil {
		writeErr(w, http.StatusInternalServerError, "totp_unwired", "")
		return
	}
	var in totpCodeInput
	if err := decodeAuthJSON(w, r, &in); err != nil {
		writeAuthDecodeErr(w, err)
		return
	}
	in.Code = strings.TrimSpace(in.Code)
	if in.Code == "" {
		writeErr(w, http.StatusBadRequest, "missing_code", "")
		return
	}

	encrypted, _, secretErr := d.Repo.GetTOTPSecret(r.Context(), mc.UserID)
	if errors.Is(secretErr, ErrNotFound) {
		writeErr(w, http.StatusBadRequest, "not_enrolled",
			"call /totp/enroll first")
		return
	}
	if secretErr != nil {
		writeErr(w, http.StatusInternalServerError, "lookup_failed", "")
		return
	}
	secret, secretErr := d.SecretCipher.Decrypt(r.Context(), encrypted, nil)
	if secretErr != nil {
		writeErr(w, http.StatusInternalServerError, "decrypt_failed", "")
		return
	}

	if !VerifyCode(secret, in.Code, time.Now(), 1) {
		writeErr(w, http.StatusUnauthorized, "invalid_code", "")
		return
	}

	// Bump last_used_at so the row reflects "enrollment confirmed".
	if err := d.Repo.MarkTOTPUsed(r.Context(), mc.TenantID, mc.UserID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// Flip the *current* session's mfa_satisfied flag so the user
	// doesn't have to immediately re-challenge.
	tok, secretErr := ParseSessionCookie(r)
	if secretErr != nil {
		writeErr(w, http.StatusUnauthorized, "no_session", "")
		return
	}
	if err := d.Repo.MarkSessionMFASatisfied(r.Context(), tok.ID); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeErr(w, http.StatusUnauthorized, "no_session", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"verified":      true,
		"mfa_satisfied": true,
	})
}

// totpChallengeInput is the body of /totp/challenge: either a 6-digit
// code or a recovery code. Exactly one must be present; the handler
// rejects the all-empty case to avoid silent acceptance.
type totpChallengeInput struct {
	Code         string `json:"code,omitempty"`
	RecoveryCode string `json:"recovery_code,omitempty"`
	// TrustDevice opts INTO issuing an AUTH#48 device-trust credential
	// alongside the successful challenge. Opt-in, never automatic: a feature
	// that weakens MFA must be something the user asked for on the screen
	// where they can see what they are agreeing to.
	TrustDevice bool `json:"trust_device,omitempty"`
	// TrustDays must be EXACTLY 30, 90 or 180 — the product owner's approved
	// set, with 180 as the maximum. Validated server-side before the code is
	// consumed, so a client posting 365 is rejected without burning a
	// recovery code. There is no custom value and no "forever".
	TrustDays int `json:"trust_days,omitempty"`
}

// TOTPChallenge satisfies MFA on the CURRENT session. The user has
// previously enrolled (via /totp/enroll + /totp/verify); this is the
// per-session step-up that downstream "require_2fa_*" gates demand.
//
// Already-MFA-satisfied sessions short-circuit with 200 {already: true}
// so the web client can call this opportunistically without burning a
// recovery code.
func (d *Deps) TOTPChallenge(w http.ResponseWriter, r *http.Request) {
	mc, ok := d.lookupMe(w, r)
	if !ok {
		return
	}
	if d.SecretCipher == nil {
		writeErr(w, http.StatusInternalServerError, "totp_unwired", "")
		return
	}
	tok, tokenErr := ParseSessionCookie(r)
	if tokenErr != nil {
		writeErr(w, http.StatusUnauthorized, "no_session", "")
		return
	}

	// Short-circuit if the current session is already MFA-OK. We refetch
	// here rather than trust the resolver projection because the
	// resolver value is stale once /totp/verify has flipped the row but
	// the request flow hasn't bounced yet.
	sess, tokenErr := d.Repo.LookupSession(r.Context(), tok.ID, tok.Verifier)
	if tokenErr != nil {
		writeErr(w, http.StatusUnauthorized, "no_session", "")
		return
	}
	if sess.MFASatisfied {
		// device_trusted is stated explicitly rather than omitted: a client
		// that asked to be remembered must be able to see that it was NOT,
		// and silence would read as success. Trust is only ever issued off
		// the back of a code this handler actually verified.
		writeJSON(w, http.StatusOK, map[string]any{
			"mfa_satisfied":  true,
			"already":        true,
			"device_trusted": false,
		})
		return
	}

	var in totpChallengeInput
	if err := decodeAuthJSON(w, r, &in); err != nil {
		writeAuthDecodeErr(w, err)
		return
	}
	in.Code = strings.TrimSpace(in.Code)
	in.RecoveryCode = strings.TrimSpace(in.RecoveryCode)
	if in.Code != "" && in.RecoveryCode != "" {
		writeErr(w, http.StatusBadRequest, "ambiguous_input",
			"send code XOR recovery_code, not both")
		return
	}
	// AUTH#48: validate the trust request BEFORE any code is verified or
	// consumed. A rejected trust_days must not cost the user a recovery code,
	// and a client posting 365 has to fail here rather than quietly receive a
	// 180-day record it did not ask for.
	if !d.validateTrustRequest(w, r, in, mc) {
		return
	}

	encrypted, _, tokenErr := d.Repo.GetTOTPSecret(r.Context(), mc.UserID)
	if errors.Is(tokenErr, ErrNotFound) {
		writeErr(w, http.StatusBadRequest, "not_enrolled", "")
		return
	}
	if tokenErr != nil {
		writeErr(w, http.StatusInternalServerError, "lookup_failed", "")
		return
	}
	if in.Code == "" && in.RecoveryCode == "" {
		writeErr(w, http.StatusBadRequest, "missing_code", "")
		return
	}

	if in.Code != "" {
		secret, err := d.SecretCipher.Decrypt(r.Context(), encrypted, nil)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "decrypt_failed", "")
			return
		}
		if !VerifyCode(secret, in.Code, time.Now(), 1) {
			writeErr(w, http.StatusUnauthorized, "invalid_code", "")
			return
		}
	} else {
		hash := HashRecoveryCode(in.RecoveryCode)
		if err := d.Repo.ConsumeRecoveryCode(
			r.Context(), mc.TenantID, mc.UserID, hash,
		); err != nil {
			if errors.Is(err, ErrNotFound) {
				writeErr(w, http.StatusUnauthorized, "invalid_code", "")
				return
			}
			writeErr(w, http.StatusInternalServerError, "consume_failed", "")
			return
		}
	}

	if err := d.Repo.MarkTOTPUsed(r.Context(), mc.TenantID, mc.UserID); err != nil {
		// Best-effort: failing to bump last_used_at must NOT undo the
		// successful challenge.
		w.Header().Set("X-Postwave-MFA-Mark-Used", "failed")
	}
	if err := d.Repo.MarkSessionMFASatisfied(r.Context(), tok.ID); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeErr(w, http.StatusUnauthorized, "no_session", "")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	// The challenge has SUCCEEDED at this point. Nothing below may turn that
	// into a failure response — the user's code is spent either way, so a
	// trust-issuance problem is reported as device_trusted:false on a 200,
	// never as a 500 that would send them back to the keypad.
	body := map[string]any{"mfa_satisfied": true, "device_trusted": false}
	if in.TrustDevice {
		d.issueDeviceTrust(w, r, mc, in.TrustDays, body)
	}
	writeJSON(w, http.StatusOK, body)
}

// TOTPDisable wipes the enrollment row entirely. Use case: the user
// is voluntarily turning MFA off (subject to the tenant's
// require_2fa_for_admins / require_2fa_for_all policy enforced one
// layer up via middleware.RequireMFAIfPolicy).
//
// Re-auth gate (audit finding M2): refuses the request when the
// session has NOT satisfied MFA. Without this, an attacker who
// stole a pre-MFA session cookie could DELETE the enrollment, then
// log in fully without ever passing TOTP. The handler is still the
// recovery-from-lockout path for users who lost their authenticator
// AND all recovery codes — those users go through support, who
// either re-verify them out-of-band and reset via the impersonate
// surface, or have the tenant admin disable MFA enforcement
// temporarily.
func (d *Deps) TOTPDisable(w http.ResponseWriter, r *http.Request) {
	mc, ok := d.lookupMe(w, r)
	if !ok {
		return
	}
	if !mc.MFASatisfied {
		writeMFAChallengeDenial(w, "complete a TOTP challenge before disabling MFA")
		return
	}
	if d.MFARequirementLookup != nil {
		required, authoritative := d.MFARequirementLookup(r.Context(), mc.TenantID, mc.UserRole)
		if !authoritative {
			writeErr(w, http.StatusServiceUnavailable, "mfa_policy_unavailable", "")
			return
		}
		if required {
			writeMFAPolicyDenial(w)
			return
		}
	}
	if err := d.Repo.DeleteTOTPSecret(r.Context(), mc.TenantID, mc.UserID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// lookupMe is the shared "must have a session" preamble. Returns
// (MeContext, true) on success; otherwise writes a 401/500 to w and
// returns (_, false) so the caller can simply `return`.
func (d *Deps) lookupMe(w http.ResponseWriter, r *http.Request) (MeContext, bool) {
	if d.MeContextLookup == nil {
		writeErr(w, http.StatusInternalServerError, "me_unwired", "")
		return MeContext{}, false
	}
	mc, ok := d.MeContextLookup(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_session", "")
		return MeContext{}, false
	}
	return mc, true
}
