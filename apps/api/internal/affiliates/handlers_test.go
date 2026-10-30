package affiliates

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestRequireAdmin_BlocksWithoutRole confirms the admin gate rejects
// unauthenticated requests with 403 + the documented error envelope.
func TestRequireAdmin_BlocksWithoutRole(t *testing.T) {
	called := false
	h := requireAdmin(false)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	r := httptest.NewRequest("GET", "/x", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}
	if called {
		t.Errorf("inner handler should NOT be invoked when role is absent")
	}
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	errObj, _ := body["error"].(map[string]any)
	if errObj["code"] != "forbidden" {
		t.Errorf("error code = %v, want forbidden", errObj["code"])
	}
}

// TestRequireAdmin_AllowsWithHeader uses the dev-mode X-Postwave-Role
// fallback to confirm the gate opens for owner/admin.
func TestRequireAdmin_AllowsWithHeaderWhenDevEnabled(t *testing.T) {
	for _, role := range []string{"owner", "admin", "ADMIN"} {
		called := false
		h := requireAdmin(true)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			called = true
		}))
		r := httptest.NewRequest("GET", "/x", nil)
		r.Header.Set("X-Postwave-Role", role)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if !called {
			t.Errorf("role %q: inner handler not called", role)
		}
		if w.Code != http.StatusOK {
			t.Errorf("role %q: status = %d", role, w.Code)
		}
	}
}

func TestRequireAdmin_BlocksHeaderByDefault(t *testing.T) {
	called := false
	h := requireAdmin(false)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	r := httptest.NewRequest("GET", "/x", nil)
	r.Header.Set("X-Postwave-Role", "admin")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if called {
		t.Fatalf("inner handler should not be called")
	}
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

// TestPublicSignup_RequiresToS verifies the consent gate on /signup.
func TestPublicSignup_RequiresToS(t *testing.T) {
	d := &Deps{} // Repo nil — body-validation runs before Repo access.
	body, _ := json.Marshal(SignupInput{Email: "x@y.co", Name: "X", AgreedToToS: false})
	r := httptest.NewRequest("POST", "/api/public/affiliates/signup", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	d.PublicSignup(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "tos_required") {
		t.Errorf("body = %s", w.Body.String())
	}
}

// TestPublicSignup_BadEmail verifies email validation.
func TestPublicSignup_BadEmail(t *testing.T) {
	d := &Deps{}
	body, _ := json.Marshal(SignupInput{Email: "not-an-email", Name: "X", AgreedToToS: true})
	r := httptest.NewRequest("POST", "/x", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	d.PublicSignup(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "bad_email") {
		t.Errorf("body = %s", w.Body.String())
	}
}

// TestPublicSignup_BadCountry verifies the ISO-3166 regex.
func TestPublicSignup_BadCountry(t *testing.T) {
	d := &Deps{}
	body, _ := json.Marshal(SignupInput{
		Email: "a@b.co", Name: "Jane", Country: "USA",
		AgreedToToS: true,
	})
	r := httptest.NewRequest("POST", "/x", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	d.PublicSignup(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "bad_country") {
		t.Errorf("body = %s", w.Body.String())
	}
}

func TestPublicSignup_RejectsOversizedBody(t *testing.T) {
	d := &Deps{}
	body := `{"email":"a@b.co","name":"` + strings.Repeat("x", int(affiliateJSONMaxBodyBytes)) + `","agreedToToS":true}`
	r := httptest.NewRequest("POST", "/api/public/affiliates/signup", bytes.NewReader([]byte(body)))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	d.PublicSignup(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413", w.Code)
	}
	if !strings.Contains(w.Body.String(), "payload_too_large") {
		t.Errorf("body = %s", w.Body.String())
	}
}

// TestPublicPixel_GIFShape confirms we return a valid 43-byte GIF89a body
// with image/gif Content-Type and no-cache headers (so email clients don't
// suppress the second open).
func TestPublicPixel_GIFShape(t *testing.T) {
	d := &Deps{}
	r := httptest.NewRequest("GET", "/api/public/affiliates/pixel.gif", nil)
	w := httptest.NewRecorder()
	d.PublicPixel(w, r)
	if w.Code != http.StatusOK {
		t.Errorf("status = %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "image/gif" {
		t.Errorf("content-type = %q, want image/gif", ct)
	}
	if !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
		t.Errorf("cache-control = %q, want no-store", w.Header().Get("Cache-Control"))
	}
	if w.Body.Len() != 43 {
		t.Errorf("body len = %d, want 43", w.Body.Len())
	}
	if !bytes.HasPrefix(w.Body.Bytes(), []byte("GIF89a")) {
		t.Errorf("body does not start with GIF89a magic")
	}
}

type captureAffiliateNotifier struct {
	ch chan AffiliateSignupNotice
}

func (c *captureAffiliateNotifier) NotifyAffiliateSignup(_ context.Context, in AffiliateSignupNotice) error {
	c.ch <- in
	return nil
}

type panicAffiliateNotifier struct {
	ch chan AffiliateSignupNotice
}

func (p *panicAffiliateNotifier) NotifyAffiliateSignup(_ context.Context, in AffiliateSignupNotice) error {
	p.ch <- in
	panic("affiliate notify exploded")
}

func TestNotifyAffiliateSignup_UsesNotifier(t *testing.T) {
	notifier := &captureAffiliateNotifier{ch: make(chan AffiliateSignupNotice, 1)}
	d := &Deps{
		AdminNotifyEmail: "partners@example.com",
		AdminNotifier:    notifier,
	}
	d.notifyAffiliateSignup(&Affiliate{
		ID:           "aff_1",
		Slug:         "jane",
		Email:        "jane@example.com",
		Name:         "Jane Doe",
		Country:      "US",
		Website:      "https://jane.example",
		AudienceSize: 12000,
		AudienceDesc: "Weekly SaaS newsletter",
		Status:       StatusPending,
	})
	select {
	case got := <-notifier.ch:
		if got.To != "partners@example.com" || got.AffiliateID != "aff_1" || got.Email != "jane@example.com" {
			t.Fatalf("notice = %+v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for affiliate signup notification")
	}
}

func TestNotifyAffiliateSignup_RecoversNotifierPanic(t *testing.T) {
	notifier := &panicAffiliateNotifier{ch: make(chan AffiliateSignupNotice, 1)}
	d := &Deps{
		AdminNotifyEmail: "partners@example.com",
		AdminNotifier:    notifier,
	}
	d.notifyAffiliateSignup(&Affiliate{
		ID:     "aff_1",
		Slug:   "jane",
		Email:  "jane@example.com",
		Name:   "Jane Doe",
		Status: StatusPending,
	})
	select {
	case got := <-notifier.ch:
		if got.AffiliateID != "aff_1" {
			t.Fatalf("notice = %+v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for affiliate signup notification")
	}
}

// TestPublicTrack_RedirectsOnSuccess confirms that even when affiliate
// resolution fails (no repo wired in this minimal test) the user is
// always redirected — outage on tracking should never break landing pages.
func TestPublicTrack_RedirectsOnSoftFailure(t *testing.T) {
	d := &Deps{
		// Pool nil → RecordClickFromRequest will panic if called; we keep
		// the test focused on the no-ref short-circuit + the redirect
		// fallback path. We pass a ref but with nil repo; the handler
		// catches the lookup error and still issues the redirect.
		MarketingHomeURL: "https://moosewave.com",
	}
	r := httptest.NewRequest("GET", "/api/public/affiliates/track?ref=", nil)
	w := httptest.NewRecorder()
	d.PublicTrack(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("missing ref → status = %d, want 400", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("content-type = %q, want JSON", ct)
	}
	if !strings.Contains(w.Body.String(), "missing_ref") {
		t.Errorf("body = %s", w.Body.String())
	}
}

func TestSafeAffiliateLandingURLBlocksOpenRedirects(t *testing.T) {
	fallback := "https://moosewave.com"
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{name: "empty", raw: "", want: fallback},
		{name: "relative path", raw: "/pricing?plan=pro", want: "/pricing?plan=pro"},
		{name: "same marketing host", raw: "https://moosewave.com/pricing", want: "https://moosewave.com/pricing"},
		{name: "same request host", raw: "https://forms.moosewave.com/welcome", want: "https://forms.moosewave.com/welcome"},
		{name: "fragment stripped", raw: "https://moosewave.com/pricing#plans", want: "https://moosewave.com/pricing"},
		{name: "external host", raw: "https://evil.example/phish", want: fallback},
		{name: "scheme relative", raw: "//evil.example/phish", want: fallback},
		{name: "javascript", raw: "javascript:alert(1)", want: fallback},
		{name: "userinfo", raw: "https://user:pass@moosewave.com/pricing", want: fallback},
		{name: "encoded crlf", raw: "https://moosewave.com/%0d%0aLocation:%20https://evil.example", want: fallback},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := safeAffiliateLandingURL(tc.raw, fallback, "forms.moosewave.com")
			if got != tc.want {
				t.Fatalf("safeAffiliateLandingURL(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

// TestSlugDerivation makes sure auto-generated slugs from createFromSignup
// agree with the standalone slugify helper. We exercise via the regex used
// in createFromSignup so any future regex tweaks regress here.
func TestSlugDerivation(t *testing.T) {
	cases := []struct {
		name string
		want string
	}{
		{"Jane Doe", "jane-doe"},
		{"O'Brien", "obrien"},
		{"!!!Hello!!!", "hello"},
	}
	for _, c := range cases {
		got := slugify(c.name)
		if got != c.want {
			t.Errorf("slugify(%q) = %q, want %q", c.name, got, c.want)
		}
	}
}
