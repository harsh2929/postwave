// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLogoutDoesNotClaimSuccessWhenRevocationIsUnavailable(t *testing.T) {
	t.Parallel()
	token, err := IssueSessionToken()
	if err != nil {
		t.Fatalf("issue session token: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: token.String()})
	rec := httptest.NewRecorder()

	(&Deps{CookieOptions: DefaultCookieOptions()}).Logout(rec, req)

	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "logout_retry") {
		t.Fatalf("unavailable logout = %d %s", rec.Code, rec.Body.String())
	}
	for _, cookie := range rec.Result().Cookies() {
		if cookie.Name == SessionCookieName && cookie.MaxAge < 0 {
			t.Fatal("failed revocation still cleared the client cookie")
		}
	}
}

func TestLogoutWithoutAUsableSessionRemainsIdempotent(t *testing.T) {
	t.Parallel()
	for _, cookieValue := range []string{"", "malformed"} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
		if cookieValue != "" {
			req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: cookieValue})
		}
		rec := httptest.NewRecorder()
		(&Deps{CookieOptions: DefaultCookieOptions()}).Logout(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("cookie %q logout = %d %s", cookieValue, rec.Code, rec.Body.String())
		}
	}
}
