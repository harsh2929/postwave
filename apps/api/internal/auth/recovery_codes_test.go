// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// nopCipher is a pass-through SecretCipher. The TOTP secret's encryption is
// tested in totp_test.go; these tests are about the recovery-code lifecycle,
// so the cipher is deliberately inert.
type nopCipher struct{}

func (nopCipher) Encrypt(_ context.Context, plaintext []byte) ([]byte, error) {
	return append([]byte(nil), plaintext...), nil
}

func (nopCipher) Decrypt(_ context.Context, blob, _ []byte) ([]byte, error) {
	return append([]byte(nil), blob...), nil
}

// recoveryFixture stands up a real tenant + owner and returns everything the
// handlers need. Uses the non-privileged postwave_app role via cliAuthDB, so
// every write below is genuinely subject to RLS.
type recoveryFixture struct {
	repo     *Repo
	deps     *Deps
	tenantID string
	userID   string
	email    string
}

func newRecoveryFixture(t *testing.T, mfaSatisfied bool) *recoveryFixture {
	t.Helper()
	pool := cliAuthDB(t)
	repo := &Repo{Pool: pool, Pepper: make([]byte, 32)}
	unique := cliUUID(t)
	slug := "recov-" + unique[:8]
	email := "recov-" + unique[:8] + "@example.test"

	phc, err := Hash("Sup3rSecret!passphrase", Recommended)
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	ctx := context.Background()
	tenantID, userID, err := repo.CreateTenantWithOwner(ctx, "Recovery test", slug, email, phc)
	if err != nil {
		t.Fatalf("CreateTenantWithOwner: %v", err)
	}
	// deleteAuthTestTenant: a one-minute budget and a retry on transient lock
	// contention. The five seconds this cleanup had were too few for a tenant
	// cascade (about 735 foreign keys) while other packages delete tenants too.
	t.Cleanup(func() { deleteAuthTestTenant(t, pool, tenantID) })

	f := &recoveryFixture{repo: repo, tenantID: tenantID, userID: userID, email: email}
	f.deps = &Deps{
		Repo:          repo,
		SecretCipher:  nopCipher{},
		CookieOptions: DefaultCookieOptions(),
		MeContextLookup: func(*http.Request) (MeContext, bool) {
			return MeContext{
				TenantID: tenantID, UserID: userID, UserEmail: email,
				UserRole: "owner", EffectiveRole: "owner",
				MFASatisfied: mfaSatisfied,
			}, true
		},
	}
	return f
}

// enrollAndConfirm mints a factor and marks it confirmed, which is the state
// every regeneration path requires.
func (f *recoveryFixture) enrollAndConfirm(t *testing.T) []string {
	t.Helper()
	rec := httptest.NewRecorder()
	f.deps.TOTPEnroll(rec, httptest.NewRequest("POST", "/api/v1/auth/totp/enroll", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("TOTPEnroll status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var enrolled struct {
		RecoveryCodes []string `json:"recovery_codes"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&enrolled); err != nil {
		t.Fatalf("decode enroll: %v", err)
	}
	// last_used_at IS NOT NULL is the "confirmed" signal; /totp/verify sets
	// it via MarkTOTPUsed. Calling the repo directly keeps the test focused
	// on recovery codes rather than on generating a valid TOTP code.
	if err := f.repo.MarkTOTPUsed(context.Background(), f.tenantID, f.userID); err != nil {
		t.Fatalf("MarkTOTPUsed: %v", err)
	}
	return enrolled.RecoveryCodes
}

// currentTOTPCode produces a code the hardened regenerate endpoint accepts.
//
// `RegenerateRecoveryCodes` now requires a current authenticator code — you
// must re-prove possession before minting a fresh bundle. These tests predate
// that and posted an empty body, so they took a 400; because the whole file was
// skipping, nobody saw it. The fixture's SecretCipher is a pass-through, so the
// stored secret is the secret.
func (f *recoveryFixture) currentTOTPCode(t *testing.T) string {
	t.Helper()
	secret, _, err := f.repo.GetTOTPSecret(context.Background(), f.userID)
	if err != nil {
		t.Fatalf("read TOTP secret: %v", err)
	}
	return Code(secret, time.Now())
}

func (f *recoveryFixture) regenerateRequest(t *testing.T) *http.Request {
	t.Helper()
	body := fmt.Sprintf(`{"code":%q}`, f.currentTOTPCode(t))
	req := httptest.NewRequest("POST", "/api/v1/auth/totp/recovery-codes", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

func (f *recoveryFixture) status(t *testing.T) recoveryCodesStatusResponse {
	t.Helper()
	rec := httptest.NewRecorder()
	f.deps.RecoveryCodesStatus(rec, httptest.NewRequest("GET", "/api/v1/auth/totp/recovery-codes", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status endpoint = %d, body = %s", rec.Code, rec.Body.String())
	}
	var out recoveryCodesStatusResponse
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	return out
}

// TestRecoveryCodeRegenerationLifecycle is the AUTH#49 end-to-end proof:
// codes can be counted, consumption is visible in the count, regeneration
// issues a fresh full bundle, and — the security-critical half — the OLD
// codes stop working the instant the new ones are issued.
func TestRecoveryCodeRegenerationLifecycle(t *testing.T) {
	f := newRecoveryFixture(t, true)
	originalCodes := f.enrollAndConfirm(t)
	if len(originalCodes) != RecoveryCodeCount {
		t.Fatalf("enroll returned %d codes, want %d", len(originalCodes), RecoveryCodeCount)
	}

	// 1. The count is now readable at all — this is what did not exist.
	st := f.status(t)
	if !st.Enrolled || st.Remaining != RecoveryCodeCount || st.Total != RecoveryCodeCount {
		t.Fatalf("status after enroll = %+v", st)
	}
	if st.Low {
		t.Fatalf("a full bundle must not be reported low: %+v", st)
	}

	// 2. Consuming a code moves the count.
	ctx := context.Background()
	if err := f.repo.ConsumeRecoveryCode(ctx, f.tenantID, f.userID, HashRecoveryCode(originalCodes[0])); err != nil {
		t.Fatalf("ConsumeRecoveryCode: %v", err)
	}
	if st = f.status(t); st.Remaining != RecoveryCodeCount-1 {
		t.Fatalf("remaining after one burn = %d, want %d", st.Remaining, RecoveryCodeCount-1)
	}

	// 3. Regeneration returns a fresh, full bundle.
	rec := httptest.NewRecorder()
	f.deps.RegenerateRecoveryCodes(rec, f.regenerateRequest(t))
	if rec.Code != http.StatusOK {
		t.Fatalf("regenerate status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var regen recoveryCodesRegenerateResponse
	if err := json.NewDecoder(rec.Body).Decode(&regen); err != nil {
		t.Fatalf("decode regenerate: %v", err)
	}
	if len(regen.RecoveryCodes) != RecoveryCodeCount || regen.Remaining != RecoveryCodeCount {
		t.Fatalf("regenerate returned %+v", regen)
	}
	if st = f.status(t); st.Remaining != RecoveryCodeCount {
		t.Fatalf("remaining after regenerate = %d, want %d", st.Remaining, RecoveryCodeCount)
	}

	// 4. THE INVARIANT: every OLD code is dead. A partial replace here would
	//    leave a leaked printout valid forever.
	for i, old := range originalCodes {
		err := f.repo.ConsumeRecoveryCode(ctx, f.tenantID, f.userID, HashRecoveryCode(old))
		if err == nil {
			t.Fatalf("old recovery code %d still works after regeneration", i)
		}
	}

	// 5. The NEW codes do work, and remain one-shot.
	if err := f.repo.ConsumeRecoveryCode(ctx, f.tenantID, f.userID, HashRecoveryCode(regen.RecoveryCodes[0])); err != nil {
		t.Fatalf("new recovery code rejected: %v", err)
	}
	if err := f.repo.ConsumeRecoveryCode(ctx, f.tenantID, f.userID, HashRecoveryCode(regen.RecoveryCodes[0])); err == nil {
		t.Fatal("new recovery code was consumable twice")
	}
}

// TestRecoveryCodeStatusReportsLowWatermark proves the server owns the
// threshold, which is the point of putting it on the wire at all.
func TestRecoveryCodeStatusReportsLowWatermark(t *testing.T) {
	f := newRecoveryFixture(t, true)
	codes := f.enrollAndConfirm(t)
	ctx := context.Background()
	// Burn down to exactly the watermark.
	for i := 0; i < RecoveryCodeCount-RecoveryCodesLowWatermark; i++ {
		if err := f.repo.ConsumeRecoveryCode(ctx, f.tenantID, f.userID, HashRecoveryCode(codes[i])); err != nil {
			t.Fatalf("burn code %d: %v", i, err)
		}
	}
	st := f.status(t)
	if st.Remaining != RecoveryCodesLowWatermark {
		t.Fatalf("remaining = %d, want %d", st.Remaining, RecoveryCodesLowWatermark)
	}
	if !st.Low {
		t.Fatalf("status at the watermark must report low: %+v", st)
	}
}

// Regeneration requires a FRESH possession proof, not a session flag.
//
// This asserted the superseded control: that a session without mfa_satisfied
// gets 403. The gate was deliberately changed (SETC-035) because
// mfa_satisfied is set once at login and never expires, so it protected
// against a stolen PRE-MFA cookie and not against a borrowed POST-MFA one. The
// current control — a current authenticator code verified server-side — defeats
// both, since neither stolen cookie carries the user's authenticator.
//
// So the test now asserts what actually guards the break-glass path: no valid
// current code, no regeneration. It deliberately uses a session that has NOT
// satisfied MFA, which is the original threat model, and proves the request is
// still refused.
func TestRegenerateRequiresAFreshPossessionProof(t *testing.T) {
	f := newRecoveryFixture(t, false) // session has NOT satisfied MFA
	f.enrollAndConfirm(t)

	for _, tc := range []struct {
		name string
		body string
	}{
		{"no body at all", ""},
		{"empty code", `{"code":""}`},
		{"a wrong code", `{"code":"000000"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var req *http.Request
			if tc.body == "" {
				req = httptest.NewRequest("POST", "/api/v1/auth/totp/recovery-codes", nil)
			} else {
				req = httptest.NewRequest("POST", "/api/v1/auth/totp/recovery-codes", strings.NewReader(tc.body))
				req.Header.Set("Content-Type", "application/json")
			}
			rec := httptest.NewRecorder()
			f.deps.RegenerateRecoveryCodes(rec, req)
			if rec.Code == http.StatusOK {
				t.Fatalf("regeneration succeeded with %s. A stolen cookie could "+
					"mint itself a working recovery code without ever touching "+
					"the authenticator: %s", tc.name, rec.Body.String())
			}
		})
	}

	// And with a genuine current code it succeeds, so the test cannot pass by
	// regeneration being broken outright.
	rec := httptest.NewRecorder()
	f.deps.RegenerateRecoveryCodes(rec, f.regenerateRequest(t))
	if rec.Code != http.StatusOK {
		t.Fatalf("regeneration with a valid current code = %d, want 200: %s",
			rec.Code, rec.Body.String())
	}
}

func TestRegenerateRefusesUnconfirmedEnrollment(t *testing.T) {
	f := newRecoveryFixture(t, true)
	// Enroll but do NOT confirm (no MarkTOTPUsed).
	rec := httptest.NewRecorder()
	f.deps.TOTPEnroll(rec, httptest.NewRequest("POST", "/api/v1/auth/totp/enroll", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("TOTPEnroll status = %d, body = %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	f.deps.RegenerateRecoveryCodes(rec, f.regenerateRequest(t))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error.Code != "not_enrolled" {
		t.Fatalf("error code = %q, want not_enrolled", body.Error.Code)
	}
}

// TestRecoveryCodeStatusForUnenrolledUser proves the endpoint is a coherent
// 200 rather than a 404/500 for the very common "no MFA yet" case.
func TestRecoveryCodeStatusForUnenrolledUser(t *testing.T) {
	f := newRecoveryFixture(t, false)
	st := f.status(t)
	if st.Enrolled || st.Remaining != 0 || st.Low {
		t.Fatalf("unenrolled status = %+v", st)
	}
	if st.Total != RecoveryCodeCount {
		t.Fatalf("total = %d, want %d", st.Total, RecoveryCodeCount)
	}
}

// TestMeSurfacesRecoveryCodeCount closes the other half of AUTH#49: the
// finding was that MeResponse carried no remaining-count field, so no
// Security surface could warn without a second call.
func TestMeSurfacesRecoveryCodeCount(t *testing.T) {
	f := newRecoveryFixture(t, true)
	codes := f.enrollAndConfirm(t)

	me := func() MeResponse {
		t.Helper()
		rec := httptest.NewRecorder()
		f.deps.Me(rec, httptest.NewRequest("GET", "/api/v1/auth/me", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("Me status = %d, body = %s", rec.Code, rec.Body.String())
		}
		var out MeResponse
		if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
			t.Fatalf("decode me: %v", err)
		}
		return out
	}

	got := me()
	if !got.TOTPEnabled {
		t.Fatal("totp_enabled = false after a confirmed enrollment")
	}
	if got.RecoveryCodesRemaining != RecoveryCodeCount {
		t.Fatalf("recovery_codes_remaining = %d, want %d", got.RecoveryCodesRemaining, RecoveryCodeCount)
	}
	if got.RecoveryCodesLow {
		t.Fatal("recovery_codes_low = true on a full bundle")
	}

	ctx := context.Background()
	for i := 0; i < RecoveryCodeCount-RecoveryCodesLowWatermark; i++ {
		if err := f.repo.ConsumeRecoveryCode(ctx, f.tenantID, f.userID, HashRecoveryCode(codes[i])); err != nil {
			t.Fatalf("burn code %d: %v", i, err)
		}
	}
	got = me()
	if got.RecoveryCodesRemaining != RecoveryCodesLowWatermark || !got.RecoveryCodesLow {
		t.Fatalf("me after burn-down = remaining %d low %v", got.RecoveryCodesRemaining, got.RecoveryCodesLow)
	}
}

// TestMeReportsNoRecoveryCodesWhenUnenrolled guards against the noisy
// failure mode: an unenrolled user must not be told they are "low" on codes
// they never had.
func TestMeReportsNoRecoveryCodesWhenUnenrolled(t *testing.T) {
	f := newRecoveryFixture(t, false)
	rec := httptest.NewRecorder()
	f.deps.Me(rec, httptest.NewRequest("GET", "/api/v1/auth/me", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("Me status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var out MeResponse
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode me: %v", err)
	}
	if out.TOTPEnabled || out.RecoveryCodesRemaining != 0 || out.RecoveryCodesLow {
		t.Fatalf("unenrolled me = %+v", out)
	}
}

// TestReplaceRecoveryCodesIsTenantIsolated is the house-rule-1 proof. The
// UPDATE is keyed on user_id, so the ONLY thing standing between a caller
// with one tenant's context and another tenant's recovery codes is the RLS
// policy on auth_totp_secrets. This runs as the non-privileged postwave_app
// role, so that policy is genuinely in force.
//
// A regression here would let any authenticated user rotate a stranger's
// break-glass codes — a denial-of-access attack on the victim's MFA.
func TestReplaceRecoveryCodesIsTenantIsolated(t *testing.T) {
	victim := newRecoveryFixture(t, true)
	attacker := newRecoveryFixture(t, true)
	victimCodes := victim.enrollAndConfirm(t)
	attacker.enrollAndConfirm(t)

	_, freshHashes, err := GenerateRecoveryCodes(RecoveryCodeCount)
	if err != nil {
		t.Fatalf("GenerateRecoveryCodes: %v", err)
	}
	// The attacker's tenant context paired with the victim's user id.
	err = attacker.repo.ReplaceRecoveryCodes(
		context.Background(), attacker.tenantID, victim.userID, freshHashes)
	if err == nil {
		t.Fatal("cross-tenant recovery-code replacement succeeded")
	}

	// And the victim's ORIGINAL codes still work, i.e. nothing was rotated
	// out from under them.
	if err := victim.repo.ConsumeRecoveryCode(context.Background(),
		victim.tenantID, victim.userID, HashRecoveryCode(victimCodes[0])); err != nil {
		t.Fatalf("victim's original code stopped working: %v", err)
	}
}

// TestRecoveryCodeStatusIsTenantScopedToTheCaller pins the read side: the
// count is derived from the session's own user id, and two tenants' factors
// never bleed into one another.
func TestRecoveryCodeStatusIsTenantScopedToTheCaller(t *testing.T) {
	a := newRecoveryFixture(t, true)
	b := newRecoveryFixture(t, true)
	aCodes := a.enrollAndConfirm(t)
	b.enrollAndConfirm(t)

	// Burn two of A's codes; B must be unaffected.
	for i := 0; i < 2; i++ {
		if err := a.repo.ConsumeRecoveryCode(context.Background(),
			a.tenantID, a.userID, HashRecoveryCode(aCodes[i])); err != nil {
			t.Fatalf("burn a[%d]: %v", i, err)
		}
	}
	if got := a.status(t).Remaining; got != RecoveryCodeCount-2 {
		t.Fatalf("A remaining = %d, want %d", got, RecoveryCodeCount-2)
	}
	if got := b.status(t).Remaining; got != RecoveryCodeCount {
		t.Fatalf("B remaining = %d, want %d — one tenant's burn changed another's", got, RecoveryCodeCount)
	}
}

// TestReplaceRecoveryCodesRefusesEmptyBundle protects the one input that
// would silently destroy a user's break-glass path.
func TestReplaceRecoveryCodesRefusesEmptyBundle(t *testing.T) {
	f := newRecoveryFixture(t, true)
	f.enrollAndConfirm(t)
	if err := f.repo.ReplaceRecoveryCodes(context.Background(), f.tenantID, f.userID, nil); err == nil {
		t.Fatal("ReplaceRecoveryCodes accepted an empty bundle")
	}
	if st := f.status(t); st.Remaining != RecoveryCodeCount {
		t.Fatalf("refused replace still mutated the bundle: %+v", st)
	}
}
