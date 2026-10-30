// SPDX-License-Identifier: AGPL-3.0-only
package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

type fakeOAuthSignupRepository struct {
	intent      *OAuthSignupIntent
	err         error
	createCalls int
}

func (*fakeOAuthSignupRepository) IssueOAuthSignup(context.Context, idpClaims) (string, error) {
	return strings.Repeat("s", 43), nil
}
func (f *fakeOAuthSignupRepository) GetOAuthSignup(context.Context, string) (*OAuthSignupIntent, error) {
	return f.intent, f.err
}
func (f *fakeOAuthSignupRepository) CreateTenantWithGoogleOwner(context.Context, string, string, string, string) (string, string, error) {
	f.createCalls++
	return "tenant", "user", f.err
}

func TestOAuthSignupHTTPGuards(t *testing.T) {
	for _, tc := range []struct {
		name, provider, cookie, body string
		want                         int
	}{
		{"unsupported provider", "microsoft", strings.Repeat("s", 43), `{}`, 404},
		{"query email is not proof", "google", "", `{"email":"owner@example.test","provider":"google"}`, 401},
		{"missing csrf", "google", strings.Repeat("s", 43), `{"workspace_name":"Test","workspace_slug":"test"}`, 403},
		{"invalid slug", "google", strings.Repeat("s", 43), `{"workspace_name":"Test","workspace_slug":"-test","csrf_token":"` + strings.Repeat("c", 43) + `"}`, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &fakeOAuthSignupRepository{}
			od := &OAuthDeps{Deps: &Deps{}, OAuthConfig: OAuthConfig{"google": {}}, SignupRepo: repo}
			router := chi.NewRouter()
			router.Post("/oauth/{provider}/signup", od.CompleteSignup)
			req := httptest.NewRequest("POST", "/oauth/"+tc.provider+"/signup?email=attacker@example.test", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			if tc.cookie != "" {
				req.AddCookie(&http.Cookie{Name: oauthSignupCookie, Value: tc.cookie})
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != tc.want || repo.createCalls != 0 {
				t.Fatalf("status=%d want=%d creates=%d body=%s", rec.Code, tc.want, repo.createCalls, rec.Body)
			}
		})
	}
}

func TestOAuthSignupMetadataAndSession(t *testing.T) {
	repo := &fakeOAuthSignupRepository{intent: &OAuthSignupIntent{Claims: idpClaims{Email: "verified@example.test"}, CSRFToken: strings.Repeat("c", 43)}}
	sessions := 0
	od := &OAuthDeps{Deps: &Deps{CookieOptions: DefaultCookieOptions()}, OAuthConfig: OAuthConfig{"google": {}}, SignupRepo: repo,
		SessionIssuer: func(_ http.ResponseWriter, _ *http.Request, tenant, user, method string) error {
			if tenant != "tenant" || user != "user" || method != "google" {
				t.Fatal("wrong signup session")
			}
			sessions++
			return nil
		},
	}
	router := chi.NewRouter()
	router.Get("/oauth/{provider}/signup", od.SignupInfo)
	router.Post("/oauth/{provider}/signup", od.CompleteSignup)
	get := httptest.NewRequest("GET", "/oauth/google/signup?email=attacker@example.test", nil)
	get.AddCookie(&http.Cookie{Name: oauthSignupCookie, Value: strings.Repeat("s", 43)})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, get)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "verified@example.test") || strings.Contains(rec.Body.String(), "attacker") || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("unsafe metadata: %d %s", rec.Code, rec.Body)
	}
	post := httptest.NewRequest("POST", "/oauth/google/signup", strings.NewReader(`{"workspace_name":"Test","workspace_slug":"test","csrf_token":"`+strings.Repeat("c", 43)+`"}`))
	post.Header.Set("Content-Type", "application/json")
	post.AddCookie(get.Cookies()[0])
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, post)
	if rec.Code != 201 || sessions != 1 || !strings.Contains(rec.Body.String(), `"email_verified":true`) {
		t.Fatalf("signup %d sessions=%d %s", rec.Code, sessions, rec.Body)
	}
	if cookies := rec.Result().Cookies(); len(cookies) != 1 || cookies[0].MaxAge != -1 {
		t.Fatal("proof cookie not cleared")
	}
}

func TestOAuthBrowserBinding(t *testing.T) {
	req := httptest.NewRequest("GET", "/callback", nil)
	hash := oauthSignupTokenHash("original-browser")
	if oauthBrowserMatches(req, hash) {
		t.Fatal("missing browser cookie accepted")
	}
	req.AddCookie(&http.Cookie{Name: oauthBrowserCookie, Value: "other-browser"})
	if oauthBrowserMatches(req, hash) {
		t.Fatal("different browser cookie accepted")
	}
	req = httptest.NewRequest("GET", "/callback", nil)
	req.AddCookie(&http.Cookie{Name: oauthBrowserCookie, Value: "original-browser"})
	if !oauthBrowserMatches(req, hash) {
		t.Fatal("original browser rejected")
	}
}
