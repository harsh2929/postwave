// SPDX-License-Identifier: AGPL-3.0-only
//
// recovery_codes.go — the second half of the TOTP recovery-code lifecycle.
//
// Before this file the bundle was write-once: GenerateRecoveryCodes was
// called in exactly one place (TOTPEnroll) and nothing ever counted or
// replaced it. A user who burned all eight codes had no path back that
// didn't involve support, and no client could warn them they were running
// low because the count was never on the wire.
//
// Routes (mounted in the authenticated, tenant-resolved group):
//
//	GET  /api/v1/auth/totp/recovery-codes  → {remaining, total, low}
//	POST /api/v1/auth/totp/recovery-codes  → {recovery_codes:[...], remaining}
//
// Design decisions worth stating explicitly, because this is the MFA
// break-glass path:
//
//  1. REGENERATION IS A FULL REPLACE. The old bundle stops working the
//     instant the new sheet is rendered. A partial top-up would leave a
//     leaked printout live forever, which is the failure mode recovery
//     codes exist to bound.
//
//  2. REGENERATION REQUIRES A FRESH POSSESSION PROOF — a current
//     authenticator code, verified server-side at the moment of the call.
//     The threat is unchanged: a stolen pre-MFA session cookie must not be
//     able to mint itself a fresh set of recovery codes and walk straight
//     through the challenge. What changed is the proof. This used to accept
//     the session's mfa_satisfied flag, which is set once at login and never
//     expires — so a BORROWED POST-MFA session could mint codes forever, and
//     the gate protected only against the weaker of the two thefts. A current
//     code is strictly stronger: it defeats both, because neither a pre-MFA
//     nor a post-MFA stolen cookie carries the user's authenticator (SETC-035).
//
//  3. THE COUNT IS NOT A SECRET, THE CODES ARE. The GET returns only a
//     count; plaintext is returned exactly once, from the POST, and is
//     never recoverable afterwards (we store sha256 only).
//
//  4. AN UNFINISHED ENROLLMENT CANNOT REGENERATE. Rotating codes for a
//     factor the user never proved they hold would hand a fresh bundle to
//     whoever started the enrollment. Those users restart /totp/enroll,
//     which mints a new secret AND a new bundle together.
package auth

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// RecoveryCodesLowWatermark is the count at or below which clients should
// nudge the user to regenerate. Two codes is one accidental burn away from
// being locked out, which is where the warning earns its interruption.
const RecoveryCodesLowWatermark = 2

// recoveryCodesStatusResponse is the body of GET /totp/recovery-codes.
type recoveryCodesStatusResponse struct {
	// Enrolled is false when the user has no confirmed factor; Remaining is
	// then 0 and the client should offer enrollment rather than regeneration.
	Enrolled bool `json:"enrolled"`
	// Remaining counts unused codes. Total is what a fresh bundle contains,
	// so a client can render "3 of 8 left" without hard-coding the 8.
	Remaining int `json:"remaining"`
	Total     int `json:"total"`
	// Low is the server's opinion, so every client agrees on the threshold
	// instead of each picking its own (the drift AUTH#53 warns about).
	Low bool `json:"low"`
}

// recoveryCodesRegenerateResponse is the body of POST /totp/recovery-codes.
// The plaintext is shown exactly once — there is no endpoint that returns
// it again.
type recoveryCodesRegenerateResponse struct {
	RecoveryCodes []string `json:"recovery_codes"`
	Remaining     int      `json:"remaining"`
	Total         int      `json:"total"`
}

// MountRecoveryCodeRoutes registers the status + regenerate pair. Caller
// wires these inside the authenticated, tenant-resolved group so
// MeContextLookup is populated — identical placement to the other /totp
// routes.
func (d *Deps) MountRecoveryCodeRoutes(r chi.Router) {
	if d == nil || d.Repo == nil {
		return
	}
	r.Get("/api/v1/auth/totp/recovery-codes", d.RecoveryCodesStatus)
	r.Post("/api/v1/auth/totp/recovery-codes", d.RegenerateRecoveryCodes)
}

// RecoveryCodesStatus GET /api/v1/auth/totp/recovery-codes.
//
// Deliberately readable by a session that has NOT satisfied MFA: a user who
// is staring at a challenge they cannot pass needs to know whether a
// recovery code is even available to them. The count leaks nothing an
// attacker can spend.
func (d *Deps) RecoveryCodesStatus(w http.ResponseWriter, r *http.Request) {
	mc, ok := d.lookupMe(w, r)
	if !ok {
		return
	}
	confirmed, remaining, err := d.Repo.TOTPFactorStatus(r.Context(), mc.UserID)
	if err != nil {
		// Never map a lookup failure to "0 codes left" — that would tell a
		// user with a healthy bundle that they are locked out. A SPECIFIC
		// code (not the generic internal one) so a client can distinguish
		// "we could not read this" from "you have none", and a log line so
		// the failure is not silent.
		d.logRecoveryFailure(r, "status", mc, err)
		writeErr(w, http.StatusInternalServerError, "recovery_status_failed",
			"could not read recovery-code state")
		return
	}
	if !confirmed {
		writeJSON(w, http.StatusOK, recoveryCodesStatusResponse{
			Enrolled: false, Remaining: 0, Total: RecoveryCodeCount, Low: false,
		})
		return
	}
	writeJSON(w, http.StatusOK, recoveryCodesStatusResponse{
		Enrolled:  true,
		Remaining: remaining,
		Total:     RecoveryCodeCount,
		Low:       remaining <= RecoveryCodesLowWatermark,
	})
}

// RegenerateRecoveryCodes POST /api/v1/auth/totp/recovery-codes.
//
// Replaces the entire bundle and returns the new plaintext once. Minting
// durable recovery codes requires a genuinely FRESH possession proof — a
// current authenticator code verified server-side right now — NOT the sticky
// session mfa_satisfied flag (which is set once at login and never expires, so
// a borrowed post-MFA session could otherwise mint codes forever). SETC-035.
func (d *Deps) RegenerateRecoveryCodes(w http.ResponseWriter, r *http.Request) {
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
		writeErr(w, http.StatusBadRequest, "missing_code",
			"a current authenticator code is required to regenerate recovery codes")
		return
	}
	encrypted, _, secretErr := d.Repo.GetTOTPSecret(r.Context(), mc.UserID)
	if errors.Is(secretErr, ErrNotFound) {
		writeErr(w, http.StatusBadRequest, "not_enrolled",
			"confirm a TOTP factor via /totp/enroll and /totp/verify first")
		return
	}
	if secretErr != nil {
		d.logRecoveryFailure(r, "regenerate.secret", mc, secretErr)
		writeErr(w, http.StatusInternalServerError, "recovery_status_failed",
			"could not read recovery-code state")
		return
	}
	secret, decErr := d.SecretCipher.Decrypt(r.Context(), encrypted, nil)
	if decErr != nil {
		d.logRecoveryFailure(r, "regenerate.decrypt", mc, decErr)
		writeErr(w, http.StatusInternalServerError, "recovery_status_failed",
			"could not read recovery-code state")
		return
	}
	if !VerifyCode(secret, in.Code, time.Now(), 1) {
		writeErr(w, http.StatusUnauthorized, "invalid_code", "that code didn't match")
		return
	}

	plainCodes, codeHashes, err := GenerateRecoveryCodes(RecoveryCodeCount)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "recovery_gen_failed",
			"could not generate recovery codes")
		return
	}
	if err := d.Repo.ReplaceRecoveryCodes(
		r.Context(), mc.TenantID, mc.UserID, codeHashes,
	); err != nil {
		if errors.Is(err, ErrNotFound) {
			// The factor was disabled or reset between the check above and
			// the write. Report the real state rather than a bare 500.
			writeErr(w, http.StatusBadRequest, "not_enrolled",
				"no confirmed TOTP factor to regenerate codes for")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	writeJSON(w, http.StatusOK, recoveryCodesRegenerateResponse{
		RecoveryCodes: plainCodes,
		Remaining:     len(plainCodes),
		Total:         RecoveryCodeCount,
	})
}

// logRecoveryFailure records a recovery-code path failure with enough context
// to investigate and nothing that would leak a code. Deliberately paired with
// a SPECIFIC error code on the wire rather than httperror.WriteInternal's
// generic one: "a 500 with a bare message" is precisely what the audit keeps
// finding, and MFA break-glass is the last place a client should have to
// guess whether to retry or to re-enroll.
func (d *Deps) logRecoveryFailure(r *http.Request, stage string, mc MeContext, err error) {
	log := d.Logger
	if log == nil {
		log = slog.Default()
	}
	log.ErrorContext(r.Context(), "auth: recovery-code operation failed",
		"stage", stage, "tenant_id", mc.TenantID, "user_id", mc.UserID,
		"err", err.Error())
}
