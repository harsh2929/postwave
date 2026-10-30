// SPDX-License-Identifier: AGPL-3.0-only
package referrals

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	referralCodeWriteAttempts = 4
	referralCodeMintAttempts  = 8
)

// ErrCodeContention is returned after the bounded referral-token retry budget
// is exhausted. HTTP callers can retry the operation without guessing whether
// a token was committed.
var ErrCodeContention = errors.New("referrals: code namespace is busy")

// canonicalizeReferralLookupCode is deliberately smaller than the set-code
// validator: lookup accepts either a generated token or a branded token, but
// never Unicode, controls, path syntax, repeated hyphens, or unbounded input.
// Case and surrounding whitespace are canonicalized for compatibility with
// the historical desired-code lookup.
func canonicalizeReferralLookupCode(raw string) (string, bool) {
	if len(raw) > 64 {
		return "", false
	}
	canonical := strings.ToLower(strings.Trim(raw, " \t\r\n\f\v"))
	if len(canonical) < 3 || len(canonical) > 32 ||
		canonical[0] == '-' || canonical[len(canonical)-1] == '-' {
		return "", false
	}
	previousHyphen := false
	for index := 0; index < len(canonical); index++ {
		character := canonical[index]
		if character == '-' {
			if previousHyphen {
				return "", false
			}
			previousHyphen = true
			continue
		}
		previousHyphen = false
		if (character < 'a' || character > 'z') &&
			(character < '0' || character > '9') {
			return "", false
		}
	}
	return canonical, true
}

func (r *Repo) lookupCodeOwner(
	ctx context.Context,
	rawCode string,
	allowDesired bool,
) (tenantID, subscriberID string, err error) {
	canonical, ok := canonicalizeReferralLookupCode(rawCode)
	if !ok || r == nil || r.Pool == nil {
		return "", "", ErrNotFound
	}

	var tokenKind string
	err = r.Pool.QueryRow(ctx, `
SELECT tenant_id::text, subscriber_id, token_kind
  FROM public.referral_code_resolve($1)`, canonical).Scan(
		&tenantID, &subscriberID, &tokenKind,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", err
	}
	if tokenKind != "code" && (!allowDesired || tokenKind != "desired") {
		return "", "", ErrNotFound
	}
	if _, parseErr := uuid.Parse(subscriberID); parseErr != nil {
		return "", "", ErrNotFound
	}

	subscriberID, err = r.resolveMergedCodeOwner(ctx, tenantID, subscriberID)
	return tenantID, subscriberID, err
}

func setReferralCodeLockTimeout(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '750ms'`)
	return err
}

func referralCodeSQLState(err error) string {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		return postgresError.Code
	}
	return ""
}

func isReferralCodeUniqueViolation(err error) bool {
	return referralCodeSQLState(err) == "23505"
}

func isReferralCodeRetryable(err error) bool {
	switch referralCodeSQLState(err) {
	case "40001", "40P01", "55P03":
		return true
	default:
		return false
	}
}

func waitForReferralCodeRetry(ctx context.Context, attempt int) error {
	delay := time.Duration(attempt+1) * 10 * time.Millisecond
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func referralCodeContentionError(lastError error) error {
	if lastError == nil {
		return ErrCodeContention
	}
	return fmt.Errorf("%w: %w", ErrCodeContention, lastError)
}
