package subscribers

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type erasureLookupFailure struct{ err error }

func (q erasureLookupFailure) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, q.err
}

// A write must never proceed because the erasure evidence could not be read.
func TestErasureLookupFailsClosed(t *testing.T) {
	t.Parallel()
	want := errors.New("suppression store unavailable")
	err := rejectErasedAddress(context.Background(), erasureLookupFailure{err: want}, "tenant", "person@example.test")
	if !errors.Is(err, want) || errors.Is(err, ErrErasureBlocked) {
		t.Fatalf("erasure lookup err=%v; want wrapped storage failure", err)
	}
}

func TestNormalizeIdentify_RequiresIdentifier(t *testing.T) {
	in := &IdentifyInput{}
	if err := normalizeIdentify(in); err == nil {
		t.Fatal("expected error when both external_id and email are empty")
	}
}

func TestNormalizeIdentify_AcceptsExternalIDOnly(t *testing.T) {
	in := &IdentifyInput{ExternalID: "shopify_42"}
	if err := normalizeIdentify(in); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if in.ExternalID != "shopify_42" {
		t.Errorf("external_id mutated: %q", in.ExternalID)
	}
}

func TestNormalizeIdentify_NormalizesEmail(t *testing.T) {
	in := &IdentifyInput{Email: "  Alice@Example.COM  "}
	if err := normalizeIdentify(in); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if in.Email != "alice@example.com" {
		t.Errorf("email = %q, want alice@example.com", in.Email)
	}
}

func TestNormalizeIdentify_PhoneLandsAsTrait(t *testing.T) {
	in := &IdentifyInput{ExternalID: "x", Phone: "+15551234567"}
	if err := normalizeIdentify(in); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if in.Traits["phone"] != "+15551234567" {
		t.Errorf("phone trait = %v, want +15551234567", in.Traits["phone"])
	}
}

// SUB-017: phone is normalized to E.164 at ingest, stripping separators.
func TestNormalizeIdentify_NormalizesPhoneToE164(t *testing.T) {
	in := &IdentifyInput{Phone: "+1 (555) 123-4567"}
	if err := normalizeIdentify(in); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if in.Phone != "+15551234567" {
		t.Errorf("phone = %q, want +15551234567", in.Phone)
	}
}

// SUB-017: phone alone is now a sufficient identifier (joins the hierarchy).
func TestNormalizeIdentify_AcceptsPhoneOnly(t *testing.T) {
	in := &IdentifyInput{Phone: "+15551234567"}
	if err := normalizeIdentify(in); err != nil {
		t.Fatalf("phone-only should be accepted: %v", err)
	}
}

// SUB-017: profile_id alone is a sufficient identifier (top of hierarchy).
func TestNormalizeIdentify_AcceptsProfileIDOnly(t *testing.T) {
	in := &IdentifyInput{ProfileID: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"}
	if err := normalizeIdentify(in); err != nil {
		t.Fatalf("profile_id-only should be accepted: %v", err)
	}
	if in.ProfileID != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" {
		t.Fatalf("profile_id = %q; want canonical UUID spelling", in.ProfileID)
	}
}

// SUB-017: a malformed profile_id is rejected with the typed sentinel so the
// handler can return a clean 400 (rather than a ::uuid bind error → 500).
func TestNormalizeIdentify_RejectsMalformedProfileID(t *testing.T) {
	in := &IdentifyInput{ProfileID: "not-a-uuid"}
	err := normalizeIdentify(in)
	if err == nil {
		t.Fatal("expected error for malformed profile_id")
	}
	if !errors.Is(err, ErrInvalidProfileID) {
		t.Fatalf("err = %v, want ErrInvalidProfileID", err)
	}
}

// SUB-017: a malformed profile_id surfaces as HTTP 400 (invalid_profile_id),
// distinct from the 422 semantic-rule failures. No DB is touched — the
// validation runs before Repo.Identify.
func TestIdentifyHandler_RejectsMalformedProfileID(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/subscribers/identify",
		strings.NewReader(`{"profile_id":"not-a-uuid"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	rec := httptest.NewRecorder()
	d.Identify(rec, r)
	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400 for malformed profile_id", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "invalid_profile_id") {
		t.Errorf("body = %q, want invalid_profile_id code", rec.Body.String())
	}
}

// SUB-017: a bare national number with no '+'/country code is rejected so the
// phone lookup key stays canonical.
func TestNormalizeIdentify_RejectsNonE164Phone(t *testing.T) {
	in := &IdentifyInput{Phone: "5551234567"}
	if err := normalizeIdentify(in); err == nil {
		t.Fatal("expected error for non-E.164 phone (missing +country)")
	}
}

func TestNormalizeE164(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"+15551234567", "+15551234567", false},
		{"+1 (555) 123-4567", "+15551234567", false},
		{"+44.20.7946.0958", "+442079460958", false},
		{"5551234567", "", true},        // no leading +
		{"+abc", "", true},              // letters
		{"+", "", true},                 // no digits
		{"+1234567890123456", "", true}, // 16 digits > 15
	}
	for _, c := range cases {
		got, err := normalizeE164(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("normalizeE164(%q): expected error, got %q", c.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("normalizeE164(%q): unexpected error %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("normalizeE164(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// SUB-003: an anonymous_id alone is a sufficient identifier so a pre-
// identification profile can be created.
func TestNormalizeIdentify_AcceptsAnonymousIDOnly(t *testing.T) {
	in := &IdentifyInput{AnonymousID: "anon-abc-123"}
	if err := normalizeIdentify(in); err != nil {
		t.Fatalf("anonymous_id-only should be accepted: %v", err)
	}
}

func TestNormalizeIdentify_RejectsOversizedAnonymousID(t *testing.T) {
	in := &IdentifyInput{AnonymousID: strings.Repeat("a", 513)}
	if err := normalizeIdentify(in); err == nil {
		t.Fatal("expected error for >512-char anonymous_id")
	}
}

// SUB-017: pickPrimary follows the precedence hierarchy — the highest-ranking
// non-nil candidate wins. The slice is ordered
// profile_id > external_id > email > phone.
func TestPickPrimary_FollowsPrecedence(t *testing.T) {
	prof := &identifyRow{id: "prof"}
	ext := &identifyRow{id: "ext"}
	email := &identifyRow{id: "email"}
	phone := &identifyRow{id: "phone"}

	if got := pickPrimary([]*identifyRow{prof, ext, email, phone}); got != prof {
		t.Errorf("profile_id should win; got %+v", got)
	}
	if got := pickPrimary([]*identifyRow{nil, ext, email, phone}); got != ext {
		t.Errorf("external_id should win when no profile_id; got %+v", got)
	}
	if got := pickPrimary([]*identifyRow{nil, nil, email, phone}); got != email {
		t.Errorf("email should win over phone; got %+v", got)
	}
	if got := pickPrimary([]*identifyRow{nil, nil, nil, phone}); got != phone {
		t.Errorf("phone should win when it is the only match; got %+v", got)
	}
	if got := pickPrimary([]*identifyRow{nil, nil, nil, nil}); got != nil {
		t.Errorf("no match should yield nil (net-new); got %+v", got)
	}
}

// SUB-003: anonymous placeholders are deterministic, bounded, non-routable,
// and case-sensitive so distinct source identifiers cannot collapse.
func TestAnonymousPlaceholderEmail(t *testing.T) {
	got := anonymousPlaceholderEmail("Anon-XYZ")
	if got != anonymousPlaceholderEmail("Anon-XYZ") {
		t.Fatalf("placeholder is not deterministic: %q", got)
	}
	assertIdentifyPlaceholder(t, got, "anonymous")
	if got == anonymousPlaceholderEmail("anon-xyz") {
		t.Fatalf("case-sensitive anonymous identifiers collapsed to %q", got)
	}
	if legacy := legacyAnonymousPlaceholderEmail("Anon-XYZ"); legacy != "anon+anon-xyz@no-email.invalid" {
		t.Fatalf("legacy compatibility placeholder = %q", legacy)
	}
}

// SUB-017: identifyEmail placeholder precedence follows the identity hierarchy:
// profile_id beats external_id, which beats phone and anonymous_id.
func TestIdentifyEmail_PlaceholderPrecedence(t *testing.T) {
	phone := identifyEmail(IdentifyInput{Phone: "+15551234567"})
	assertIdentifyPlaceholder(t, phone, "phone")
	external := identifyEmail(IdentifyInput{ExternalID: "x", Phone: "+15551234567", AnonymousID: "a"})
	assertIdentifyPlaceholder(t, external, "external")
	profile := identifyEmail(IdentifyInput{
		ProfileID:  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		ExternalID: "x",
	})
	assertIdentifyPlaceholder(t, profile, "profile")
	if profile == external || external == phone {
		t.Fatalf("placeholder namespaces collapsed: profile=%q external=%q phone=%q", profile, external, phone)
	}
	long := identifyEmail(IdentifyInput{ExternalID: strings.Repeat("X", 256)})
	assertIdentifyPlaceholder(t, long, "external")
	if len(long) > 254 {
		t.Fatalf("placeholder exceeds RFC email bound: %d", len(long))
	}
}

func TestNormalizeIdentify_RejectsOversizedExternalID(t *testing.T) {
	in := &IdentifyInput{ExternalID: strings.Repeat("a", 257)}
	if err := normalizeIdentify(in); err == nil {
		t.Fatal("expected error for >256-char external_id")
	}
}

func TestIdentifyEmail_Placeholder(t *testing.T) {
	got := identifyEmail(IdentifyInput{ExternalID: "ShopCust_99"})
	assertIdentifyPlaceholder(t, got, "external")
	if got == identifyEmail(IdentifyInput{ExternalID: "shopcust_99"}) {
		t.Fatalf("case-sensitive external identifiers collapsed to %q", got)
	}
}

func TestIdentifyEmail_RealEmailWins(t *testing.T) {
	got := identifyEmail(IdentifyInput{ExternalID: "x", Email: "a@b.com"})
	if got != "a@b.com" {
		t.Errorf("got %q, want a@b.com", got)
	}
}

func assertIdentifyPlaceholder(t *testing.T, value, kind string) {
	t.Helper()
	if !strings.HasPrefix(value, kind+"-") || !strings.HasSuffix(value, "@no-email.invalid") {
		t.Fatalf("placeholder %q does not use %s namespace and .invalid domain", value, kind)
	}
	local := strings.SplitN(value, "@", 2)[0]
	if len(local) > 64 {
		t.Fatalf("placeholder local part is %d bytes; want <=64 (%q)", len(local), value)
	}
}

// Handler: rejects oversized payload before touching DB.
func TestIdentifyHandler_RejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"external_id":"x","traits":{"blob":"` + strings.Repeat("a", int(subscriberJSONMaxBodyBytes)+1) + `"}}`
	rec := httptest.NewRecorder()
	d.Identify(rec, subscriberTenantRequest("POST", "/api/v1/subscribers/identify", body))
	if rec.Code != 413 {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}

// Handler: requires tenant context → 401.
func TestIdentifyHandler_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/subscribers/identify",
		strings.NewReader(`{"external_id":"x"}`))
	r.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.Identify(rec, r)
	if rec.Code != 401 {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// Handler: payload missing both identifiers → 422.
func TestIdentifyHandler_RejectsEmptyPayload(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/subscribers/identify",
		strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	rec := httptest.NewRecorder()
	d.Identify(rec, r)
	if rec.Code != 422 {
		t.Fatalf("status = %d, want 422 for missing identifier", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "profile_id, external_id, email, phone or anonymous_id") {
		t.Errorf("body = %q, want validation message", rec.Body.String())
	}
}

// Repo: top-level guards run before any DB access.
func TestIdentifyRepo_RejectsEmptyTenant(t *testing.T) {
	r := &Repo{Pool: nil}
	if _, err := r.Identify(context.Background(), "", IdentifyInput{ExternalID: "x"}); err == nil {
		t.Fatal("expected error for empty tenant")
	}
}

func TestIdentifyRepo_RejectsEmptyPayload(t *testing.T) {
	r := &Repo{Pool: nil}
	if _, err := r.Identify(context.Background(), "t1", IdentifyInput{}); err == nil {
		t.Fatal("expected error when all ids are empty")
	}
}

// SUB-017: loadIdentifyRow validates the lookup column against the allow-list
// before touching the tx, so an unknown column can never widen into SQL
// injection. The four supported columns are accepted by the switch; an
// unknown column errors. We exercise the guard path (nil tx) for the error
// case — the supported columns are covered by the live identify integration
// (skipped without a DB).
func TestLoadIdentifyRow_RejectsUnknownColumn(t *testing.T) {
	if _, err := loadIdentifyRow(context.Background(), nil, "t1", "ssn", "x"); err == nil {
		t.Fatal("expected error for unknown lookup column")
	}
}
