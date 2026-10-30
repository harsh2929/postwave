// SPDX-License-Identifier: AGPL-3.0-only
//
// Magic-link sign-in. Two endpoints:
//
//   - POST /api/v1/auth/magic-link/start
//     { email, link_version, link_audience, state? }
//     Always returns 202 Accepted. If the email maps to a user, we
//     issue a magic_link token (5-minute TTL) and email it. We
//     deliberately do NOT signal whether the email existed: the
//     enumeration leak shows up via timing + presence-of-email
//     otherwise.
//
//   - POST /api/v1/auth/magic-link/consume
//     { token, link_version, link_flow, link_audience, state?,
//     link_signature }
//     Consumes the token, issues a session (auth_method=magic_link),
//     sets the cookie, and returns {user_id, tenant_id}. Multi-tenant
//     ambiguity is impossible by design: each auth_tokens row carries
//     a single (user_id, tenant_id), so consuming the token uniquely
//     resolves the tenant the user is signing into. The HMAC-bound v1
//     envelope prevents flow/audience/state rewriting before consumption.
//
// If the user has the same email across multiple tenants, that's a
// product surface to expose at the START step ("we sent links for
// each of your workspaces") — handled here by issuing one token per
// tenant row.
package auth

import (
	"context"
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/mailer"
)

// magicLinkTTL is intentionally short — these are sign-in credentials
// over plain email, so the window for an intercepted link to be useful
// is tight. 5 minutes balances usability (slow inbox delivery) against
// blast radius.
const magicLinkTTL = 5 * time.Minute

// MagicLinkStartInput is the body of POST /api/v1/auth/magic-link/start.
type MagicLinkStartInput struct {
	Email string `json:"email"`
	AuthLinkStartFields
}

// MagicLinkConsumeInput is the body of POST /api/v1/auth/magic-link/consume.
type MagicLinkConsumeInput struct {
	Token string `json:"token"`
	AuthLinkProofFields
}

// MagicLinkStart accepts an email and (if it resolves to one or more
// users) emails a magic-link token. ALWAYS returns 202: do not leak
// whether the email exists.
func (d *Deps) MagicLinkStart(w http.ResponseWriter, r *http.Request) {
	var in MagicLinkStartInput
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

	users, err := d.Repo.LookupUserByEmail(r.Context(), in.Email)
	if err != nil && !errors.Is(err, ErrNotFound) {
		// Internal failure — surface as 500 (not 202): a failing DB
		// shouldn't be silently masked by the enumeration-defense
		// behavior. The user retries.
		writeErr(w, http.StatusInternalServerError, "lookup_failed", "")
		return
	}

	// On no-match, fall through to the 202: same response the user
	// sees when the email matches.
	if !errors.Is(err, ErrNotFound) {
		for _, u := range users {
			// Best-effort send. Delivery status is intentionally never exposed
			// in the response: a per-account header would defeat the uniform
			// 202 body and disclose which email addresses resolve locally.
			if e := d.sendMagicLink(r.Context(), u.TenantID, u.ID, u.Email, binding); e != nil {
				if d.Logger != nil {
					d.Logger.Warn("magic link delivery failed",
						"err", e.Error(), "user_id", u.ID, "tenant_id", u.TenantID)
				}
			}
		}
	}

	writeJSON(w, http.StatusAccepted, map[string]any{"sent": true})
}

// MagicLinkConsume validates a one-time magic-link token and signs the
// user in.
func (d *Deps) MagicLinkConsume(w http.ResponseWriter, r *http.Request) {
	var in MagicLinkConsumeInput
	if err := decodeAuthJSON(w, r, &in); err != nil {
		writeAuthDecodeErr(w, err)
		return
	}
	if strings.TrimSpace(in.Token) == "" {
		writeErr(w, http.StatusBadRequest, "missing_token", "")
		return
	}
	if err := d.verifyAuthLinkProof(in.Token, authLinkFlowMagic, in.AuthLinkProofFields); err != nil {
		if errors.Is(err, errAuthLinkSigningKey) {
			writeErr(w, http.StatusInternalServerError, "link_verification_unavailable", "")
			return
		}
		writeErr(w, http.StatusBadRequest, "invalid_link_contract", "")
		return
	}

	userID, tenantID, purpose, err := d.Repo.ConsumeToken(r.Context(), in.Token)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_token", "")
		return
	}
	if purpose != "magic_link" {
		writeErr(w, http.StatusBadRequest, "wrong_purpose", "")
		return
	}

	if err := d.issueSession(w, r, tenantID, userID, "magic_link"); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"user_id":   userID,
		"tenant_id": tenantID,
	})
}

// SendMagicLink is the exported wrapper around sendMagicLink so other
// packages (notably main.go's billingAutoTenantAdapter) can issue a
// magic-link invitation after auto-provisioning a tenant. The signature
// is identical; this lives next to its lowercase sibling so the two
// implementations can never drift.
//
// Callers MUST be sure the (tenantID, userID, email) tuple resolves to
// a real users row — IssueToken will succeed against any uuid pair the
// auth_tokens table accepts, but a token bound to a non-existent user
// is dead-on-arrival on consumption.
func (d *Deps) SendMagicLink(ctx context.Context, tenantID, userID, email string) error {
	return d.sendMagicLink(ctx, tenantID, userID, email, authLinkBinding{
		Version:  authLinkVersion,
		Audience: authLinkAudienceWeb,
	})
}

// sendMagicLink issues a magic-link token and emails it. Mirrors the
// shape of sendVerification so operators only learn one pattern.
func (d *Deps) sendMagicLink(
	ctx context.Context,
	tenantID, userID, email string,
	binding authLinkBinding,
) error {
	plain, err := d.Repo.IssueToken(ctx, tenantID, userID, "magic_link", magicLinkTTL)
	if err != nil {
		return err
	}
	// Mailer can be nil in tests / dev scaffolds. We still issued the
	// token so a manual extraction path (dev-time inspection of the
	// auth_tokens table) works.
	if d.Mailer == nil {
		return nil
	}
	link, err := d.buildVersionedAuthPublicLink(
		"/magic-link",
		plain,
		authLinkFlowMagic,
		binding,
	)
	if err != nil {
		return err
	}
	return d.Mailer.Send(ctx, mailer.Message{
		From:    d.FromAddress,
		To:      email,
		Subject: "Your Moosewave sign-in link",
		Body: "Sign in to Moosewave with the link below. It expires in 5 minutes.\n\n" +
			link + "\n\nIf you didn't request this, ignore this email.\n",
		Tags: map[string]string{"purpose": "magic_link"},
	})
}
