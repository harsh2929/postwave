package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/audit"
)

func TestPortalCSPAllowsOnlyExactHTTPSAncestors(t *testing.T) {
	csp := portalCSP("'self' https://customer.example https://embed.example:8443")
	for _, want := range []string{"frame-ancestors 'self' https://customer.example https://embed.example:8443", "default-src 'none'", "connect-src 'self'", "img-src 'self' data:;"} {
		if !strings.Contains(csp, want) {
			t.Fatalf("CSP %q does not contain %q", csp, want)
		}
	}
}

func TestPortalCSPNoneFailsClosed(t *testing.T) {
	if got := portalCSP("https://customer.example 'none'"); !strings.HasSuffix(got, "frame-ancestors 'none'") {
		t.Fatalf("explicit none must fail closed, got %q", got)
	}
	if got := portalCSP("*"); !strings.HasSuffix(got, "frame-ancestors 'none'") {
		t.Fatalf("invalid list must fail closed, got %q", got)
	}
}

func TestValidatePortalFrameAncestors(t *testing.T) {
	for _, valid := range []string{"", "'none'", "'self'", "https://customer.example https://second.example:8443"} {
		if err := ValidatePortalFrameAncestors(valid); err != nil {
			t.Errorf("valid %q: %v", valid, err)
		}
	}
	for _, invalid := range []string{"*", "https://*.example", "http://customer.example", "https://customer.example/path", "'none' https://customer.example"} {
		if err := ValidatePortalFrameAncestors(invalid); err == nil {
			t.Errorf("expected %q to be rejected", invalid)
		}
	}
}

func TestPortalBrandingValuesAreConstrained(t *testing.T) {
	if got := safePortalColor(`url(https://tracker.example/pixel)`); got != "#1d4ed8" {
		t.Fatalf("unsafe color survived: %q", got)
	}
	if got := safePortalColor("#C8102E"); got != "#C8102E" {
		t.Fatalf("valid color changed: %q", got)
	}
	if got := safePortalColor("#FFFFFF"); got != "#1d4ed8" {
		t.Fatalf("low-contrast color survived: %q", got)
	}
	for _, value := range []string{
		"safe\u061cspoof", "safe\u200espoof", "safe\u200fspoof", "safe\u202espoof",
		"safe\u2061spoof", "safe\u206aspoof",
	} {
		if got := safePortalBrandName(value); got != "Audit Portal" {
			t.Errorf("bidi-marked brand %q survived as %q", value, got)
		}
	}
}

func TestPortalBrandingDisabledIsAlwaysNeutral(t *testing.T) {
	brand := "Secret Draft Brand"
	color := "#000000"
	support := "private@example.com"
	got := portalBrandingProjection(false, &brand, &color, &support)
	if got.brandName != "Audit Portal" || got.logoURL != "" ||
		got.primaryColor != "#1d4ed8" || got.supportEmail != "" {
		t.Fatalf("disabled branding leaked stored draft: %+v", got)
	}
}

func TestPortalBrandingEnabledUsesOnlyValidatedProjection(t *testing.T) {
	brand := "Customer Audit"
	color := "#1D4ED8"
	support := "audit@customer.example"
	got := portalBrandingProjection(true, &brand, &color, &support)
	if got.brandName != brand || got.logoURL != "" || got.primaryColor != color ||
		got.supportEmail != support {
		t.Fatalf("enabled valid branding projection = %+v", got)
	}
	badBrand := "spoof\u202e"
	badColor := "#FFFFFF"
	badSupport := "Display <audit@customer.example>"
	got = portalBrandingProjection(true, &badBrand, &badColor, &badSupport)
	if got.brandName != "Audit Portal" || got.logoURL != "" ||
		got.primaryColor != "#1d4ed8" || got.supportEmail != "" {
		t.Fatalf("unsafe enabled branding was not neutralized: %+v", got)
	}
}

func TestAuditPortalServeSPAHeadersPermitConfiguredEmbedding(t *testing.T) {
	h := &AuditPortalHandlers{FrameAncestors: "https://customer.example"}
	req := httptest.NewRequest(http.MethodGet, "https://portal.example/portal/audit", nil)
	rr := httptest.NewRecorder()
	h.ServeSPA(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("Cache-Control=%q", got)
	}
	if got := rr.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy=%q", got)
	}
	if got := rr.Header().Get("X-Frame-Options"); got != "" {
		t.Fatalf("legacy X-Frame-Options conflicts with frame-ancestors: %q", got)
	}
	if got := rr.Header().Get("Content-Security-Policy"); !strings.Contains(got, "frame-ancestors https://customer.example") {
		t.Fatalf("CSP=%q", got)
	}
}

func TestAuditPortalExchangeOriginAndBodyFailClosed(t *testing.T) {
	h := &AuditPortalHandlers{PortalOrigin: "https://portal.example"}

	t.Run("wrong origin", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "https://portal.example/api/v1/audit/portal/exchange", strings.NewReader(`{"bootstrap":"abc"}`))
		req.Header.Set("Origin", "https://attacker.example")
		rr := httptest.NewRecorder()
		h.Exchange(rr, req)
		if rr.Code != http.StatusForbidden {
			t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
		}
	})

	t.Run("unknown field", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "https://portal.example/api/v1/audit/portal/exchange", strings.NewReader(`{"bootstrap":"abc","token":"smuggled"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "https://portal.example")
		rr := httptest.NewRecorder()
		h.Exchange(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
		}
	})

	t.Run("oversized", func(t *testing.T) {
		body := `{"bootstrap":"` + strings.Repeat("x", portalExchangeLimit) + `"}`
		req := httptest.NewRequest(http.MethodPost, "https://portal.example/api/v1/audit/portal/exchange", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "https://portal.example")
		rr := httptest.NewRecorder()
		h.Exchange(rr, req)
		if rr.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
		}
	})

	t.Run("durable store required", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "https://portal.example/api/v1/audit/portal/exchange", strings.NewReader(`{"bootstrap":"a.b.c"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "https://PORTAL.example")
		rr := httptest.NewRecorder()
		h.Exchange(rr, req)
		if rr.Code != http.StatusServiceUnavailable {
			t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
		}
	})
}

func TestAuditPortalCookieSecurityAttributes(t *testing.T) {
	h := &AuditPortalHandlers{PortalOrigin: "https://portal.example"}
	c := h.portalCookie("opaque", time.Now().Add(time.Hour))
	if c.Name != portalCookieName || !c.HttpOnly || !c.Secure || !c.Partitioned || c.SameSite != http.SameSiteNoneMode || c.Path != "/" {
		t.Fatalf("insecure production portal cookie: %#v", c)
	}
}

func TestAuditPortalMiddlewareRejectsCredentialSmuggling(t *testing.T) {
	h := &AuditPortalHandlers{PortalOrigin: "https://portal.example"}
	called := false
	next := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true })
	req := httptest.NewRequest(http.MethodGet, "https://portal.example/api/v1/audit/portal/events", nil)
	req.Header.Set("Authorization", "Bearer should-not-be-accepted")
	req.AddCookie(&http.Cookie{Name: portalCookieName, Value: "a.b.c"})
	rr := httptest.NewRecorder()
	h.RequirePortalSession(next).ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized || called {
		t.Fatalf("status=%d called=%v body=%s", rr.Code, called, rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), "should-not-be-accepted") {
		t.Fatal("response reflected a credential")
	}
}

func TestAuditPortalEvidenceReleaseHoldNeverReturnsEvidence(t *testing.T) {
	t.Parallel()

	h := &AuditPortalHandlers{}
	payload := &audit.SessionPayload{
		TenantID:  "00000000-0000-4000-8000-000000000001",
		Scope:     audit.PortalScope,
		SessionID: "00000000-0000-4000-8000-000000000002",
		ExpiresAt: time.Now().Add(time.Hour),
	}
	paths := []string{
		"https://portal.example/api/v1/audit/portal/events?action=must-not-echo",
		"https://portal.example/api/v1/audit/portal/ai-session/must-not-echo/aivs-bundle",
	}

	for _, path := range paths {
		path := path
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			ctx := audit.WithPortalSession(context.Background(), payload)
			req = req.WithContext(ctx)
			if _, ok := audit.PortalSessionFromContext(req.Context()); !ok {
				t.Fatal("test request is missing its authorized portal context")
			}

			rr := httptest.NewRecorder()
			h.EvidenceReleaseHold(rr, req)

			if rr.Code != http.StatusServiceUnavailable {
				t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
			}
			if got := rr.Header().Get("Cache-Control"); got != "no-store, private, max-age=0" {
				t.Fatalf("Cache-Control=%q", got)
			}
			if got := rr.Header().Get("Pragma"); got != "no-cache" {
				t.Fatalf("Pragma=%q", got)
			}
			var out struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if out.Error.Code != "service_unavailable" ||
				out.Error.Message != "audit portal evidence is not available in this release" {
				t.Fatalf("unexpected response: %#v", out.Error)
			}
			for _, forbidden := range []string{"must-not-echo", payload.TenantID, payload.SessionID, `"rows"`, `"bundle"`} {
				if strings.Contains(rr.Body.String(), forbidden) {
					t.Fatalf("release-hold response leaked %q: %s", forbidden, rr.Body.String())
				}
			}
		})
	}
}
