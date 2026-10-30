package affiliates

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewCookieID_LengthAndHex(t *testing.T) {
	a, err := NewCookieID()
	if err != nil {
		t.Fatal(err)
	}
	if len(a) != 32 {
		t.Errorf("len = %d, want 32", len(a))
	}
	for _, c := range a {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Errorf("non-hex char %q", c)
		}
	}
	b, _ := NewCookieID()
	if a == b {
		t.Errorf("two consecutive ids collided: %s", a)
	}
}

func TestExtractOrCreateCookie_Existing(t *testing.T) {
	r := httptest.NewRequest("GET", "/x", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: "deadbeef"})
	id, fresh, err := ExtractOrCreateCookie(r)
	if err != nil {
		t.Fatal(err)
	}
	if id != "deadbeef" {
		t.Errorf("id = %q, want deadbeef", id)
	}
	if fresh {
		t.Errorf("expected fresh=false for existing cookie")
	}
}

func TestExtractOrCreateCookie_Generates(t *testing.T) {
	r := httptest.NewRequest("GET", "/x", nil)
	id, fresh, err := ExtractOrCreateCookie(r)
	if err != nil {
		t.Fatal(err)
	}
	if !fresh {
		t.Errorf("expected fresh=true on no-cookie path")
	}
	if len(id) != 32 {
		t.Errorf("generated id length = %d, want 32", len(id))
	}
}

func TestExtractOrCreateCookie_BlankReplaced(t *testing.T) {
	r := httptest.NewRequest("GET", "/x", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: "   "})
	id, fresh, err := ExtractOrCreateCookie(r)
	if err != nil {
		t.Fatal(err)
	}
	if !fresh {
		t.Errorf("blank cookie should be replaced")
	}
	if id == "   " || strings.TrimSpace(id) == "" {
		t.Errorf("expected fresh id, got %q", id)
	}
}

func TestBuildSetCookie_Defaults(t *testing.T) {
	c := BuildSetCookie("abc123", CookieConfig{
		Domain: ".moosewave.com",
		Secure: true,
	})
	if c.Name != CookieName || c.Value != "abc123" {
		t.Errorf("name/value = %+v", c)
	}
	if c.Domain != ".moosewave.com" {
		t.Errorf("domain = %q", c.Domain)
	}
	if !c.HttpOnly {
		t.Errorf("expected HttpOnly")
	}
	if !c.Secure {
		t.Errorf("expected Secure when configured")
	}
	if c.SameSite != http.SameSiteLaxMode {
		t.Errorf("samesite = %v", c.SameSite)
	}
	if c.MaxAge != CookieMaxAgeSeconds {
		t.Errorf("max-age = %d, want %d", c.MaxAge, CookieMaxAgeSeconds)
	}
}

func TestBuildSetCookie_DevHostOnly(t *testing.T) {
	c := BuildSetCookie("x", CookieConfig{Domain: "", Secure: false, MaxAgeSeconds: 60})
	if c.Domain != "" {
		t.Errorf("expected empty domain (host-only) for local dev, got %q", c.Domain)
	}
	if c.MaxAge != 60 {
		t.Errorf("MaxAge override ignored: got %d, want 60", c.MaxAge)
	}
}

// TestClientIPFromRequest covers the XFF / X-Real-IP / RemoteAddr fallback
// chain so that affiliate clicks attribute to the original viewer rather
// than the proxy.
func TestClientIPFromRequest(t *testing.T) {
	cases := []struct {
		name  string
		setup func(r *http.Request)
		want  string
	}{
		{
			name: "xff_first",
			setup: func(r *http.Request) {
				r.Header.Set("X-Forwarded-For", "203.0.113.5, 10.0.0.1")
			},
			want: "203.0.113.5",
		},
		{
			name: "real_ip_fallback",
			setup: func(r *http.Request) {
				r.Header.Set("X-Real-IP", "198.51.100.7")
			},
			want: "198.51.100.7",
		},
		{
			name: "remote_addr_strip_port",
			setup: func(r *http.Request) {
				r.RemoteAddr = "192.0.2.10:54321"
			},
			want: "192.0.2.10",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/x", nil)
			c.setup(r)
			got := clientIPFromRequest(r)
			if got != c.want {
				t.Errorf("got %q, want %q", got, c.want)
			}
		})
	}
}
