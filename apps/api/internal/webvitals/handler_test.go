package webvitals

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type recordingExecutor struct {
	calls [][]any
	err   error
}

func (r *recordingExecutor) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	r.calls = append(r.calls, append([]any(nil), args...))
	return pgconn.CommandTag{}, r.err
}

func TestDecodeEvents_Single(t *testing.T) {
	events, err := decodeEvents([]byte(`{"name":"LCP","value":2500,"rating":"good"}`))
	if err != nil {
		t.Fatalf("decodeEvents: %v", err)
	}
	if len(events) != 1 || events[0].Name != "LCP" || events[0].Value != 2500 {
		t.Fatalf("unexpected events: %+v", events)
	}
}

func TestDecodeEvents_NextPayloadShape(t *testing.T) {
	events, err := decodeEvents([]byte(`{"id":"v3-abc","session_id":"sess-1","name":"INP","value":100,"rating":"good","navigationType":"reload","page":"/dashboard","href":"https://app.example/dashboard?x=1","ts":1770000000000}`))
	if err != nil {
		t.Fatalf("decodeEvents: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("want 1 event, got %d", len(events))
	}
	ev := events[0]
	if ev.ID != "v3-abc" || ev.SessionID != "sess-1" || ev.TS != 1770000000000 {
		t.Fatalf("unexpected event shape: %+v", ev)
	}
}

func TestDecodeEvents_Array(t *testing.T) {
	events, err := decodeEvents([]byte(`[{"name":"LCP","value":1},{"name":"INP","value":2}]`))
	if err != nil {
		t.Fatalf("decodeEvents: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("want 2 events, got %d", len(events))
	}
}

func TestDecodeEvents_RejectsOversizedBatch(t *testing.T) {
	body := `[` + strings.Repeat(`{"name":"LCP"},`, maxBatchEvents) + `{"name":"LCP"}]`
	if _, err := decodeEvents([]byte(body)); !errors.Is(err, errTooManyEvents) {
		t.Fatalf("decodeEvents error = %v, want errTooManyEvents", err)
	}
}

func TestDecodeEvents_EmptyBodyOK(t *testing.T) {
	events, err := decodeEvents([]byte(``))
	if err != nil {
		t.Fatalf("empty body should not error: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("want 0 events, got %d", len(events))
	}
}

func TestDecodeEvents_InvalidJSONFails(t *testing.T) {
	if _, err := decodeEvents([]byte(`not json`)); err == nil {
		t.Fatal("decodeEvents accepted garbage")
	}
}

func TestRateLimiter_Allows100PerMinute(t *testing.T) {
	now := time.Unix(0, 0)
	clock := func() time.Time { return now }
	l := newIPRateLimiter(3, time.Minute, clock)
	if !l.allow("1.2.3.4", 1) {
		t.Fatal("first request should be allowed")
	}
	if !l.allow("1.2.3.4", 1) {
		t.Fatal("second request should be allowed")
	}
	if !l.allow("1.2.3.4", 1) {
		t.Fatal("third request should be allowed")
	}
	if l.allow("1.2.3.4", 1) {
		t.Fatal("fourth request should be rate-limited")
	}
	// Different IP shares no state.
	if !l.allow("5.6.7.8", 1) {
		t.Fatal("other IP should be allowed")
	}
}

func TestRateLimiter_RefillsAfterWindow(t *testing.T) {
	now := time.Unix(0, 0)
	clock := func() time.Time { return now }
	l := newIPRateLimiter(1, time.Minute, clock)
	if !l.allow("1.1.1.1", 1) {
		t.Fatal("first should pass")
	}
	if l.allow("1.1.1.1", 1) {
		t.Fatal("second should be limited")
	}
	now = now.Add(2 * time.Minute)
	if !l.allow("1.1.1.1", 1) {
		t.Fatal("after window should refill")
	}
}

func TestRateLimiter_ChargesPerEvent(t *testing.T) {
	l := newIPRateLimiter(3, time.Minute, func() time.Time { return time.Unix(0, 0) })
	if !l.allow("1.2.3.4", 3) {
		t.Fatal("three-event batch should fit a fresh three-event budget")
	}
	if l.allow("1.2.3.4", 1) {
		t.Fatal("batch should consume all three event tokens")
	}
	if l.allow("5.6.7.8", 4) {
		t.Fatal("a charge larger than bucket capacity must fail")
	}
}

func TestRateLimiter_BoundedLRUEvictsLeastRecentlyUsedIdentity(t *testing.T) {
	now := time.Unix(0, 0)
	l := newIPRateLimiterWithBucketCapacity(1, time.Minute, 2, func() time.Time { return now })
	if !l.allow("a", 1) || !l.allow("b", 1) {
		t.Fatal("fresh identities should be allowed")
	}
	if l.allow("a", 1) {
		t.Fatal("touching exhausted a should remain denied")
	}
	if !l.allow("c", 1) {
		t.Fatal("fresh c should be allowed")
	}
	if got := l.buckets.Len(); got != 2 {
		t.Fatalf("bucket count = %d, want strict capacity 2", got)
	}
	if !l.allow("b", 1) {
		t.Fatal("b should have been evicted as LRU and recreated fresh")
	}
}

func TestMetricAtUsesBrowserTimestampWhenSane(t *testing.T) {
	now := time.Date(2026, 5, 11, 12, 0, 0, 0, time.UTC)
	ts := now.Add(-2 * time.Minute)
	got := metricAt(metricEvent{TS: ts.UnixMilli()}, now)
	if !got.Equal(ts) {
		t.Fatalf("metricAt = %s, want %s", got, ts)
	}
	if got := metricAt(metricEvent{TS: now.Add(10 * time.Minute).UnixMilli()}, now); !got.Equal(now) {
		t.Fatalf("future timestamp should clamp to now, got %s", got)
	}
}

func TestSafePagePathForStorageRedactsBearerAndPIISegments(t *testing.T) {
	t.Parallel()
	const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	tests := []struct {
		path string
		want string
	}{
		{
			path: "/api/public/preferences/short-capability/one-click",
			want: "/api/public/preferences/[redacted]/one-click",
		},
		{
			path: "/en/preferences/short-future-capability",
			want: "/en/preferences/[redacted]",
		},
		{path: "/en/preferences/" + token, want: "/en/preferences/[redacted]"},
		{path: "/reset/" + token, want: "/reset/[redacted]"},
		{
			path: "/subscribers/person@example.test/preferences",
			want: "/subscribers/[redacted]/preferences",
		},
		{
			path: "https://user:password@moosewave.com/en/preferences/" + token +
				"?token=query-secret#fragment-secret",
			want: "/en/preferences/[redacted]",
		},
		{
			path: "/reset/" + token + "?email=person@example.test",
			want: "/reset/[redacted]",
		},
		{path: "/dashboard/campaigns", want: "/dashboard/campaigns"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.path, func(t *testing.T) {
			t.Parallel()
			got := safePagePathForStorage(test.path)
			if got != test.want {
				t.Fatalf("safePagePathForStorage(%q)=%q want=%q", test.path, got, test.want)
			}
			if strings.Contains(got, token) {
				t.Fatalf("stored page path leaked bearer: %q", got)
			}
		})
	}
}

func TestHandler_RejectsNonPOST(t *testing.T) {
	h := NewHandler(&Deps{})
	req := httptest.NewRequest(http.MethodGet, "/api/internal/web-vitals", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("want 405, got %d", rec.Code)
	}
	if got := errorCode(t, rec); got != "method_not_allowed" {
		t.Fatalf("error code = %q, want method_not_allowed", got)
	}
	if got := rec.Header().Get("Allow"); got != "POST, OPTIONS" {
		t.Fatalf("allow = %q, want POST, OPTIONS", got)
	}
	assertPrivateResponseHeaders(t, rec)
}

func TestHandler_OptionsPreflightWithCanonicalAllowedOrigins(t *testing.T) {
	origins := []string{"https://moosewave.com", "https://app.moosewave.com"}
	h := NewHandler(&Deps{AllowedOrigins: origins})
	for _, origin := range origins {
		t.Run(origin, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodOptions, "/api/internal/web-vitals", nil)
			req.Header.Set("Origin", origin)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusNoContent {
				t.Fatalf("want 204, got %d", rec.Code)
			}
			if got := rec.Header().Get("Access-Control-Allow-Origin"); got != origin {
				t.Fatalf("want allow-origin %q, got %q", origin, got)
			}
			if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
				t.Fatalf("allow-credentials = %q, want true for sendBeacon compatibility", got)
			}
			assertPrivateResponseHeaders(t, rec)
		})
	}
}

func TestProtectResponsesCoversUpstreamPreflightAndRouterRefusal(t *testing.T) {
	terminal := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusMethodNotAllowed)
	})
	h := ProtectResponses(nil)(terminal)
	for _, method := range []string{http.MethodOptions, http.MethodGet} {
		req := httptest.NewRequest(method, ingestPath, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		assertPrivateResponseHeaders(t, rec)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Cache-Control"); got != "" {
		t.Fatalf("unrelated cache-control = %q, want untouched", got)
	}
}

func TestHandler_DisallowedOriginNoCORSHeaders(t *testing.T) {
	h := NewHandler(&Deps{AllowedOrigins: []string{"https://app.moosewave.com"}})
	req := httptest.NewRequest(http.MethodPost, "/api/internal/web-vitals",
		strings.NewReader(`{"name":"LCP","value":1}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://attacker.example")
	rec := httptest.NewRecorder()
	// Model headers already granted by the API-wide CORS middleware. The
	// endpoint-specific allow-list must fail closed and remove them.
	rec.Header().Set("Access-Control-Allow-Origin", "https://attacker.example")
	rec.Header().Set("Access-Control-Allow-Credentials", "true")
	h.ServeHTTP(rec, req)
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("disallowed origin should not get allow-origin header")
	}
	if rec.Header().Get("Access-Control-Allow-Credentials") != "" {
		t.Fatal("anonymous telemetry must not inherit credentialed CORS")
	}
	if got := rec.Header().Get("Vary"); got != "Origin" {
		t.Fatalf("vary = %q, want Origin even for a disallowed origin", got)
	}
}

func TestHandler_WildcardOriginIsNotAccepted(t *testing.T) {
	h := NewHandler(&Deps{AllowedOrigins: []string{"*"}})
	req := httptest.NewRequest(http.MethodOptions, "/api/internal/web-vitals", nil)
	req.Header.Set("Origin", "https://attacker.example")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("allow-origin = %q, want wildcard configuration rejected", got)
	}
}

func TestHandler_PostBodyAcceptedWithNoPool(t *testing.T) {
	// No pool wired → handler should still 204 (it just skips the
	// insert). This is the path the dev stack takes on first boot
	// before the migration runner has finished.
	h := NewHandler(&Deps{})
	req := httptest.NewRequest(http.MethodPost, "/api/internal/web-vitals",
		strings.NewReader(`[{"name":"LCP","value":1234,"rating":"good"}]`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("want 204, got %d", rec.Code)
	}
	assertPrivateResponseHeaders(t, rec)
}

func TestHandler_AnonymousTenantIDIsIgnoredAndStoredAsNull(t *testing.T) {
	const forgedTenant = "11111111-1111-4111-8111-111111111111"
	h := NewHandler(&Deps{})
	store := &recordingExecutor{}
	h.executor = store
	req := httptest.NewRequest(http.MethodPost, "/api/internal/web-vitals",
		strings.NewReader(`{"tenant_id":"`+forgedTenant+`","name":"LCP","value":1}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if len(store.calls) != 1 {
		t.Fatalf("insert calls = %d, want 1", len(store.calls))
	}
	if got := store.calls[0][1]; got != nil {
		t.Fatalf("tenant insert arg = %#v, want nil for anonymous telemetry", got)
	}
}

func TestHandler_InsertFailureRemainsBestEffort(t *testing.T) {
	h := NewHandler(&Deps{})
	h.executor = &recordingExecutor{err: errors.New("database unavailable")}
	req := httptest.NewRequest(http.MethodPost, "/api/internal/web-vitals",
		strings.NewReader(`{"name":"LCP","value":1}`))
	rec := httptest.NewRecorder()
	expectNoPanic(t, func() { h.ServeHTTP(rec, req) })
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want best-effort 204", rec.Code)
	}
}

func TestHandler_BatchConsumesProportionalBudget(t *testing.T) {
	now := time.Unix(0, 0)
	h := NewHandler(&Deps{Now: func() time.Time { return now }})
	h.limiter = newIPRateLimiter(3, time.Minute, func() time.Time { return now })

	batch := httptest.NewRequest(http.MethodPost, "/api/internal/web-vitals",
		strings.NewReader(`[{"name":"LCP"},{"name":"INP"},{"name":"CLS"}]`))
	batch.RemoteAddr = "9.9.9.9:1234"
	batchRec := httptest.NewRecorder()
	h.ServeHTTP(batchRec, batch)
	if batchRec.Code != http.StatusNoContent {
		t.Fatalf("batch status = %d, want 204", batchRec.Code)
	}

	single := httptest.NewRequest(http.MethodPost, "/api/internal/web-vitals",
		strings.NewReader(`{"name":"LCP"}`))
	single.RemoteAddr = "9.9.9.9:1234"
	singleRec := httptest.NewRecorder()
	h.ServeHTTP(singleRec, single)
	if singleRec.Code != http.StatusTooManyRequests {
		t.Fatalf("post-batch status = %d, want 429", singleRec.Code)
	}
}

func TestHandler_UntrustedPeerCannotRotateLimiterWithForgedXFF(t *testing.T) {
	defer func() { _ = middleware.SetTrustedProxyCIDRs(nil) }()
	if err := middleware.SetTrustedProxyCIDRs([]string{"10.0.0.0/8"}); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(0, 0)
	h := NewHandler(&Deps{Now: func() time.Time { return now }, TrustForwardedIPHeaders: true})
	h.limiter = newIPRateLimiter(1, time.Minute, func() time.Time { return now })

	for index, forged := range []string{"198.51.100.1", "198.51.100.2"} {
		req := httptest.NewRequest(http.MethodPost, "/api/internal/web-vitals", strings.NewReader(`{"name":"LCP"}`))
		req.RemoteAddr = "192.0.2.10:1234"
		req.Header.Set("X-Forwarded-For", forged)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		want := http.StatusNoContent
		if index == 1 {
			want = http.StatusTooManyRequests
		}
		if rec.Code != want {
			t.Fatalf("request %d status = %d, want %d", index, rec.Code, want)
		}
	}
}

func TestHandler_TrustedProxyUsesVerifiedForwardedClientIdentity(t *testing.T) {
	defer func() { _ = middleware.SetTrustedProxyCIDRs(nil) }()
	if err := middleware.SetTrustedProxyCIDRs([]string{"10.0.0.0/8"}); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(0, 0)
	h := NewHandler(&Deps{Now: func() time.Time { return now }, TrustForwardedIPHeaders: true})
	h.limiter = newIPRateLimiter(1, time.Minute, func() time.Time { return now })

	for _, client := range []string{"198.51.100.1", "198.51.100.2"} {
		req := httptest.NewRequest(http.MethodPost, "/api/internal/web-vitals", strings.NewReader(`{"name":"LCP"}`))
		req.RemoteAddr = "10.0.0.5:1234"
		req.Header.Set("X-Forwarded-For", "forged.example, "+client)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("client %s status = %d, want 204", client, rec.Code)
		}
	}
}

func TestHandler_RejectsTooManyEventsAndOversizedBody(t *testing.T) {
	h := NewHandler(&Deps{})
	tests := []struct {
		name string
		body string
		code string
	}{
		{
			name: "too many events",
			body: `[` + strings.Repeat(`{"name":"LCP"},`, maxBatchEvents) + `{"name":"LCP"}]`,
			code: "too_many_events",
		},
		{
			name: "oversized body",
			body: `{"name":"` + strings.Repeat("x", int(maxBodyBytes)) + `"}`,
			code: "payload_too_large",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/internal/web-vitals", strings.NewReader(test.body))
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusRequestEntityTooLarge {
				t.Fatalf("status = %d, want 413", rec.Code)
			}
			if got := errorCode(t, rec); got != test.code {
				t.Fatalf("error code = %q, want %q", got, test.code)
			}
			assertPrivateResponseHeaders(t, rec)
		})
	}
}

func TestHandler_RateLimitReturns429(t *testing.T) {
	now := time.Unix(0, 0)
	d := &Deps{Now: func() time.Time { return now }}
	h := NewHandler(d)
	// Drain the bucket. Default capacity is 100; loop hits the same
	// IP so all 100 requests come from one bucket.
	for i := 0; i < 100; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/internal/web-vitals",
			strings.NewReader(`{"name":"LCP","value":1}`))
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = "9.9.9.9:1234"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("req %d: want 204, got %d", i, rec.Code)
		}
	}
	req := httptest.NewRequest(http.MethodPost, "/api/internal/web-vitals",
		strings.NewReader(`{"name":"LCP","value":1}`))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "9.9.9.9:1234"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("101st: want 429, got %d", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "60" {
		t.Fatalf("want Retry-After 60, got %q", got)
	}
	if got := errorCode(t, rec); got != "rate_limited" {
		t.Fatalf("error code = %q, want rate_limited", got)
	}
	assertPrivateResponseHeaders(t, rec)
}

func TestHandler_InvalidJSONReturnsJSONError(t *testing.T) {
	h := NewHandler(&Deps{})
	req := httptest.NewRequest(http.MethodPost, "/api/internal/web-vitals",
		strings.NewReader(`not json`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
	if got := errorCode(t, rec); got != "invalid_json" {
		t.Fatalf("error code = %q, want invalid_json", got)
	}
	assertPrivateResponseHeaders(t, rec)
}

func assertPrivateResponseHeaders(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("cache-control = %q, want private, no-store", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("x-content-type-options = %q, want nosniff", got)
	}
}

func expectNoPanic(t *testing.T, fn func()) {
	t.Helper()
	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("unexpected panic: %v", recovered)
		}
	}()
	fn()
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("content-type = %q, want application/json", got)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return body.Error.Code
}

// The web client (apps/web/src/lib/web-vitals.ts) sends one batch per page
// view as text/plain — a CORS-simple request, so a cross-origin ingest costs
// no preflight — and backs off when it can read a 429. Both depend on this
// handler: it must decode a text/plain JSON array, and a 429 to an allowed
// origin must carry that origin's grant, or the browser hides the status.
func TestHandler_AcceptsTextPlainBatchAndLets429BeRead(t *testing.T) {
	const origin = "https://app.moosewave.com"
	now := time.Unix(0, 0)
	h := NewHandler(&Deps{
		AllowedOrigins: []string{origin},
		Now:            func() time.Time { return now },
	})
	h.limiter = newIPRateLimiter(3, time.Minute, func() time.Time { return now })
	store := &recordingExecutor{}
	h.executor = store

	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/internal/web-vitals",
			strings.NewReader(body))
		req.Header.Set("Content-Type", "text/plain;charset=UTF-8")
		req.Header.Set("Origin", origin)
		req.RemoteAddr = "9.9.9.9:1234"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	rec := post(`[{"name":"LCP","value":1800},{"name":"CLS","value":0.02},{"name":"INP","value":120}]`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("text/plain batch status = %d, want 204", rec.Code)
	}
	if len(store.calls) != 3 {
		t.Fatalf("inserts = %d, want one per event", len(store.calls))
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != origin {
		t.Fatalf("allow-origin = %q, want %q", got, origin)
	}

	rec = post(`[{"name":"LCP","value":1700}]`)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("over budget status = %d, want 429", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != origin {
		t.Fatalf("429 allow-origin = %q, want %q so the client can read it", got, origin)
	}
}
