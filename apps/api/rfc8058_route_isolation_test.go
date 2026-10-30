// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestMandatoryOneClickRouteIsolatedFromSharedPublicIPBudget(t *testing.T) {
	t.Parallel()

	router := chi.NewRouter()
	shared := middleware.NewRateLimit(10, time.Minute)
	router.With(shared.Middleware).Post("/api/public/shared", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	var honoured atomic.Int32
	router.With(httpcache.WithPolicy(httpcache.Mutation())).
		Post("/api/public/preferences/{token}/one-click", func(w http.ResponseWriter, r *http.Request) {
			if token := chi.URLParam(r, "token"); token != "opaque-recipient-capability" {
				t.Errorf("token = %q", token)
			}
			honoured.Add(1)
			w.WriteHeader(http.StatusOK)
		})

	// More requests than the legacy shared 10/min/IP budget must all reach the
	// mandatory receiver, even from one mailbox-provider egress address.
	for attempt := 0; attempt < 25; attempt++ {
		req := httptest.NewRequest(
			http.MethodPost,
			"/api/public/preferences/opaque-recipient-capability/one-click",
			strings.NewReader("List-Unsubscribe=One-Click"),
		)
		req.RemoteAddr = "203.0.113.20:443"
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("one-click attempt %d status = %d, body=%s", attempt+1, res.Code, res.Body.String())
		}
		if got := res.Header().Get("Cache-Control"); got != "private, no-store" {
			t.Fatalf("one-click attempt %d Cache-Control = %q", attempt+1, got)
		}
		if got := res.Header().Get("X-RateLimit-Limit"); got != "" {
			t.Fatalf("one-click attempt %d inherited shared rate-limit headers: %q", attempt+1, got)
		}
	}
	if got := honoured.Load(); got != 25 {
		t.Fatalf("honoured one-click requests = %d, want 25", got)
	}

	// The ordinary public route still owns its 10/min/IP abuse budget. This
	// proves isolation rather than accidental global limiter removal.
	for attempt := 0; attempt < 11; attempt++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/shared", nil)
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

func TestProductionOneClickMountPrecedesSharedPublicLimiterGroup(t *testing.T) {
	t.Parallel()
	root := readAPICompositionRoot(t)
	source := root.main
	pathLiteral := `"/api/public/preferences/{token}/one-click"`
	if inRun, inRoot := strings.Count(root.run, pathLiteral), strings.Count(root.all, pathLiteral); inRun != 1 || inRoot != 1 {
		t.Fatalf("one-click production mounts = %d in run() and %d in the composition root, want exactly one, "+
			"in run()", inRun, inRoot)
	}
	mountAt := strings.Index(source, pathLiteral)
	sharedGroupAt := strings.Index(source, "// Remaining public routes — no auth and no tenant context.")
	if mountAt < 0 || sharedGroupAt < 0 || mountAt >= sharedGroupAt {
		t.Fatal("RFC 8058 mount is not isolated before the shared public limiter group")
	}
	windowStart := mountAt - 256
	if windowStart < 0 {
		windowStart = 0
	}
	mountWindow := source[windowStart : mountAt+len(pathLiteral)]
	if !strings.Contains(mountWindow, "httpcache.WithPolicy(httpcache.Mutation())") {
		t.Fatal("RFC 8058 production mount lost explicit no-store mutation policy")
	}
}
