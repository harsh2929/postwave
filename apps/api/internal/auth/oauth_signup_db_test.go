// SPDX-License-Identifier: AGPL-3.0-only
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestGoogleSignupDatabaseLifecycle(t *testing.T) {
	pool := cliAuthDB(t)
	repo := &Repo{Pool: pool, Pepper: []byte("google-signup-test-pepper-32-bytes-minimum")}
	ctx := context.Background()
	id := cliUUID(t)[:8]
	claims := idpClaims{Sub: "google-signup-" + id, Email: "google-signup-" + id + "@example.test", EmailVerified: true}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/token" {
			_, _ = w.Write([]byte(`{"access_token":"test-access-token"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(claims)
	}))
	defer provider.Close()
	od := &OAuthDeps{Deps: &Deps{Repo: repo, PublicBaseURL: "https://app.moosewave.com", CookieOptions: DefaultCookieOptions()},
		StateRepo: &OAuthStateRepo{Pool: pool}, HTTPClient: provider.Client(),
		OAuthConfig: OAuthConfig{"google": {ClientID: "test", ClientSecret: "test", AuthURL: provider.URL + "/authorize", TokenURL: provider.URL + "/token", UserinfoURL: provider.URL + "/userinfo", RedirectURI: "https://app.moosewave.com/api/v1/auth/oauth/google/callback"}},
	}
	router := chi.NewRouter()
	router.Get("/api/v1/auth/oauth/{provider}/start", od.Start)
	router.Get("/api/v1/auth/oauth/{provider}/callback", od.Callback)
	router.Get("/api/v1/auth/oauth/{provider}/signup", od.SignupInfo)
	router.Post("/api/v1/auth/oauth/{provider}/signup", od.CompleteSignup)
	roundTrip := func(withBrowser bool) *httptest.ResponseRecorder {
		t.Helper()
		start := httptest.NewRecorder()
		router.ServeHTTP(start, httptest.NewRequest("GET", "/api/v1/auth/oauth/google/start?redirect_to=/app", nil))
		loc, err := url.Parse(start.Header().Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		callback := httptest.NewRequest("GET", "/api/v1/auth/oauth/google/callback?code=test&state="+url.QueryEscape(loc.Query().Get("state")), nil)
		if withBrowser {
			for _, cookie := range start.Result().Cookies() {
				callback.AddCookie(cookie)
			}
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, callback)
		return response
	}
	if response := roundTrip(false); response.Code != 400 {
		t.Fatalf("callback without starting browser accepted: %d", response.Code)
	}
	response := roundTrip(true)
	if response.Code != 302 || !strings.Contains(response.Header().Get("Location"), "/signup?") {
		t.Fatalf("callback: %d %s", response.Code, response.Body)
	}
	var proof *http.Cookie
	for _, c := range response.Result().Cookies() {
		if c.Name == oauthSignupCookie {
			proof = c
		}
	}
	if proof == nil || !proof.HttpOnly || !proof.Secure {
		t.Fatal("no secure signup capability cookie")
	}
	metadata := httptest.NewRequest("GET", "/api/v1/auth/oauth/google/signup?email=forged@example.test", nil)
	metadata.AddCookie(proof)
	info := httptest.NewRecorder()
	router.ServeHTTP(info, metadata)
	var identity struct {
		Email string `json:"email"`
		CSRF  string `json:"csrf_token"`
	}
	if err := json.Unmarshal(info.Body.Bytes(), &identity); err != nil {
		t.Fatal(err)
	}
	if info.Code != 200 || identity.Email != claims.Email || identity.CSRF == "" {
		t.Fatalf("metadata: %d %s", info.Code, info.Body)
	}
	// Wrong CSRF neither creates an account nor burns a valid proof.
	if _, _, err := repo.CreateTenantWithGoogleOwner(ctx, proof.Value, strings.Repeat("x", 43), "Test", "google-"+id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong CSRF accepted: %v", err)
	}
	if _, err := repo.GetOAuthSignup(ctx, proof.Value); err != nil {
		t.Fatalf("wrong CSRF consumed proof: %v", err)
	}
	occupiedSlug := "google-occupied-" + id
	localEmail := "google-local-" + id + "@example.test"
	localTenant, _, err := repo.CreateTenantWithOwner(ctx, "Existing password account", occupiedSlug, localEmail, "test-password-phc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { deleteAuthTestTenant(t, pool, localTenant) })
	if _, _, err := repo.CreateTenantWithGoogleOwner(ctx, proof.Value, identity.CSRF, "Test", occupiedSlug); !isUniqueViolation(err) {
		t.Fatalf("expected slug conflict: %v", err)
	}
	if _, err := repo.GetOAuthSignup(ctx, proof.Value); err != nil {
		t.Fatalf("slug conflict consumed proof: %v", err)
	}
	body := `{"workspace_name":"Google workspace","workspace_slug":"google-` + id + `","csrf_token":"` + identity.CSRF + `"}`
	post := httptest.NewRequest("POST", "/api/v1/auth/oauth/google/signup", strings.NewReader(body))
	post.Header.Set("Content-Type", "application/json")
	post.AddCookie(proof)
	created := httptest.NewRecorder()
	router.ServeHTTP(created, post)
	if created.Code != 201 {
		t.Fatalf("create: %d %s", created.Code, created.Body)
	}
	user, err := repo.LookupUserByIdP(ctx, "google", claims.Sub)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { deleteAuthTestTenant(t, pool, user.TenantID) })
	if user.EmailVerifiedAt == nil || user.AuthProvider != "google" {
		t.Fatalf("owner not Google-verified: %+v", user)
	}
	hasPassword, err := repo.UserHasPassword(ctx, user.TenantID, user.ID)
	if err != nil || hasPassword {
		t.Fatalf("Google signup created a password: %v %v", hasPassword, err)
	}
	links, err := repo.ListIdPLinks(ctx, user.TenantID, user.ID)
	if err != nil || len(links) != 1 || links[0].Provider != "google" {
		t.Fatalf("Google not connected: %+v %v", links, err)
	}
	sessionRequest := httptest.NewRequest("GET", "/", nil)
	for _, c := range created.Result().Cookies() {
		if c.Name == SessionCookieName {
			sessionRequest.AddCookie(c)
		}
	}
	tok, err := ParseSessionCookie(sessionRequest)
	if err != nil {
		t.Fatalf("no signup session: %v", err)
	}
	session, err := repo.LookupSession(ctx, tok.ID, tok.Verifier)
	if err != nil || session.AuthMethod != "google" || session.UserID != user.ID {
		t.Fatalf("invalid Google signup session: %+v %v", session, err)
	}
	// A fresh POST with the same proof must never create a second workspace.
	post = httptest.NewRequest("POST", "/api/v1/auth/oauth/google/signup", strings.NewReader(body))
	post.Header.Set("Content-Type", "application/json")
	post.AddCookie(proof)
	replay := httptest.NewRecorder()
	router.ServeHTTP(replay, post)
	if replay.Code != 401 {
		t.Fatalf("proof replay: %d %s", replay.Code, replay.Body)
	}
	// A later Google login immediately issues a session without signup/settings.
	login := roundTrip(true)
	if login.Code != 302 || login.Header().Get("Location") != "/app" {
		t.Fatalf("repeat Google login: %d %s", login.Code, login.Body)
	}
	gotSession := false
	for _, c := range login.Result().Cookies() {
		if c.Name == SessionCookieName {
			gotSession = true
		}
	}
	if !gotSession {
		t.Fatal("repeat Google login did not issue a session")
	}
	// A pending identity cannot be used to attach Google to an existing account.
	existingProof, err := repo.IssueOAuthSignup(ctx, idpClaims{Sub: "existing-" + id, Email: localEmail, EmailVerified: true})
	if err != nil {
		t.Fatal(err)
	}
	existing, err := repo.GetOAuthSignup(ctx, existingProof)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := repo.CreateTenantWithGoogleOwner(ctx, existingProof, existing.CSRFToken, "Forbidden", "forbidden-"+id); !errors.Is(err, ErrOAuthSignupAccountExists) {
		t.Fatalf("existing password account accepted: %v", err)
	}
	if _, err := repo.LookupUserByIdP(ctx, "google", "existing-"+id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("silently linked existing account: %v", err)
	}
	_, err = pool.Exec(ctx, `UPDATE auth_oauth_state SET expires_at = now() - interval '1 second' WHERE state = $1`, oauthSignupTokenHash(existingProof))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.GetOAuthSignup(ctx, existingProof); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired proof readable: %v", err)
	}
	if _, _, err := repo.CreateTenantWithGoogleOwner(ctx, existingProof, existing.CSRFToken, "Expired", "expired-"+id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired proof accepted: %v", err)
	}
	_, _ = pool.Exec(ctx, `DELETE FROM auth_oauth_state WHERE state = $1`, oauthSignupTokenHash(existingProof))
}

func TestGoogleSignupConcurrentCompletions(t *testing.T) {
	pool := cliAuthDB(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	id := cliUUID(t)[:8]
	claims := idpClaims{Sub: "race-" + id, Email: "race-" + id + "@example.test", EmailVerified: true}
	var proofs [2]string
	var intents [2]*OAuthSignupIntent
	for i := range proofs {
		var err error
		proofs[i], err = repo.IssueOAuthSignup(ctx, claims)
		if err != nil {
			t.Fatal(err)
		}
		intents[i], err = repo.GetOAuthSignup(ctx, proofs[i])
		if err != nil {
			t.Fatal(err)
		}
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	var tenants [2]string
	var errs [2]error
	for i := range proofs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			tenants[i], _, errs[i] = repo.CreateTenantWithGoogleOwner(ctx, proofs[i], intents[i].CSRFToken, "Race", "race-"+id+string(rune('a'+i)))
		}(i)
	}
	close(start)
	wg.Wait()
	successes := 0
	for i, err := range errs {
		if err == nil {
			successes++
			tenant := tenants[i]
			t.Cleanup(func() { deleteAuthTestTenant(t, pool, tenant) })
		} else if !errors.Is(err, ErrOAuthSignupAccountExists) {
			t.Fatalf("unexpected race failure: %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("created %d workspaces for one Google identity", successes)
	}
	for _, token := range proofs {
		_, _ = pool.Exec(ctx, `DELETE FROM auth_oauth_state WHERE state = $1`, oauthSignupTokenHash(token))
	}
}
