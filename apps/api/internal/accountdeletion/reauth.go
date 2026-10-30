// SPDX-License-Identifier: AGPL-3.0-only
package accountdeletion

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/auth"
)

type AuthRepository interface {
	LookupSession(ctx context.Context, id, verifier string) (*auth.Session, error)
	LookupCredential(ctx context.Context, userID string) (*auth.Credential, error)
	RecordLoginFailure(ctx context.Context, userID string) error
	ResetLoginCounters(ctx context.Context, userID string) error
	HasTOTPSecret(ctx context.Context, userID string) (bool, error)
	GetTOTPSecret(ctx context.Context, userID string) ([]byte, [][]byte, error)
}

type SecretCipher interface {
	Decrypt(ctx context.Context, blob, legacyKEK []byte) ([]byte, error)
}

// SessionReauth verifies the same opaque session cookie used by the request,
// then performs a credential-appropriate destructive-action step-up:
// password users submit their current password; external-provider and magic
// link users must have a session issued within Freshness; confirmed TOTP users
// must additionally submit a current code.
type SessionReauth struct {
	Repo      AuthRepository
	Cipher    SecretCipher
	Now       func() time.Time
	Freshness time.Duration
}

func (s *SessionReauth) Verify(ctx context.Context, cookie, tenantID, userID string, in ReauthInput) (string, error) {
	if s == nil || s.Repo == nil {
		return "", fmt.Errorf("account deletion reauthentication is not configured")
	}
	tok, cookieErr := parseCookieValue(cookie)
	if cookieErr != nil {
		return "", ErrNoSession
	}
	session, cookieErr := s.Repo.LookupSession(ctx, tok.ID, tok.Verifier)
	if cookieErr != nil {
		if errors.Is(cookieErr, auth.ErrNotFound) || errors.Is(cookieErr, auth.ErrSessionExpired) || errors.Is(cookieErr, auth.ErrSessionRevoked) {
			return "", ErrNoSession
		}
		return "", fmt.Errorf("lookup deletion session: %w", cookieErr)
	}
	if session.UserID != userID || session.TenantID != tenantID {
		return "", ErrNoSession
	}

	now := s.now()
	method := strings.ToLower(strings.TrimSpace(session.AuthMethod))
	switch method {
	case "password":
		credential, err := s.Repo.LookupCredential(ctx, userID)
		if err != nil {
			if errors.Is(err, auth.ErrNotFound) {
				return "", ErrReauthFailed
			}
			return "", fmt.Errorf("lookup deletion credential: %w", err)
		}
		if credential.TenantID != tenantID || (credential.LockedUntil != nil && credential.LockedUntil.After(now)) {
			return "", ErrReauthFailed
		}
		if err := auth.Verify(credential.PasswordPHC, in.Password); err != nil {
			_ = s.Repo.RecordLoginFailure(ctx, userID)
			if errors.Is(err, auth.ErrMismatch) {
				return "", ErrReauthFailed
			}
			return "", fmt.Errorf("verify deletion password: %w", err)
		}
		if err := s.Repo.ResetLoginCounters(ctx, userID); err != nil {
			return "", fmt.Errorf("reset deletion reauth counters: %w", err)
		}
	case "google", "microsoft", "saml", "magic_link":
		freshness := s.Freshness
		if freshness <= 0 {
			freshness = 5 * time.Minute
		}
		age := now.Sub(session.IssuedAt)
		if age < -time.Minute || age > freshness {
			return "", ErrFreshAuth
		}
	default:
		return "", ErrFreshAuth
	}

	hasTOTP, cookieErr := s.Repo.HasTOTPSecret(ctx, userID)
	if cookieErr != nil {
		return "", fmt.Errorf("lookup deletion MFA state: %w", cookieErr)
	}
	if hasTOTP {
		if strings.TrimSpace(in.MFACode) == "" {
			return "", ErrMFARequired
		}
		if s.Cipher == nil {
			return "", fmt.Errorf("account deletion MFA cipher is not configured")
		}
		encrypted, _, err := s.Repo.GetTOTPSecret(ctx, userID)
		if err != nil {
			return "", fmt.Errorf("load deletion MFA secret: %w", err)
		}
		secret, err := s.Cipher.Decrypt(ctx, encrypted, nil)
		if err != nil {
			return "", fmt.Errorf("decrypt deletion MFA secret: %w", err)
		}
		if !auth.VerifyCode(secret, in.MFACode, now, 1) {
			return "", ErrReauthFailed
		}
	}
	return method, nil
}

func (s *SessionReauth) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func parseCookieValue(value string) (auth.SessionToken, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return auth.SessionToken{}, auth.ErrNoSession
	}
	const prefix = auth.SessionCookieName + "="
	value = strings.TrimPrefix(value, prefix)
	parts := strings.SplitN(value, ".", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return auth.SessionToken{}, auth.ErrInvalidSession
	}
	return auth.SessionToken{ID: parts[0], Verifier: parts[1]}, nil
}
