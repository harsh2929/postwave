package auth

import (
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"testing"
)

// WHY THIS FILE EXISTS.
//
// A mobile sign-in was reported broken for over a year and recorded as a
// "getMe needs a tenant slug, login returns a UUID" defect. It was neither.
// The server accepted the password and issued a session cookie carrying the
// Secure attribute; the client discarded it; the NEXT request arrived with no
// session and returned 401; the app rendered that 401 as "Email or password is
// incorrect." Every layer behaved as written and the composite was a lie.
//
// The reason it survived so long is the asymmetry this file pins. http on
// LOOPBACK is a "potentially trustworthy" origin, so a Secure cookie round
// trips there — which is exactly how every web developer runs the stack, so
// nobody saw it. A phone or simulator must use a routable address
// (EXPO_PUBLIC_API_URL=http://172.20.10.2:8080), gets no exemption, and
// silently drops the cookie.
//
// cookiejar implements RFC 6265 the same way CFNetwork and the browsers do,
// so it is a faithful stand-in for the client half.

func jarAfterLogin(t *testing.T, origin string, secure bool) int {
	t.Helper()
	u, err := url.Parse(origin)
	if err != nil {
		t.Fatalf("bad origin %q: %v", origin, err)
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	// Issue through the REAL writer, so a change to SetSessionCookie's
	// attributes is caught here rather than by a hand-rolled copy of it.
	rec := httptest.NewRecorder()
	SetSessionCookie(rec, SessionToken{ID: "aWQ", Verifier: "dmVy"}, CookieOptions{
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
	jar.SetCookies(u, rec.Result().Cookies())
	return len(jar.Cookies(u))
}

func TestSecureSessionCookieIsDroppedOffLoopback(t *testing.T) {
	// The defect, reproduced: a routable dev host loses the session.
	for _, origin := range []string{
		"http://172.20.10.2:8080",  // iOS personal hotspot, the observed case
		"http://192.168.1.42:8080", // ordinary LAN
		"http://10.0.2.2:8080",     // Android emulator's host alias
	} {
		if got := jarAfterLogin(t, origin, true); got != 0 {
			t.Fatalf("%s: expected a Secure cookie to be dropped over plaintext, kept %d", origin, got)
		}
		// ...and the fix restores it.
		if got := jarAfterLogin(t, origin, false); got != 1 {
			t.Fatalf("%s: POSTWAVE_SESSION_COOKIE_INSECURE must restore the session, got %d", origin, got)
		}
	}
}

func TestLoopbackHidesTheDefect(t *testing.T) {
	// Not incidental — this is the reason it went unnoticed. If this ever
	// starts failing, the defect became visible to web dev too, and the
	// explanation above needs rewriting rather than the code.
	for _, origin := range []string{"http://localhost:8080", "http://127.0.0.1:8080"} {
		if got := jarAfterLogin(t, origin, true); got != 1 {
			t.Fatalf("%s: loopback is a trustworthy origin and should keep the cookie, got %d", origin, got)
		}
	}
}

func TestProductionDefaultsStaySecure(t *testing.T) {
	if !DefaultCookieOptions().Secure {
		t.Fatal("the production default must keep Secure")
	}
	rec := httptest.NewRecorder()
	SetSessionCookie(rec, SessionToken{ID: "aWQ", Verifier: "dmVy"}, DefaultCookieOptions())
	c := rec.Result().Cookies()
	if len(c) != 1 || !c[0].Secure || !c[0].HttpOnly {
		t.Fatalf("default session cookie must be Secure+HttpOnly, got %+v", c)
	}
}

// CookieOptionsFor is where the deployment decision now lives. These run
// through the SAME function main.go calls, which is the property the earlier
// config-level assertions could not reach: with the logic inline in main.go,
// deleting it left every test green.
func TestCookieOptionsForResolvesSecure(t *testing.T) {
	for _, tc := range []struct {
		name       string
		in         SessionCookieSettings
		wantSecure bool
	}{
		{"empty settings are production-safe", SessionCookieSettings{}, true},
		{"insecure opt-in drops Secure", SessionCookieSettings{Insecure: true}, false},
		{"legacy tenant-slug path still drops Secure", SessionCookieSettings{DevTenantSlugHeader: true}, false},
		{"either switch alone is enough", SessionCookieSettings{DevTenantSlugHeader: true, Insecure: true}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := CookieOptionsFor(tc.in).Secure; got != tc.wantSecure {
				t.Fatalf("Secure = %v, want %v", got, tc.wantSecure)
			}
		})
	}
}

func TestCookieOptionsForKeepsDomainAndHardening(t *testing.T) {
	opts := CookieOptionsFor(SessionCookieSettings{Domain: ".moosewave.com"})
	if opts.Domain != ".moosewave.com" {
		t.Fatalf("domain lost: %q", opts.Domain)
	}
	// Dropping Secure locally must not quietly relax anything else.
	insecure := CookieOptionsFor(SessionCookieSettings{Insecure: true})
	if insecure.SameSite != DefaultCookieOptions().SameSite {
		t.Fatal("SameSite must not change with the local-dev switch")
	}
	if insecure.MaxAge != DefaultCookieOptions().MaxAge {
		t.Fatal("MaxAge must not change with the local-dev switch")
	}
}
