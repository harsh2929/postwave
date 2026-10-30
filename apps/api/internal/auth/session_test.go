package auth

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIssueSessionToken_RandomEachTime(t *testing.T) {
	a, err := IssueSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	b, err := IssueSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	if a.ID == b.ID {
		t.Errorf("ids collided: %s", a.ID)
	}
	if a.Verifier == b.Verifier {
		t.Errorf("verifiers collided")
	}
	if a.ID == "" || a.Verifier == "" {
		t.Errorf("empty fields: %+v", a)
	}
}

func TestSessionToken_StringRoundTrip(t *testing.T) {
	tok, err := IssueSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	cookie := tok.String()
	if !strings.Contains(cookie, ".") {
		t.Errorf("missing separator in %q", cookie)
	}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.AddCookie(&http.Cookie{Name: SessionCookieName, Value: cookie})
	parsed, err := ParseSessionCookie(r)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.ID != tok.ID || parsed.Verifier != tok.Verifier {
		t.Errorf("round-trip mismatch: got %+v, want %+v", parsed, tok)
	}
}

func TestParseSessionCookie_Errors(t *testing.T) {
	cases := []struct {
		name   string
		cookie *http.Cookie
		want   error
	}{
		{"no cookie", nil, ErrNoSession},
		{"empty value", &http.Cookie{Name: SessionCookieName, Value: ""}, ErrInvalidSession},
		{"missing dot", &http.Cookie{Name: SessionCookieName, Value: "foo"}, ErrInvalidSession},
		{"empty id", &http.Cookie{Name: SessionCookieName, Value: ".verifier"}, ErrInvalidSession},
		{"empty verifier", &http.Cookie{Name: SessionCookieName, Value: "id."}, ErrInvalidSession},
		{"non-base64 id", &http.Cookie{Name: SessionCookieName, Value: "!!!.verifier"}, ErrInvalidSession},
		{"non-base64 verifier", &http.Cookie{Name: SessionCookieName, Value: "abc.!!!"}, ErrInvalidSession},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			if tc.cookie != nil {
				r.AddCookie(tc.cookie)
			}
			_, err := ParseSessionCookie(r)
			if !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
		})
	}
}

func TestVerifyVerifier_ConstantTime(t *testing.T) {
	pepper := []byte("super-secret-pepper-32bytes-min!!")
	tok, _ := IssueSessionToken()
	stored := HashVerifier(tok.Verifier, pepper)

	if !VerifyVerifier(tok.Verifier, stored, pepper) {
		t.Errorf("good verifier should match")
	}
	if VerifyVerifier("wrong-verifier", stored, pepper) {
		t.Errorf("wrong verifier must not match")
	}
	// Different pepper → mismatch even with right verifier.
	if VerifyVerifier(tok.Verifier, stored, []byte("different-pepper")) {
		t.Errorf("verifier under different pepper must not match")
	}
}

func TestSetAndClearCookie(t *testing.T) {
	w := httptest.NewRecorder()
	tok, _ := IssueSessionToken()
	opts := DefaultCookieOptions()
	opts.Secure = false // for the http test recorder
	SetSessionCookie(w, tok, opts)
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != SessionCookieName {
		t.Fatalf("expected one %q cookie, got %+v", SessionCookieName, cookies)
	}
	if cookies[0].Value != tok.String() {
		t.Errorf("cookie value mismatch")
	}
	if !cookies[0].HttpOnly {
		t.Errorf("HttpOnly must be set on the session cookie")
	}

	w2 := httptest.NewRecorder()
	ClearSessionCookie(w2, opts)
	cleared := w2.Result().Cookies()
	if len(cleared) != 1 || cleared[0].MaxAge >= 0 {
		t.Errorf("clear cookie should have MaxAge<0; got %+v", cleared)
	}
}

func TestBestEffortClientIP_NormalizesIPv4AndIPv6(t *testing.T) {
	tests := []struct {
		name       string
		remoteAddr string
		xForwarded string
		xRealIP    string
		want       string
	}{
		{
			name:       "IPv4 remote with port",
			remoteAddr: "127.0.0.1:54321",
			want:       "127.0.0.1",
		},
		{
			name:       "bracketed IPv6 remote with port",
			remoteAddr: "[::1]:54321",
			want:       "::1",
		},
		{
			name:       "raw IPv6 after proxy normalization",
			remoteAddr: "2001:db8::1",
			want:       "2001:db8::1",
		},
		{
			name:       "first valid forwarded address",
			remoteAddr: "127.0.0.1:54321",
			xForwarded: "2001:db8::2, 192.0.2.10",
			want:       "2001:db8::2",
		},
		{
			name:       "malformed forwarded address falls through",
			remoteAddr: "127.0.0.1:54321",
			xForwarded: "not-an-ip",
			xRealIP:    "192.0.2.20",
			want:       "192.0.2.20",
		},
		{
			name:       "all malformed values become nullable",
			remoteAddr: "not-an-address",
			xForwarded: "also-invalid",
			xRealIP:    "still-invalid",
			want:       "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
			r.RemoteAddr = tc.remoteAddr
			if tc.xForwarded != "" {
				r.Header.Set("X-Forwarded-For", tc.xForwarded)
			}
			if tc.xRealIP != "" {
				r.Header.Set("X-Real-IP", tc.xRealIP)
			}
			if got := bestEffortClientIP(r); got != tc.want {
				t.Fatalf("bestEffortClientIP() = %q, want %q", got, tc.want)
			}
		})
	}
}
