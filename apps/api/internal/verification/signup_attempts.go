// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	SignupAttemptTTL            = 24 * time.Hour
	SignupIdentityPendingStale  = 2 * time.Minute
	maxSignupAttemptIDBytes     = 128
	minSignupAttemptIDBytes     = 16
	signupAttemptHashDomain     = "postwave-signup-attempt-v1"
	signupRequestHashDomain     = "postwave-signup-request-v1"
	signupIdentityHashDomain    = "postwave-signup-identity-v1"
	signupAttemptStatePending   = "pending"
	signupIdentityStatePending  = "pending"
	signupIdentityStateResolved = "resolved"
	SignupAttemptAllowed        = "allowed"
	SignupAttemptBlocked        = "blocked"
	SignupAttemptAmbiguous      = "ambiguous"
)

var signupAttemptIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._~-]*$`)

var (
	ErrSignupAttemptInvalid  = errors.New("verification: invalid signup submission attempt")
	ErrSignupAttemptMismatch = errors.New("verification: signup submission attempt was reused for different input")
	ErrSignupAttemptPending  = errors.New("verification: signup submission attempt outcome is pending")
)

// SignupAttemptReceipt is deliberately code-only. The backing table has no
// address, request-body, raw-token, provider-body, or error-text column.
type SignupAttemptReceipt struct {
	State        string
	DispatchedAt *time.Time
	Allow        *bool
	Checked      *bool
	Degraded     *bool
	Status       *Status
	SubStatus    *SubStatus
	SuggestTypos *bool
	ExpiresAt    time.Time
	identityHash []byte
}

// signupIdentityReceipt is tenant-wide, not form-scoped. Provider cache and
// credentials are tenant-wide too, so two forms racing the same address must
// share one reservation. It stores policy-neutral verification evidence only.
type signupIdentityReceipt struct {
	State        string
	DispatchedAt *time.Time
	Checked      *bool
	Degraded     *bool
	Status       *Status
	SubStatus    *SubStatus
	CreatedAt    time.Time
	UpdatedAt    time.Time
	ExpiresAt    time.Time
}

type signupAttemptClaim struct {
	Attempt         SignupAttemptReceipt
	AttemptInserted bool
	Identity        signupIdentityReceipt
	IdentityOwner   bool
}

func validSignupAttemptID(raw string) bool {
	return len(raw) >= minSignupAttemptIDBytes &&
		len(raw) <= maxSignupAttemptIDBytes &&
		raw == strings.TrimSpace(raw) &&
		signupAttemptIDPattern.MatchString(raw)
}

func scopedSignupDigest(domain, tenantID, formID string, value []byte) [sha256.Size]byte {
	h := sha256.New()
	_, _ = h.Write([]byte(domain))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(tenantID))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(formID))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write(value)
	var out [sha256.Size]byte
	copy(out[:], h.Sum(nil))
	return out
}

func signupIdentityDigest(tenantID, email string) [sha256.Size]byte {
	// The form id is deliberately absent: this reservation fences paid egress
	// across every public form owned by the tenant.
	return scopedSignupDigest(signupIdentityHashDomain, tenantID, "", []byte(NormalizeEmail(email)))
}

func signupAttemptDigests(
	tenantID, formID, email, attemptID string,
	requestFingerprint []byte,
) ([32]byte, [32]byte, [32]byte, error) {
	if !validSignupAttemptID(attemptID) || len(requestFingerprint) != sha256.Size ||
		strings.TrimSpace(tenantID) == "" || strings.TrimSpace(formID) == "" || NormalizeEmail(email) == "" {
		return [32]byte{}, [32]byte{}, [32]byte{}, ErrSignupAttemptInvalid
	}
	attemptHash := scopedSignupDigest(signupAttemptHashDomain, tenantID, formID, []byte(attemptID))
	requestHash := scopedSignupDigest(signupRequestHashDomain, tenantID, formID, requestFingerprint)
	identityHash := signupIdentityDigest(tenantID, email)
	return attemptHash, requestHash, identityHash, nil
}

// beginSignupAttempt atomically registers the exact caller attempt and claims
// the tenant-wide address reservation. Only the transaction that inserted the
// identity row may proceed toward provider egress. Distinct attempts still get
// their own fingerprint-bound rows so later reuse with changed intent fails.
func (s *Store) beginSignupAttempt(
	ctx context.Context,
	tenantID, formID, email, attemptID string,
	requestFingerprint []byte,
) (signupAttemptClaim, error) {
	if s == nil || s.Pool == nil {
		return signupAttemptClaim{}, errors.New("verification: no database pool configured")
	}
	attemptHash, requestHash, identityHash, err := signupAttemptDigests(
		tenantID, formID, email, attemptID, requestFingerprint,
	)
	if err != nil {
		return signupAttemptClaim{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return signupAttemptClaim{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Expiry is enforced on lookup even if the hourly janitor has not reached
	// the row. Deleting the identity cascades all shorter-lived attempt rows.
	if _, err := tx.Exec(ctx, `
DELETE FROM verification_signup_identities
 WHERE tenant_id = $1::uuid AND identity_hash = $2 AND expires_at <= now()`,
		tenantID, identityHash[:]); err != nil {
		return signupAttemptClaim{}, err
	}

	var insertedIdentity []byte
	err = tx.QueryRow(ctx, `
INSERT INTO verification_signup_identities (tenant_id, identity_hash, owner_attempt_hash)
VALUES ($1::uuid, $2, $3)
ON CONFLICT (tenant_id, identity_hash) DO NOTHING
RETURNING identity_hash`, tenantID, identityHash[:], attemptHash[:]).Scan(&insertedIdentity)
	identityOwner := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return signupAttemptClaim{}, err
	}
	identity, err := loadSignupIdentityReceipt(ctx, tx, tenantID, identityHash[:])
	if err != nil {
		return signupAttemptClaim{}, err
	}

	var insertedAttempt []byte
	err = tx.QueryRow(ctx, `
INSERT INTO verification_signup_attempts
       (tenant_id, form_id, attempt_hash, identity_hash, request_fingerprint, expires_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
ON CONFLICT (tenant_id, form_id, attempt_hash) DO NOTHING
RETURNING attempt_hash`, tenantID, formID, attemptHash[:], identityHash[:], requestHash[:], identity.ExpiresAt).
		Scan(&insertedAttempt)
	attemptInserted := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return signupAttemptClaim{}, err
	}

	attempt, storedRequestHash, err := loadSignupAttemptReceipt(ctx, tx, tenantID, formID, attemptHash[:])
	if err != nil {
		return signupAttemptClaim{}, err
	}
	if len(storedRequestHash) != sha256.Size || len(attempt.identityHash) != sha256.Size ||
		subtle.ConstantTimeCompare(storedRequestHash, requestHash[:]) != 1 ||
		subtle.ConstantTimeCompare(attempt.identityHash, identityHash[:]) != 1 {
		return signupAttemptClaim{}, ErrSignupAttemptMismatch
	}
	if err := tx.Commit(ctx); err != nil {
		return signupAttemptClaim{}, err
	}
	return signupAttemptClaim{
		Attempt: attempt, AttemptInserted: attemptInserted,
		Identity: identity, IdentityOwner: identityOwner,
	}, nil
}

type signupAttemptQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func loadSignupIdentityReceipt(
	ctx context.Context,
	q signupAttemptQuerier,
	tenantID string,
	identityHash []byte,
) (signupIdentityReceipt, error) {
	var (
		out               signupIdentityReceipt
		checked, degraded *bool
		status, subStatus *string
	)
	err := q.QueryRow(ctx, `
SELECT state, dispatched_at, checked, degraded, status, sub_status,
       created_at, updated_at, expires_at
  FROM verification_signup_identities
 WHERE tenant_id = $1::uuid AND identity_hash = $2`, tenantID, identityHash).
		Scan(&out.State, &out.DispatchedAt, &checked, &degraded, &status, &subStatus,
			&out.CreatedAt, &out.UpdatedAt, &out.ExpiresAt)
	if err != nil {
		return signupIdentityReceipt{}, err
	}
	out.Checked = checked
	out.Degraded = degraded
	if status != nil {
		v := Status(*status)
		out.Status = &v
	}
	if subStatus != nil {
		v := SubStatus(*subStatus)
		out.SubStatus = &v
	}
	return out, nil
}

func loadSignupAttemptReceipt(
	ctx context.Context,
	q signupAttemptQuerier,
	tenantID, formID string,
	attemptHash []byte,
) (SignupAttemptReceipt, []byte, error) {
	var (
		out               SignupAttemptReceipt
		requestHash       []byte
		allow             *bool
		checked           *bool
		degraded          *bool
		status, subStatus *string
		suggestTypos      *bool
	)
	err := q.QueryRow(ctx, `
SELECT state, dispatched_at, allow, checked, degraded, status, sub_status,
       suggest_typos, expires_at, request_fingerprint, identity_hash
  FROM verification_signup_attempts
 WHERE tenant_id = $1::uuid AND form_id = $2::uuid AND attempt_hash = $3`,
		tenantID, formID, attemptHash).
		Scan(&out.State, &out.DispatchedAt, &allow, &checked, &degraded,
			&status, &subStatus, &suggestTypos, &out.ExpiresAt, &requestHash, &out.identityHash)
	if err != nil {
		return SignupAttemptReceipt{}, nil, err
	}
	out.Allow = allow
	out.Checked = checked
	out.Degraded = degraded
	out.SuggestTypos = suggestTypos
	if status != nil {
		v := Status(*status)
		out.Status = &v
	}
	if subStatus != nil {
		v := SubStatus(*subStatus)
		out.SubStatus = &v
	}
	return out, requestHash, nil
}

// markSignupAttemptDispatched commits the irreversible boundary on both the
// tenant-wide reservation and its owning exact attempt before provider egress.
func (s *Store) markSignupAttemptDispatched(
	ctx context.Context,
	tenantID, formID, email, attemptID string,
	requestFingerprint []byte,
) error {
	attemptHash, requestHash, identityHash, err := signupAttemptDigests(
		tenantID, formID, email, attemptID, requestFingerprint,
	)
	if err != nil {
		return err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	identityTag, err := tx.Exec(ctx, `
UPDATE verification_signup_identities
   SET dispatched_at = now(), updated_at = now()
 WHERE tenant_id = $1::uuid AND identity_hash = $2
   AND owner_attempt_hash = $3
   AND state = 'pending' AND dispatched_at IS NULL AND expires_at > now()`,
		tenantID, identityHash[:], attemptHash[:])
	if err != nil {
		return err
	}
	if identityTag.RowsAffected() != 1 {
		return ErrSignupAttemptPending
	}
	attemptTag, err := tx.Exec(ctx, `
UPDATE verification_signup_attempts
   SET dispatched_at = now(), updated_at = now()
 WHERE tenant_id = $1::uuid AND form_id = $2::uuid
   AND attempt_hash = $3 AND identity_hash = $4 AND request_fingerprint = $5
   AND state = 'pending' AND dispatched_at IS NULL AND expires_at > now()`,
		tenantID, formID, attemptHash[:], identityHash[:], requestHash[:])
	if err != nil {
		return err
	}
	if attemptTag.RowsAffected() != 1 {
		return ErrSignupAttemptPending
	}
	return tx.Commit(ctx)
}

// finishClaimedSignupAttempt atomically stores policy-neutral identity
// evidence and the owner's exact policy decision. No retry can observe one
// terminal record without the other.
func (s *Store) finishClaimedSignupAttempt(
	ctx context.Context,
	tenantID, formID, email, attemptID string,
	requestFingerprint []byte,
	decision Decision,
	state string,
	suggestTypos bool,
) error {
	attemptHash, requestHash, identityHash, err := signupAttemptDigests(
		tenantID, formID, email, attemptID, requestFingerprint,
	)
	if err != nil {
		return err
	}
	decision, err = normalizedSignupTerminalDecision(decision, state)
	if err != nil {
		return err
	}
	identityState := signupIdentityStateResolved
	if state == SignupAttemptAmbiguous {
		identityState = SignupAttemptAmbiguous
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	identityTag, err := tx.Exec(ctx, `
UPDATE verification_signup_identities
   SET state = $4, checked = $5, degraded = $6,
       status = $7, sub_status = $8, updated_at = now()
 WHERE tenant_id = $1::uuid AND identity_hash = $2
   AND owner_attempt_hash = $3
   AND state = 'pending' AND expires_at > now()`,
		tenantID, identityHash[:], attemptHash[:], identityState, decision.Checked, decision.Degraded,
		string(decision.Status), string(decision.SubStatus))
	if err != nil {
		return err
	}
	if identityTag.RowsAffected() != 1 {
		return ErrSignupAttemptPending
	}
	if err := finishSignupAttemptTx(ctx, tx, tenantID, formID, attemptHash[:], identityHash[:],
		requestHash[:], decision, state, suggestTypos); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// finishSignupAttempt records a decision derived from an already-terminal
// identity under the current policy. It never changes the shared evidence.
func (s *Store) finishSignupAttempt(
	ctx context.Context,
	tenantID, formID, email, attemptID string,
	requestFingerprint []byte,
	decision Decision,
	state string,
	suggestTypos bool,
) error {
	attemptHash, requestHash, identityHash, err := signupAttemptDigests(
		tenantID, formID, email, attemptID, requestFingerprint,
	)
	if err != nil {
		return err
	}
	decision, err = normalizedSignupTerminalDecision(decision, state)
	if err != nil {
		return err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := finishSignupAttemptTx(ctx, tx, tenantID, formID, attemptHash[:], identityHash[:],
		requestHash[:], decision, state, suggestTypos); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func normalizedSignupTerminalDecision(decision Decision, state string) (Decision, error) {
	if state != SignupAttemptAllowed && state != SignupAttemptBlocked && state != SignupAttemptAmbiguous {
		return Decision{}, fmt.Errorf("verification: invalid signup attempt terminal state %q", truncate(state, 40))
	}
	if state == SignupAttemptAmbiguous {
		decision = Decision{
			Allow: true, Checked: true, Degraded: true,
			Status: StatusUnknown, SubStatus: SubStatusProviderUnavailable,
		}
	}
	if !decision.Status.Valid() {
		return Decision{}, errors.New("verification: refusing to persist signup attempt with invalid status")
	}
	return decision, nil
}

func finishSignupAttemptTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, formID string,
	attemptHash, identityHash, requestHash []byte,
	decision Decision,
	state string,
	suggestTypos bool,
) error {
	tag, err := tx.Exec(ctx, `
UPDATE verification_signup_attempts
   SET state = $6, allow = $7, checked = $8, degraded = $9,
       status = $10, sub_status = $11, suggest_typos = $12, updated_at = now()
 WHERE tenant_id = $1::uuid AND form_id = $2::uuid
   AND attempt_hash = $3 AND identity_hash = $4 AND request_fingerprint = $5
   AND state = 'pending' AND expires_at > now()`,
		tenantID, formID, attemptHash, identityHash, requestHash, state,
		decision.Allow, decision.Checked, decision.Degraded,
		string(decision.Status), string(decision.SubStatus), suggestTypos)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrSignupAttemptPending
	}
	return nil
}

// recoverStaleSignupIdentity handles a crash-left tenant-wide reservation.
// A reservation that never crossed the dispatch boundary can be leased to the
// current exact attempt without spending twice. Once dispatched, however, its
// provider outcome is unknowable and it may only become terminal ambiguous.
// Fresh reservations remain retryable and never admit a subscriber.
func (s *Store) recoverStaleSignupIdentity(
	ctx context.Context,
	tenantID, formID, email, attemptID string,
	requestFingerprint []byte,
) (signupIdentityReceipt, bool, error) {
	attemptHash, _, identityHash, err := signupAttemptDigests(
		tenantID, formID, email, attemptID, requestFingerprint,
	)
	if err != nil {
		return signupIdentityReceipt{}, false, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return signupIdentityReceipt{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// owner_attempt_hash is a durable lease token. A paused former owner cannot
	// resume and mark dispatch after a distinct attempt has reclaimed the row.
	reclaimed, err := tx.Exec(ctx, `
UPDATE verification_signup_identities
   SET owner_attempt_hash=$3, updated_at=now()
 WHERE tenant_id=$1::uuid AND identity_hash=$2
   AND state='pending' AND dispatched_at IS NULL AND expires_at > now()
   AND updated_at <= now() - $4::interval`,
		tenantID, identityHash[:], attemptHash[:], durationInterval(SignupIdentityPendingStale))
	if err != nil {
		return signupIdentityReceipt{}, false, err
	}
	identityOwner := reclaimed.RowsAffected() == 1

	if !identityOwner {
		if _, err := tx.Exec(ctx, `
UPDATE verification_signup_identities
   SET state='ambiguous', checked=true, degraded=true,
       status='unknown', sub_status='provider_unavailable', updated_at=now()
 WHERE tenant_id=$1::uuid AND identity_hash=$2
   AND state='pending' AND expires_at > now()
	   AND dispatched_at IS NOT NULL
	   AND dispatched_at <= now() - $3::interval`,
			tenantID, identityHash[:], durationInterval(SignupIdentityPendingStale)); err != nil {
			return signupIdentityReceipt{}, false, err
		}
	}
	receipt, err := loadSignupIdentityReceipt(ctx, tx, tenantID, identityHash[:])
	if err != nil {
		return signupIdentityReceipt{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return signupIdentityReceipt{}, false, err
	}
	return receipt, identityOwner, nil
}

func retryableSignupDecision() Decision {
	return Decision{
		Allow: false, Checked: true, Degraded: true, Retryable: true,
		Status: StatusUnknown, SubStatus: SubStatusProviderUnavailable,
		Reason: "Email verification is still in progress. Retry this submission shortly.",
	}
}

func ambiguousSignupDecision() Decision {
	return Decision{
		Allow: true, Checked: true, Degraded: true,
		Status: StatusUnknown, SubStatus: SubStatusProviderUnavailable,
	}
}

func decisionFromSignupReceipt(receipt SignupAttemptReceipt, email string) (Decision, error) {
	if receipt.State == signupAttemptStatePending {
		return Decision{}, ErrSignupAttemptPending
	}
	if receipt.Allow == nil || receipt.Checked == nil || receipt.Degraded == nil ||
		receipt.Status == nil || receipt.SubStatus == nil || receipt.SuggestTypos == nil {
		return Decision{}, errors.New("verification: malformed terminal signup attempt receipt")
	}
	d := Decision{
		Allow:     *receipt.Allow,
		Checked:   *receipt.Checked,
		Degraded:  *receipt.Degraded,
		Status:    *receipt.Status,
		SubStatus: *receipt.SubStatus,
	}
	if !d.Allow {
		d.Reason = rejectionReason(d.Status, d.SubStatus)
	}
	d.DidYouMean = replayableSignupSuggestion(email, d.SubStatus, *receipt.SuggestTypos)
	return d, nil
}

func decisionFromSignupIdentity(receipt signupIdentityReceipt, email string, policy Policy) (Decision, error) {
	if receipt.State == signupIdentityStatePending {
		return Decision{}, ErrSignupAttemptPending
	}
	if receipt.Checked == nil || receipt.Degraded == nil || receipt.Status == nil || receipt.SubStatus == nil {
		return Decision{}, errors.New("verification: malformed terminal signup identity receipt")
	}
	if receipt.State == SignupAttemptAmbiguous {
		return ambiguousSignupDecision(), nil
	}
	if receipt.State != signupIdentityStateResolved {
		return Decision{}, errors.New("verification: unsupported signup identity state")
	}
	d := Decision{
		Allow:      !policy.rejects(*receipt.Status),
		Checked:    *receipt.Checked,
		Degraded:   *receipt.Degraded,
		Status:     *receipt.Status,
		SubStatus:  *receipt.SubStatus,
		DidYouMean: replayableSignupSuggestion(email, *receipt.SubStatus, policy.SuggestTypos()),
	}
	if !d.Allow {
		d.Reason = rejectionReason(d.Status, d.SubStatus)
	}
	return d, nil
}

// replayableSignupSuggestion reconstructs the only supported typo suggestion
// from the exact retried request. This keeps durable receipts PII-free.
func replayableSignupSuggestion(email string, subStatus SubStatus, enabled bool) string {
	if !enabled || subStatus != SubStatusPossibleTypo {
		return ""
	}
	local, domain, ok := splitAddress(NormalizeEmail(email))
	if !ok {
		return ""
	}
	suggestion, ok := suggestDomain(domain)
	if !ok {
		return ""
	}
	return local + "@" + suggestion
}
