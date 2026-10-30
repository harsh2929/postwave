package subscribers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// SUB-042: the closed channel set is exactly the five reachability channels.
func TestChannelConsentChannels(t *testing.T) {
	want := map[string]bool{"email": true, "sms": true, "push": true, "whatsapp": true, "rcs": true}
	if len(ChannelConsentChannels) != len(want) {
		t.Fatalf("ChannelConsentChannels = %v, want %d channels", ChannelConsentChannels, len(want))
	}
	for _, c := range ChannelConsentChannels {
		if !want[c] {
			t.Errorf("unexpected channel %q", c)
		}
	}
}

// SUB-042: channel tokens are case-insensitive and validated against the set.
func TestNormalizeChannel(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"email", "email", false},
		{"  SMS ", "sms", false},
		{"WhatsApp", "whatsapp", false},
		{"rcs", "rcs", false},
		{"push", "push", false},
		{"", "", true},
		{"fax", "", true},
	}
	for _, c := range cases {
		got, err := normalizeChannel(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("normalizeChannel(%q): expected error", c.in)
			} else if !errors.Is(err, ErrInvalidInput) {
				t.Errorf("normalizeChannel(%q): error should wrap ErrInvalidInput, got %v", c.in, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("normalizeChannel(%q): unexpected error %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("normalizeChannel(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// SUB-042: status vocabulary is enforced; empty falls back.
func TestNormalizeChannelConsentStatus(t *testing.T) {
	cases := []struct {
		in       string
		fallback string
		want     string
		wantErr  bool
	}{
		{"opted_in", "", "opted_in", false},
		{" Opted_Out ", "", "opted_out", false},
		{"PENDING", "", "pending", false},
		{"unknown", "", "unknown", false},
		{"", "unknown", "unknown", false}, // empty -> fallback
		{"", "", "", false},               // empty + no fallback -> ""
		{"bogus", "", "", true},
	}
	for _, c := range cases {
		got, err := normalizeChannelConsentStatus(c.in, c.fallback)
		if c.wantErr {
			if err == nil {
				t.Errorf("normalizeChannelConsentStatus(%q): expected error", c.in)
			} else if !errors.Is(err, ErrInvalidInput) {
				t.Errorf("normalizeChannelConsentStatus(%q): error should wrap ErrInvalidInput, got %v", c.in, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("normalizeChannelConsentStatus(%q): unexpected error %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("normalizeChannelConsentStatus(%q, %q) = %q, want %q", c.in, c.fallback, got, c.want)
		}
	}
}

// SUB-042: handlers require tenant context → 401, without touching the DB.
func TestChannelConsentHandlers_RequireTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	for _, tc := range []struct {
		name string
		fn   func(*httptest.ResponseRecorder)
	}{
		{"list", func(rec *httptest.ResponseRecorder) {
			d.ListChannelConsents(rec, httptest.NewRequest("GET", "/api/v1/subscribers/abc/channel-consents", nil))
		}},
		{"set", func(rec *httptest.ResponseRecorder) {
			d.SetChannelConsent(rec, httptest.NewRequest("PATCH", "/api/v1/subscribers/abc/channel-consents/email", strings.NewReader(`{"status":"opted_in"}`)))
		}},
	} {
		rec := httptest.NewRecorder()
		tc.fn(rec)
		if rec.Code != 401 {
			t.Errorf("%s: status = %d, want 401 without tenant", tc.name, rec.Code)
		}
	}
}

// SUB-042: SetChannelConsent handler rejects an oversized body before the DB.
func TestSetChannelConsentHandler_RejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"consent_source":"` + strings.Repeat("x", int(subscriberJSONMaxBodyBytes)+1) + `"}`
	rec := httptest.NewRecorder()
	req := subscriberTenantRequest("PATCH", "/api/v1/subscribers/abc/channel-consents/email", body)
	req.Header.Set("If-Match", `"subscriber:abc:v1"`)
	d.SetChannelConsent(rec, req)
	if rec.Code != 413 {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}

// derefStr is the small *string → string helper used by the upsert binding.
func TestDerefStr(t *testing.T) {
	if got := derefStr(nil); got != "" {
		t.Errorf("derefStr(nil) = %q, want empty", got)
	}
	v := "form"
	if got := derefStr(&v); got != "form" {
		t.Errorf("derefStr(&\"form\") = %q, want form", got)
	}
}

func channelString(value string) *string { return &value }

func TestSetChannelConsent_ConsentEvidenceFailsClosedBeforeDB(t *testing.T) {
	repo := &Repo{Pool: nil}
	when := time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name string
		in   UpdateChannelConsentInput
	}{
		{
			name: "opt in without provenance",
			in:   UpdateChannelConsentInput{Status: channelString("opted_in")},
		},
		{
			name: "evidence mutation without status",
			in: UpdateChannelConsentInput{
				ConsentSource:    channelString("double_optin"),
				ConsentTimestamp: &when,
			},
		},
		{
			name: "pending cannot claim provenance",
			in: UpdateChannelConsentInput{
				Status:        channelString("pending"),
				ConsentSource: channelString("double_optin"),
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := repo.SetChannelConsent(context.Background(), "tenant", "subscriber", "email", tc.in)
			if err == nil || !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("error = %v, want ErrInvalidInput before database access", err)
			}
		})
	}
}

func TestSetChannelConsentHandler_RejectsUnknownEvidenceFields(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	rec := httptest.NewRecorder()
	req := subscriberTenantRequest(http.MethodPatch,
		"/api/v1/subscribers/abc/channel-consents/email",
		`{"status":"opted_in","inferred_consent":true}`)
	req.Header.Set("If-Match", `"subscriber:abc:v1"`)
	d.SetChannelConsent(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for an unknown consent claim", rec.Code)
	}
}

func TestSetChannelConsentHandler_RequiresExactIfMatch(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	for _, header := range []string{"", "*", `W/"subscriber:abc:v1"`, `"subscriber:abc:v1", "subscriber:abc:v2"`} {
		rec := httptest.NewRecorder()
		req := subscriberTenantRequest(http.MethodPatch,
			"/api/v1/subscribers/abc/channel-consents/email",
			`{"clear_frequency_cap":true}`)
		if header != "" {
			req.Header.Set("If-Match", header)
		}
		d.SetChannelConsent(rec, req)
		if rec.Code != http.StatusPreconditionRequired {
			t.Fatalf("If-Match %q status = %d, want 428", header, rec.Code)
		}
	}
}

func TestChannelConsentHandlerMapsRepairLockTimeoutToRetriableConflict(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Deps{}).writeChannelConsentErr(
		rec,
		httptest.NewRequest(http.MethodPatch, "/api/v1/subscribers/abc/channel-consents/email", nil),
		ErrConcurrentConsentDecision,
	)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
	if body := rec.Body.String(); !strings.Contains(body, "concurrent_consent_change") ||
		!strings.Contains(body, "retry the complete request") {
		t.Fatalf("unsafe or non-retriable conflict body = %s", body)
	}
}

func TestNormalizeChannelConsentMutation_FailsClosedForDecorativeStates(t *testing.T) {
	for _, tc := range []struct {
		name    string
		channel string
		status  string
	}{
		{"non-email grant", "sms", "opted_in"},
		{"non-email revoke", "push", "opted_out"},
		{"email pending", "email", "pending"},
		{"email unknown", "email", "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := UpdateChannelConsentInput{Status: &tc.status}
			if _, err := normalizeChannelConsentMutation(tc.channel, &in); err == nil || !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("error = %v, want fail-closed ErrInvalidInput", err)
			}
		})
	}
}

func TestNormalizeChannelConsentMutation_GrantRequiresCanonicalEvidencePair(t *testing.T) {
	when := time.Now().UTC().Add(-time.Hour)
	status := "opted_in"
	base := UpdateChannelConsentInput{
		Status: &status, ConsentSource: channelString("double_optin"),
		ConsentTimestamp: &when, EvidenceChannel: channelString("email"),
		LegalBasis: channelString("consent"), Evidence: channelString("receipt:42"),
		Jurisdiction: channelString("GB"), Reason: channelString("reviewed receipt"),
		PolicyVersion: channelString("privacy-2026-07"),
	}
	for _, mutate := range []func(*UpdateChannelConsentInput){
		func(in *UpdateChannelConsentInput) { in.Evidence = channelString("") },
		func(in *UpdateChannelConsentInput) { in.LegalBasis = channelString("contract") },
		func(in *UpdateChannelConsentInput) { in.EvidenceChannel = channelString("mobile") },
	} {
		in := base
		mutate(&in)
		if _, err := normalizeChannelConsentMutation("email", &in); err == nil || !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("error = %v, want canonical grant validation failure", err)
		}
	}
}
