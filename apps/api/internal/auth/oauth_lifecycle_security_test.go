// SPDX-License-Identifier: AGPL-3.0-only
package auth

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

type fakeOAuthStateStore struct {
	provider      string
	stateContext  string
	verifier      string
	consumeErr    error
	issuedContext string
	issueCalls    int
	consumeCalls  int
}

func (f *fakeOAuthStateStore) IssueState(_ context.Context, provider, stateContext, verifier string) (string, error) {
	f.issueCalls++
	f.provider = provider
	f.issuedContext = stateContext
	f.verifier = verifier
	return "state-nonce", nil
}

func (f *fakeOAuthStateStore) ConsumeState(context.Context, string) (string, string, string, error) {
	f.consumeCalls++
	return f.provider, f.stateContext, f.verifier, f.consumeErr
}

type fakeOAuthIdentityRepository struct {
	session          *Session
	sessionErr       error
	active           bool
	activeErr        error
	linkedUser       *User
	linkedErr        error
	users            []User
	usersErr         error
	linkErr          error
	lookupIDPCalls   int
	lookupEmailCalls int
	linkCalls        int
	linkedUserID     string
}

func (f *fakeOAuthIdentityRepository) LookupSession(context.Context, string, string) (*Session, error) {
	return f.session, f.sessionErr
}
func (f *fakeOAuthIdentityRepository) IsActiveIdentityLinkSession(context.Context, string, string, string) (bool, error) {
	return f.active, f.activeErr
}
func (f *fakeOAuthIdentityRepository) LookupUserByIdP(context.Context, string, string) (*User, error) {
	f.lookupIDPCalls++
	return f.linkedUser, f.linkedErr
}
func (f *fakeOAuthIdentityRepository) LookupUserByEmail(context.Context, string) ([]User, error) {
	f.lookupEmailCalls++
	return f.users, f.usersErr
}
func (f *fakeOAuthIdentityRepository) LinkIdP(_ context.Context, userID, _, _, _ string, _ []byte) error {
	f.linkCalls++
	f.linkedUserID = userID
	return f.linkErr
}
func (*fakeOAuthIdentityRepository) IssueToken(context.Context, string, string, string, time.Duration) (string, error) {
	return "magic-token", nil
}

func oauthCallbackResponse(
	t *testing.T,
	claimsJSON string,
	stateContext oauthStateContext,
	repo *fakeOAuthIdentityRepository,
) (*httptest.ResponseRecorder, int) {
	t.Helper()
	providerServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"access_token":"provider-access-token","token_type":"Bearer"}`))
		case "/userinfo":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(claimsJSON))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(providerServer.Close)

	encoded, err := encodeOAuthStateContext(stateContext)
	if err != nil {
		t.Fatal(err)
	}
	stateStore := &fakeOAuthStateStore{
		provider:     "google",
		stateContext: encoded,
		verifier:     "pkce-verifier",
	}
	sessionsIssued := 0
	od := &OAuthDeps{
		Deps: &Deps{PublicBaseURL: "https://app.moosewave.com"},
		OAuthConfig: OAuthConfig{
			"google": {
				ClientID:     "client-id",
				ClientSecret: "client-secret",
				RedirectURI:  "https://api.moosewave.com/api/v1/auth/oauth/google/callback",
				TokenURL:     providerServer.URL + "/token",
				UserinfoURL:  providerServer.URL + "/userinfo",
			},
		},
		StateRepo:    stateStore,
		IdentityRepo: repo,
		HTTPClient:   providerServer.Client(),
		SessionIssuer: func(http.ResponseWriter, *http.Request, string, string, string) error {
			sessionsIssued++
			return nil
		},
	}
	router := chi.NewRouter()
	router.Get("/api/v1/auth/oauth/{provider}/callback", od.Callback)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/auth/oauth/google/callback?code=provider-code&state=state-nonce", nil)
	router.ServeHTTP(rec, req)
	return rec, sessionsIssued
}

func TestOAuthCallbackRejectsMissingOrFalseEmailVerifiedClaim(t *testing.T) {
	for _, claims := range []string{
		`{"sub":"provider-user","email":"person@example.com"}`,
		`{"sub":"provider-user","email":"person@example.com","email_verified":false}`,
	} {
		repo := &fakeOAuthIdentityRepository{linkedErr: ErrNotFound}
		rec, sessions := oauthCallbackResponse(t, claims, oauthStateContext{RedirectTo: "/app"}, repo)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403; body=%s", rec.Code, rec.Body.String())
		}
		if code := readErrCode(t, rec.Body); code != "unverified_email" {
			t.Fatalf("error code = %q, want unverified_email", code)
		}
		if repo.lookupIDPCalls != 0 || repo.linkCalls != 0 || sessions != 0 {
			t.Fatalf("unverified claims reached identity persistence: idp=%d links=%d sessions=%d",
				repo.lookupIDPCalls, repo.linkCalls, sessions)
		}
	}
}

func TestOAuthCallbackNeverAutoLinksByMatchingEmail(t *testing.T) {
	repo := &fakeOAuthIdentityRepository{
		linkedErr: ErrNotFound,
		users: []User{{
			ID: "local-user", TenantID: "local-tenant", Email: "person@example.com",
		}},
	}
	rec, sessions := oauthCallbackResponse(t,
		`{"sub":"provider-user","email":"person@example.com","email_verified":true}`,
		oauthStateContext{RedirectTo: "/app"}, repo)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if code := readErrCode(t, rec.Body); code != "identity_link_required" {
		t.Fatalf("error code = %q, want identity_link_required", code)
	}
	if repo.linkCalls != 0 || sessions != 0 {
		t.Fatalf("matching email silently linked identity: links=%d sessions=%d", repo.linkCalls, sessions)
	}
}

func TestOAuthCallbackLinksOnlyWithActiveSessionBoundConsent(t *testing.T) {
	sessionID := base64.RawURLEncoding.EncodeToString([]byte("session-id"))
	stateContext := oauthStateContext{
		RedirectTo: "/app/settings/security",
		Link: &oauthLinkIntent{
			UserID: "local-user", TenantID: "local-tenant", SessionID: sessionID,
		},
	}
	repo := &fakeOAuthIdentityRepository{
		active:    true,
		linkedErr: ErrNotFound,
		users: []User{{
			ID: "local-user", TenantID: "local-tenant", Email: "person@example.com",
		}},
	}
	rec, sessions := oauthCallbackResponse(t,
		`{"sub":"provider-user","email":"person@example.com","email_verified":true}`,
		stateContext, repo)
	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302; body=%s", rec.Code, rec.Body.String())
	}
	if location := rec.Header().Get("Location"); location != "/app/settings/security" {
		t.Fatalf("Location = %q", location)
	}
	if repo.linkCalls != 1 || repo.linkedUserID != "local-user" || sessions != 1 {
		t.Fatalf("link result: calls=%d user=%q sessions=%d", repo.linkCalls, repo.linkedUserID, sessions)
	}
}

func TestOAuthCallbackRejectsLinkWhenStartingSessionWasRevoked(t *testing.T) {
	sessionID := base64.RawURLEncoding.EncodeToString([]byte("session-id"))
	repo := &fakeOAuthIdentityRepository{
		active:    false,
		linkedErr: ErrNotFound,
	}
	rec, sessions := oauthCallbackResponse(t,
		`{"sub":"provider-user","email":"person@example.com","email_verified":true}`,
		oauthStateContext{
			RedirectTo: "/app/settings/security",
			Link: &oauthLinkIntent{
				UserID: "local-user", TenantID: "local-tenant", SessionID: sessionID,
			},
		}, repo)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
	if code := readErrCode(t, rec.Body); code != "reauthentication_required" {
		t.Fatalf("error code = %q, want reauthentication_required", code)
	}
	if repo.linkCalls != 0 || sessions != 0 {
		t.Fatalf("revoked session linked identity: links=%d sessions=%d", repo.linkCalls, sessions)
	}
}

func TestOAuthCallbackRejectsLinkWhenVerifiedEmailDoesNotMatchSessionUser(t *testing.T) {
	sessionID := base64.RawURLEncoding.EncodeToString([]byte("session-id"))
	repo := &fakeOAuthIdentityRepository{
		active:    true,
		linkedErr: ErrNotFound,
		users: []User{{
			ID: "different-user", TenantID: "local-tenant", Email: "person@example.com",
		}},
	}
	rec, sessions := oauthCallbackResponse(t,
		`{"sub":"provider-user","email":"person@example.com","email_verified":true}`,
		oauthStateContext{
			Link: &oauthLinkIntent{
				UserID: "local-user", TenantID: "local-tenant", SessionID: sessionID,
			},
		}, repo)
	if rec.Code != http.StatusForbidden || readErrCode(t, rec.Body) != "link_email_mismatch" {
		t.Fatalf("status=%d body=%s, want 403 link_email_mismatch", rec.Code, rec.Body.String())
	}
	if repo.linkCalls != 0 || sessions != 0 {
		t.Fatalf("mismatched account linked identity: links=%d sessions=%d", repo.linkCalls, sessions)
	}
}

func TestOAuthCallbackRejectsIdentityAlreadyLinkedToAnotherUser(t *testing.T) {
	sessionID := base64.RawURLEncoding.EncodeToString([]byte("session-id"))
	repo := &fakeOAuthIdentityRepository{
		active:     true,
		linkedUser: &User{ID: "other-user", TenantID: "other-tenant"},
		users: []User{{
			ID: "local-user", TenantID: "local-tenant", Email: "person@example.com",
		}},
	}
	rec, sessions := oauthCallbackResponse(t,
		`{"sub":"provider-user","email":"person@example.com","email_verified":true}`,
		oauthStateContext{
			Link: &oauthLinkIntent{
				UserID: "local-user", TenantID: "local-tenant", SessionID: sessionID,
			},
		}, repo)
	if rec.Code != http.StatusConflict || readErrCode(t, rec.Body) != "identity_already_linked" {
		t.Fatalf("status=%d body=%s, want 409 identity_already_linked", rec.Code, rec.Body.String())
	}
	if repo.linkCalls != 0 || sessions != 0 {
		t.Fatalf("conflicting identity was relinked: links=%d sessions=%d", repo.linkCalls, sessions)
	}
}

func TestOAuthCallbackMapsConcurrentLinkConflictToSafeResponse(t *testing.T) {
	sessionID := base64.RawURLEncoding.EncodeToString([]byte("session-id"))
	repo := &fakeOAuthIdentityRepository{
		active:    true,
		linkedErr: ErrNotFound,
		linkErr:   ErrIdentityAlreadyLinked,
		users: []User{{
			ID: "local-user", TenantID: "local-tenant", Email: "person@example.com",
		}},
	}
	rec, sessions := oauthCallbackResponse(t,
		`{"sub":"provider-user","email":"person@example.com","email_verified":true}`,
		oauthStateContext{
			Link: &oauthLinkIntent{
				UserID: "local-user", TenantID: "local-tenant", SessionID: sessionID,
			},
		}, repo)
	if rec.Code != http.StatusConflict || readErrCode(t, rec.Body) != "identity_already_linked" {
		t.Fatalf("status=%d body=%s, want 409 identity_already_linked", rec.Code, rec.Body.String())
	}
	if repo.linkCalls != 1 || sessions != 0 {
		t.Fatalf("concurrent conflict result: links=%d sessions=%d", repo.linkCalls, sessions)
	}
}

func TestOAuthLinkStartBindsAuthenticatedSessionIntoServerState(t *testing.T) {
	sessionID := base64.RawURLEncoding.EncodeToString([]byte("session-id"))
	verifier := base64.RawURLEncoding.EncodeToString([]byte("session-verifier"))
	repo := &fakeOAuthIdentityRepository{
		session: &Session{ID: sessionID, UserID: "local-user", TenantID: "local-tenant"},
	}
	stateStore := &fakeOAuthStateStore{}
	od := &OAuthDeps{
		Deps: &Deps{},
		OAuthConfig: OAuthConfig{
			"google": {ClientID: "client-id", AuthURL: "https://accounts.example/authorize"},
		},
		StateRepo:    stateStore,
		IdentityRepo: repo,
	}
	router := chi.NewRouter()
	router.Get("/api/v1/auth/oauth/{provider}/start", od.Start)
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/auth/oauth/google/start?link=true&redirect_to="+url.QueryEscape("/app/settings/security"), nil)
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: sessionID + "." + verifier})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302; body=%s", rec.Code, rec.Body.String())
	}
	if stateStore.issueCalls != 1 {
		t.Fatalf("state issue calls = %d, want 1", stateStore.issueCalls)
	}
	decoded, err := decodeOAuthStateContext(stateStore.issuedContext)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Link == nil || decoded.Link.UserID != "local-user" ||
		decoded.Link.TenantID != "local-tenant" || decoded.Link.SessionID != sessionID {
		t.Fatalf("link intent = %+v", decoded.Link)
	}
	if decoded.RedirectTo != "/app/settings/security" {
		t.Fatalf("redirect = %q", decoded.RedirectTo)
	}
}

func TestOAuthLinkStartRequiresAuthenticatedSessionBeforeIssuingState(t *testing.T) {
	stateStore := &fakeOAuthStateStore{}
	od := &OAuthDeps{
		Deps: &Deps{},
		OAuthConfig: OAuthConfig{
			"google": {ClientID: "client-id", AuthURL: "https://accounts.example/authorize"},
		},
		StateRepo:    stateStore,
		IdentityRepo: &fakeOAuthIdentityRepository{},
	}
	router := chi.NewRouter()
	router.Get("/api/v1/auth/oauth/{provider}/start", od.Start)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
		"/api/v1/auth/oauth/google/start?link=true", nil))
	if rec.Code != http.StatusUnauthorized || readErrCode(t, rec.Body) != "reauthentication_required" {
		t.Fatalf("status=%d body=%s, want 401 reauthentication_required", rec.Code, rec.Body.String())
	}
	if stateStore.issueCalls != 0 {
		t.Fatalf("unauthenticated link attempt issued OAuth state %d times", stateStore.issueCalls)
	}
}

func TestOAuthStateContextRoundTripAndLegacyCompatibility(t *testing.T) {
	sessionID := base64.RawURLEncoding.EncodeToString([]byte("session-id"))
	want := oauthStateContext{
		RedirectTo: "/app",
		Link: &oauthLinkIntent{
			UserID: "user", TenantID: "tenant", SessionID: sessionID,
		},
	}
	encoded, err := encodeOAuthStateContext(want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := decodeOAuthStateContext(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if got.RedirectTo != want.RedirectTo || got.Link == nil || *got.Link != *want.Link {
		t.Fatalf("round trip = %+v, want %+v", got, want)
	}
	legacy, err := decodeOAuthStateContext("/app/campaigns")
	if err != nil || legacy.RedirectTo != "/app/campaigns" || legacy.Link != nil {
		t.Fatalf("legacy state = %+v err=%v", legacy, err)
	}
}

func TestMicrosoftOAuthCannotStartOrCallbackEvenIfMisconfigured(t *testing.T) {
	stateStore := &fakeOAuthStateStore{}
	od := &OAuthDeps{
		Deps: &Deps{},
		OAuthConfig: OAuthConfig{
			"microsoft": {
				ClientID:    "must-not-be-used",
				AuthURL:     "https://login.microsoftonline.com/authorize",
				TokenURL:    "https://login.microsoftonline.com/token",
				UserinfoURL: "https://graph.microsoft.com/oidc/userinfo",
			},
		},
		StateRepo: stateStore,
	}
	router := chi.NewRouter()
	router.Get("/api/v1/auth/oauth/{provider}/start", od.Start)
	router.Get("/api/v1/auth/oauth/{provider}/callback", od.Callback)

	for _, path := range []string{
		"/api/v1/auth/oauth/microsoft/start?redirect_to=%2Fapp",
		"/api/v1/auth/oauth/microsoft/callback?code=code&state=state",
	} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want 404; body=%s", path, rec.Code, rec.Body.String())
		}
		if code := readErrCode(t, rec.Body); code != "provider_disabled" {
			t.Fatalf("%s error code = %q, want provider_disabled", path, code)
		}
	}
	if stateStore.issueCalls != 0 || stateStore.consumeCalls != 0 {
		t.Fatalf("disabled Microsoft flow touched OAuth state: issue=%d consume=%d",
			stateStore.issueCalls, stateStore.consumeCalls)
	}
}
