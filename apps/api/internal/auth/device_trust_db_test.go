// SPDX-License-Identifier: AGPL-3.0-only
//
// device_trust_db_test.go — the AUTH#48 tests that need a real database,
// because the things worth proving about device trust are the things that
// only the database can be wrong about.
//
// Run under the NON-PRIVILEGED role so RLS and column grants are genuinely
// exercised (a superuser connection bypasses both and hides exactly the class
// of bug this feature must not have):
//
//	DATABASE_URL=postgres://postwave_app:local-test-password-only@localhost:5432/postwave_verify?sslmode=disable \
//	  go test ./internal/auth -run DeviceTrust
package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// withChiURLParam attaches a chi route param so a handler that reads
// chi.URLParam can be driven without standing up the router.
func withChiURLParam(r *http.Request, key, value string) *http.Request {
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add(key, value)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, routeCtx))
}

// trustFixture stands up two real workspaces so cross-tenant claims can be
// tested rather than asserted. Everything runs through the same Repo the
// handlers use.
type trustFixture struct {
	repo     *Repo
	deps     *Deps
	tenantA  string
	userA    string
	emailA   string
	tenantB  string
	userB    string
	cipher   nopCipher
	nowClock time.Time
}

func newTrustFixture(t *testing.T) *trustFixture {
	t.Helper()
	pool := cliAuthDB(t)
	repo := &Repo{Pool: pool, Pepper: []byte("0123456789abcdef0123456789abcdef")}
	ctx := context.Background()
	unique := cliUUID(t)

	phc, err := Hash("Sup3rSecret!passphrase", Recommended)
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	emailA := "trust-a-" + unique[:8] + "@example.test"
	tenantA, userA, err := repo.CreateTenantWithOwner(
		ctx, "Trust A", "trust-a-"+unique[:8], emailA, phc)
	if err != nil {
		t.Fatalf("CreateTenantWithOwner A: %v", err)
	}
	tenantB, userB, err := repo.CreateTenantWithOwner(
		ctx, "Trust B", "trust-b-"+unique[:8], "trust-b-"+unique[:8]+"@example.test", phc)
	if err != nil {
		t.Fatalf("CreateTenantWithOwner B: %v", err)
	}
	// Each tenant is deleted in a transaction bound to that tenant. The
	// tenants DELETE policy sees only the row whose id equals app.tenant_id;
	// the worker scope this cleanup used to open (db.WithWorkerScope sets
	// app.outbox_worker, not app.tenant_id) makes every row invisible, so the
	// DELETE matched nothing, reported no error, and each run left its
	// tenants in the shared database.
	t.Cleanup(func() {
		for _, tid := range []string{tenantA, tenantB} {
			deleteAuthTestTenant(t, pool, tid)
		}
	})

	f := &trustFixture{
		repo: repo, tenantA: tenantA, userA: userA, emailA: emailA,
		tenantB: tenantB, userB: userB, nowClock: time.Now(),
	}
	f.deps = &Deps{
		Repo:          repo,
		SecretCipher:  f.cipher,
		CookieOptions: DefaultCookieOptions(),
		MeContextLookup: func(*http.Request) (MeContext, bool) {
			return MeContext{
				TenantID: tenantA, UserID: userA, UserEmail: emailA,
				UserRole: "owner", EffectiveRole: "owner",
			}, true
		},
	}
	return f
}

// mint writes a trust record directly through the repo and returns the token
// whose verifier matches it. Used where the test is about CONSUMPTION rather
// than about the issuance handler.
func (f *trustFixture) mint(t *testing.T, tenantID, userID string, days int, expires time.Time) TrustToken {
	t.Helper()
	tok, err := IssueTrustToken()
	if err != nil {
		t.Fatalf("IssueTrustToken: %v", err)
	}
	if _, err := f.repo.CreateTrustedDevice(context.Background(), TrustedDevice{
		ID: tok.ID, TenantID: tenantID, UserID: userID, TrustDays: days,
		Label: "Test device", UserAgent: "postwave-test/1.0", IP: "203.0.113.9",
		ExpiresAt: expires,
	}, HashTrustVerifier(tok.Verifier, f.repo.trustPepper())); err != nil {
		t.Fatalf("CreateTrustedDevice: %v", err)
	}
	return tok
}

// setTrustPolicy writes the tenant's allow_trusted_devices opt-out.
func (f *trustFixture) setTrustPolicy(t *testing.T, tenantID string, allow bool) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, f.repo.Pool, tenantID)
	if err != nil {
		t.Fatalf("setTrustPolicy begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenant_security_settings (tenant_id, allow_trusted_devices)
VALUES ($1::uuid, $2)
ON CONFLICT (tenant_id) DO UPDATE SET allow_trusted_devices = EXCLUDED.allow_trusted_devices`,
		tenantID, allow); err != nil {
		t.Fatalf("setTrustPolicy upsert: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("setTrustPolicy commit: %v", err)
	}
}

// rowState reads the raw columns the application is not allowed to touch on
// use, so "expiry is absolute" can be checked against storage rather than
// against a return value.
func (f *trustFixture) rowState(t *testing.T, tenantID, id string) (expiresAt time.Time, lastUsed *time.Time, revoked *time.Time) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, f.repo.Pool, tenantID)
	if err != nil {
		t.Fatalf("rowState begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx,
		`SELECT expires_at, last_used_at, revoked_at FROM auth_trusted_devices WHERE id = $1`, id).
		Scan(&expiresAt, &lastUsed, &revoked); err != nil {
		t.Fatalf("rowState scan: %v", err)
	}
	_ = tx.Commit(ctx)
	return expiresAt, lastUsed, revoked
}

// ─────────────────────────────────────────────────────────────────────────────
// THE DANGEROUS LINE. ConsumeTrustedDevice returning true is the only way a
// brand new session is born MFA-satisfied. Every refusal path is proved here
// against real rows, not against a fake.
// ─────────────────────────────────────────────────────────────────────────────

func TestDeviceTrustConsumptionRefusesEveryBadState_DB(t *testing.T) {
	f := newTrustFixture(t)
	ctx := context.Background()

	tok := f.mint(t, f.tenantA, f.userA, 90, time.Now().Add(90*24*time.Hour))

	// Happy path first, so the negative cases below are known to be refusing
	// for the right reason rather than because nothing works.
	ok, err := f.repo.ConsumeTrustedDevice(ctx, f.tenantA, f.userA, tok.ID, tok.Verifier)
	if err != nil || !ok {
		t.Fatalf("valid trust consume = (%v, %v), want (true, nil)", ok, err)
	}

	// A WRONG VERIFIER is the whole point of storing a hash.
	if ok, err := f.repo.ConsumeTrustedDevice(ctx, f.tenantA, f.userA, tok.ID, "not-the-verifier"); ok || err != nil {
		t.Fatalf("wrong verifier consume = (%v, %v), want (false, nil)", ok, err)
	}
	// A verifier that is valid for the SESSION credential must be useless
	// here — the two peppers are disjoint.
	sessionShaped := HashVerifier(tok.Verifier, f.repo.Pepper)
	if ok, _ := f.repo.ConsumeTrustedDevice(ctx, f.tenantA, f.userA, tok.ID, string(sessionShaped)); ok {
		t.Fatal("a session-peppered verifier satisfied device trust")
	}

	// WRONG USER, same tenant. A trust record speaks for one identity.
	if ok, err := f.repo.ConsumeTrustedDevice(ctx, f.tenantA, f.userB, tok.ID, tok.Verifier); ok || err != nil {
		t.Fatalf("wrong-user consume = (%v, %v), want (false, nil)", ok, err)
	}
	// WRONG TENANT. The cookie is shared across workspaces on one host, so
	// this is the realistic cross-tenant attempt, and RLS + the predicate
	// must both refuse it.
	if ok, err := f.repo.ConsumeTrustedDevice(ctx, f.tenantB, f.userA, tok.ID, tok.Verifier); ok || err != nil {
		t.Fatalf("wrong-tenant consume = (%v, %v), want (false, nil)", ok, err)
	}

	// EXPIRY IS ABSOLUTE: consuming a record must not push expires_at out.
	expBefore, lastUsed, _ := f.rowState(t, f.tenantA, tok.ID)
	if lastUsed == nil {
		t.Fatal("a successful consume did not record last_used_at")
	}
	for i := 0; i < 3; i++ {
		if ok, err := f.repo.ConsumeTrustedDevice(ctx, f.tenantA, f.userA, tok.ID, tok.Verifier); err != nil || !ok {
			t.Fatalf("repeat consume %d = (%v, %v)", i, ok, err)
		}
	}
	expAfter, _, _ := f.rowState(t, f.tenantA, tok.ID)
	if !expAfter.Equal(expBefore) {
		t.Fatalf("expires_at moved from %s to %s — use extended the trust window",
			expBefore, expAfter)
	}

	// REVOKED must not satisfy MFA. This is one of the two cases the brief
	// names explicitly.
	revoked, err := f.repo.RevokeTrustedDevice(ctx, f.tenantA, f.userA, tok.ID)
	if err != nil || !revoked {
		t.Fatalf("RevokeTrustedDevice = (%v, %v), want (true, nil)", revoked, err)
	}
	if ok, err := f.repo.ConsumeTrustedDevice(ctx, f.tenantA, f.userA, tok.ID, tok.Verifier); ok || err != nil {
		t.Fatalf("REVOKED trust consume = (%v, %v), want (false, nil)", ok, err)
	}

	// EXPIRED must not satisfy MFA. The other case the brief names.
	expiredTok := f.mint(t, f.tenantA, f.userA, 30, time.Now().Add(-time.Minute))
	if ok, err := f.repo.ConsumeTrustedDevice(ctx, f.tenantA, f.userA, expiredTok.ID, expiredTok.Verifier); ok || err != nil {
		t.Fatalf("EXPIRED trust consume = (%v, %v), want (false, nil)", ok, err)
	}
	// And an expired record leaves no last_used_at trace — it was never used.
	if _, used, _ := f.rowState(t, f.tenantA, expiredTok.ID); used != nil {
		t.Fatal("an expired record recorded a use")
	}

	// An id that never existed.
	if ok, err := f.repo.ConsumeTrustedDevice(ctx, f.tenantA, f.userA, "no-such-id", "whatever"); ok || err != nil {
		t.Fatalf("unknown-id consume = (%v, %v), want (false, nil)", ok, err)
	}
	// Empty inputs must never be a wildcard.
	for _, args := range [][3]string{{"", f.userA, tok.ID}, {f.tenantA, "", tok.ID}, {f.tenantA, f.userA, ""}} {
		if ok, _ := f.repo.ConsumeTrustedDevice(ctx, args[0], args[1], args[2], tok.Verifier); ok {
			t.Fatalf("empty-argument consume %v granted trust", args)
		}
	}
}

// The per-tenant opt-out must be honoured SERVER-SIDE at consumption, not only
// at issuance: a workspace that turns device trust off has to stop records it
// already issued from satisfying MFA, immediately.
func TestDeviceTrustTenantOptOutStopsExistingRecords_DB(t *testing.T) {
	f := newTrustFixture(t)
	ctx := context.Background()
	tok := f.mint(t, f.tenantA, f.userA, 30, time.Now().Add(30*24*time.Hour))

	// Default is ALLOWED — the owner approved the feature, so a workspace
	// with no security-settings row at all still gets it.
	if allowed, err := f.repo.DeviceTrustAllowed(ctx, f.tenantA); err != nil || !allowed {
		t.Fatalf("DeviceTrustAllowed with no settings row = (%v, %v), want (true, nil)", allowed, err)
	}
	if ok, err := f.repo.ConsumeTrustedDevice(ctx, f.tenantA, f.userA, tok.ID, tok.Verifier); err != nil || !ok {
		t.Fatalf("consume under default policy = (%v, %v), want (true, nil)", ok, err)
	}

	f.setTrustPolicy(t, f.tenantA, false)
	if allowed, err := f.repo.DeviceTrustAllowed(ctx, f.tenantA); err != nil || allowed {
		t.Fatalf("DeviceTrustAllowed after opt-out = (%v, %v), want (false, nil)", allowed, err)
	}
	if ok, err := f.repo.ConsumeTrustedDevice(ctx, f.tenantA, f.userA, tok.ID, tok.Verifier); ok || err != nil {
		t.Fatalf("consume with the policy OFF = (%v, %v), want (false, nil)", ok, err)
	}

	// Turning it back on restores the record — the opt-out suppresses, it does
	// not destroy, so a workspace that flips the switch twice does not silently
	// leave dead credentials behind that the user can no longer see.
	f.setTrustPolicy(t, f.tenantA, true)
	if ok, err := f.repo.ConsumeTrustedDevice(ctx, f.tenantA, f.userA, tok.ID, tok.Verifier); err != nil || !ok {
		t.Fatalf("consume after re-enabling = (%v, %v), want (true, nil)", ok, err)
	}
}

// END TO END, through the real session-issuance path: a NEW session must be
// born mfa_satisfied ONLY when a live trust cookie is present. This is the
// property a session-scoped mfa_satisfied flag can never have, and the one
// that would be catastrophic to get wrong.
func TestDeviceTrustSatisfiesMFAOnANewSession_DB(t *testing.T) {
	f := newTrustFixture(t)
	ctx := context.Background()

	// login issues a session for a request carrying whatever cookies it has.
	login := func(t *testing.T, cookie string) *Session {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: TrustCookieName, Value: cookie})
		}
		if err := f.deps.issueSessionWithLifetime(rec, req, f.tenantA, f.userA, "password", true); err != nil {
			t.Fatalf("issueSessionWithLifetime: %v", err)
		}
		for _, c := range rec.Result().Cookies() {
			if c.Name != SessionCookieName {
				continue
			}
			idx := strings.Index(c.Value, ".")
			if idx <= 0 {
				t.Fatalf("malformed session cookie %q", c.Value)
			}
			sess, err := f.repo.LookupSession(ctx, c.Value[:idx], c.Value[idx+1:])
			if err != nil {
				t.Fatalf("LookupSession: %v", err)
			}
			return sess
		}
		t.Fatal("no session cookie issued")
		return nil
	}

	// No trust cookie → an ordinary session that still owes a second factor.
	if sess := login(t, ""); sess.MFASatisfied {
		t.Fatal("a session issued WITHOUT a trust cookie was born MFA-satisfied")
	}

	tok := f.mint(t, f.tenantA, f.userA, 180, time.Now().Add(180*24*time.Hour))

	// A garbage cookie must not help.
	if sess := login(t, "aaaa.bbbb"); sess.MFASatisfied {
		t.Fatal("a session issued with a FORGED trust cookie was born MFA-satisfied")
	}
	// The right id with the wrong verifier must not help either.
	if sess := login(t, tok.ID+".wrong-verifier"); sess.MFASatisfied {
		t.Fatal("a wrong verifier satisfied MFA on a new session")
	}
	// The real credential does.
	if sess := login(t, tok.String()); !sess.MFASatisfied {
		t.Fatal("a valid trust cookie did NOT satisfy MFA on the new session")
	}

	// REVOKED: the panic button has to work through the login path, not just
	// at the repo.
	if _, err := f.repo.RevokeAllTrustedDevices(ctx, f.tenantA, f.userA); err != nil {
		t.Fatalf("RevokeAllTrustedDevices: %v", err)
	}
	if sess := login(t, tok.String()); sess.MFASatisfied {
		t.Fatal("a REVOKED trust cookie satisfied MFA on a new session")
	}

	// EXPIRED, through the same path.
	expired := f.mint(t, f.tenantA, f.userA, 30, time.Now().Add(-time.Second))
	if sess := login(t, expired.String()); sess.MFASatisfied {
		t.Fatal("an EXPIRED trust cookie satisfied MFA on a new session")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// THE OWNER'S CONSTRAINT: exactly 30 / 90 / 180, enforced on the SERVER.
// ─────────────────────────────────────────────────────────────────────────────

// The database is the last line: even if every Go guard were deleted, a
// 365-day trust record cannot exist.
func TestTrustDaysCheckConstraintRejectsThreeSixtyFive_DB(t *testing.T) {
	f := newTrustFixture(t)
	ctx := context.Background()

	// Through the repo: a clean Go error, not a 23514 surfacing as a 500.
	if _, err := f.repo.CreateTrustedDevice(ctx, TrustedDevice{
		ID: "should-not-exist-" + cliUUID(t), TenantID: f.tenantA, UserID: f.userA,
		TrustDays: 365, ExpiresAt: time.Now().Add(365 * 24 * time.Hour),
	}, []byte("hash")); err == nil {
		t.Fatal("CreateTrustedDevice accepted trust_days = 365")
	}

	// Straight past the Go guard, at the table itself.
	tx, err := db.WithTenant(ctx, f.repo.Pool, f.tenantA)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, days := range []int{0, 1, 29, 31, 179, 181, 365, 3650} {
		_, err := tx.Exec(ctx, `
INSERT INTO auth_trusted_devices (id, tenant_id, user_id, verifier_hash, trust_days, expires_at)
VALUES ($1, $2::uuid, $3::uuid, $4, $5, now() + interval '1 day')`,
			"raw-"+cliUUID(t), f.tenantA, f.userA, []byte("h"), days)
		if err == nil {
			t.Fatalf("the CHECK constraint accepted trust_days = %d", days)
		}
		if !strings.Contains(err.Error(), "auth_trusted_devices_trust_days_allowed") {
			t.Fatalf("trust_days = %d failed for the WRONG reason: %v", days, err)
		}
		// A failed statement poisons the tx; restart for the next probe.
		_ = tx.Rollback(ctx)
		if tx, err = db.WithTenant(ctx, f.repo.Pool, f.tenantA); err != nil {
			t.Fatalf("re-begin: %v", err)
		}
	}
	// And the three approved values must actually be insertable, or the
	// constraint above would be "proved" by a table that rejects everything.
	for _, days := range AllowedTrustDays {
		if _, err := tx.Exec(ctx, `
INSERT INTO auth_trusted_devices (id, tenant_id, user_id, verifier_hash, trust_days, expires_at)
VALUES ($1, $2::uuid, $3::uuid, $4, $5, now() + interval '1 day')`,
			"ok-"+cliUUID(t), f.tenantA, f.userA, []byte("h"), days); err != nil {
			t.Fatalf("the CHECK constraint rejected the APPROVED value %d: %v", days, err)
		}
	}
	_ = tx.Rollback(ctx)
}

// A client posting 365 to the challenge endpoint must be rejected — and must
// not pay for the attempt. The recovery code it sent has to still work
// afterwards, which is the only way to prove the validation really ran BEFORE
// the code was consumed.
func TestTOTPChallengeRejectsUnapprovedTrustDaysWithoutBurningTheCode_DB(t *testing.T) {
	f := newTrustFixture(t)
	ctx := context.Background()

	// Enroll a factor and confirm it, then take a recovery code to spend.
	rec := httptest.NewRecorder()
	f.deps.TOTPEnroll(rec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/totp/enroll", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("TOTPEnroll = %d, body %s", rec.Code, rec.Body.String())
	}
	var enrolled struct {
		RecoveryCodes []string `json:"recovery_codes"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&enrolled); err != nil {
		t.Fatalf("decode enroll: %v", err)
	}
	if len(enrolled.RecoveryCodes) == 0 {
		t.Fatal("enroll returned no recovery codes")
	}
	if err := f.repo.MarkTOTPUsed(ctx, f.tenantA, f.userA); err != nil {
		t.Fatalf("MarkTOTPUsed: %v", err)
	}

	// A real, not-yet-MFA-satisfied session, since the handler refetches it.
	seed := httptest.NewRecorder()
	if err := f.deps.issueSessionWithLifetime(
		seed, httptest.NewRequest(http.MethodPost, "/seed", nil),
		f.tenantA, f.userA, "password", true); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	sessionCookie := ""
	for _, c := range seed.Result().Cookies() {
		if c.Name == SessionCookieName {
			sessionCookie = c.Value
		}
	}
	if sessionCookie == "" {
		t.Fatal("no seed session cookie")
	}

	challenge := func(t *testing.T, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/totp/challenge", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: sessionCookie})
		out := httptest.NewRecorder()
		f.deps.TOTPChallenge(out, req)
		return out
	}
	code := enrolled.RecoveryCodes[0]

	// THE CONSTRAINT, on the wire. 365 is the value the brief names; the
	// others are the realistic ways a client drifts.
	for _, days := range []int{365, 181, 0, -1, 3650, 29, 91} {
		out := challenge(t, `{"recovery_code":"`+code+`","trust_device":true,"trust_days":`+strconv.Itoa(days)+`}`)
		if out.Code != http.StatusBadRequest {
			t.Fatalf("challenge with trust_days=%d = %d, want 400; body %s",
				days, out.Code, out.Body.String())
		}
		var envelope struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(out.Body.Bytes(), &envelope); err != nil {
			t.Fatalf("decode error envelope: %v", err)
		}
		if envelope.Error.Code != "invalid_trust_duration" {
			t.Fatalf("trust_days=%d error code = %q, want invalid_trust_duration", days, envelope.Error.Code)
		}
		for _, c := range out.Result().Cookies() {
			if c.Name == TrustCookieName {
				t.Fatalf("a rejected trust_days=%d still issued a trust cookie", days)
			}
		}
	}

	// The rejected attempts must not have cost the user anything: the SAME
	// recovery code still satisfies the challenge.
	out := challenge(t, `{"recovery_code":"`+code+`","trust_device":true,"trust_days":180}`)
	if out.Code != http.StatusOK {
		t.Fatalf("valid challenge after rejected attempts = %d, body %s", out.Code, out.Body.String())
	}
	var okBody map[string]any
	if err := json.Unmarshal(out.Body.Bytes(), &okBody); err != nil {
		t.Fatalf("decode success body: %v", err)
	}
	if okBody["device_trusted"] != true {
		t.Fatalf("device_trusted = %v, want true; body %s", okBody["device_trusted"], out.Body.String())
	}
	if okBody["trust_days"] != float64(180) {
		t.Fatalf("trust_days echoed = %v, want 180", okBody["trust_days"])
	}
	var issued *http.Cookie
	for _, c := range out.Result().Cookies() {
		if c.Name == TrustCookieName {
			issued = c
		}
	}
	if issued == nil {
		t.Fatal("a successful opt-in issued no trust cookie")
	}
	if !issued.HttpOnly {
		t.Fatal("the trust cookie is not HttpOnly")
	}
	if issued.MaxAge != 180*24*60*60 {
		t.Fatalf("trust cookie MaxAge = %d, want %d", issued.MaxAge, 180*24*60*60)
	}
	// And the stored record carries the approved duration and an absolute
	// expiry inside the ceiling.
	idx := strings.Index(issued.Value, ".")
	if idx <= 0 {
		t.Fatalf("malformed trust cookie %q", issued.Value)
	}
	expiresAt, _, _ := f.rowState(t, f.tenantA, issued.Value[:idx])
	if expiresAt.After(time.Now().Add(time.Duration(MaxTrustDays)*24*time.Hour + time.Minute)) {
		t.Fatalf("stored expiry %s exceeds the %d-day ceiling", expiresAt, MaxTrustDays)
	}
}

// Trust must never be issued without the opt-in flag, and never when the
// workspace has switched the feature off.
func TestTOTPChallengeTrustIsOptInAndPolicyGated_DB(t *testing.T) {
	f := newTrustFixture(t)
	ctx := context.Background()

	rec := httptest.NewRecorder()
	f.deps.TOTPEnroll(rec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/totp/enroll", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("TOTPEnroll = %d", rec.Code)
	}
	var enrolled struct {
		RecoveryCodes []string `json:"recovery_codes"`
	}
	_ = json.NewDecoder(rec.Body).Decode(&enrolled)
	if err := f.repo.MarkTOTPUsed(ctx, f.tenantA, f.userA); err != nil {
		t.Fatalf("MarkTOTPUsed: %v", err)
	}

	newSessionCookie := func(t *testing.T) string {
		t.Helper()
		seed := httptest.NewRecorder()
		if err := f.deps.issueSessionWithLifetime(
			seed, httptest.NewRequest(http.MethodPost, "/seed", nil),
			f.tenantA, f.userA, "password", true); err != nil {
			t.Fatalf("seed session: %v", err)
		}
		for _, c := range seed.Result().Cookies() {
			if c.Name == SessionCookieName {
				return c.Value
			}
		}
		t.Fatal("no seed session cookie")
		return ""
	}
	challenge := func(t *testing.T, cookie, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/totp/challenge", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: cookie})
		out := httptest.NewRecorder()
		f.deps.TOTPChallenge(out, req)
		return out
	}

	// OPT-IN: a plain successful challenge issues nothing, even though the
	// server knows a duration it could have defaulted to.
	out := challenge(t, newSessionCookie(t), `{"recovery_code":"`+enrolled.RecoveryCodes[0]+`"}`)
	if out.Code != http.StatusOK {
		t.Fatalf("plain challenge = %d, body %s", out.Code, out.Body.String())
	}
	for _, c := range out.Result().Cookies() {
		if c.Name == TrustCookieName {
			t.Fatal("a challenge WITHOUT trust_device issued a trust cookie")
		}
	}
	var body map[string]any
	_ = json.Unmarshal(out.Body.Bytes(), &body)
	if body["device_trusted"] != false {
		t.Fatalf("device_trusted = %v on a non-opt-in challenge, want false", body["device_trusted"])
	}

	// POLICY OFF: a workspace that disabled the feature refuses issuance with
	// a specific 403, before the code is spent.
	f.setTrustPolicy(t, f.tenantA, false)
	code := enrolled.RecoveryCodes[1]
	out = challenge(t, newSessionCookie(t), `{"recovery_code":"`+code+`","trust_device":true,"trust_days":30}`)
	if out.Code != http.StatusForbidden {
		t.Fatalf("challenge under a disabled policy = %d, body %s", out.Code, out.Body.String())
	}
	var envelope struct {
		Error struct{ Code string } `json:"error"`
	}
	_ = json.Unmarshal(out.Body.Bytes(), &envelope)
	if envelope.Error.Code != "device_trust_disabled" {
		t.Fatalf("error code = %q, want device_trust_disabled", envelope.Error.Code)
	}
	// The code survived, so the user can retry without the box ticked.
	f.setTrustPolicy(t, f.tenantA, true)
	out = challenge(t, newSessionCookie(t), `{"recovery_code":"`+code+`"}`)
	if out.Code != http.StatusOK {
		t.Fatalf("retry with the same recovery code = %d, body %s", out.Code, out.Body.String())
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// VISIBILITY + REVOCATION. A credential the user cannot see or kill is not
// acceptable, so these routes are part of the feature, not a nicety.
// ─────────────────────────────────────────────────────────────────────────────

func TestTrustedDeviceListAndRevokeHandlers_DB(t *testing.T) {
	f := newTrustFixture(t)
	ctx := context.Background()

	live := f.mint(t, f.tenantA, f.userA, 90, time.Now().Add(90*24*time.Hour))
	expired := f.mint(t, f.tenantA, f.userA, 30, time.Now().Add(-time.Hour))
	other := f.mint(t, f.tenantA, f.userA, 180, time.Now().Add(180*24*time.Hour))

	withUser := func(r *http.Request) *http.Request {
		return r.WithContext(middleware.WithUser(r.Context(),
			&middleware.User{ID: f.userA, TenantID: f.tenantA, Email: f.emailA, Role: "owner"}))
	}
	list := func(t *testing.T, trustCookie string) trustedDevicesResponse {
		t.Helper()
		req := withUser(httptest.NewRequest(http.MethodGet, "/api/v1/auth/trusted-devices", nil))
		if trustCookie != "" {
			req.AddCookie(&http.Cookie{Name: TrustCookieName, Value: trustCookie})
		}
		out := httptest.NewRecorder()
		f.deps.ListTrustedDevices(out, req)
		if out.Code != http.StatusOK {
			t.Fatalf("list = %d, body %s", out.Code, out.Body.String())
		}
		var resp trustedDevicesResponse
		if err := json.Unmarshal(out.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode list: %v", err)
		}
		return resp
	}

	resp := list(t, live.String())
	if len(resp.TrustedDevices) != 2 {
		t.Fatalf("list returned %d devices, want 2 (the expired one must be hidden)", len(resp.TrustedDevices))
	}
	// The policy travels with the list so no client hard-codes the durations.
	if len(resp.AllowedDurations) != 3 || resp.AllowedDurations[0] != 30 ||
		resp.AllowedDurations[1] != 90 || resp.AllowedDurations[2] != 180 {
		t.Fatalf("allowed_durations = %v, want [30 90 180]", resp.AllowedDurations)
	}
	if resp.MaxDays != 180 || resp.DefaultDays != 30 || !resp.Allowed {
		t.Fatalf("policy fields = max %d default %d allowed %v", resp.MaxDays, resp.DefaultDays, resp.Allowed)
	}
	seenCurrent := 0
	for _, d := range resp.TrustedDevices {
		if d.ID == expired.ID {
			t.Fatal("an EXPIRED record appeared in the visible list")
		}
		if d.Current {
			seenCurrent++
			if d.ID != live.ID {
				t.Fatalf("current flag on %s, want %s", d.ID, live.ID)
			}
		}
		// ABSENCE IS NOT ZERO: an unused record omits last_used_at entirely.
		if d.LastUsedAt != nil && d.LastUsedAt.IsZero() {
			t.Fatalf("device %s reported a zero last_used_at instead of omitting it", d.ID)
		}
	}
	if seenCurrent != 1 {
		t.Fatalf("current-device flag set on %d rows, want 1", seenCurrent)
	}

	// Revoking one: 404 for an id that is not the caller's, 200 + cookie clear
	// for the caller's own device.
	revoke := func(t *testing.T, id, trustCookie string) *httptest.ResponseRecorder {
		t.Helper()
		req := withUser(httptest.NewRequest(http.MethodDelete, "/api/v1/auth/trusted-devices/"+id, nil))
		req = withChiURLParam(req, "id", id)
		if trustCookie != "" {
			req.AddCookie(&http.Cookie{Name: TrustCookieName, Value: trustCookie})
		}
		out := httptest.NewRecorder()
		f.deps.RevokeTrustedDevice(out, req)
		return out
	}
	if got := revoke(t, "not-a-real-id", ""); got.Code != http.StatusNotFound {
		t.Fatalf("revoking an unknown id = %d, want 404", got.Code)
	}
	// A record belonging to tenant B must be indistinguishable from absent.
	bTok := f.mint(t, f.tenantB, f.userB, 30, time.Now().Add(30*24*time.Hour))
	if got := revoke(t, bTok.ID, ""); got.Code != http.StatusNotFound {
		t.Fatalf("revoking another tenant's device = %d, want 404", got.Code)
	}
	if ok, _ := f.repo.ConsumeTrustedDevice(ctx, f.tenantB, f.userB, bTok.ID, bTok.Verifier); !ok {
		t.Fatal("the cross-tenant 404 actually revoked the other tenant's record")
	}

	got := revoke(t, live.ID, live.String())
	if got.Code != http.StatusOK {
		t.Fatalf("revoking own device = %d, body %s", got.Code, got.Body.String())
	}
	cleared := false
	for _, c := range got.Result().Cookies() {
		if c.Name == TrustCookieName && c.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Fatal("revoking THIS device's own trust did not clear its cookie")
	}
	if ok, _ := f.repo.ConsumeTrustedDevice(ctx, f.tenantA, f.userA, live.ID, live.Verifier); ok {
		t.Fatal("a revoked record still satisfied MFA")
	}

	// Revoke-all is the panic button: everything, plus the cookie.
	allReq := withUser(httptest.NewRequest(http.MethodPost, "/api/v1/auth/trusted-devices/revoke-all", nil))
	allOut := httptest.NewRecorder()
	f.deps.RevokeAllTrustedDevices(allOut, allReq)
	if allOut.Code != http.StatusOK {
		t.Fatalf("revoke-all = %d, body %s", allOut.Code, allOut.Body.String())
	}
	var allBody map[string]any
	_ = json.Unmarshal(allOut.Body.Bytes(), &allBody)
	// live was already revoked; `other` and the expired row remain unrevoked.
	if allBody["revoked_count"] != float64(2) {
		t.Fatalf("revoked_count = %v, want 2", allBody["revoked_count"])
	}
	if ok, _ := f.repo.ConsumeTrustedDevice(ctx, f.tenantA, f.userA, other.ID, other.Verifier); ok {
		t.Fatal("revoke-all left a record able to satisfy MFA")
	}
	if after := list(t, ""); len(after.TrustedDevices) != 0 {
		t.Fatalf("list after revoke-all returned %d devices, want 0", len(after.TrustedDevices))
	}
	// Tenant B is untouched by A's panic button.
	if ok, _ := f.repo.ConsumeTrustedDevice(ctx, f.tenantB, f.userB, bTok.ID, bTok.Verifier); !ok {
		t.Fatal("tenant A's revoke-all killed tenant B's trust record")
	}
}

// A PASSWORD RESET must end every way back in, not just the sessions.
//
// The reset is the "I may be compromised" verb. If it revoked sessions but
// left device trust alive, the standard compromise response would quietly
// leave an MFA bypass running on the exact machine the user was worried
// about — and whoever ends up with the new password and that device would
// skip the second factor entirely.
func TestPasswordResetRevokesTrustedDevices_DB(t *testing.T) {
	f := newTrustFixture(t)
	ctx := context.Background()

	tok := f.mint(t, f.tenantA, f.userA, 180, time.Now().Add(180*24*time.Hour))
	other := f.mint(t, f.tenantB, f.userB, 30, time.Now().Add(30*24*time.Hour))
	if ok, err := f.repo.ConsumeTrustedDevice(ctx, f.tenantA, f.userA, tok.ID, tok.Verifier); err != nil || !ok {
		t.Fatalf("pre-reset consume = (%v, %v), want (true, nil)", ok, err)
	}

	plain, err := f.repo.IssueToken(ctx, f.tenantA, f.userA, "password_reset", time.Hour)
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	newPHC, err := Hash("An3ntirely-Different!passphrase", Recommended)
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	if err := f.repo.ResetPassword(ctx, plain, newPHC); err != nil {
		t.Fatalf("ResetPassword: %v", err)
	}

	if ok, err := f.repo.ConsumeTrustedDevice(ctx, f.tenantA, f.userA, tok.ID, tok.Verifier); ok || err != nil {
		t.Fatalf("trust survived a password reset: (%v, %v), want (false, nil)", ok, err)
	}
	live, err := f.repo.ListTrustedDevices(ctx, f.tenantA, f.userA)
	if err != nil || len(live) != 0 {
		t.Fatalf("after reset the user still lists %d trusted devices (err %v)", len(live), err)
	}
	// Scoped: another workspace's records are untouched.
	if ok, err := f.repo.ConsumeTrustedDevice(ctx, f.tenantB, f.userB, other.ID, other.Verifier); err != nil || !ok {
		t.Fatalf("a reset in workspace A revoked workspace B's trust: (%v, %v)", ok, err)
	}
}

// DISABLING THE FACTOR must take its trust records with it.
//
// A trust record exists only because this factor produced a verified code. If
// it outlived the factor, a user who disables and re-enrolls — which is what
// you do when your authenticator is lost or compromised — would find their
// BRAND NEW factor already bypassed on every previously trusted device.
func TestDisablingTOTPRevokesTrustedDevices_DB(t *testing.T) {
	f := newTrustFixture(t)
	ctx := context.Background()

	tok := f.mint(t, f.tenantA, f.userA, 90, time.Now().Add(90*24*time.Hour))
	other := f.mint(t, f.tenantB, f.userB, 30, time.Now().Add(30*24*time.Hour))

	if err := f.repo.DeleteTOTPSecret(ctx, f.tenantA, f.userA); err != nil {
		t.Fatalf("DeleteTOTPSecret: %v", err)
	}
	if ok, err := f.repo.ConsumeTrustedDevice(ctx, f.tenantA, f.userA, tok.ID, tok.Verifier); ok || err != nil {
		t.Fatalf("trust survived disabling the factor: (%v, %v), want (false, nil)", ok, err)
	}
	if ok, err := f.repo.ConsumeTrustedDevice(ctx, f.tenantB, f.userB, other.ID, other.Verifier); err != nil || !ok {
		t.Fatalf("disabling A's factor revoked B's trust: (%v, %v)", ok, err)
	}
}

// RLS + the (tenant, user) predicate must keep one workspace's trust records
// entirely out of another's list.
func TestTrustedDeviceListIsTenantIsolated_DB(t *testing.T) {
	f := newTrustFixture(t)
	ctx := context.Background()
	a := f.mint(t, f.tenantA, f.userA, 30, time.Now().Add(30*24*time.Hour))
	b := f.mint(t, f.tenantB, f.userB, 30, time.Now().Add(30*24*time.Hour))

	aList, err := f.repo.ListTrustedDevices(ctx, f.tenantA, f.userA)
	if err != nil {
		t.Fatalf("list A: %v", err)
	}
	if len(aList) != 1 || aList[0].ID != a.ID {
		t.Fatalf("tenant A list = %+v, want exactly its own record", aList)
	}
	bList, err := f.repo.ListTrustedDevices(ctx, f.tenantB, f.userB)
	if err != nil {
		t.Fatalf("list B: %v", err)
	}
	if len(bList) != 1 || bList[0].ID != b.ID {
		t.Fatalf("tenant B list = %+v, want exactly its own record", bList)
	}
	// Asking tenant A's context for tenant B's user yields nothing, even
	// though the user id is real.
	cross, err := f.repo.ListTrustedDevices(ctx, f.tenantA, f.userB)
	if err != nil {
		t.Fatalf("cross list: %v", err)
	}
	if len(cross) != 0 {
		t.Fatalf("cross-tenant list returned %d records", len(cross))
	}
}

// The per-user cap keeps the visible list readable. Surplus records are
// REVOKED (auditable) rather than deleted, and the newest survives.
func TestTrustedDeviceCapRevokesOldest_DB(t *testing.T) {
	f := newTrustFixture(t)
	ctx := context.Background()

	toks := make([]TrustToken, 0, MaxTrustedDevicesPerUser+3)
	for i := 0; i < MaxTrustedDevicesPerUser+3; i++ {
		toks = append(toks, f.mint(t, f.tenantA, f.userA, 30, time.Now().Add(30*24*time.Hour)))
		// issued_at ordering is what the cap sorts on; give it distinct values.
		time.Sleep(2 * time.Millisecond)
	}
	live, err := f.repo.ListTrustedDevices(ctx, f.tenantA, f.userA)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(live) != MaxTrustedDevicesPerUser {
		t.Fatalf("live trust records = %d, want the cap %d", len(live), MaxTrustedDevicesPerUser)
	}
	// The most recently issued must be among the survivors; the oldest must not.
	newest := toks[len(toks)-1].ID
	oldest := toks[0].ID
	found := map[string]bool{}
	for _, d := range live {
		found[d.ID] = true
	}
	if !found[newest] {
		t.Fatal("the cap revoked the record it had just issued")
	}
	if found[oldest] {
		t.Fatal("the cap did not revoke the oldest record")
	}
	if ok, _ := f.repo.ConsumeTrustedDevice(ctx, f.tenantA, f.userA, oldest, toks[0].Verifier); ok {
		t.Fatal("a capped-out record still satisfied MFA")
	}
}
