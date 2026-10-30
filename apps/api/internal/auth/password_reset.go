// SPDX-License-Identifier: AGPL-3.0-only
//
// Password reset flow. Two endpoints:
//
//   - POST /api/v1/auth/password-reset/start
//     { email, link_version, link_audience, state? }
//     Always returns 202 Accepted. Issues a password_reset token + email
//     when the email matches a user; silent no-op otherwise. The 1-hour
//     TTL is longer than magic-link's 5min — users frequently take a
//     coffee break before clicking — but bounded so a stolen email
//     spool doesn't yield indefinite reset capability.
//
//   - POST /api/v1/auth/password-reset/confirm
//     { token, new_password, link_version, link_flow, link_audience,
//     state?, link_signature }
//     Validates new_password length >= 12 and hashes it with
//     auth.Hash(..., Recommended). ResetPassword then atomically consumes the
//     purpose-bound token, changes the credential, and revokes every existing
//     session. Any failure rolls the whole transaction back, leaving the token
//     retryable and the old password + sessions unchanged. The user signs in
//     fresh after success.
package auth

import (
	"context"
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/mailer"
)

// PasswordResetRepository is the narrow persistence contract for the reset
// lifecycle. ResetPassword MUST implement token consumption, credential update,
// and session revocation in one transaction. The interface exists so the HTTP
// failure paths can be tested without weakening Repo's transaction boundary.
type PasswordResetRepository interface {
	LookupUserByEmail(ctx context.Context, email string) ([]User, error)
	LookupCredential(ctx context.Context, userID string) (*Credential, error)
	IssueToken(ctx context.Context, tenantID, userID, purpose string, ttl time.Duration) (string, error)
	ResetPassword(ctx context.Context, token, newPasswordPHC string) error
}

func (d *Deps) passwordResetRepository() PasswordResetRepository {
	if d.PasswordResetRepo != nil {
		return d.PasswordResetRepo
	}
	if d.Repo != nil {
		return d.Repo
	}
	return nil
}

// passwordResetTTL: 1 hour is the industry-conventional window. Long
// enough for users on slow email; short enough to bound exposure.
const passwordResetTTL = 1 * time.Hour

// PasswordResetStartInput is the body of POST /api/v1/auth/password-reset/start.
type PasswordResetStartInput struct {
	Email string `json:"email"`
	AuthLinkStartFields
}

// PasswordResetConfirmInput is the body of POST /api/v1/auth/password-reset/confirm.
type PasswordResetConfirmInput struct {
	Token       string `json:"token"`
	NewPassword string `json:"new_password"`
	AuthLinkProofFields
}

// PasswordResetStart accepts an email and (if it resolves to one or
// more users) issues + emails reset tokens. Always 202.
func (d *Deps) PasswordResetStart(w http.ResponseWriter, r *http.Request) {
	var in PasswordResetStartInput
	if err := decodeAuthJSON(w, r, &in); err != nil {
		writeAuthDecodeErr(w, err)
		return
	}
	in.Email = strings.TrimSpace(in.Email)
	if _, err := mail.ParseAddress(in.Email); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_email", "")
		return
	}
	binding, bindingErr := normalizeAuthLinkStart(in.AuthLinkStartFields)
	if bindingErr != nil {
		writeErr(w, http.StatusBadRequest, "invalid_link_contract", "")
		return
	}

	repo := d.passwordResetRepository()
	if repo == nil {
		writeErr(w, http.StatusInternalServerError, "reset_unavailable", "")
		return
	}
	users, err := repo.LookupUserByEmail(r.Context(), in.Email)
	if err != nil && !errors.Is(err, ErrNotFound) {
		writeErr(w, http.StatusInternalServerError, "lookup_failed", "")
		return
	}

	if !errors.Is(err, ErrNotFound) {
		for _, u := range users {
			// Accounts without a local password must continue with their IdP;
			// do not issue a reset token that can never update a credential.
			// The external response remains the same 202 for every account state.
			if _, credentialErr := repo.LookupCredential(r.Context(), u.ID); credentialErr != nil {
				if !errors.Is(credentialErr, ErrNotFound) && d.Logger != nil {
					d.Logger.Warn("password reset credential lookup failed",
						"err", credentialErr.Error(), "user_id", u.ID, "tenant_id", u.TenantID)
				}
				continue
			}
			if e := d.sendPasswordReset(r.Context(), repo, u.TenantID, u.ID, u.Email, binding); e != nil {
				// Do not expose delivery status: a per-account header is an email
				// enumeration oracle. Operators retain the structured failure.
				if d.Logger != nil {
					d.Logger.Warn("password reset delivery failed",
						"err", e.Error(), "user_id", u.ID, "tenant_id", u.TenantID)
				}
			}
		}
	}

	writeJSON(w, http.StatusAccepted, map[string]any{"sent": true})
}

// PasswordResetConfirm consumes the reset token and writes a new
// password. Also revokes all of the user's existing sessions.
func (d *Deps) PasswordResetConfirm(w http.ResponseWriter, r *http.Request) {
	var in PasswordResetConfirmInput
	if err := decodeAuthJSON(w, r, &in); err != nil {
		writeAuthDecodeErr(w, err)
		return
	}
	if strings.TrimSpace(in.Token) == "" {
		writeErr(w, http.StatusBadRequest, "missing_token", "")
		return
	}
	if len(in.NewPassword) < 12 {
		writeErr(w, http.StatusBadRequest, "weak_password",
			"password must be at least 12 characters")
		return
	}
	if err := d.verifyAuthLinkProof(in.Token, authLinkFlowReset, in.AuthLinkProofFields); err != nil {
		if errors.Is(err, errAuthLinkSigningKey) {
			writeErr(w, http.StatusInternalServerError, "link_verification_unavailable", "")
			return
		}
		writeErr(w, http.StatusBadRequest, "invalid_link_contract", "")
		return
	}

	phc, err := Hash(in.NewPassword, Recommended)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "hash_failed", "")
		return
	}

	repo := d.passwordResetRepository()
	if repo == nil {
		writeErr(w, http.StatusInternalServerError, "reset_unavailable", "")
		return
	}
	if err := repo.ResetPassword(r.Context(), in.Token, phc); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeErr(w, http.StatusBadRequest, "invalid_token", "")
			return
		}
		writeErr(w, http.StatusInternalServerError, "update_failed", "")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"reset": true})
}

// sendPasswordReset issues a reset token and emails it.
func (d *Deps) sendPasswordReset(
	ctx context.Context,
	repo PasswordResetRepository,
	tenantID, userID, email string,
	binding authLinkBinding,
) error {
	plain, err := repo.IssueToken(ctx, tenantID, userID, "password_reset", passwordResetTTL)
	if err != nil {
		return err
	}
	if d.Mailer == nil {
		return nil
	}
	link, err := d.buildVersionedAuthPublicLink(
		"/reset-password",
		plain,
		authLinkFlowReset,
		binding,
	)
	if err != nil {
		return err
	}
	return d.Mailer.Send(ctx, mailer.Message{
		From:    d.FromAddress,
		To:      email,
		Subject: "Reset your Moosewave password",
		Body: "We received a request to reset your Moosewave password.\n\n" +
			"Click the link below to choose a new one. The link expires in 1 hour.\n\n" +
			link + "\n\nIf you didn't request this, ignore this email — your password will not change.\n",
		Tags: map[string]string{"purpose": "password_reset"},
	})
}
