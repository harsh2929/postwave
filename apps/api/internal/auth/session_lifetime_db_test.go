// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestLoginRememberControlsSessionCookieLifetime proves AUTH-024: a login with
// remember=true persists a 30-day cookie, while remember=false issues a
// browser-session cookie (Max-Age 0) so the session ends when the browser does.
func TestLoginRememberControlsSessionCookieLifetime(t *testing.T) {
	pool := cliAuthDB(t)
	repo := &Repo{Pool: pool, Pepper: make([]byte, 32)}
	unique := cliUUID(t)
	slug := "remember-" + unique[:8]
	email := "remember-" + unique[:8] + "@example.test"
	password := "Sup3rSecret!passphrase"

	phc, err := Hash(password, Recommended)
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	ctx := context.Background()
	tenantID, _, err := repo.CreateTenantWithOwner(ctx, "Remember test", slug, email, phc)
	if err != nil {
		t.Fatalf("CreateTenantWithOwner: %v", err)
	}
	// deleteAuthTestTenant: a one-minute budget and a retry on transient lock
	// contention. The five seconds this cleanup had were too few for a tenant
	// cascade (about 735 foreign keys) while other packages delete tenants too.
	t.Cleanup(func() { deleteAuthTestTenant(t, pool, tenantID) })

	d := &Deps{Repo: repo, CookieOptions: DefaultCookieOptions()}
	sessionCookie := func(rec *httptest.ResponseRecorder) *http.Cookie {
		for _, c := range rec.Result().Cookies() {
			if c.Name == SessionCookieName {
				return c
			}
		}
		return nil
	}

	// remember=true → persistent cookie.
	recPersist := postJSON(t, d.Login, LoginInput{Email: email, Password: password, Remember: true})
	if recPersist.Code != http.StatusOK {
		t.Fatalf("remember login status=%d body=%s", recPersist.Code, recPersist.Body.String())
	}
	cp := sessionCookie(recPersist)
	if cp == nil || cp.MaxAge <= 0 {
		t.Fatalf("remember=true should set a persistent cookie (Max-Age>0), got %+v", cp)
	}

	// remember=false → browser-session cookie (no Max-Age persistence).
	recSession := postJSON(t, d.Login, LoginInput{Email: email, Password: password, Remember: false})
	if recSession.Code != http.StatusOK {
		t.Fatalf("session login status=%d body=%s", recSession.Code, recSession.Body.String())
	}
	cs := sessionCookie(recSession)
	if cs == nil || cs.MaxAge != 0 {
		t.Fatalf("remember=false should set a browser-session cookie (Max-Age 0), got %+v", cs)
	}
}
