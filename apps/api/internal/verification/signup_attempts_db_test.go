// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"context"
	"crypto/sha256"
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func newVerificationSignupForm(t *testing.T, s *Store, tenantID string) string {
	t.Helper()
	tx, err := db.WithTenant(context.Background(), s.Pool, tenantID)
	if err != nil {
		t.Fatalf("begin form insert: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var id string
	err = tx.QueryRow(context.Background(), `
INSERT INTO forms (tenant_id, slug, name, opt_in_mode, structure, settings, status)
VALUES ($1::uuid, $2, 'Verification attempt test', 'single',
        '{"fields":[]}'::jsonb, '{}'::jsonb, 'published')
RETURNING id::text`, tenantID, "verification-attempt-"+uuid.NewString()).Scan(&id)
	if err != nil {
		t.Fatalf("insert form: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit form: %v", err)
	}
	return id
}

func signupFingerprint(value string) []byte {
	digest := sha256.Sum256([]byte(value))
	return digest[:]
}

type signupAttemptVerifier struct {
	calls  atomic.Int32
	verify func(context.Context, string) (Result, error)
}

func (v *signupAttemptVerifier) Name() string { return ProviderZeroBounce }
func (v *signupAttemptVerifier) Credits(context.Context) (int, error) {
	return 100, nil
}
func (v *signupAttemptVerifier) Verify(ctx context.Context, email string) (Result, error) {
	v.calls.Add(1)
	return v.verify(ctx, email)
}
func (v *signupAttemptVerifier) VerifyBatch(ctx context.Context, emails []string) ([]Result, error) {
	out := make([]Result, 0, len(emails))
	for _, email := range emails {
		result, err := v.Verify(ctx, email)
		if err != nil {
			return nil, err
		}
		out = append(out, result)
	}
	return out, nil
}

func fullSignupAttemptStore(t *testing.T) (*Store, string, string) {
	t.Helper()
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	s := newStore(t, pool, nil)
	s.Local = &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
		return true, "mx.example.com", nil
	}}
	if _, err := s.SetPolicy(context.Background(), tenantID, Policy{FormsMode: ModeFull}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}
	return s, tenantID, newVerificationSignupForm(t, s, tenantID)
}

func gateAuthorized(
	s *Store,
	tenantID, formID, email, attemptID string,
	fingerprint []byte,
) (Decision, error) {
	return s.GateSignupAuthorizedAttempt(
		context.Background(), tenantID, formID, email, attemptID, fingerprint, true,
	)
}

func TestDBSignupAttemptReplaysTerminalDecisionWithoutAnotherVendorCall(t *testing.T) {
	s, tenantID, formID := fullSignupAttemptStore(t)
	vendor := &signupAttemptVerifier{verify: func(_ context.Context, email string) (Result, error) {
		return Result{
			Email: email, Status: StatusValid, Provider: ProviderZeroBounce, Billable: true,
		}, nil
	}}
	s.chainOverride = func(context.Context, string) (*Chain, error) {
		return &Chain{Local: s.Local, Vendor: vendor}, nil
	}
	attemptID := "opaque-attempt-00000001"
	fingerprint := signupFingerprint("same intent")

	first, err := gateAuthorized(s, tenantID, formID, "reader@example.com", attemptID, fingerprint)
	if err != nil {
		t.Fatalf("first gate: %v", err)
	}
	second, err := gateAuthorized(s, tenantID, formID, "reader@example.com", attemptID, fingerprint)
	if err != nil {
		t.Fatalf("replay gate: %v", err)
	}
	if vendor.calls.Load() != 1 {
		t.Fatalf("vendor calls = %d, want exactly 1", vendor.calls.Load())
	}
	if !first.Allow || !second.Allow || first.Status != second.Status ||
		first.SubStatus != second.SubStatus || first.Degraded != second.Degraded {
		t.Fatalf("terminal replay drifted: first=%+v second=%+v", first, second)
	}
	if !first.Billable || second.Billable {
		t.Fatalf("billing receipt should be reported once: first=%+v second=%+v", first, second)
	}
}

func TestDBSignupAttemptFingerprintMismatchIsRejectedWithoutDispatch(t *testing.T) {
	s, tenantID, formID := fullSignupAttemptStore(t)
	vendor := &signupAttemptVerifier{verify: func(_ context.Context, email string) (Result, error) {
		return Result{Email: email, Status: StatusValid, Provider: ProviderZeroBounce}, nil
	}}
	s.chainOverride = func(context.Context, string) (*Chain, error) {
		return &Chain{Local: s.Local, Vendor: vendor}, nil
	}
	attemptID := "opaque-attempt-00000002"
	if _, err := gateAuthorized(s, tenantID, formID, "reader@example.com", attemptID,
		signupFingerprint("first")); err != nil {
		t.Fatalf("first gate: %v", err)
	}
	mismatch, err := gateAuthorized(s, tenantID, formID, "other@example.com", attemptID,
		signupFingerprint("changed"))
	if err != nil {
		t.Fatalf("mismatch gate: %v", err)
	}
	if mismatch.Allow || mismatch.Reason == "" {
		t.Fatalf("mismatched intent was not rejected: %+v", mismatch)
	}
	if vendor.calls.Load() != 1 {
		t.Fatalf("vendor calls after mismatch = %d, want 1", vendor.calls.Load())
	}
}

type concurrentSignupResult struct {
	decision Decision
	err      error
}

func assertConcurrentInvalidIsFenced(
	t *testing.T,
	s *Store,
	tenantID, firstFormID, secondFormID, firstAttemptID, secondAttemptID string,
	firstFingerprint, secondFingerprint []byte,
) {
	t.Helper()
	started := make(chan struct{})
	release := make(chan struct{})
	var startedOnce sync.Once
	vendor := &signupAttemptVerifier{verify: func(_ context.Context, email string) (Result, error) {
		startedOnce.Do(func() { close(started) })
		<-release
		return Result{
			Email: email, Status: StatusInvalid, SubStatus: SubStatusMailboxNotFound,
			Provider: ProviderZeroBounce, Billable: true,
		}, nil
	}}
	s.chainOverride = func(context.Context, string) (*Chain, error) {
		return &Chain{Local: s.Local, Vendor: vendor}, nil
	}

	firstDone := make(chan concurrentSignupResult, 1)
	go func() {
		d, err := gateAuthorized(s, tenantID, firstFormID, "reader@example.com",
			firstAttemptID, firstFingerprint)
		firstDone <- concurrentSignupResult{decision: d, err: err}
	}()
	<-started

	loser, err := gateAuthorized(s, tenantID, secondFormID, "READER@example.com",
		secondAttemptID, secondFingerprint)
	if err != nil {
		t.Fatalf("concurrent losing gate: %v", err)
	}
	if loser.Allow || !loser.Retryable {
		t.Fatalf("fresh pending identity admitted losing request: %+v", loser)
	}
	if vendor.calls.Load() != 1 {
		t.Fatalf("concurrent vendor calls = %d, want 1", vendor.calls.Load())
	}

	close(release)
	first := <-firstDone
	if first.err != nil {
		t.Fatalf("first gate: %v", first.err)
	}
	if first.decision.Allow || first.decision.Retryable || first.decision.Status != StatusInvalid {
		t.Fatalf("first invalid decision = %+v", first.decision)
	}

	replay, err := gateAuthorized(s, tenantID, secondFormID, "reader@example.com",
		secondAttemptID, secondFingerprint)
	if err != nil {
		t.Fatalf("losing attempt replay: %v", err)
	}
	if replay.Allow || replay.Retryable || replay.Status != StatusInvalid {
		t.Fatalf("losing attempt did not inherit terminal invalid evidence: %+v", replay)
	}
	if vendor.calls.Load() != 1 {
		t.Fatalf("terminal replay redispatched: calls=%d", vendor.calls.Load())
	}
}

func TestDBSignupAttemptSameTokenPendingCannotAdmitAheadOfInvalid(t *testing.T) {
	s, tenantID, formID := fullSignupAttemptStore(t)
	assertConcurrentInvalidIsFenced(t, s, tenantID, formID, formID,
		"opaque-attempt-same-token-01", "opaque-attempt-same-token-01",
		signupFingerprint("same intent"), signupFingerprint("same intent"))
}

func TestDBSignupAttemptDistinctTokensShareTenantIdentityFence(t *testing.T) {
	s, tenantID, formID := fullSignupAttemptStore(t)
	assertConcurrentInvalidIsFenced(t, s, tenantID, formID, formID,
		"opaque-attempt-distinct-a-01", "opaque-attempt-distinct-b-01",
		signupFingerprint("name=first"), signupFingerprint("name=changed"))
}

func TestDBSignupAttemptCrossFormTokensShareTenantIdentityFence(t *testing.T) {
	s, tenantID, firstFormID := fullSignupAttemptStore(t)
	secondFormID := newVerificationSignupForm(t, s, tenantID)
	assertConcurrentInvalidIsFenced(t, s, tenantID, firstFormID, secondFormID,
		"opaque-attempt-cross-form-a", "opaque-attempt-cross-form-b",
		signupFingerprint("form one"), signupFingerprint("form two changed fields"))
}

func TestDBSignupAttemptNewIntentAppliesCurrentPolicyButExactReplayDoesNot(t *testing.T) {
	s, tenantID, formID := fullSignupAttemptStore(t)
	vendor := &signupAttemptVerifier{verify: func(_ context.Context, email string) (Result, error) {
		return Result{
			Email: email, Status: StatusDoNotMail, SubStatus: SubStatusToxic,
			Provider: ProviderZeroBounce,
		}, nil
	}}
	s.chainOverride = func(context.Context, string) (*Chain, error) {
		return &Chain{Local: s.Local, Vendor: vendor}, nil
	}
	firstAttempt := "opaque-attempt-policy-first"
	firstFingerprint := signupFingerprint("policy first")
	first, err := gateAuthorized(s, tenantID, formID, "reader@example.com", firstAttempt, firstFingerprint)
	if err != nil || first.Allow {
		t.Fatalf("initial terminal-F decision=%+v err=%v", first, err)
	}
	if _, err := s.SetPolicy(context.Background(), tenantID, Policy{
		FormsMode: ModeFull, FormsRejectStatuses: []string{string(StatusInvalid)},
	}); err != nil {
		t.Fatalf("change policy: %v", err)
	}

	newIntent, err := gateAuthorized(s, tenantID, formID, "reader@example.com",
		"opaque-attempt-policy-second", signupFingerprint("policy second"))
	if err != nil || !newIntent.Allow || newIntent.Status != StatusDoNotMail {
		t.Fatalf("new intent did not apply current policy: decision=%+v err=%v", newIntent, err)
	}
	exactReplay, err := gateAuthorized(s, tenantID, formID, "reader@example.com",
		firstAttempt, firstFingerprint)
	if err != nil || exactReplay.Allow {
		t.Fatalf("exact replay lost original policy decision: decision=%+v err=%v", exactReplay, err)
	}
	if vendor.calls.Load() != 1 {
		t.Fatalf("policy re-evaluation vendor calls=%d, want 1", vendor.calls.Load())
	}
}

func TestDBSignupAttemptMarksDispatchBeforeEgressAndTerminalizesUnknownOutcome(t *testing.T) {
	s, tenantID, formID := fullSignupAttemptStore(t)
	email := "reader@example.com"
	attemptID := "opaque-attempt-00000004"
	fingerprint := signupFingerprint("ambiguous")
	vendor := &signupAttemptVerifier{verify: func(ctx context.Context, _ string) (Result, error) {
		attemptHash, _, identityHash, err := signupAttemptDigests(
			tenantID, formID, email, attemptID, fingerprint,
		)
		if err != nil {
			t.Fatalf("signupAttemptDigests: %v", err)
		}
		tx, err := db.WithTenant(ctx, s.Pool, tenantID)
		if err != nil {
			t.Fatalf("begin receipt inspection: %v", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		var attemptState, identityState string
		var attemptDispatched, identityDispatched bool
		if err := tx.QueryRow(ctx, `
SELECT attempt.state, attempt.dispatched_at IS NOT NULL,
       identity.state, identity.dispatched_at IS NOT NULL
  FROM verification_signup_attempts AS attempt
  JOIN verification_signup_identities AS identity
    ON identity.tenant_id=attempt.tenant_id AND identity.identity_hash=attempt.identity_hash
 WHERE attempt.tenant_id=$1::uuid AND attempt.form_id=$2::uuid
   AND attempt.attempt_hash=$3 AND identity.identity_hash=$4`,
			tenantID, formID, attemptHash[:], identityHash[:]).Scan(
			&attemptState, &attemptDispatched, &identityState, &identityDispatched,
		); err != nil {
			t.Fatalf("inspect pre-egress receipts: %v", err)
		}
		if attemptState != signupAttemptStatePending || identityState != signupIdentityStatePending ||
			!attemptDispatched || !identityDispatched {
			t.Fatalf("pre-egress receipts attempt=%q/%v identity=%q/%v",
				attemptState, attemptDispatched, identityState, identityDispatched)
		}
		return Result{}, ErrProviderUnavailable
	}}
	s.chainOverride = func(context.Context, string) (*Chain, error) {
		return &Chain{Local: s.Local, Vendor: vendor}, nil
	}

	first, err := gateAuthorized(s, tenantID, formID, email, attemptID, fingerprint)
	if err != nil {
		t.Fatalf("first gate: %v", err)
	}
	second, err := gateAuthorized(s, tenantID, formID, email, attemptID, fingerprint)
	if err != nil {
		t.Fatalf("replay gate: %v", err)
	}
	if !first.Allow || !first.Degraded || !second.Allow || !second.Degraded {
		t.Fatalf("ambiguous outcome did not fail open/replay: first=%+v second=%+v", first, second)
	}
	if vendor.calls.Load() != 1 {
		t.Fatalf("ambiguous outcome redispatched: calls=%d", vendor.calls.Load())
	}

	tx, err := db.WithTenant(context.Background(), s.Pool, tenantID)
	if err != nil {
		t.Fatalf("begin terminal receipt read: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var attemptState, identityState string
	if err := tx.QueryRow(context.Background(), `
SELECT attempt.state, identity.state
  FROM verification_signup_attempts AS attempt
  JOIN verification_signup_identities AS identity
    ON identity.tenant_id=attempt.tenant_id AND identity.identity_hash=attempt.identity_hash
 WHERE attempt.tenant_id=$1::uuid AND attempt.form_id=$2::uuid`, tenantID, formID).
		Scan(&attemptState, &identityState); err != nil {
		t.Fatalf("read terminal receipts: %v", err)
	}
	if attemptState != SignupAttemptAmbiguous || identityState != SignupAttemptAmbiguous {
		t.Fatalf("terminal states attempt=%q identity=%q, want ambiguous", attemptState, identityState)
	}
	var rawColumns int
	if err := tx.QueryRow(context.Background(), `
SELECT count(*)
  FROM information_schema.columns
 WHERE table_schema='public'
   AND table_name IN ('verification_signup_attempts','verification_signup_identities')
   AND column_name IN ('email','error','raw_error','attempt_id','request_body')`).Scan(&rawColumns); err != nil {
		t.Fatalf("inspect receipt schemas: %v", err)
	}
	if rawColumns != 0 {
		t.Fatalf("receipt tables expose %d raw PII/error columns", rawColumns)
	}
}

func TestDBSignupAttemptChainBuildFailurePreservesLocalTerminalRejections(t *testing.T) {
	s, tenantID, formID := fullSignupAttemptStore(t)
	s.Local.ExtraDisposable = map[string]struct{}{"explicit-disposable.test": {}}
	var buildCalls atomic.Int32
	s.chainOverride = func(context.Context, string) (*Chain, error) {
		buildCalls.Add(1)
		return nil, errors.New("provider configuration unavailable")
	}

	tests := []struct {
		name      string
		email     string
		attemptID string
		status    Status
		subStatus SubStatus
	}{
		{
			name: "invalid syntax", email: "not-an-email",
			attemptID: "opaque-build-failure-invalid", status: StatusInvalid,
			subStatus: SubStatusSyntaxInvalid,
		},
		{
			name: "explicit disposable", email: "reader@explicit-disposable.test",
			attemptID: "opaque-build-failure-disposable", status: StatusDoNotMail,
			subStatus: SubStatusDisposable,
		},
		{
			name: "abuse mailbox", email: "abuse@example.com",
			attemptID: "opaque-build-failure-abuse", status: StatusAbuse,
			subStatus: SubStatusRoleBased,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fingerprint := signupFingerprint(tt.name)
			first, err := gateAuthorized(s, tenantID, formID, tt.email, tt.attemptID, fingerprint)
			if err != nil {
				t.Fatalf("first gate: %v", err)
			}
			if first.Allow || !first.Checked || !first.Degraded || first.Retryable ||
				first.Status != tt.status || first.SubStatus != tt.subStatus ||
				first.Provider != ProviderLocal || first.Reason == "" {
				t.Fatalf("local terminal decision = %+v", first)
			}

			replay, err := gateAuthorized(s, tenantID, formID, tt.email, tt.attemptID, fingerprint)
			if err != nil {
				t.Fatalf("replay gate: %v", err)
			}
			if replay.Allow || !replay.Checked || !replay.Degraded || replay.Retryable ||
				replay.Status != tt.status || replay.SubStatus != tt.subStatus || replay.Reason == "" {
				t.Fatalf("replayed local terminal decision = %+v", replay)
			}
		})
	}
	if got := buildCalls.Load(); got != int32(len(tests)) {
		t.Fatalf("chain build calls=%d, want one per identity (%d)", got, len(tests))
	}
}

func TestDBSignupAttemptStalePreDispatchReservationIsSafelyReclaimed(t *testing.T) {
	s, tenantID, formID := fullSignupAttemptStore(t)
	email := "reader@example.com"
	claim, err := s.beginSignupAttempt(context.Background(), tenantID, formID, email,
		"opaque-attempt-abandoned-owner", signupFingerprint("abandoned"))
	if err != nil || !claim.IdentityOwner {
		t.Fatalf("seed abandoned claim=%+v err=%v", claim, err)
	}
	identityHash := signupIdentityDigest(tenantID, email)
	tx, err := db.WithTenant(context.Background(), s.Pool, tenantID)
	if err != nil {
		t.Fatalf("begin stale update: %v", err)
	}
	if _, err := tx.Exec(context.Background(), `
UPDATE verification_signup_identities
   SET updated_at=now()-interval '3 minutes'
 WHERE tenant_id=$1::uuid AND identity_hash=$2`, tenantID, identityHash[:]); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("age pre-dispatch identity: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit stale update: %v", err)
	}

	vendor := &signupAttemptVerifier{verify: func(_ context.Context, email string) (Result, error) {
		return Result{Email: email, Status: StatusValid, Provider: ProviderZeroBounce}, nil
	}}
	s.chainOverride = func(context.Context, string) (*Chain, error) {
		return &Chain{Local: s.Local, Vendor: vendor}, nil
	}
	d, err := gateAuthorized(s, tenantID, formID, email,
		"opaque-attempt-reclaimed-owner", signupFingerprint("new intent"))
	if err != nil || !d.Allow || d.Retryable || d.Degraded {
		t.Fatalf("reclaimed decision=%+v err=%v", d, err)
	}
	if vendor.calls.Load() != 1 {
		t.Fatalf("reclaimed vendor calls=%d, want 1", vendor.calls.Load())
	}
}

func TestDBSignupAttemptStalePostDispatchReservationBecomesAmbiguous(t *testing.T) {
	s, tenantID, formID := fullSignupAttemptStore(t)
	email := "reader@example.com"
	attemptID := "opaque-attempt-dispatched-owner"
	fingerprint := signupFingerprint("dispatched")
	claim, err := s.beginSignupAttempt(context.Background(), tenantID, formID, email, attemptID, fingerprint)
	if err != nil || !claim.IdentityOwner {
		t.Fatalf("seed dispatched claim=%+v err=%v", claim, err)
	}
	if err := s.markSignupAttemptDispatched(context.Background(), tenantID, formID, email,
		attemptID, fingerprint); err != nil {
		t.Fatalf("mark dispatched: %v", err)
	}
	identityHash := signupIdentityDigest(tenantID, email)
	tx, err := db.WithTenant(context.Background(), s.Pool, tenantID)
	if err != nil {
		t.Fatalf("begin dispatched aging: %v", err)
	}
	if _, err := tx.Exec(context.Background(), `
UPDATE verification_signup_identities
   SET dispatched_at=now()-interval '3 minutes', updated_at=now()-interval '3 minutes'
 WHERE tenant_id=$1::uuid AND identity_hash=$2`, tenantID, identityHash[:]); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("age dispatched identity: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit dispatched aging: %v", err)
	}

	vendor := &signupAttemptVerifier{verify: func(_ context.Context, email string) (Result, error) {
		return Result{Email: email, Status: StatusValid, Provider: ProviderZeroBounce}, nil
	}}
	s.chainOverride = func(context.Context, string) (*Chain, error) {
		return &Chain{Local: s.Local, Vendor: vendor}, nil
	}
	d, err := gateAuthorized(s, tenantID, formID, email,
		"opaque-attempt-after-unknown", signupFingerprint("after unknown"))
	if err != nil || !d.Allow || !d.Degraded || d.Retryable || d.Status != StatusUnknown {
		t.Fatalf("stale post-dispatch decision=%+v err=%v", d, err)
	}
	if vendor.calls.Load() != 0 {
		t.Fatalf("stale post-dispatch identity redispatched: calls=%d", vendor.calls.Load())
	}
}

func TestDBSignupAttemptFullModeWithoutAntiAbuseProofIsLocalOnly(t *testing.T) {
	s, tenantID, formID := fullSignupAttemptStore(t)
	vendor := &signupAttemptVerifier{verify: func(_ context.Context, email string) (Result, error) {
		return Result{Email: email, Status: StatusValid, Provider: ProviderZeroBounce}, nil
	}}
	s.chainOverride = func(context.Context, string) (*Chain, error) {
		return &Chain{Local: s.Local, Vendor: vendor}, nil
	}
	d, err := s.GateSignupAuthorizedAttempt(context.Background(), tenantID, formID,
		"reader@example.com", "opaque-attempt-no-captcha-proof", signupFingerprint("intent"), false)
	if err != nil {
		t.Fatalf("GateSignupAuthorizedAttempt: %v", err)
	}
	if !d.Allow || !d.Checked || !d.Degraded || d.Provider != ProviderLocal {
		t.Fatalf("no-proof full-mode decision = %+v", d)
	}
	if vendor.calls.Load() != 0 {
		t.Fatalf("no-proof full-mode vendor calls = %d, want 0", vendor.calls.Load())
	}
}

func TestDBSignupAttemptLegacyFullModeIsLocalOnlyAndDegraded(t *testing.T) {
	s, tenantID, _ := fullSignupAttemptStore(t)
	vendor := &signupAttemptVerifier{verify: func(_ context.Context, email string) (Result, error) {
		return Result{Email: email, Status: StatusValid, Provider: ProviderZeroBounce}, nil
	}}
	s.chainOverride = func(context.Context, string) (*Chain, error) {
		return &Chain{Local: s.Local, Vendor: vendor}, nil
	}
	d, err := s.GateSignup(context.Background(), tenantID, "reader@example.com")
	if err != nil {
		t.Fatalf("GateSignup: %v", err)
	}
	if !d.Allow || !d.Checked || !d.Degraded || d.Provider != ProviderLocal {
		t.Fatalf("legacy full-mode decision = %+v", d)
	}
	if vendor.calls.Load() != 0 {
		t.Fatalf("legacy full-mode vendor calls = %d, want 0", vendor.calls.Load())
	}
}

func TestDBSignupAttemptReceiptsAreTenantIsolatedAndWorkerExpiryScoped(t *testing.T) {
	pool := verificationDB(t)
	tenantA := newTenant(t, pool)
	tenantB := newTenant(t, pool)
	s := newStore(t, pool, nil)
	formA := newVerificationSignupForm(t, s, tenantA)
	ctx := context.Background()
	claim, err := s.beginSignupAttempt(ctx, tenantA, formA, "reader@example.com",
		"opaque-attempt-tenant-a-01", signupFingerprint("tenant-a"))
	if err != nil || !claim.IdentityOwner {
		t.Fatalf("begin tenant A attempt claim=%+v err=%v", claim, err)
	}

	tables := []string{"verification_signup_attempts", "verification_signup_identities"}
	for _, table := range tables {
		tenantBTx, err := db.WithTenant(ctx, pool, tenantB)
		if err != nil {
			t.Fatalf("begin tenant B scope for %s: %v", table, err)
		}
		var visible int
		if err := tenantBTx.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&visible); err != nil {
			_ = tenantBTx.Rollback(ctx)
			t.Fatalf("tenant B select %s: %v", table, err)
		}
		updated, err := tenantBTx.Exec(ctx, "UPDATE "+table+" SET updated_at=now()")
		if err != nil {
			_ = tenantBTx.Rollback(ctx)
			t.Fatalf("tenant B update %s: %v", table, err)
		}
		deleted, err := tenantBTx.Exec(ctx, "DELETE FROM "+table)
		if err != nil {
			_ = tenantBTx.Rollback(ctx)
			t.Fatalf("tenant B delete %s: %v", table, err)
		}
		if visible != 0 || updated.RowsAffected() != 0 || deleted.RowsAffected() != 0 {
			_ = tenantBTx.Rollback(ctx)
			t.Fatalf("tenant B crossed %s boundary visible=%d updated=%d deleted=%d",
				table, visible, updated.RowsAffected(), deleted.RowsAffected())
		}
		if err := tenantBTx.Commit(ctx); err != nil {
			t.Fatalf("commit tenant B scope for %s: %v", table, err)
		}
	}

	// Worker scope is cross-tenant by design, so an unfiltered count or DELETE
	// under it would see, and destroy, every expired receipt in the shared
	// database, including another test's. Filtering to this test's two tenants
	// leaves the proof about the worker policies exact for the rows the test
	// seeded, and touches nobody else's.
	ownTenants := []string{tenantA, tenantB}
	for _, table := range tables {
		workerTx, err := db.WithWorkerScope(ctx, pool)
		if err != nil {
			t.Fatalf("begin live worker scope for %s: %v", table, err)
		}
		var visible int
		if err = workerTx.QueryRow(ctx,
			"SELECT count(*) FROM "+table+" WHERE tenant_id = ANY($1::uuid[])", ownTenants).Scan(&visible); err != nil {
			_ = workerTx.Rollback(ctx)
			t.Fatalf("worker live select %s: %v", table, err)
		}
		deleted, err := workerTx.Exec(ctx,
			"DELETE FROM "+table+" WHERE tenant_id = ANY($1::uuid[])", ownTenants)
		if err != nil {
			_ = workerTx.Rollback(ctx)
			t.Fatalf("worker live delete %s: %v", table, err)
		}
		if visible != 0 || deleted.RowsAffected() != 0 {
			_ = workerTx.Rollback(ctx)
			t.Fatalf("worker saw/deleted live %s visible=%d deleted=%d",
				table, visible, deleted.RowsAffected())
		}
		if err := workerTx.Commit(ctx); err != nil {
			t.Fatalf("commit live worker scope for %s: %v", table, err)
		}
	}

	tenantATx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatalf("begin tenant A expiry: %v", err)
	}
	if _, err := tenantATx.Exec(ctx, `
UPDATE verification_signup_attempts
   SET created_at=now()-interval '23 hours', expires_at=now()-interval '1 minute'
 WHERE tenant_id=$1::uuid AND form_id=$2::uuid`, tenantA, formA); err != nil {
		_ = tenantATx.Rollback(ctx)
		t.Fatalf("expire tenant A attempt: %v", err)
	}
	if _, err := tenantATx.Exec(ctx, `
UPDATE verification_signup_identities
   SET created_at=now()-interval '23 hours', expires_at=now()-interval '1 minute'
 WHERE tenant_id=$1::uuid`, tenantA); err != nil {
		_ = tenantATx.Rollback(ctx)
		t.Fatalf("expire tenant A identity: %v", err)
	}
	if err := tenantATx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant A expiry: %v", err)
	}

	for _, table := range tables {
		workerTx, err := db.WithWorkerScope(ctx, pool)
		if err != nil {
			t.Fatalf("begin expired worker scope for %s: %v", table, err)
		}
		var visible int
		if err = workerTx.QueryRow(ctx,
			"SELECT count(*) FROM "+table+" WHERE tenant_id = ANY($1::uuid[])", ownTenants).Scan(&visible); err != nil {
			_ = workerTx.Rollback(ctx)
			t.Fatalf("worker expired select %s: %v", table, err)
		}
		deleted, err := workerTx.Exec(ctx,
			"DELETE FROM "+table+" WHERE tenant_id = ANY($1::uuid[])", ownTenants)
		if err != nil {
			_ = workerTx.Rollback(ctx)
			t.Fatalf("worker expired delete %s: %v", table, err)
		}
		if visible != 1 || deleted.RowsAffected() != 1 {
			_ = workerTx.Rollback(ctx)
			t.Fatalf("worker expired %s visible=%d deleted=%d, want 1/1",
				table, visible, deleted.RowsAffected())
		}
		if err := workerTx.Commit(ctx); err != nil {
			t.Fatalf("commit expired worker scope for %s: %v", table, err)
		}
	}

	for _, table := range tables {
		var forced bool
		if err := pool.QueryRow(ctx, `
SELECT relforcerowsecurity FROM pg_class WHERE oid=$1::regclass`, table).Scan(&forced); err != nil {
			t.Fatalf("read FORCE RLS flag for %s: %v", table, err)
		}
		if !forced {
			t.Fatalf("%s does not FORCE ROW LEVEL SECURITY", table)
		}
	}
}

func TestSignupAttemptDigestValidationAndScoping(t *testing.T) {
	fingerprint := signupFingerprint("intent")
	a, requestA, identityA, err := signupAttemptDigests(
		"tenant-a", "form-a", "Person@Example.com", "opaque-attempt-00000005", fingerprint,
	)
	if err != nil {
		t.Fatalf("signupAttemptDigests: %v", err)
	}
	b, requestB, identityB, err := signupAttemptDigests(
		"tenant-a", "form-b", "person@example.com", "opaque-attempt-00000005", fingerprint,
	)
	if err != nil {
		t.Fatalf("signupAttemptDigests: %v", err)
	}
	if a == b || requestA == requestB {
		t.Fatal("attempt and request digests must be form scoped")
	}
	if identityA != identityB {
		t.Fatal("normalized identity digest must be tenant-wide across forms")
	}
	_, _, identityOtherTenant, err := signupAttemptDigests(
		"tenant-b", "form-b", "person@example.com", "opaque-attempt-00000005", fingerprint,
	)
	if err != nil {
		t.Fatalf("other tenant signupAttemptDigests: %v", err)
	}
	if identityA == identityOtherTenant {
		t.Fatal("identity digest must remain tenant scoped")
	}
	if _, _, _, err := signupAttemptDigests(
		"tenant-a", "form-a", "person@example.com", "short", fingerprint,
	); !errors.Is(err, ErrSignupAttemptInvalid) {
		t.Fatalf("short attempt error = %v", err)
	}
}
