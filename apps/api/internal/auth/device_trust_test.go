// SPDX-License-Identifier: AGPL-3.0-only
package auth

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/routeauth"
)

// AUTHORIZATION IS ENFORCED TWICE, and for these three routes the routeauth
// manifest is the binding half: there is no apikeys.RequireScope wrapper at
// the mount site (identity_api.go), exactly like /auth/sessions, because the
// policy that matters here is "session only" — which a scope wrapper cannot
// express. So the manifest rows ARE the gate, and this test reads them through
// the same resolver the middleware uses rather than trusting the JSON by eye.
//
// What must hold, and why:
//   - session ONLY. No API key may enumerate or revoke somebody else's MFA
//     bypasses; an api-key principal is refused with insufficient_auth_method
//     before the handler runs.
//   - viewer minimum. These are the CALLER'S OWN credentials. A viewer who
//     cannot revoke their own trusted device would be locked out of undoing
//     the one thing on this feature that weakens their account.
//   - the bulk revoke must resolve to its OWN row, not be swallowed by the
//     {id} pattern — a "revoke-all" that matched a DELETE-scoped policy would
//     be authorized by the wrong rule.
func TestTrustedDeviceRoutesAreSessionOnlyInTheManifest(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/auth/trusted-devices"},
		{http.MethodDelete, "/api/v1/auth/trusted-devices/abc123"},
		{http.MethodPost, "/api/v1/auth/trusted-devices/revoke-all"},
	} {
		policy, ok := routeauth.PolicyFor(tc.method, tc.path)
		if !ok {
			t.Fatalf("%s %s has NO routeauth policy — the middleware would 403 it as unclassified",
				tc.method, tc.path)
		}
		if policy.Exposure != routeauth.ExposureAuthenticated {
			t.Fatalf("%s %s exposure = %q, want authenticated", tc.method, tc.path, policy.Exposure)
		}
		if len(policy.AuthMethods) != 1 || policy.AuthMethods[0] != "session" {
			t.Fatalf("%s %s auth_methods = %v, want exactly [session]",
				tc.method, tc.path, policy.AuthMethods)
		}
		if len(policy.APIKeyScopes) != 0 {
			t.Fatalf("%s %s grants API-key scopes %v; an API key must never reach these",
				tc.method, tc.path, policy.APIKeyScopes)
		}
		if policy.SessionMinimumRole != "viewer" {
			t.Fatalf("%s %s session_minimum_role = %q, want viewer — the caller owns these records",
				tc.method, tc.path, policy.SessionMinimumRole)
		}
	}

	// The bulk revoke resolves to its own row and not to the {id} DELETE.
	all, _ := routeauth.PolicyFor(http.MethodPost, "/api/v1/auth/trusted-devices/revoke-all")
	if all.Path != "/api/v1/auth/trusted-devices/revoke-all" {
		t.Fatalf("revoke-all matched %q %s instead of its own row", all.Method, all.Path)
	}
	one, _ := routeauth.PolicyFor(http.MethodDelete, "/api/v1/auth/trusted-devices/abc123")
	if one.Path != "/api/v1/auth/trusted-devices/{id}" {
		t.Fatalf("single revoke matched %q %s", one.Method, one.Path)
	}
}

// The owner approved EXACTLY three durations with 180 as the maximum. This
// test is the executable statement of that decision: widening the set, adding
// a "custom" value, or slipping in a longer option fails here first.
func TestAllowedTrustDaysIsExactlyThirtyNinetyOneEighty(t *testing.T) {
	t.Parallel()
	if len(AllowedTrustDays) != 3 {
		t.Fatalf("AllowedTrustDays = %v, want exactly three values", AllowedTrustDays)
	}
	want := []int{30, 90, 180}
	for i, days := range want {
		if AllowedTrustDays[i] != days {
			t.Fatalf("AllowedTrustDays = %v, want %v", AllowedTrustDays, want)
		}
	}
	if MaxTrustDays != 180 {
		t.Fatalf("MaxTrustDays = %d, want 180", MaxTrustDays)
	}
	// The ceiling constant and the set must agree, or a reader trusting one
	// would be misled by the other.
	max := 0
	for _, days := range AllowedTrustDays {
		if days > max {
			max = days
		}
	}
	if max != MaxTrustDays {
		t.Fatalf("largest allowed duration %d != MaxTrustDays %d", max, MaxTrustDays)
	}
	// The default a client preselects must be the SHORTEST option: the safe
	// default for a feature whose job is to enforce MFA less often.
	if DefaultTrustDays != 30 {
		t.Fatalf("DefaultTrustDays = %d, want the shortest option (30)", DefaultTrustDays)
	}
}

func TestIsAllowedTrustDaysRejectsEverythingElse(t *testing.T) {
	t.Parallel()
	for _, days := range []int{30, 90, 180} {
		if !IsAllowedTrustDays(days) {
			t.Fatalf("IsAllowedTrustDays(%d) = false, want true", days)
		}
	}
	// 365 is the value the brief names explicitly; 0 and negatives are the
	// shapes a malformed or hostile client actually sends; 181 and 179 are the
	// off-by-one attempts to creep past the ceiling.
	for _, days := range []int{0, -1, -180, 1, 29, 31, 89, 91, 179, 181, 365, 3650, 1 << 30} {
		if IsAllowedTrustDays(days) {
			t.Fatalf("IsAllowedTrustDays(%d) = true, want false", days)
		}
	}
}

func TestTrustDurationRefusesUnapprovedDays(t *testing.T) {
	t.Parallel()
	got, ok := TrustDuration(90)
	if !ok || got != 90*24*time.Hour {
		t.Fatalf("TrustDuration(90) = (%v, %v), want (2160h, true)", got, ok)
	}
	if got, ok := TrustDuration(365); ok || got != 0 {
		t.Fatalf("TrustDuration(365) = (%v, %v), want (0, false)", got, ok)
	}
	if got, ok := TrustDuration(0); ok || got != 0 {
		t.Fatalf("TrustDuration(0) = (%v, %v), want (0, false)", got, ok)
	}
}

// The trust credential must not be derivable from the session credential.
// Concretely: the same verifier string must hash to different values under the
// two peppers, so a verifier_hash lifted out of auth_sessions is useless
// against auth_trusted_devices and vice versa.
func TestDeviceTrustPepperIsDisjointFromSessionPepper(t *testing.T) {
	t.Parallel()
	sessionPepper := bytes.Repeat([]byte{0x5a}, 32)
	trustPepper := DeriveTrustPepper(sessionPepper)

	if bytes.Equal(trustPepper, sessionPepper) {
		t.Fatal("derived trust pepper equals the session pepper")
	}
	const verifier = "a-verifier-that-appears-in-both-tables"
	sessionHash := HashVerifier(verifier, sessionPepper)
	trustHash := HashTrustVerifier(verifier, trustPepper)
	if bytes.Equal(sessionHash, trustHash) {
		t.Fatal("session and trust hash spaces collide for the same verifier")
	}
	// Cross-verification must fail in BOTH directions.
	if VerifyTrustVerifier(verifier, sessionHash, trustPepper) {
		t.Fatal("a session verifier_hash validated as a trust verifier_hash")
	}
	if VerifyVerifier(verifier, trustHash, sessionPepper) {
		t.Fatal("a trust verifier_hash validated as a session verifier_hash")
	}
	// And the derivation must be stable + pepper-sensitive.
	if !bytes.Equal(trustPepper, DeriveTrustPepper(sessionPepper)) {
		t.Fatal("DeriveTrustPepper is not deterministic")
	}
	other := DeriveTrustPepper(bytes.Repeat([]byte{0x5b}, 32))
	if bytes.Equal(other, trustPepper) {
		t.Fatal("DeriveTrustPepper ignores its input")
	}
}

// An explicitly configured pepper must win over the derived one, so a
// deployment can rotate the trust credential independently of sessions.
func TestRepoTrustPepperPrefersExplicitConfiguration(t *testing.T) {
	t.Parallel()
	sessionPepper := bytes.Repeat([]byte{0x11}, 32)
	derived := &Repo{Pepper: sessionPepper}
	if !bytes.Equal(derived.trustPepper(), DeriveTrustPepper(sessionPepper)) {
		t.Fatal("unset TrustPepper did not fall back to the derived pepper")
	}
	explicit := bytes.Repeat([]byte{0x22}, 32)
	configured := &Repo{Pepper: sessionPepper, TrustPepper: explicit}
	if !bytes.Equal(configured.trustPepper(), explicit) {
		t.Fatal("configured TrustPepper was ignored")
	}
	if bytes.Equal(configured.trustPepper(), derived.trustPepper()) {
		t.Fatal("configured and derived peppers are identical")
	}
}

// The trust cookie is a SEPARATE credential: a session cookie must never be
// readable as one, and vice versa.
func TestTrustCookieIsNotTheSessionCookie(t *testing.T) {
	t.Parallel()
	if TrustCookieName == SessionCookieName {
		t.Fatal("trust and session cookies share a name")
	}
	tok, err := IssueTrustToken()
	if err != nil {
		t.Fatalf("IssueTrustToken: %v", err)
	}

	// A request carrying ONLY a session cookie has no trust credential.
	sessionOnly := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	sessionOnly.AddCookie(&http.Cookie{Name: SessionCookieName, Value: tok.String()})
	if _, err := ParseTrustCookie(sessionOnly); err != ErrNoTrustCookie {
		t.Fatalf("ParseTrustCookie on a session-only request = %v, want ErrNoTrustCookie", err)
	}

	// A request carrying ONLY a trust cookie has no session.
	trustOnly := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	trustOnly.AddCookie(&http.Cookie{Name: TrustCookieName, Value: tok.String()})
	if _, err := ParseSessionCookie(trustOnly); err != ErrNoSession {
		t.Fatalf("ParseSessionCookie on a trust-only request = %v, want ErrNoSession", err)
	}
	got, err := ParseTrustCookie(trustOnly)
	if err != nil || got.ID != tok.ID || got.Verifier != tok.Verifier {
		t.Fatalf("ParseTrustCookie round trip = (%+v, %v)", got, err)
	}
}

func TestParseTrustCookieRejectsMalformedValues(t *testing.T) {
	t.Parallel()
	for _, value := range []string{"", ".", "abc", "abc.", ".abc", "!!!.abc", "abc.!!!"} {
		r := httptest.NewRequest(http.MethodPost, "/", nil)
		r.AddCookie(&http.Cookie{Name: TrustCookieName, Value: value})
		if _, err := ParseTrustCookie(r); err == nil {
			t.Fatalf("ParseTrustCookie(%q) accepted a malformed value", value)
		}
	}
}

func TestIssueTrustTokenIsUnpredictable(t *testing.T) {
	t.Parallel()
	seen := make(map[string]struct{}, 64)
	for i := 0; i < 64; i++ {
		tok, err := IssueTrustToken()
		if err != nil {
			t.Fatalf("IssueTrustToken: %v", err)
		}
		if len(tok.ID) < 20 || len(tok.Verifier) < 40 {
			t.Fatalf("token halves too short: id %d, verifier %d", len(tok.ID), len(tok.Verifier))
		}
		if _, dup := seen[tok.String()]; dup {
			t.Fatal("IssueTrustToken repeated a value")
		}
		seen[tok.String()] = struct{}{}
	}
}

// The cookie's MaxAge must be the chosen window, so a browser drops it at the
// same moment the server row expires and never presents a stale credential.
func TestSetTrustCookieUsesTheChosenWindow(t *testing.T) {
	t.Parallel()
	rec := httptest.NewRecorder()
	tok := TrustToken{ID: "id", Verifier: "ver"}
	ttl, ok := TrustDuration(180)
	if !ok {
		t.Fatal("TrustDuration(180) rejected an approved duration")
	}
	SetTrustCookie(rec, tok, CookieOptions{Secure: true, SameSite: http.SameSiteLaxMode}, ttl)
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("wrote %d cookies, want 1", len(cookies))
	}
	c := cookies[0]
	if c.Name != TrustCookieName {
		t.Fatalf("cookie name = %q", c.Name)
	}
	if !c.HttpOnly || !c.Secure {
		t.Fatalf("cookie is not HttpOnly+Secure: %+v", c)
	}
	if c.MaxAge != 180*24*60*60 {
		t.Fatalf("cookie MaxAge = %d, want %d", c.MaxAge, 180*24*60*60)
	}

	clear := httptest.NewRecorder()
	ClearTrustCookie(clear, CookieOptions{Secure: true, SameSite: http.SameSiteLaxMode})
	cleared := clear.Result().Cookies()
	if len(cleared) != 1 || cleared[0].MaxAge >= 0 || cleared[0].Value != "" {
		t.Fatalf("ClearTrustCookie wrote %+v", cleared)
	}
}

// consumeDeviceTrust must be inert without a cookie and without a repo — the
// two shapes every non-trusted login takes.
func TestConsumeDeviceTrustIsInertWithoutACredential(t *testing.T) {
	t.Parallel()
	d := &Deps{}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	if d.consumeDeviceTrust(r, "tenant", "user") {
		t.Fatal("consumeDeviceTrust granted trust with no repo and no cookie")
	}
	withCookie := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	withCookie.AddCookie(&http.Cookie{Name: TrustCookieName, Value: "aaaa.bbbb"})
	if d.consumeDeviceTrust(withCookie, "tenant", "user") {
		t.Fatal("consumeDeviceTrust granted trust with no repo")
	}
	// Empty identity must never be treated as a wildcard match.
	if d.consumeDeviceTrust(withCookie, "", "") {
		t.Fatal("consumeDeviceTrust granted trust for an empty identity")
	}
}
