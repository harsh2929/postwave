package subscribers

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

// SUB-016: the per-profile cap is 5.
func TestMaxEmailsPerProfile(t *testing.T) {
	if MaxEmailsPerProfile != 5 {
		t.Fatalf("MaxEmailsPerProfile = %d, want 5", MaxEmailsPerProfile)
	}
}

// SUB-016: consent_status vocabulary is enforced; empty falls back.
func TestNormalizeConsentStatus(t *testing.T) {
	cases := []struct {
		in       string
		fallback string
		want     string
		wantErr  bool
	}{
		{"subscribed", "", "subscribed", false},
		{"  Unsubscribed ", "", "unsubscribed", false},
		{"PENDING", "", "pending", false},
		{"unknown", "", "unknown", false},
		// SUB-044: the third meaningful state, accepted case-insensitively.
		{"never_subscribed", "", "never_subscribed", false},
		{"  Never_Subscribed ", "", "never_subscribed", false},
		{"", "subscribed", "subscribed", false}, // empty -> fallback
		{"", "", "", false},                     // empty + no fallback -> ""
		{"bogus", "", "", true},                 // unknown vocab -> error
	}
	for _, c := range cases {
		got, err := normalizeConsentStatus(c.in, c.fallback)
		if c.wantErr {
			if err == nil {
				t.Errorf("normalizeConsentStatus(%q): expected error", c.in)
			}
			if !errors.Is(err, ErrInvalidInput) {
				t.Errorf("normalizeConsentStatus(%q): error should wrap ErrInvalidInput, got %v", c.in, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("normalizeConsentStatus(%q): unexpected error %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("normalizeConsentStatus(%q, %q) = %q, want %q", c.in, c.fallback, got, c.want)
		}
	}
}

// SUB-016: the limit-reached + email-taken sentinels carry the right
// classifications for the HTTP mapping (422 vs 409).
func TestMultiEmailSentinels(t *testing.T) {
	if !errors.Is(ErrEmailLimitReached, ErrInvalidInput) {
		t.Error("ErrEmailLimitReached should wrap ErrInvalidInput (422)")
	}
	if errors.Is(ErrEmailTaken, ErrInvalidInput) {
		t.Error("ErrEmailTaken must NOT wrap ErrInvalidInput (it maps to 409)")
	}
}

// isUniqueViolation duck-types the pgx SQLSTATE for unique_violation (23505).
func TestIsUniqueViolation(t *testing.T) {
	if !isUniqueViolation(&fakePgErr{code: "23505"}) {
		t.Error("23505 should be detected as unique_violation")
	}
	if isUniqueViolation(&fakePgErr{code: "42P01"}) {
		t.Error("42P01 (undefined_table) is not a unique_violation")
	}
	if isUniqueViolation(errors.New("plain")) {
		t.Error("plain error is not a unique_violation")
	}
}

// Handlers require tenant context → 401, without touching the DB.
func TestMultiEmailHandlers_RequireTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	for _, tc := range []struct {
		name string
		fn   func(*httptest.ResponseRecorder)
	}{
		{"list", func(rec *httptest.ResponseRecorder) {
			d.ListEmails(rec, httptest.NewRequest("GET", "/api/v1/subscribers/abc/emails", nil))
		}},
		{"add", func(rec *httptest.ResponseRecorder) {
			d.AddEmail(rec, httptest.NewRequest("POST", "/api/v1/subscribers/abc/emails", strings.NewReader(`{"email":"a@b.com"}`)))
		}},
		{"update", func(rec *httptest.ResponseRecorder) {
			d.UpdateEmail(rec, httptest.NewRequest("PATCH", "/api/v1/subscribers/abc/emails/e1", strings.NewReader(`{"is_primary":true}`)))
		}},
		{"delete", func(rec *httptest.ResponseRecorder) {
			d.DeleteEmail(rec, httptest.NewRequest("DELETE", "/api/v1/subscribers/abc/emails/e1", nil))
		}},
	} {
		rec := httptest.NewRecorder()
		tc.fn(rec)
		if rec.Code != 401 {
			t.Errorf("%s: status = %d, want 401 without tenant", tc.name, rec.Code)
		}
	}
}

// AddEmail handler rejects an oversized body before the DB.
func TestAddEmailHandler_RejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"email":"a@b.com","consent_status":"` + strings.Repeat("x", int(subscriberJSONMaxBodyBytes)+1) + `"}`
	rec := httptest.NewRecorder()
	d.AddEmail(rec, subscriberTenantRequest("POST", "/api/v1/subscribers/abc/emails", body))
	if rec.Code != 413 {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}
