// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/consent"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestHostedPreferenceNoStoreSurvivesConditionalComposition(t *testing.T) {
	t.Parallel()
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"email":"person@example.test"}`)
	})
	handler := consent.ProtectSensitiveResponses(
		httpcache.Conditional()(
			httpcache.WithPolicy(httpcache.Mutation())(inner),
		),
	)
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		request := httptest.NewRequest(
			method,
			"/api/public/preferences/recipient-capability",
			nil,
		)
		request.Header.Set("If-None-Match", `W/"stale-sensitive-body"`)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Errorf("%s status=%d want=200", method, recorder.Code)
		}
		if got := recorder.Header().Get("Cache-Control"); got != "private, no-store" {
			t.Errorf("%s Cache-Control=%q", method, got)
		}
		if got := recorder.Header().Get("ETag"); got != "" {
			t.Errorf("%s synthesized a sensitive ETag %q", method, got)
		}
	}
}

func TestProductionHostedPreferenceMountsUseExplicitNoStorePolicy(t *testing.T) {
	t.Parallel()
	root := readAPICompositionRoot(t)
	source := root.main
	sharedGroupAt := strings.Index(source, "// Remaining public routes — no auth and no tenant context.")
	if sharedGroupAt < 0 {
		t.Fatal("shared public limiter group marker missing")
	}
	guardAt := strings.LastIndex(source[:sharedGroupAt], "r.Use(consent.ProtectSensitiveResponses)")
	if guardAt < 0 {
		t.Fatal("dedicated hosted-preference group lacks sensitive response guard")
	}
	for _, mount := range []string{
		`Get("/api/public/preferences/{token}", prefPublic.PublicLookup)`,
		`Post("/api/public/preferences/{token}", prefPublic.PublicUpdate)`,
		`Post("/api/public/preferences/{token}/frequency", prefPublic.PublicSmartUnsubscribe)`,
		`Post("/api/public/preferences/{token}/one-click", prefPublic.PublicOneClickUnsubscribe)`,
	} {
		if inRun, inRoot := strings.Count(root.run, mount), strings.Count(root.all, mount); inRun != 1 || inRoot != 1 {
			t.Fatalf("production mount count = %d in run() and %d in the composition root, want exactly one, "+
				"in run(): %s", inRun, inRoot, mount)
		}
		index := strings.Index(source, mount)
		if index >= sharedGroupAt {
			t.Fatalf("production mount remains inside shared public limiter group: %s", mount)
		}
		if index <= guardAt {
			t.Fatalf("production mount is not protected by dedicated sensitive response guard: %s", mount)
		}
		windowStart := index - 100
		if windowStart < 0 {
			windowStart = 0
		}
		if !strings.Contains(source[windowStart:index], "httpcache.WithPolicy(httpcache.Mutation())") {
			t.Fatalf("production mount lacks explicit no-store policy: %s", mount)
		}
	}
}

func TestHostedPreferenceRoutesAreIsolatedFromSharedPublicIPBudget(t *testing.T) {
	t.Parallel()

	router := chi.NewRouter()
	shared := middleware.NewRateLimit(10, time.Minute)
	router.With(shared.Middleware).Get("/api/public/shared", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	var reached atomic.Int32
	router.Group(func(r chi.Router) {
		r.Use(consent.ProtectSensitiveResponses)
		r.With(httpcache.WithPolicy(httpcache.Mutation())).
			Get("/api/public/preferences/{token}", func(w http.ResponseWriter, r *http.Request) {
				if token := chi.URLParam(r, "token"); token != "opaque-recipient-capability" {
					t.Errorf("token = %q", token)
				}
				reached.Add(1)
				w.WriteHeader(http.StatusOK)
			})
	})

	// The canonical web proxy can collapse many recipients onto one API-facing
	// address. More than the legacy shared budget must still reach the recipient-
	// bound capability handler without inheriting shared rate-limit headers.
	for attempt := 0; attempt < 25; attempt++ {
		req := httptest.NewRequest(
			http.MethodGet,
			"/api/public/preferences/opaque-recipient-capability",
			nil,
		)
		req.RemoteAddr = "203.0.113.20:443"
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("hosted preference attempt %d status = %d", attempt+1, res.Code)
		}
		if got := res.Header().Get("Cache-Control"); got != "private, no-store" {
			t.Fatalf("hosted preference attempt %d Cache-Control = %q", attempt+1, got)
		}
		if got := res.Header().Get("X-RateLimit-Limit"); got != "" {
			t.Fatalf("hosted preference attempt %d inherited shared rate-limit headers: %q", attempt+1, got)
		}
	}
	if got := reached.Load(); got != 25 {
		t.Fatalf("hosted preference requests reaching handler = %d, want 25", got)
	}

	// An ordinary public route retains the shared 10/min/IP abuse boundary.
	for attempt := 0; attempt < 11; attempt++ {
		req := httptest.NewRequest(http.MethodGet, "/api/public/shared", nil)
		req.RemoteAddr = "203.0.113.20:443"
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		want := http.StatusNoContent
		if attempt == 10 {
			want = http.StatusTooManyRequests
		}
		if res.Code != want {
			t.Fatalf("shared attempt %d status = %d, want %d", attempt+1, res.Code, want)
		}
	}
}
