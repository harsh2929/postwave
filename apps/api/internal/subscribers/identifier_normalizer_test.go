package subscribers

// SUB-018 — identifier normalization transforms.
//
// The pure transform helpers (email dot/plus stripping, phone E.164, the
// preview builder) need no database and are exercised directly. The HTTP
// handlers' validation branches (no-tenant, empty-patch, invalid-region) are
// reachable without postgres because they reject before any repo call; the
// full LoadIdentifierTransforms / UpdateIdentifierTransforms round-trip needs a
// DB and follows the established skip-on-DATABASE_URL-unset pattern elsewhere
// in the package.

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestNormalizeEmailWithConfig_Dots(t *testing.T) {
	cfg := IdentifierTransformConfig{EmailNormalizeDots: true}
	got := normalizeEmailWithConfig("j.o.h.n@gmail.com", cfg)
	if got != "john@gmail.com" {
		t.Errorf("got %q, want john@gmail.com", got)
	}
	// Dots in the domain are significant and must survive.
	got = normalizeEmailWithConfig("a.b@my.domain.com", cfg)
	if got != "ab@my.domain.com" {
		t.Errorf("got %q, want ab@my.domain.com (domain dots preserved)", got)
	}
}

func TestNormalizeEmailWithConfig_Plus(t *testing.T) {
	cfg := IdentifierTransformConfig{EmailNormalizePlus: true}
	got := normalizeEmailWithConfig("john+promo@gmail.com", cfg)
	if got != "john@gmail.com" {
		t.Errorf("got %q, want john@gmail.com", got)
	}
	// A "+" in the domain is not a sub-address and must not be touched
	// (the local-part has no "+", so the address is unchanged).
	got = normalizeEmailWithConfig("john@gmail.com", cfg)
	if got != "john@gmail.com" {
		t.Errorf("got %q, want unchanged", got)
	}
}

func TestNormalizeEmailWithConfig_DotsAndPlusTogether(t *testing.T) {
	cfg := IdentifierTransformConfig{EmailNormalizeDots: true, EmailNormalizePlus: true}
	got := normalizeEmailWithConfig("j.o.h.n+newsletter@gmail.com", cfg)
	if got != "john@gmail.com" {
		t.Errorf("got %q, want john@gmail.com", got)
	}
}

func TestNormalizeEmailWithConfig_Disabled_IsNoOp(t *testing.T) {
	cfg := IdentifierTransformConfig{} // all off
	in := "j.o.h.n+promo@gmail.com"
	if got := normalizeEmailWithConfig(in, cfg); got != in {
		t.Errorf("got %q, want unchanged %q", got, in)
	}
}

func TestNormalizeEmailWithConfig_NeverEmptiesLocalPart(t *testing.T) {
	// "+tag@domain" with plus-stripping would empty the local-part; the
	// transform must bail and return the original rather than "@domain".
	cfg := IdentifierTransformConfig{EmailNormalizePlus: true}
	in := "+promo@gmail.com"
	if got := normalizeEmailWithConfig(in, cfg); got != in {
		t.Errorf("got %q, want original (empty local-part guard)", got)
	}
	// All-dots local-part with dot-stripping would also empty it.
	cfg = IdentifierTransformConfig{EmailNormalizeDots: true}
	in = "...@gmail.com"
	if got := normalizeEmailWithConfig(in, cfg); got != in {
		t.Errorf("got %q, want original (empty local-part guard)", got)
	}
}

func TestNormalizePhoneE164(t *testing.T) {
	cases := []struct {
		name   string
		raw    string
		region string
		want   string
		wantOK bool
	}{
		{"already_e164", "+14155552671", "", "+14155552671", true},
		{"us_national_formatted", "(415) 555-2671", "US", "+14155552671", true},
		{"gb_national_with_trunk_zero", "0415 555 2671", "GB", "+444155552671", true},
		{"intl_double_zero", "001 415 555 2671", "", "+14155552671", true},
		{"gb_national", "020 7946 0958", "GB", "+442079460958", true},
		{"unknown_region_no_plus", "415 555 2671", "ZZ", "415 555 2671", false},
		{"empty", "", "US", "", false},
		{"letters_only", "not-a-number", "US", "not-a-number", false},
		{"too_short", "12", "US", "12", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := normalizePhoneE164(c.raw, c.region)
			if ok != c.wantOK {
				t.Fatalf("ok = %v, want %v (got %q)", ok, c.wantOK, got)
			}
			if c.wantOK && got != c.want {
				t.Errorf("got %q, want %q", got, c.want)
			}
			if !c.wantOK && got != c.raw {
				t.Errorf("on failure got %q, want raw %q untouched", got, c.raw)
			}
		})
	}
}

func TestNormalizePhoneE164_GBNationalTrunkZero(t *testing.T) {
	// A UK national number with a trunk "0" interpreted under GB drops the
	// trunk zero and prefixes +44.
	got, ok := normalizePhoneE164("07911 123456", "GB")
	if !ok || got != "+447911123456" {
		t.Errorf("got %q ok=%v, want +447911123456 true", got, ok)
	}
}

func TestIsE164(t *testing.T) {
	good := []string{"+14155552671", "+447911123456", "+919876543210"}
	for _, g := range good {
		if !isE164(g) {
			t.Errorf("%q should be valid E.164", g)
		}
	}
	bad := []string{"", "+", "14155552671", "+0123456", "+12", "+1415555267a", "+1234567890123456"}
	for _, b := range bad {
		if isE164(b) {
			t.Errorf("%q should be invalid E.164", b)
		}
	}
}

func TestApplyPhoneTransforms(t *testing.T) {
	cfg := IdentifierTransformConfig{PhoneE164Format: true, PhoneDefaultRegion: "US"}
	fields := map[string]any{
		"PHONE":          "(415) 555-2671",
		"favorite_color": "blue", // untouched: not a phone key
		"SMSNUMBER":      "+14155552671",
		"mobile":         12345, // non-string: skipped
	}
	changed := applyPhoneTransforms(fields, cfg)
	if changed != 1 {
		t.Errorf("changed = %d, want 1 (only PHONE rewritten; SMSNUMBER already E.164)", changed)
	}
	if fields["PHONE"] != "+14155552671" {
		t.Errorf("PHONE = %v, want +14155552671", fields["PHONE"])
	}
	if fields["favorite_color"] != "blue" {
		t.Errorf("favorite_color mutated: %v", fields["favorite_color"])
	}
	if fields["mobile"] != 12345 {
		t.Errorf("non-string mobile mutated: %v", fields["mobile"])
	}
}

func TestApplyPhoneTransforms_DisabledIsNoOp(t *testing.T) {
	cfg := IdentifierTransformConfig{} // phone off
	fields := map[string]any{"phone": "(415) 555-2671"}
	if changed := applyPhoneTransforms(fields, cfg); changed != 0 {
		t.Errorf("changed = %d, want 0 when disabled", changed)
	}
	if fields["phone"] != "(415) 555-2671" {
		t.Errorf("phone mutated while disabled: %v", fields["phone"])
	}
}

func TestApplyIdentifierTransforms_EmailAndPhone(t *testing.T) {
	cfg := IdentifierTransformConfig{
		EmailNormalizeDots: true,
		EmailNormalizePlus: true,
		PhoneE164Format:    true,
		PhoneDefaultRegion: "US",
	}
	email := "j.o.h.n+promo@gmail.com"
	merge := map[string]any{"PHONE": "415-555-2671"}
	custom := map[string]any{"mobile": "(212) 555-0100"}
	applyIdentifierTransforms(&email, merge, custom, cfg)
	if email != "john@gmail.com" {
		t.Errorf("email = %q, want john@gmail.com", email)
	}
	if merge["PHONE"] != "+14155552671" {
		t.Errorf("merge PHONE = %v, want +14155552671", merge["PHONE"])
	}
	if custom["mobile"] != "+12125550100" {
		t.Errorf("custom mobile = %v, want +12125550100", custom["mobile"])
	}
}

func TestValidRegionCode(t *testing.T) {
	if !validRegionCode("") {
		t.Error("empty region should be valid (no default)")
	}
	if !validRegionCode("us") {
		t.Error("us (lowercased) should be valid")
	}
	if !validRegionCode("GB") {
		t.Error("GB should be valid")
	}
	if validRegionCode("ZZ") {
		t.Error("ZZ should be invalid (unknown region)")
	}
}

func TestBuildTransformPreview(t *testing.T) {
	cfg := IdentifierTransformConfig{
		EmailNormalizePlus: true,
		PhoneE164Format:    true,
		PhoneDefaultRegion: "US",
	}
	in := PreviewTransformInput{
		Email:       "  Alice+News@Example.COM ",
		MergeFields: map[string]any{"phone": "415-555-2671"},
	}
	out := buildTransformPreview(in, cfg)
	if out.EmailOutput != "alice@example.com" {
		t.Errorf("email_output = %q, want alice@example.com", out.EmailOutput)
	}
	if !out.EmailChanged {
		t.Error("email_changed should be true")
	}
	if len(out.Phones) != 1 {
		t.Fatalf("len(phones) = %d, want 1", len(out.Phones))
	}
	p := out.Phones[0]
	if p.Output != "+14155552671" || !p.Changed {
		t.Errorf("phone preview = %+v, want +14155552671 changed", p)
	}
}

func TestBuildTransformPreview_NoConfig_LowercasesOnly(t *testing.T) {
	// With an all-off config the preview still reflects the unconditional
	// lowercase step (so the operator sees what ingest actually stores).
	out := buildTransformPreview(PreviewTransformInput{Email: "Bob@Example.com"}, IdentifierTransformConfig{})
	if out.EmailOutput != "bob@example.com" {
		t.Errorf("email_output = %q, want bob@example.com", out.EmailOutput)
	}
	if !out.EmailChanged {
		t.Error("email_changed should be true (casing changed)")
	}
}

// ---- handler validation branches (no DB) ----

func TestUpdateIdentifierTransforms_RequiresTenant(t *testing.T) {
	d := &Deps{}
	r := httptest.NewRequest("PATCH", "/api/v1/settings/identifier-transforms",
		strings.NewReader(`{"email_normalize_dots":true}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	d.UpdateIdentifierTransforms(w, r)
	if w.Code != 401 {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
}

func TestUpdateIdentifierTransforms_RejectsEmptyBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("PATCH", "/api/v1/settings/identifier-transforms",
		strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.UpdateIdentifierTransforms(w, r)
	if w.Code != 400 && w.Code != 422 {
		t.Errorf("status = %d, want 4xx for empty body", w.Code)
	}
	if !strings.Contains(w.Body.String(), "validation_failed") {
		t.Errorf("body = %q, want validation_failed", w.Body.String())
	}
}

func TestUpdateIdentifierTransforms_RejectsUnknownRegion(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("PATCH", "/api/v1/settings/identifier-transforms",
		strings.NewReader(`{"phone_e164_format":true,"phone_default_region":"ZZ"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.UpdateIdentifierTransforms(w, r)
	if w.Code != 400 && w.Code != 422 {
		t.Errorf("status = %d, want 4xx for unknown region", w.Code)
	}
	if !strings.Contains(w.Body.String(), "invalid_region") {
		t.Errorf("body = %q, want invalid_region", w.Body.String())
	}
}

func TestPreviewIdentifierTransforms_WithOverrides_NoDBNeeded(t *testing.T) {
	// Supplying overrides skips the repo load, so this exercises the full
	// handler without a database.
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{
		"email":"J.O.H.N+promo@Gmail.com",
		"merge_fields":{"phone":"415-555-2671"},
		"overrides":{"email_normalize_dots":true,"email_normalize_plus":true,"phone_e164_format":true,"phone_default_region":"US"}
	}`
	r := httptest.NewRequest("POST", "/api/v1/subscribers/preview-transforms",
		strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.PreviewIdentifierTransforms(w, r)
	if w.Code != 200 {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var out PreviewTransformResult
	if err := json.NewDecoder(w.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.EmailOutput != "john@gmail.com" {
		t.Errorf("email_output = %q, want john@gmail.com", out.EmailOutput)
	}
	if len(out.Phones) != 1 || out.Phones[0].Output != "+14155552671" {
		t.Errorf("phones = %+v, want one +14155552671", out.Phones)
	}
}

func TestGetIdentifierTransforms_RequiresTenant(t *testing.T) {
	d := &Deps{}
	r := httptest.NewRequest("GET", "/api/v1/settings/identifier-transforms", nil)
	w := httptest.NewRecorder()
	d.GetIdentifierTransforms(w, r)
	if w.Code != 401 {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
}
