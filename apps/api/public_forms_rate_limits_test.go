// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type publicFormsMemoryWindowStore struct {
	mu     sync.Mutex
	counts map[string]int
}

func (s *publicFormsMemoryWindowStore) Reserve(
	_ context.Context,
	key string,
	_ int,
	window time.Duration,
	now time.Time,
) (int, time.Time, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.counts == nil {
		s.counts = make(map[string]int)
	}
	s.counts[key]++
	return s.counts[key], now.Add(window), nil
}

func (s *publicFormsMemoryWindowStore) count(key string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.counts[key]
}

func TestPublicFormsRateLimitsKeepRendersAndAbuseBucketsIndependent(t *testing.T) {
	t.Parallel()

	store := &publicFormsMemoryWindowStore{}
	limits := newPublicFormsRateLimits(middleware.RateLimitOptions{Store: store})
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	render := limits.render.Middleware(ok)
	submit := limits.submit.Middleware(ok)
	confirm := limits.confirm.Middleware(ok)

	// Model the production failure topology: unrelated visitors are rendered by
	// one web process and therefore reach the API with the same TCP peer. More
	// than ten renders must remain healthy and must not spend submit capacity.
	for i := 0; i < 25; i++ {
		request := httptest.NewRequest(http.MethodGet, "/api/public/forms/form", nil)
		request.RemoteAddr = "10.0.0.9:443"
		// Untrusted forwarding data does not create fresh buckets by default.
		request.Header.Set("X-Forwarded-For", "198.51.100."+strconv.Itoa(i+1))
		response := httptest.NewRecorder()
		render.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("render %d status = %d, want 200", i+1, response.Code)
		}
	}

	for i := 0; i < publicFormSubmitRequestsPerMinute; i++ {
		response := servePublicFormsLimit(t, submit, http.MethodPost, "/api/public/forms/form/submit")
		if response.Code != http.StatusOK {
			t.Fatalf("submit %d status = %d, want 200", i+1, response.Code)
		}
	}
	overLimit := servePublicFormsLimit(t, submit, http.MethodPost, "/api/public/forms/form/submit")
	if overLimit.Code != http.StatusTooManyRequests {
		t.Fatalf("submit over limit status = %d, want 429", overLimit.Code)
	}
	if overLimit.Header().Get("Retry-After") == "" {
		t.Fatal("submit 429 is missing Retry-After")
	}

	// Submit abuse cannot starve a legitimate token confirmation.
	confirmed := servePublicFormsLimit(t, confirm, http.MethodGet, "/api/public/forms/confirm/token")
	if confirmed.Code != http.StatusOK {
		t.Fatalf("confirm after submit exhaustion status = %d, want 200", confirmed.Code)
	}
	for i := 1; i < publicFormConfirmRequestsPerMinute; i++ {
		response := servePublicFormsLimit(t, confirm, http.MethodGet, "/api/public/forms/confirm/token")
		if response.Code != http.StatusOK {
			t.Fatalf("confirm %d status = %d, want 200", i+1, response.Code)
		}
	}
	confirmOverLimit := servePublicFormsLimit(t, confirm, http.MethodGet, "/api/public/forms/confirm/token")
	if confirmOverLimit.Code != http.StatusTooManyRequests {
		t.Fatalf("confirm over limit status = %d, want 429", confirmOverLimit.Code)
	}

	if got := store.count("ip:forms-render:ip:10.0.0.9"); got != 25 {
		t.Fatalf("render bucket count = %d, want 25", got)
	}
	if got := store.count("ip:forms-submit:ip:10.0.0.9"); got != 11 {
		t.Fatalf("submit bucket count = %d, want 11", got)
	}
	if got := store.count("ip:forms-confirm:ip:10.0.0.9"); got != publicFormConfirmRequestsPerMinute+1 {
		t.Fatalf("confirm bucket count = %d, want %d", got, publicFormConfirmRequestsPerMinute+1)
	}
}

func TestPublicFormsRoutesUseDedicatedLimitersInComposition(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	source := root.main

	for _, marker := range []string{
		`r.With(publicFormsLimits.render.Middleware, httpcache.Conditional()).`,
		`Get("/api/public/forms/{slug}"`,
		`r.With(publicFormsLimits.submit.Middleware).`,
		`Post("/api/public/forms/{slug}/submit"`,
		`r.With(publicFormsLimits.confirm.Middleware).`,
		`Get("/api/public/forms/confirm/{token}"`,
		`r.With(publicFormsLimits.upload.Middleware).`,
		`Post("/api/public/forms/{slug}/upload-url"`,
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("main.go is missing public Forms rate-limit marker %q", marker)
		}
	}
	for _, route := range []string{
		`r.Get("/api/public/forms/{slug}"`,
		`r.Post("/api/public/forms/{slug}/submit"`,
		`r.Get("/api/public/forms/confirm/{token}"`,
		`r.Post("/api/public/forms/{slug}/upload-url"`,
	} {
		if strings.Contains(root.all, route) {
			t.Fatalf("Forms route bypasses its dedicated limiter via %q", route)
		}
	}
}

func servePublicFormsLimit(
	t *testing.T,
	handler http.Handler,
	method string,
	path string,
) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, nil)
	request.RemoteAddr = "10.0.0.9:443"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
