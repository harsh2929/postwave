package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"

	"github.com/postwave/postwave/apps/api/internal/webvitals"
)

// unconditionalForwardedTrust matches TrustForwardedIPHeaders set to true, as a
// composite-literal field or by assignment.
var unconditionalForwardedTrust = regexp.MustCompile(`TrustForwardedIPHeaders\s*:?=?\s*true\b`)

func TestWebVitalsUsesGatewayTrustedProxyPosture(t *testing.T) {
	root := readAPICompositionRoot(t)
	// The handler is built once, in run(): a second construction anywhere in
	// the composition root would sit outside the region checked below.
	const construction = "webvitals.NewHandler("
	inRun, inRoot := strings.Count(root.run, construction), strings.Count(root.all, construction)
	if inRun != 1 || inRoot != 1 {
		t.Fatalf("%s appears %d time(s) in run() and %d in the composition root, want exactly once, in run()",
			construction, inRun, inRoot)
	}
	block := root.run
	start := strings.Index(block, "webVitalsHandler := webvitals.NewHandler")
	if start < 0 {
		t.Fatal("web-vitals handler construction is missing")
	}
	block = block[start:]
	if end := strings.Index(block, "r.Group(func"); end >= 0 {
		block = block[:end]
	}
	if !strings.Contains(block, "TrustForwardedIPHeaders: cfg.TrustForwardedIPHeaders") {
		t.Fatal("web-vitals limiter must use the gateway's reviewed trusted-proxy posture")
	}
	// Read with every helper the region calls, so a helper cannot turn the
	// trust back on after the construction above.
	if match := unconditionalForwardedTrust.FindString(root.withCalledFunctions(block)); match != "" {
		t.Fatalf("web-vitals limiter must not unconditionally trust forwarded headers (found %q)", match)
	}
}

func TestWebVitalsResponseProtectionPrecedesGlobalCORS(t *testing.T) {
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	protection := strings.Index(text, "r.Use(webvitals.ProtectResponses(webVitalsOrigins))")
	globalCORS := strings.Index(text, "r.Use(cors.Handler")
	if protection < 0 || globalCORS < 0 || protection > globalCORS {
		t.Fatal("web-vitals response protection must run before global CORS can answer preflights")
	}
}

func TestWebVitalsPreflightUsesNarrowOriginPolicyBeforeGlobalCORS(t *testing.T) {
	router := chi.NewRouter()
	router.Use(webvitals.ProtectResponses([]string{"https://app.moosewave.com"}))
	router.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"https://app.moosewave.com", "https://marketing.moosewave.com"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Content-Type", "Authorization"},
		AllowCredentials: true,
	}))
	handler := webvitals.NewHandler(&webvitals.Deps{
		AllowedOrigins: []string{"https://app.moosewave.com"},
	})
	router.Method(http.MethodPost, "/api/internal/web-vitals", handler)
	router.Method(http.MethodOptions, "/api/internal/web-vitals", handler)

	for _, tc := range []struct {
		name       string
		origin     string
		wantOrigin string
	}{
		{
			name:       "endpoint origin is granted",
			origin:     "https://app.moosewave.com",
			wantOrigin: "https://app.moosewave.com",
		},
		{
			name:       "gateway-only origin is denied",
			origin:     "https://marketing.moosewave.com",
			wantOrigin: "",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodOptions, "/api/internal/web-vitals", nil)
			request.Header.Set("Origin", tc.origin)
			request.Header.Set("Access-Control-Request-Method", http.MethodPost)
			request.Header.Set("Access-Control-Request-Headers", "Content-Type, Authorization")
			response := httptest.NewRecorder()

			router.ServeHTTP(response, request)

			if response.Code != http.StatusNoContent {
				t.Fatalf("status = %d, want %d", response.Code, http.StatusNoContent)
			}
			if got := response.Header().Get("Access-Control-Allow-Origin"); got != tc.wantOrigin {
				t.Fatalf("Access-Control-Allow-Origin = %q, want %q", got, tc.wantOrigin)
			}
			if tc.wantOrigin != "" {
				if got := response.Header().Get("Access-Control-Allow-Methods"); got != "POST, OPTIONS" {
					t.Fatalf("Access-Control-Allow-Methods = %q", got)
				}
				if got := response.Header().Get("Access-Control-Allow-Headers"); got != "Content-Type" {
					t.Fatalf("Access-Control-Allow-Headers = %q", got)
				}
			}
			if got := response.Header().Get("Cache-Control"); got != "private, no-store" {
				t.Fatalf("Cache-Control = %q", got)
			}
			if got := response.Header().Get("X-Content-Type-Options"); got != "nosniff" {
				t.Fatalf("X-Content-Type-Options = %q", got)
			}
		})
	}
}
