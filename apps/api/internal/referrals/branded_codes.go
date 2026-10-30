// SPDX-License-Identifier: AGPL-3.0-only
package referrals

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ErrCodeTaken is returned when a desired_code is already claimed by
// another subscriber (within or across tenants — global uniqueness).
var ErrCodeTaken = errors.New("referrals: desired code is taken")

// ErrBadCode is returned when validateDesiredCode rejects the input.
var ErrBadCode = errors.New("referrals: invalid desired code")

// validateDesiredCode applies the policy for branded codes:
//   - 3..32 chars
//   - lowercase a-z, digits, hyphens
//   - cannot start or end with hyphen, no consecutive hyphens
//   - cannot collide with reserved words ("admin", "system", "test")
//
// Returned canonical form is lowercased + trimmed.
func validateDesiredCode(raw string) (string, error) {
	s := strings.ToLower(strings.TrimSpace(raw))
	if len(s) < 3 || len(s) > 32 {
		return "", ErrBadCode
	}
	if s[0] == '-' || s[len(s)-1] == '-' {
		return "", ErrBadCode
	}
	prevHyphen := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '-' {
			if prevHyphen {
				return "", ErrBadCode
			}
			prevHyphen = true
			continue
		}
		prevHyphen = false
		ok := (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
		if !ok {
			return "", ErrBadCode
		}
	}
	switch s {
	case "admin", "system", "test", "support", "help":
		return "", ErrBadCode
	}
	return s, nil
}

// SetDesiredCode updates the desired_code column for an existing
// referral code row, after validating + checking uniqueness.
//
// The public redirect and conversion paths accept either the random `code` or
// `desired_code` and resolve both to the same referrer. Migration 1772's
// private token registry gives both columns one global uniqueness namespace,
// so random/branded cross-column races cannot make resolution ambiguous.
func (r *Repo) SetDesiredCode(ctx context.Context, tenantID, subscriberID, desired string) error {
	canon, validationErr := validateDesiredCode(desired)
	if validationErr != nil {
		return validationErr
	}

	// EnsureCode owns the random-token collision/retry path. Once the row
	// exists, the 1772 registry trigger makes the desired-token update one
	// atomic claim in the same global namespace as every generated code.
	if _, err := r.EnsureCode(ctx, tenantID, subscriberID); err != nil {
		return err
	}

	var lastError error
	for attempt := 0; attempt < referralCodeWriteAttempts; attempt++ {
		tx, err := db.WithTenant(ctx, r.Pool, tenantID)
		if err != nil {
			return err
		}
		if err := setReferralCodeLockTimeout(ctx, tx); err != nil {
			_ = tx.Rollback(ctx)
			return err
		}

		tag, err := tx.Exec(ctx, `
UPDATE public.referral_codes
   SET desired_code = $3
 WHERE tenant_id = $1::uuid
   AND subscriber_id = $2`, tenantID, subscriberID, canon)
		if err == nil && tag.RowsAffected() == 0 {
			err = ErrNotFound
		}
		if err == nil {
			err = tx.Commit(ctx)
		} else {
			_ = tx.Rollback(ctx)
		}

		switch {
		case err == nil:
			return nil
		case isReferralCodeUniqueViolation(err):
			return ErrCodeTaken
		case !isReferralCodeRetryable(err):
			return err
		default:
			lastError = err
			if waitErr := waitForReferralCodeRetry(ctx, attempt); waitErr != nil {
				return waitErr
			}
		}
	}
	return referralCodeContentionError(lastError)
}

// CodeOwnerByAny resolves both the random code AND a desired_code
// to (tenant, subscriber). Lets the public redirect accept either
// without the caller knowing which kind it has.
func (r *Repo) CodeOwnerByAny(ctx context.Context, code string) (tenantID, subscriberID string, err error) {
	return r.lookupCodeOwner(ctx, code, true)
}

// SetDesiredCode POST /api/v1/subscribers/{id}/referral/code
// Body: {"desired_code": "acme-bestie"}
func (d *Deps) SetDesiredCode(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	subID := strings.TrimSpace(strings.TrimPrefix(strings.TrimSuffix(
		r.URL.Path, "/referral/code"), "/api/v1/subscribers/"))
	if subID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_subscriber", ""))
		return
	}
	var in struct {
		DesiredCode string `json:"desired_code"`
	}
	if err := httpbody.DecodeJSON(w, r, 1024, &in); err != nil {
		// httpbody returns operator-safe codes (bad_json / payload_too_large)
		// and the error text is authored by httpbody itself — safe to echo.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	err := d.Repo.SetDesiredCode(r.Context(), t.ID, subID, in.DesiredCode)
	switch {
	case errors.Is(err, ErrBadCode):
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_code",
			"3-32 lowercase letters, digits, single hyphens; cannot start/end with hyphen"))
	case errors.Is(err, ErrCodeTaken):
		writeJSON(w, http.StatusConflict, errEnv("code_taken", "that code is already in use"))
	case errors.Is(err, ErrCodeContention):
		w.Header().Set("Retry-After", "1")
		writeJSON(w, http.StatusConflict, errEnv("code_contention", "code namespace is busy; retry this request"))
	case err != nil:
		// db/pgx errors may embed query/driver text; route through WriteInternal
		// so the generic envelope ships and the detail lands in the log.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	default:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}
