// SPDX-License-Identifier: AGPL-3.0-only
//
// AUTH#6 — POST /api/v1/auth/workspaces/switch against a real database under
// the non-privileged postwave_app role. Every property under test is enforced
// by SQL the handler cannot see around: the `users` rows are read through the
// auth resolver GUC, the session rows are written under RLS, and the
// auth_method vocabulary is a CHECK constraint (migration 1817).

package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type switchFixture struct {
	repo    *Repo
	deps    *Deps
	email   string
	tenantA string
	userA   string
	tenantB string
	userB   string
	// me is mutated by tests to move the "current session" principal.
	me MeContext
}

func newSwitchFixture(t *testing.T) *switchFixture {
	t.Helper()
	pool := cliAuthDB(t)
	repo := &Repo{Pool: pool, Pepper: make([]byte, 32)}
	unique := cliUUID(t)
	email := "wsswitch-" + unique[:8] + "@example.test"
	phc, err := Hash("Sup3rSecret!passphrase", Recommended)
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	ctx := context.Background()

	tenantA, userA, err := repo.CreateTenantWithOwner(ctx, "Switch A", "wsa-"+unique[:8], email, phc)
	if err != nil {
		t.Fatalf("CreateTenantWithOwner A: %v", err)
	}
	tenantB, userB, err := repo.CreateTenantWithOwner(ctx, "Switch B", "wsb-"+unique[:8], email, phc)
	if err != nil {
		t.Fatalf("CreateTenantWithOwner B: %v", err)
	}
	for _, id := range []string{tenantA, tenantB} {
		tenantID := id
		// deleteAuthTestTenant: a one-minute budget and a retry on transient
		// lock contention. The five seconds this cleanup had were too few for
		// a tenant cascade while other packages delete tenants too.
		t.Cleanup(func() { deleteAuthTestTenant(t, pool, tenantID) })
	}

	f := &switchFixture{
		repo: repo, email: email,
		tenantA: tenantA, userA: userA,
		tenantB: tenantB, userB: userB,
	}
	f.me = MeContext{
		TenantID: tenantA, UserID: userA, UserEmail: email,
		UserRole: "owner", EffectiveRole: "owner",
	}
	f.deps = &Deps{
		Repo:          repo,
		CookieOptions: DefaultCookieOptions(),
		PublicBaseURL: "https://app.example.test",
		MeContextLookup: func(*http.Request) (MeContext, bool) {
			return f.me, true
		},
	}
	return f
}

// verifyEmail stamps email_verified_at on a user row, which is what the
// switch requires of the CALLING session.
func (f *switchFixture) verifyEmail(t *testing.T, tenantID, userID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, f.repo.Pool, tenantID)
	if err != nil {
		t.Fatalf("verifyEmail begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE users SET email_verified_at = now() WHERE id = $1::uuid`, userID); err != nil {
		t.Fatalf("verifyEmail update: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("verifyEmail commit: %v", err)
	}
}

func (f *switchFixture) setStatus(t *testing.T, tenantID, userID, status string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, f.repo.Pool, tenantID)
	if err != nil {
		t.Fatalf("setStatus begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE users SET status = $2 WHERE id = $1::uuid`, userID, status); err != nil {
		t.Fatalf("setStatus update: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("setStatus commit: %v", err)
	}
}

// issueSourceSession mints a real session for the current `me` principal and
// returns the cookie value a switch request should carry.
func (f *switchFixture) issueSourceSession(t *testing.T) (id, cookie string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/seed", nil)
	if err := f.deps.issueSessionWithLifetime(
		rec, req, f.me.TenantID, f.me.UserID, "password", true,
	); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == SessionCookieName {
			parts := c.Value
			// id is everything before the first "."
			for i := 0; i < len(parts); i++ {
				if parts[i] == '.' {
					return parts[:i], parts
				}
			}
			t.Fatalf("malformed session cookie %q", parts)
		}
	}
	t.Fatal("no session cookie issued")
	return "", ""
}

func (f *switchFixture) switchTo(t *testing.T, workspaceID, cookie string) *httptest.ResponseRecorder {
	t.Helper()
	body := `{"workspace_id":"` + workspaceID + `","remember":true}`
	req := httptest.NewRequest("POST", "/api/v1/auth/workspaces/switch", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: cookie})
	}
	rec := httptest.NewRecorder()
	f.deps.SwitchWorkspace(rec, req)
	return rec
}

func decodeSwitch(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode switch response: %v", err)
	}
	return out
}

// sessionRow reads the durable facts a switched session must carry.
func (f *switchFixture) sessionRow(t *testing.T, tenantID, id string) (userID, method string, mfa bool, revoked bool) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, f.repo.Pool, tenantID)
	if err != nil {
		t.Fatalf("sessionRow begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var revokedAt *time.Time
	if err := tx.QueryRow(ctx, `
SELECT user_id::text, auth_method, mfa_satisfied, revoked_at
  FROM auth_sessions WHERE id = $1`, id).Scan(&userID, &method, &mfa, &revokedAt); err != nil {
		t.Fatalf("sessionRow query: %v", err)
	}
	_ = tx.Commit(ctx)
	return userID, method, mfa, revokedAt != nil
}

// TestSwitchWorkspaceMovesTheSessionToTheSiblingWorkspace is the happy path:
// a verified session in A becomes a session in B, the old session is revoked,
// and the new one is deliberately not MFA-satisfied.
func TestSwitchWorkspaceMovesTheSessionToTheSiblingWorkspace(t *testing.T) {
	f := newSwitchFixture(t)
	f.verifyEmail(t, f.tenantA, f.userA)
	oldID, cookie := f.issueSourceSession(t)

	rec := f.switchTo(t, f.tenantB, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("switch = %d, body = %s", rec.Code, rec.Body.String())
	}
	out := decodeSwitch(t, rec)
	if out["tenant_id"] != f.tenantB || out["user_id"] != f.userB {
		t.Fatalf("switched into %v/%v, want %s/%s", out["tenant_id"], out["user_id"], f.tenantB, f.userB)
	}
	if out["switched"] != true {
		t.Fatalf("switched = %v, want true", out["switched"])
	}

	// The old session is dead.
	if _, _, _, revoked := f.sessionRow(t, f.tenantA, oldID); !revoked {
		t.Fatal("source session was not revoked by the switch")
	}

	// The new cookie is a real session in B, not MFA-satisfied.
	var newID string
	for _, c := range rec.Result().Cookies() {
		if c.Name == SessionCookieName {
			for i := 0; i < len(c.Value); i++ {
				if c.Value[i] == '.' {
					newID = c.Value[:i]
					break
				}
			}
		}
	}
	if newID == "" {
		t.Fatal("switch issued no session cookie")
	}
	userID, method, mfa, revoked := f.sessionRow(t, f.tenantB, newID)
	if userID != f.userB {
		t.Fatalf("new session user = %s, want %s", userID, f.userB)
	}
	if method != "workspace_switch" {
		t.Fatalf("new session auth_method = %q, want workspace_switch", method)
	}
	if mfa {
		t.Fatal("new session inherited mfa_satisfied; the target tenant must re-challenge")
	}
	if revoked {
		t.Fatal("new session is already revoked")
	}
}

// TestSwitchWorkspaceRefusesAnUnverifiedSourceSession is the takeover guard.
// Signup issues a live session BEFORE the verification email is answered, so
// an attacker who signs up a throwaway workspace using someone else's address
// must not be able to walk into that address's existing workspace.
func TestSwitchWorkspaceRefusesAnUnverifiedSourceSession(t *testing.T) {
	f := newSwitchFixture(t)
	// Deliberately do NOT verify A — this is the fresh-signup state.
	_, cookie := f.issueSourceSession(t)

	rec := f.switchTo(t, f.tenantB, cookie)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("switch = %d, want 403; body = %s", rec.Code, rec.Body.String())
	}
	out := decodeSwitch(t, rec)
	errObj, _ := out["error"].(map[string]any)
	if errObj["code"] != "email_not_verified" {
		t.Fatalf("error code = %v, want email_not_verified", errObj["code"])
	}
}

// TestSwitchWorkspaceRefusesASuspendedMembership: revoking a teammate in
// Settings > Team must not be routed around by a sibling session minted
// before the revocation.
func TestSwitchWorkspaceRefusesASuspendedMembership(t *testing.T) {
	f := newSwitchFixture(t)
	f.verifyEmail(t, f.tenantA, f.userA)
	f.setStatus(t, f.tenantB, f.userB, "suspended")
	oldID, cookie := f.issueSourceSession(t)

	rec := f.switchTo(t, f.tenantB, cookie)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("switch = %d, want 403; body = %s", rec.Code, rec.Body.String())
	}
	out := decodeSwitch(t, rec)
	errObj, _ := out["error"].(map[string]any)
	if errObj["code"] != "workspace_access_revoked" {
		t.Fatalf("error code = %v, want workspace_access_revoked", errObj["code"])
	}
	// A refused switch must leave the caller signed in where they were.
	if _, _, _, revoked := f.sessionRow(t, f.tenantA, oldID); revoked {
		t.Fatal("a refused switch revoked the source session")
	}
}

// TestSwitchWorkspaceRefusesAWorkspaceTheEmailDoesNotBelongTo — and does so
// with the same 404 an unknown workspace gets, so the endpoint is not a
// tenant-existence oracle.
func TestSwitchWorkspaceRefusesAForeignWorkspace(t *testing.T) {
	f := newSwitchFixture(t)
	f.verifyEmail(t, f.tenantA, f.userA)
	oldID, cookie := f.issueSourceSession(t)

	stranger := cliUUID(t)
	rec := f.switchTo(t, stranger, cookie)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("switch = %d, want 404; body = %s", rec.Code, rec.Body.String())
	}
	out := decodeSwitch(t, rec)
	errObj, _ := out["error"].(map[string]any)
	if errObj["code"] != "workspace_not_found" {
		t.Fatalf("error code = %v, want workspace_not_found", errObj["code"])
	}
	if _, _, _, revoked := f.sessionRow(t, f.tenantA, oldID); revoked {
		t.Fatal("a refused switch revoked the source session")
	}
}

// TestSwitchWorkspaceToCurrentWorkspaceIsAFreeNoOp — a client that re-sends
// the workspace it is already in must not be logged out and re-issued.
func TestSwitchWorkspaceToCurrentWorkspaceIsAFreeNoOp(t *testing.T) {
	f := newSwitchFixture(t)
	f.verifyEmail(t, f.tenantA, f.userA)
	oldID, cookie := f.issueSourceSession(t)

	rec := f.switchTo(t, f.tenantA, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("switch = %d, body = %s", rec.Code, rec.Body.String())
	}
	out := decodeSwitch(t, rec)
	if out["switched"] != false {
		t.Fatalf("switched = %v, want false", out["switched"])
	}
	if len(rec.Result().Cookies()) != 0 {
		t.Fatal("a no-op switch rotated the session cookie")
	}
	if _, _, _, revoked := f.sessionRow(t, f.tenantA, oldID); revoked {
		t.Fatal("a no-op switch revoked the source session")
	}
}

// TestSwitchWorkspaceAcceptsAFederatedSourceWithoutALocalVerificationStamp:
// an SSO/magic-link row proves mailbox control even when email_verified_at
// was never stamped locally.
func TestSwitchWorkspaceAcceptsAFederatedSourceWithoutALocalVerificationStamp(t *testing.T) {
	f := newSwitchFixture(t)
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, f.repo.Pool, f.tenantA)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE users SET auth_provider = 'google' WHERE id = $1::uuid`, f.userA); err != nil {
		t.Fatalf("set provider: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	_, cookie := f.issueSourceSession(t)
	rec := f.switchTo(t, f.tenantB, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("switch = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
}
