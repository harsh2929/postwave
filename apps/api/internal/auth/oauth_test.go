// SPDX-License-Identifier: AGPL-3.0-only
package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// ---- LoadOAuthConfig env handling --------------------------------------

func TestLoadOAuthConfig_GoogleOnly(t *testing.T) {
	t.Setenv("POSTWAVE_OAUTH_GOOGLE_CLIENT_ID", "g-id")
	t.Setenv("POSTWAVE_OAUTH_GOOGLE_CLIENT_SECRET", "g-secret")
	t.Setenv("POSTWAVE_OAUTH_MICROSOFT_CLIENT_ID", "")
	t.Setenv("POSTWAVE_OAUTH_REDIRECT_BASE", "https://api.moosewave.com/")

	cfg := LoadOAuthConfig()
	g, ok := cfg["google"]
	if !ok {
		t.Fatalf("expected google provider; got %#v", cfg)
	}
	if g.ClientID != "g-id" || g.ClientSecret != "g-secret" {
		t.Errorf("client creds not loaded: %+v", g)
	}
	if g.RedirectURI != "https://api.moosewave.com/api/v1/auth/oauth/google/callback" {
		t.Errorf("redirect URI wrong (note: trailing slash should be trimmed): %q", g.RedirectURI)
	}
	if _, ok := cfg["microsoft"]; ok {
		t.Errorf("microsoft must be absent when client id unset")
	}
}

func TestLoadOAuthConfig_MicrosoftRemainsDisabledEvenWhenEnvSet(t *testing.T) {
	t.Setenv("POSTWAVE_OAUTH_GOOGLE_CLIENT_ID", "g")
	t.Setenv("POSTWAVE_OAUTH_GOOGLE_CLIENT_SECRET", "gs")
	t.Setenv("POSTWAVE_OAUTH_MICROSOFT_CLIENT_ID", "m")
	t.Setenv("POSTWAVE_OAUTH_MICROSOFT_CLIENT_SECRET", "ms")
	t.Setenv("POSTWAVE_OAUTH_REDIRECT_BASE", "http://localhost:8080")

	cfg := LoadOAuthConfig()
	if len(cfg) != 1 {
		t.Errorf("expected only Google, got %d providers", len(cfg))
	}
	if _, enabled := cfg["microsoft"]; enabled {
		t.Fatal("Microsoft OAuth must remain disabled until its ID-token validation contract is implemented")
	}
	if !contains(cfg["google"].Scopes, "openid") {
		t.Errorf("google missing openid: %v", cfg["google"].Scopes)
	}
}

func TestLoadOAuthConfig_NoneSet(t *testing.T) {
	t.Setenv("POSTWAVE_OAUTH_GOOGLE_CLIENT_ID", "")
	t.Setenv("POSTWAVE_OAUTH_MICROSOFT_CLIENT_ID", "ignored-microsoft-id")
	cfg := LoadOAuthConfig()
	if len(cfg) != 0 {
		t.Errorf("expected empty config; got %#v", cfg)
	}
	if cfg == nil {
		t.Errorf("must return non-nil empty map so callers can index without nil check")
	}
}

func TestLoadOAuthConfig_PartialGoogleConfigurationStaysDisabled(t *testing.T) {
	for _, tc := range []struct {
		name, id, secret, base string
	}{
		{name: "missing client secret", id: "google-id", base: "https://api.moosewave.com"},
		{name: "missing client id", secret: "google-secret", base: "https://api.moosewave.com"},
		{name: "missing redirect base", id: "google-id", secret: "google-secret"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("POSTWAVE_OAUTH_GOOGLE_CLIENT_ID", tc.id)
			t.Setenv("POSTWAVE_OAUTH_GOOGLE_CLIENT_SECRET", tc.secret)
			t.Setenv("POSTWAVE_OAUTH_REDIRECT_BASE", tc.base)
			if cfg := LoadOAuthConfig(); len(cfg) != 0 {
				t.Fatalf("partial Google config enabled OAuth: %#v", cfg)
			}
		})
	}
}

// ---- PKCE pair --------------------------------------------------------

func TestGeneratePKCEPair_DeterministicChallenge(t *testing.T) {
	v, c, err := generatePKCEPair()
	if err != nil {
		t.Fatal(err)
	}
	if v == "" || c == "" {
		t.Fatalf("empty pair: v=%q c=%q", v, c)
	}
	// Verifier is base64url(64 random bytes) → 86 chars unpadded.
	if len(v) < 80 {
		t.Errorf("verifier too short: %d", len(v))
	}
	// Challenge must be base64url(sha256(verifier)).
	sum := sha256.Sum256([]byte(v))
	want := base64.RawURLEncoding.EncodeToString(sum[:])
	if c != want {
		t.Errorf("challenge ≠ sha256(verifier):\n got %q\nwant %q", c, want)
	}
	// Two calls produce distinct verifiers.
	v2, c2, _ := generatePKCEPair()
	if v == v2 || c == c2 {
		t.Errorf("PKCE pair not random across calls")
	}
}

func TestGeneratePKCEPair_Base64URLOnly(t *testing.T) {
	// PKCE verifier MUST use the URL-safe alphabet (no '+', '/', '=').
	// RFC 7636 §4.1 — providers reject anything else.
	v, c, err := generatePKCEPair()
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{v, c} {
		if strings.ContainsAny(s, "+/=") {
			t.Errorf("non-URL-safe chars in PKCE field: %q", s)
		}
	}
}

// ---- OAuth state TTL math ---------------------------------------------

func TestOAuthStateTTL_Window(t *testing.T) {
	// 10 minutes is the documented window in the migration. If we
	// shrink it below 5m, users completing provider MFA or account selection
	// start to fail callbacks — bake the floor in.
	if OAuthStateTTL < 5*time.Minute {
		t.Errorf("OAuthStateTTL=%s is below the 5m floor for slow MFA prompts", OAuthStateTTL)
	}
	if OAuthStateTTL > 30*time.Minute {
		t.Errorf("OAuthStateTTL=%s is too long; CSRF window should stay tight", OAuthStateTTL)
	}
}

// ---- parseOAuthError surface -----------------------------------------

func TestParseOAuthError_CodeOnly(t *testing.T) {
	if got := parseOAuthError("access_denied", ""); got != "access_denied" {
		t.Errorf("got %q", got)
	}
}

func TestParseOAuthError_WithDescription(t *testing.T) {
	got := parseOAuthError("invalid_grant", "code already redeemed")
	if got != "invalid_grant: code already redeemed" {
		t.Errorf("got %q", got)
	}
}

func TestParseOAuthError_TruncatesLongDescription(t *testing.T) {
	long := strings.Repeat("x", 500)
	got := parseOAuthError("server_error", long)
	if len(got) > 220 {
		t.Errorf("expected truncation, got len=%d", len(got))
	}
	if !strings.HasPrefix(got, "server_error: ") {
		t.Errorf("missing prefix: %q", got[:30])
	}
}

// ---- redirect sanitisation ----------------------------------------------

func TestSanitizeOAuthRedirect_AllowsRelativeAndDesktopMagic(t *testing.T) {
	cases := map[string]string{
		"/app":                   "/app",
		"/app/campaigns?draft=1": "/app/campaigns?draft=1",
		"moosewave://auth/magic?state=nonce_123&x=evil": "moosewave://auth/magic?state=nonce_123",
	}
	for raw, want := range cases {
		if got := sanitizeOAuthRedirect(raw); got != want {
			t.Errorf("sanitizeOAuthRedirect(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestSanitizeOAuthRedirect_RejectsOpenRedirects(t *testing.T) {
	for _, raw := range []string{
		"https://evil.example/cb",
		"//evil.example/cb",
		"moosewave://settings",
		"moosewave://auth/magic",
		"moosewave://auth/magic?x=evil",
		"moosewave://auth/reset",
		"moosewave://auth/magic?state=one&state=two",
		"moosewave://auth/magic?state=%0a",
		"file:///tmp/payload",
		"javascript:alert(1)",
		"/app\nLocation: https://evil.example",
		"/app%0d%0aLocation:https://evil.example",
		"/app#fragment",
	} {
		if got := sanitizeOAuthRedirect(raw); got != "" {
			t.Errorf("sanitizeOAuthRedirect(%q) = %q, want empty", raw, got)
		}
	}
}

func TestOAuthBounceBackDesktopAddsSignedV1Proof(t *testing.T) {
	deps := &Deps{AuthLinkSigningKey: []byte("0123456789abcdef0123456789abcdef")}
	od := &OAuthDeps{
		Deps:         deps,
		IdentityRepo: &fakeOAuthIdentityRepository{},
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/callback", nil)
	od.bounceBack(
		rec,
		req,
		"moosewave://auth/magic?state=desktop_nonce_123456",
		"tenant-id",
		"user-id",
	)

	if rec.Code != http.StatusFound {
		t.Fatalf("status=%d body=%s, want 302", rec.Code, rec.Body.String())
	}
	loc, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	q := loc.Query()
	if loc.Scheme != "moosewave" || loc.Host != "auth" || loc.Path != "/magic" ||
		q.Get("v") != "1" || q.Get("flow") != authLinkFlowMagic ||
		q.Get("aud") != authLinkAudienceMobile || q.Get("state") != "desktop_nonce_123456" ||
		q.Get("token") != "magic-token" || q.Get("sig") == "" {
		t.Fatalf("desktop redirect missing signed proof: %s", loc.String())
	}
	if err := deps.verifyAuthLinkProof(q.Get("token"), authLinkFlowMagic, AuthLinkProofFields{
		LinkVersion:   authLinkVersion,
		LinkFlow:      q.Get("flow"),
		LinkAudience:  q.Get("aud"),
		State:         q.Get("state"),
		LinkSignature: q.Get("sig"),
	}); err != nil {
		t.Fatalf("redirect proof did not verify: %v", err)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control=%q, want no-store", got)
	}
}

func TestSafeOAuthWebRedirect(t *testing.T) {
	cases := map[string]string{
		"https://app.moosewave.com/base?token=x#frag": "https://app.moosewave.com/base",
		"http://localhost:3000/app":                   "http://localhost:3000/app",
		"/app/settings":                               "/app/settings",
	}
	for raw, want := range cases {
		if got := safeOAuthWebRedirect(raw, "/"); got != want {
			t.Fatalf("safeOAuthWebRedirect(%q) = %q, want %q", raw, got, want)
		}
	}
	for _, raw := range []string{
		"http://app.moosewave.com",
		"https://user:pass@app.moosewave.com",
		"https://app.moosewave.com/%0aLocation:https://evil.example",
		"javascript:alert(1)",
	} {
		if got := safeOAuthWebRedirect(raw, "/"); got != "/" {
			t.Fatalf("safeOAuthWebRedirect(%q) = %q, want fallback", raw, got)
		}
	}
}

func TestBuildAuthPublicLink(t *testing.T) {
	got, err := buildAuthPublicLink("https://app.moosewave.com/base/?ignored=1#frag", "/magic-link", "tok value")
	if err != nil {
		t.Fatal(err)
	}
	want := "https://app.moosewave.com/base/magic-link?token=tok+value"
	if got != want {
		t.Fatalf("buildAuthPublicLink = %q, want %q", got, want)
	}

	got, err = buildAuthPublicLink("https://app.moosewave.com", "/magic-link", "tok", map[string]string{"state": "nonce_123"})
	if err != nil {
		t.Fatal(err)
	}
	if want := "https://app.moosewave.com/magic-link?state=nonce_123&token=tok"; got != want {
		t.Fatalf("buildAuthPublicLink with state = %q, want %q", got, want)
	}

	if got, err := buildAuthPublicLink("http://localhost:3000/", "reset-password", "tok"); err != nil || got != "http://localhost:3000/reset-password?token=tok" {
		t.Fatalf("localhost auth link = %q err=%v", got, err)
	}
}

func TestBuildAuthPublicLinkRejectsUnsafeBase(t *testing.T) {
	for _, raw := range []string{
		"",
		"http://app.moosewave.com",
		"https://user:pass@app.moosewave.com",
		"https://app.moosewave.com/%0d%0aLocation:https://evil.example",
		"javascript:alert(1)",
		"/app",
	} {
		if got, err := buildAuthPublicLink(raw, "/magic-link", "tok"); err == nil {
			t.Fatalf("buildAuthPublicLink(%q) = %q, want error", raw, got)
		}
	}
}

// ---- Token exchange against a mocked endpoint ------------------------
//
// These verify exchangeCode + fetchUserinfo across success and the
// two failure shapes (4xx with json error, 200 with bad body) without
// reaching the live providers.

func TestExchangeCode_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		// Standard OAuth 2.0 + PKCE form fields must be present.
		want := map[string]string{
			"grant_type":    "authorization_code",
			"code":          "the-code",
			"redirect_uri":  "https://example.com/cb",
			"client_id":     "id",
			"client_secret": "sec",
			"code_verifier": "the-verifier",
		}
		for k, v := range want {
			if got := r.PostForm.Get(k); got != v {
				t.Errorf("form[%s] = %q, want %q", k, got, v)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "AT",
			"token_type":   "Bearer",
			"expires_in":   3600,
		})
	}))
	defer srv.Close()

	tr, err := exchangeCode(context.Background(), srv.Client(),
		&OAuthProvider{
			ClientID:     "id",
			ClientSecret: "sec",
			RedirectURI:  "https://example.com/cb",
			TokenURL:     srv.URL,
		}, "the-code", "the-verifier")
	if err != nil {
		t.Fatal(err)
	}
	if tr.AccessToken != "AT" {
		t.Errorf("access_token = %q, want AT", tr.AccessToken)
	}
}

func TestExchangeCode_ProviderError(t *testing.T) {
	// Standard RFC 6749 §5.2 error body.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error":             "invalid_grant",
			"error_description": "Code was already redeemed",
		})
	}))
	defer srv.Close()

	_, err := exchangeCode(context.Background(), srv.Client(),
		&OAuthProvider{TokenURL: srv.URL}, "code", "verifier")
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "invalid_grant") {
		t.Errorf("error did not include OAuth code: %v", err)
	}
}

func TestExchangeCode_CapsProviderResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("{", int(oauthProviderMaxResponseBytes)+1)))
	}))
	defer srv.Close()

	_, err := exchangeCode(context.Background(), srv.Client(), &OAuthProvider{TokenURL: srv.URL}, "code", "verifier")
	if err == nil || !strings.Contains(err.Error(), "response body too large") {
		t.Fatalf("exchangeCode err = %v, want response body too large", err)
	}
}

func TestExchangeCode_DecodeErrorDoesNotEchoTokenBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"SECRET_TOKEN",`))
	}))
	defer srv.Close()

	_, err := exchangeCode(context.Background(), srv.Client(), &OAuthProvider{TokenURL: srv.URL}, "code", "verifier")
	if err == nil {
		t.Fatal("expected decode error")
	}
	if strings.Contains(err.Error(), "SECRET_TOKEN") || strings.Contains(err.Error(), "access_token") {
		t.Fatalf("decode error leaked response body: %v", err)
	}
}

func TestFetchUserinfo_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer AT" {
			t.Errorf("Authorization header = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"sub":"123","email":"a@b.com","name":"A B"}`))
	}))
	defer srv.Close()

	c, raw, err := fetchUserinfo(context.Background(), srv.Client(),
		&OAuthProvider{UserinfoURL: srv.URL}, "AT")
	if err != nil {
		t.Fatal(err)
	}
	if c.Sub != "123" || c.Email != "a@b.com" || c.Name != "A B" {
		t.Errorf("unexpected claims: %+v", c)
	}
	if !strings.Contains(string(raw), `"sub":"123"`) {
		t.Errorf("raw JSON not preserved: %s", string(raw))
	}
}

func TestFetchUserinfo_CapsProviderResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("{", int(oauthProviderMaxResponseBytes)+1)))
	}))
	defer srv.Close()

	_, _, err := fetchUserinfo(context.Background(), srv.Client(), &OAuthProvider{UserinfoURL: srv.URL}, "AT")
	if err == nil || !strings.Contains(err.Error(), "response body too large") {
		t.Fatalf("fetchUserinfo err = %v, want response body too large", err)
	}
}

func TestFetchUserinfo_NonJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html>not json</html>"))
	}))
	defer srv.Close()

	_, _, err := fetchUserinfo(context.Background(), srv.Client(),
		&OAuthProvider{UserinfoURL: srv.URL}, "AT")
	if err == nil {
		t.Fatal("expected decode error")
	}
}

func TestFetchUserinfo_HTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"invalid_token"}`))
	}))
	defer srv.Close()

	_, _, err := fetchUserinfo(context.Background(), srv.Client(),
		&OAuthProvider{UserinfoURL: srv.URL}, "AT")
	if err == nil {
		t.Fatal("expected error on 401")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Errorf("error should mention status: %v", err)
	}
	if strings.Contains(err.Error(), "invalid_token") {
		t.Errorf("error should not echo provider body: %v", err)
	}
}

// ---- bounceToSignup carries a cookie capability, never identity claims ----

func TestBounceToSignup_QueryShape(t *testing.T) {
	od := &OAuthDeps{
		Deps:              &Deps{PublicBaseURL: "https://app.moosewave.com"},
		SignupRedirectURL: "",
		SignupRepo:        &fakeOAuthSignupRepository{},
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/cb", nil)
	od.bounceToSignup(w, r, "google", idpClaims{Sub: "X", Email: "new@example.com", Name: "New"})

	res := w.Result()
	if res.StatusCode != http.StatusFound {
		t.Errorf("status = %d, want 302", res.StatusCode)
	}
	loc, err := url.Parse(res.Header.Get("Location"))
	if err != nil {
		t.Fatalf("bad Location: %v", err)
	}
	if loc.Host != "app.moosewave.com" || loc.Path != "/signup" {
		t.Errorf("unexpected destination: %s", loc.String())
	}
	q := loc.Query()
	if q.Get("from") != "oauth" || q.Get("provider") != "google" || q.Has("email") {
		t.Errorf("unexpected signup query params: %s", loc.RawQuery)
	}
	if q.Has("claims") {
		t.Errorf("raw IdP claims must not be placed in browser history: %s", loc.RawQuery)
	}
	if len(res.Cookies()) != 1 || res.Cookies()[0].Name != oauthSignupCookie || !res.Cookies()[0].HttpOnly || res.Cookies()[0].SameSite != http.SameSiteStrictMode {
		t.Fatal("signup must carry an HttpOnly, SameSite=Strict capability cookie")
	}
}

// ---- helpers ---------------------------------------------------------

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}
