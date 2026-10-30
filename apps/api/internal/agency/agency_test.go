// SPDX-License-Identifier: AGPL-3.0-only

package agency

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type replaySpy struct{ calls int }

func (s *replaySpy) Get(context.Context, string, string) (*idempotency.Record, error) {
	s.calls++
	return nil, idempotency.ErrNotFound
}
func (s *replaySpy) Claim(context.Context, *idempotency.Record) (bool, error) {
	s.calls++
	return true, nil
}
func (s *replaySpy) Complete(context.Context, *idempotency.Record) error {
	s.calls++
	return nil
}
func (s *replaySpy) DeletePending(context.Context, string, string) error {
	s.calls++
	return nil
}

func TestNormalizeHexColorContract(t *testing.T) {
	for _, value := range []string{"#1d4ed8", "#ABCDEF", "#000000"} {
		if _, ok := normalizeHexColor(value); !ok {
			t.Errorf("expected %q to be valid", value)
		}
	}
	for _, value := range []string{"", "#abc", "1d4ed8", "#12345g", "#1234567"} {
		if _, ok := normalizeHexColor(value); ok {
			t.Errorf("expected %q to be invalid", value)
		}
	}
	if !colorHasWhiteTextContrast("#1D4ED8") {
		t.Fatal("canonical dark blue must retain readable white text")
	}
	if colorHasWhiteTextContrast("#FFFFFF") {
		t.Fatal("white-on-white must fail the 4.5:1 contrast floor")
	}
}
func TestAgencyJSONRejectsDuplicateMembersAtAnyDepth(t *testing.T) {
	for _, body := range []string{
		`{"mode":"self","mode":"parent"}`,
		`{"outer":{"key":1,"key":2}}`,
		`{"items":[{"key":1,"key":2}]}`,
	} {
		if err := decodeAgencyJSON([]byte(body)); err == nil || !strings.Contains(err.Error(), "duplicate") {
			t.Errorf("body %s: err=%v", body, err)
		}
	}
	if err := decodeAgencyJSON([]byte(`{"mode":"self","nested":{"key":1}}`)); err != nil {
		t.Fatalf("unambiguous JSON rejected: %v", err)
	}
}

func TestAgencyInputValidation(t *testing.T) {
	if !validWorkspaceSlug("valid-child-01") || validWorkspaceSlug("Bad_Slug") ||
		validWorkspaceSlug("-edge") || validWorkspaceSlug(strings.Repeat("a", 41)) {
		t.Fatal("workspace slug grammar drifted")
	}
	for _, value := range []string{
		"safe\u061cspoof", "safe\u200espoof", "safe\u200fspoof", "safe\u202espoof",
		"safe\u2061spoof", "safe\u206aspoof", "line\nbreak",
	} {
		if validBoundedText(value, 1, 120) {
			t.Errorf("invisible/control text %q must be rejected", value)
		}
	}
	for _, domain := range []string{"brand.example.com", "xn--bcher-kva.example.com"} {
		if _, ok := normalizeCustomDomain(domain); !ok {
			t.Errorf("valid custom domain %q rejected", domain)
		}
	}
	for _, domain := range []string{
		"localhost", "127.0.0.1", "127.1", "0177.0.0.1", "0x7f.0.0.1",
		"brand.local", "https://brand.example.com", "*.example.com",
	} {
		if _, ok := normalizeCustomDomain(domain); ok {
			t.Errorf("unsafe custom domain %q accepted", domain)
		}
	}
	for _, logo := range []string{
		"http://assets.example.com/logo.svg",
		"https://127.0.0.1/logo.svg",
		"https://127.1/logo.svg",
		"https://0177.0.0.1/logo.svg",
		"https://0x7f.0.0.1/logo.svg",
		"https://assets.local/logo.svg",
		"https://user:secret@assets.example.com/logo.svg",
		"https://assets.example.com:443/logo.svg",
		"https://assets.example.com/logo.svg?tracking=1",
		"https://assets.example.com/logo.svg#fragment",
	} {
		if _, ok := normalizeLogoURL(logo); ok {
			t.Errorf("unsafe logo URL %q accepted", logo)
		}
	}
	if got, ok := normalizeLogoURL("https://assets.example.com/logo.svg"); !ok || got != "https://assets.example.com/logo.svg" {
		t.Fatalf("valid logo URL normalized to %q ok=%v", got, ok)
	}
}

func TestBrandingPatchReleaseHoldAndPrecondition(t *testing.T) {
	handler := (&Deps{}).UpdateBranding
	request := func(body, ifMatch string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPatch, "/api/v1/agency/branding", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if ifMatch != "" {
			req.Header.Set("If-Match", ifMatch)
		}
		ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{
			ID: "11111111-1111-1111-1111-111111111111",
		})
		req = req.WithContext(ctx)
		recorder := httptest.NewRecorder()
		handler(recorder, req)
		return recorder
	}

	missing := request(`{"brand_name":"Safe Brand"}`, "")
	if missing.Code != http.StatusPreconditionRequired ||
		missing.Header().Get(MutationOutcomeHeader) != mutationOutcomeNotCommitted {
		t.Fatalf("missing precondition: status=%d outcome=%q body=%s", missing.Code,
			missing.Header().Get(MutationOutcomeHeader), missing.Body.String())
	}
	duplicate := request(`{"brand_name":"A","brand_name":"B"}`, `"agency-branding:x:v1"`)
	if duplicate.Code != http.StatusBadRequest ||
		duplicate.Header().Get(MutationOutcomeHeader) != mutationOutcomeNotCommitted ||
		!strings.Contains(duplicate.Body.String(), "duplicate_json_key") {
		t.Fatalf("duplicate: status=%d outcome=%q body=%s", duplicate.Code,
			duplicate.Header().Get(MutationOutcomeHeader), duplicate.Body.String())
	}
	held := request(`{"brand_name":"Safe Brand","primary_color":"#1D4ED8"}`, `"agency-branding:x:v1"`)
	if held.Code != http.StatusServiceUnavailable || held.Header().Get("Retry-After") != "" ||
		held.Header().Get(MutationOutcomeHeader) != mutationOutcomeNotCommitted ||
		!strings.Contains(held.Body.String(), "agency_branding_update_release_hold") {
		t.Fatalf("hold: status=%d outcome=%q retry=%q body=%s", held.Code,
			held.Header().Get(MutationOutcomeHeader), held.Header().Get("Retry-After"), held.Body.String())
	}
}

func TestProtectResponsesCoversUpstreamRefusals(t *testing.T) {
	wrapped := ProtectResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=3600")
		http.Error(w, "denied", http.StatusUnauthorized)
	}))
	recorder := httptest.NewRecorder()
	wrapped.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/agency/children", nil))
	if recorder.Header().Get("Cache-Control") != "private, no-store" ||
		recorder.Header().Get("Pragma") != "no-cache" ||
		recorder.Header().Get("Expires") != "0" ||
		recorder.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("private headers missing: %v", recorder.Header())
	}
	vary := strings.Join(recorder.Header().Values("Vary"), ",")
	if !strings.Contains(vary, "Authorization") || !strings.Contains(vary, "Cookie") {
		t.Fatalf("Vary=%q", vary)
	}
}

func TestHeldMutationReplayBypassIsExactAndTouchesNoLedger(t *testing.T) {
	cases := []struct {
		method string
		path   string
		want   bool
	}{
		{http.MethodPost, "/api/v1/agency/children", true},
		{http.MethodPost, "/api/v1/agency/billing-mode", true},
		{http.MethodPatch, "/api/v1/agency/branding", true},
		{http.MethodDelete, "/api/v1/agency/children/11111111-1111-1111-1111-111111111111", true},
		{http.MethodGet, "/api/v1/agency/children", false},
		{http.MethodPost, "/api/v1/agency/children/", false},
		{http.MethodDelete, "/api/v1/agency/children/a/b", false},
		{http.MethodPatch, "/api/v1/agency/branding/", false},
	}
	for _, test := range cases {
		req := httptest.NewRequest(test.method, test.path, nil)
		if got := MutationGlobalReplayBypass(req, nil); got != test.want {
			t.Errorf("%s %s bypass=%v want %v", test.method, test.path, got, test.want)
		}
		if got := MutationGlobalReplayBypass(req, []byte(`{"ignored":true}`)); got != test.want {
			t.Errorf("%s %s body-bearing bypass=%v want %v", test.method, test.path, got, test.want)
		}
	}

	spy := &replaySpy{}
	handler := http.HandlerFunc((&Deps{}).UpdateBranding)
	wrapped := idempotency.ProcessWithReplayBypassAndHandlerOwnedReplayAndBodyLimit(
		spy,
		func(*http.Request) (string, bool) { return "11111111-1111-1111-1111-111111111111", true },
		MutationGlobalReplayBypass,
		nil,
		nil,
	)(handler)
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/agency/branding",
		strings.NewReader(`{"brand_name":"Safe Brand"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-Match", `"agency-branding:test:v0"`)
	req.Header.Add("Idempotency-Key", "legacy-one")
	req.Header.Add("Idempotency-Key", "legacy-two")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: "11111111-1111-1111-1111-111111111111",
	}))
	recorder := httptest.NewRecorder()
	wrapped.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusServiceUnavailable ||
		recorder.Header().Get(MutationOutcomeHeader) != mutationOutcomeNotCommitted || spy.calls != 0 {
		t.Fatalf("held replay bypass status=%d outcome=%q ledger_calls=%d body=%s",
			recorder.Code, recorder.Header().Get(MutationOutcomeHeader), spy.calls, recorder.Body.String())
	}
}
