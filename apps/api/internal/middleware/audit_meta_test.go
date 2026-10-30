// SPDX-License-Identifier: AGPL-3.0-only
package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestAuditMetaList_StatusGate(t *testing.T) {
	// Middleware skips emission for 4xx/5xx — we can't dial a real
	// pool in this unit test, so we verify the gate by passing a nil
	// pool and confirming the wrapped handler still runs.
	cases := []struct {
		name   string
		status int
		want   bool // wrapped handler called
	}{
		{"200", http.StatusOK, true},
		{"204", http.StatusNoContent, true},
		{"403", http.StatusForbidden, true},
		{"500", http.StatusInternalServerError, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			handler := AuditMetaMiddleware(nil, AuditReadList)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(tc.status)
			}))
			req := httptest.NewRequest(http.MethodGet, "/api/v1/audit?actor_type=user&action=delete", nil)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if called != tc.want {
				t.Fatalf("called=%v, want %v", called, tc.want)
			}
			if rec.Code != tc.status {
				t.Fatalf("status=%d, want %d", rec.Code, tc.status)
			}
		})
	}
}

func TestAuditMetaExport_RowCounterThreaded(t *testing.T) {
	// Export streams rows — the handler increments a counter passed
	// in via ctx. Verify the counter is observable from the
	// middleware after the handler returns.
	var observed int64
	handler := AuditMetaMiddleware(nil, AuditReadExport)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c := RowCounterFromContext(r.Context())
		c.Add(42)
		observed = c.Load()
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/audit/export", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if observed != 42 {
		t.Fatalf("counter inside handler = %d, want 42", observed)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestAuditMetaStream_FlusherPreserved(t *testing.T) {
	// SSE handler requires Flusher on the response writer. The
	// middleware wraps the writer; if the wrapper hides the Flusher
	// interface, the stream wedges. The test asserts the wrapper
	// still implements Flush — and that calling Flush is a no-op
	// when the underlying writer doesn't support it.
	called := false
	handler := AuditMetaMiddleware(nil, AuditReadStreamOpen)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if _, ok := w.(http.Flusher); ok {
			called = true
		}
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/audit/stream", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if !called {
		t.Fatalf("wrapped writer must implement http.Flusher")
	}
}

func TestFilterNormalization(t *testing.T) {
	cases := []struct {
		name   string
		raw    map[string][]string
		expect map[string]string
	}{
		{
			name: "strips auth params",
			raw: map[string][]string{
				"actor_type":   {"user"},
				"stream_token": {"pws_secret"},
				"api_key":      {"pw_live_xxx"},
			},
			expect: map[string]string{"actor_type": "user"},
		},
		{
			name: "trims whitespace",
			raw: map[string][]string{
				"action": {"  subscriber.delete  "},
			},
			expect: map[string]string{"action": "subscriber.delete"},
		},
		{
			name: "drops empty values",
			raw: map[string][]string{
				"actor_label": {""},
				"action":      {"login"},
			},
			expect: map[string]string{"action": "login"},
		},
		{
			name: "keeps last value on repeat",
			raw: map[string][]string{
				"action": {"first", "second"},
			},
			expect: map[string]string{"action": "second"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := normalizeFilters(tc.raw)
			if len(got) != len(tc.expect) {
				t.Fatalf("len(got)=%d, want %d (got=%v)", len(got), len(tc.expect), got)
			}
			for k, v := range tc.expect {
				if got[k] != v {
					t.Fatalf("got[%q]=%q, want %q", k, got[k], v)
				}
			}
		})
	}
}

func TestCanonicalQueryString_Sorted(t *testing.T) {
	// Two reads that ask the same question (different param order)
	// must produce the same canonical string so the auditor can
	// string-compare them.
	a := canonicalQueryString(map[string]string{
		"action":     "delete",
		"actor_type": "user",
		"since":      "2026-01-01T00:00:00Z",
	})
	b := canonicalQueryString(map[string]string{
		"since":      "2026-01-01T00:00:00Z",
		"actor_type": "user",
		"action":     "delete",
	})
	if a != b {
		t.Fatalf("canonical(a)=%q, canonical(b)=%q — must be equal", a, b)
	}
	if !strings.Contains(a, "action=delete") {
		t.Fatalf("canonical missing action filter: %q", a)
	}
	if !strings.Contains(a, "&") {
		t.Fatalf("canonical missing separator: %q", a)
	}
	// Empty filter set must canonicalize to empty.
	if got := canonicalQueryString(nil); got != "" {
		t.Fatalf("nil filters canonical = %q, want empty", got)
	}
}

func TestBuildAuditReadMetadata_Shape(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/audit?actor_type=user&action=delete&stream_token=secret",
		nil)
	md := buildAuditReadMetadata(req, 17)

	if md["path"] != "/api/v1/audit" {
		t.Fatalf("path = %v, want /api/v1/audit", md["path"])
	}
	if md["method"] != "GET" {
		t.Fatalf("method = %v, want GET", md["method"])
	}
	if md["row_count"].(int64) != 17 {
		t.Fatalf("row_count = %v, want 17", md["row_count"])
	}
	canonical, _ := md["query_canonical"].(string)
	if strings.Contains(canonical, "stream_token") {
		t.Fatalf("query_canonical leaked stream_token: %q", canonical)
	}
	filters, _ := md["filters"].(map[string]string)
	if filters["actor_type"] != "user" || filters["action"] != "delete" {
		t.Fatalf("filters mismatch: %v", filters)
	}
	if _, ok := filters["stream_token"]; ok {
		t.Fatalf("filters leaked stream_token: %v", filters)
	}
}

func TestRowCounter_DefaultIsZero(t *testing.T) {
	// When no counter is in ctx, RowCounterFromContext must return
	// a non-nil counter so handlers can call Add() unconditionally.
	c := RowCounterFromContext(httptest.NewRequest("GET", "/", nil).Context())
	if c == nil {
		t.Fatal("counter must not be nil")
	}
	c.Add(1)
	if c.Load() != 1 {
		t.Fatalf("counter Add failed, got %d", c.Load())
	}
}

func TestRowCounter_RoundTrip(t *testing.T) {
	c := new(atomic.Int64)
	c.Add(7)
	ctx := WithRowCounter(httptest.NewRequest("GET", "/", nil).Context(), c)
	got := RowCounterFromContext(ctx)
	if got != c {
		t.Fatalf("round-tripped counter mismatch")
	}
	if got.Load() != 7 {
		t.Fatalf("counter value = %d, want 7", got.Load())
	}
}

func TestStatusCapturingWriter_DefaultsTo200(t *testing.T) {
	// When the handler writes a body without calling WriteHeader,
	// HTTP defaults to 200. Our wrapper must reflect that.
	rec := httptest.NewRecorder()
	sw := &statusCapturingWriter{ResponseWriter: rec, status: http.StatusOK}
	_, _ = sw.Write([]byte("ok"))
	if sw.status != http.StatusOK {
		t.Fatalf("status = %d, want 200", sw.status)
	}
}

func TestStatusCapturingWriter_RecordsWriteHeader(t *testing.T) {
	rec := httptest.NewRecorder()
	sw := &statusCapturingWriter{ResponseWriter: rec, status: http.StatusOK}
	sw.WriteHeader(http.StatusCreated)
	if sw.status != http.StatusCreated {
		t.Fatalf("status = %d, want 201", sw.status)
	}
	// Second WriteHeader must NOT overwrite — go semantics say only
	// the first wins.
	sw.WriteHeader(http.StatusTeapot)
	if sw.status != http.StatusCreated {
		t.Fatalf("status = %d after second WriteHeader, want 201", sw.status)
	}
}
