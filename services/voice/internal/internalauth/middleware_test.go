package internalauth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMiddlewareRequiresBearerWhenTokenConfigured(t *testing.T) {
	handler := Middleware("secret")(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for _, tc := range []struct {
		name   string
		header string
		want   int
	}{
		{name: "missing", want: http.StatusUnauthorized},
		{name: "wrong", header: "Bearer nope", want: http.StatusUnauthorized},
		{name: "valid", header: "Bearer secret", want: http.StatusNoContent},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/voice/sources", nil)
			req.RemoteAddr = "203.0.113.10:49152"
			if tc.header != "" {
				req.Header.Set("Authorization", tc.header)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d", rec.Code, tc.want)
			}
		})
	}
}

func TestMiddlewareLeavesHealthPublic(t *testing.T) {
	handler := Middleware("secret")(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.RemoteAddr = "203.0.113.10:49152"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}
}

func TestParseTokensSplitsAndDedups(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"", 0},
		{"   ", 0},
		{"only", 1},
		{"a,b", 2},
		{" a , b ", 2},
		{"a,a,b", 2},
		{"a,,b,", 2},
	}
	for _, tc := range cases {
		if got := len(parseTokens(tc.in)); got != tc.want {
			t.Errorf("parseTokens(%q) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestMiddlewareAcceptsAnyOfMultipleTokens(t *testing.T) {
	handler := Middleware("old-token,new-token")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !IsInternalBearerAuth(r.Context()) {
			t.Fatal("expected ctx to record bearer auth mode")
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	for _, token := range []string{"old-token", "new-token"} {
		req := httptest.NewRequest(http.MethodGet, "/v1/voice/sources", nil)
		req.RemoteAddr = "203.0.113.10:49152"
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Errorf("rotation token %q rejected: status=%d", token, rec.Code)
		}
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/voice/sources", nil)
	req.RemoteAddr = "203.0.113.10:49152"
	req.Header.Set("Authorization", "Bearer not-a-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("unknown token = %d, want 401", rec.Code)
	}
	if !strings.EqualFold(rec.Header().Get("WWW-Authenticate"), "Bearer") {
		t.Error("missing WWW-Authenticate: Bearer challenge on 401")
	}
}

func TestMiddlewareUnsetTokenAllowsOnlyLoopback(t *testing.T) {
	handler := Middleware("")(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for _, tc := range []struct {
		name       string
		remoteAddr string
		want       int
	}{
		{name: "loopback", remoteAddr: "127.0.0.1:49152", want: http.StatusNoContent},
		{name: "private-not-loopback", remoteAddr: "10.0.0.4:49152", want: http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/voice/sources", nil)
			req.RemoteAddr = tc.remoteAddr
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d", rec.Code, tc.want)
			}
		})
	}
}
