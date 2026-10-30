package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestKeyRateLimit_NoAPIKeyPassesThrough(t *testing.T) {
	rl := NewKeyRateLimit(func(context.Context, string) (int, int, int, error) {
		t.Fatal("lookup should not run without API key id")
		return 0, 0, 0, nil
	})
	h := rl.Middleware(newOK())

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/x", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
}

func TestKeyRateLimit_PerMinuteBurstAndRetryAfter(t *testing.T) {
	rl := NewKeyRateLimit(func(context.Context, string) (int, int, int, error) {
		return 2, 0, 1, nil
	})
	h := rl.Middleware(newOK())

	for i := 0; i < 3; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, keyLimitRequest("key_1"))
		if w.Code != http.StatusOK {
			t.Fatalf("request %d status = %d, want 200", i+1, w.Code)
		}
	}

	w := httptest.NewRecorder()
	h.ServeHTTP(w, keyLimitRequest("key_1"))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	if got := w.Header().Get("Retry-After"); got == "" {
		t.Fatalf("Retry-After missing")
	}
	if !strings.Contains(w.Body.String(), "rate_limited") {
		t.Fatalf("body = %s", w.Body.String())
	}
}

func TestKeyRateLimit_PerDay(t *testing.T) {
	rl := NewKeyRateLimit(func(context.Context, string) (int, int, int, error) {
		return 0, 1, 0, nil
	})
	h := rl.Middleware(newOK())

	h.ServeHTTP(httptest.NewRecorder(), keyLimitRequest("key_daily"))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, keyLimitRequest("key_daily"))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	if !strings.Contains(w.Body.String(), "rate_limited_daily") {
		t.Fatalf("body = %s", w.Body.String())
	}
}

func TestKeyRateLimit_CachesLookup(t *testing.T) {
	calls := 0
	rl := NewKeyRateLimit(func(context.Context, string) (int, int, int, error) {
		calls++
		return 10, 0, 0, nil
	})
	h := rl.Middleware(newOK())

	h.ServeHTTP(httptest.NewRecorder(), keyLimitRequest("key_cached"))
	h.ServeHTTP(httptest.NewRecorder(), keyLimitRequest("key_cached"))
	if calls != 1 {
		t.Fatalf("lookup calls = %d, want 1", calls)
	}
}

// TestKeyRateLimit_RegressionPerMinuteHardLimit guards against the
// p0-api-key-rate-limit regression. Prior to the fix, the per-key
// rate limit was a silent no-op because the lookup function in main.go
// called Repo.Get(ctx, "" /* tenant */, keyID) which always errored
// (db.WithTenant rejects empty tenants), so LookupLimits returned
// (0,0,0) and every request passed through. This test pins the
// expected behaviour from the perspective of the limiter directly:
// with perMin=2 and burst=0, the 3rd request in the window MUST be
// rejected with 429.
func TestKeyRateLimit_RegressionPerMinuteHardLimit(t *testing.T) {
	rl := NewKeyRateLimit(func(context.Context, string) (int, int, int, error) {
		return 2, 0, 0, nil
	})
	h := rl.Middleware(newOK())

	// First 2 requests pass.
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, keyLimitRequest("regression_key"))
		if w.Code != http.StatusOK {
			t.Fatalf("request %d status = %d, want 200", i+1, w.Code)
		}
	}
	// 3rd request blocked.
	w := httptest.NewRecorder()
	h.ServeHTTP(w, keyLimitRequest("regression_key"))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("3rd request status = %d, want 429 (silent no-op regression?)", w.Code)
	}
	if !strings.Contains(w.Body.String(), "rate_limited") {
		t.Fatalf("body = %s, want rate_limited error code", w.Body.String())
	}
}

// A limits lookup that errors means the limits are UNKNOWN, not "unlimited".
// The middleware used to collapse the two: `if err != nil { return 0, 0, 0 }`
// in main.go's closure, which fetchLimits then CACHED for a full minute — so a
// pool exhaustion (which a rate-limited attacker can cause on purpose) removed
// their own rate limit and kept it removed after the database recovered.
func TestKeyRateLimit_LookupErrorFailsClosedAndIsNotCached(t *testing.T) {
	calls := 0
	failing := errors.New("pool exhausted")
	rl := NewKeyRateLimit(func(context.Context, string) (int, int, int, error) {
		calls++
		if calls == 1 {
			return 0, 0, 0, failing
		}
		return 2, 0, 0, nil
	})
	h := rl.Middleware(newOK())

	w := httptest.NewRecorder()
	h.ServeHTTP(w, keyLimitRequest("key_failing"))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 on an unknown limit", w.Code)
	}
	if !strings.Contains(w.Body.String(), "rate_limit_unavailable") {
		t.Fatalf("body = %s, want rate_limit_unavailable", w.Body.String())
	}

	// The failed lookup must not have been memoised: the very next request
	// re-reads and gets the real limit, rather than serving "no limit" for the
	// 60s cache lifetime.
	for i := 0; i < 2; i++ {
		w = httptest.NewRecorder()
		h.ServeHTTP(w, keyLimitRequest("key_failing"))
		if w.Code != http.StatusOK {
			t.Fatalf("recovered request %d status = %d, want 200", i+1, w.Code)
		}
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, keyLimitRequest("key_failing"))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429: the real limit was never applied", w.Code)
	}
	if calls != 2 {
		t.Fatalf("lookup calls = %d, want 2 (one failed + one cached refresh)", calls)
	}
}

// The lookup must run against the request's context so it inherits the
// caller's deadline; the closure used to pass context.Background().
func TestKeyRateLimit_LookupReceivesRequestContext(t *testing.T) {
	type ctxKey struct{}
	var seen bool
	rl := NewKeyRateLimit(func(ctx context.Context, _ string) (int, int, int, error) {
		seen = ctx.Value(ctxKey{}) == "marker"
		return 0, 0, 0, nil
	})
	h := rl.Middleware(newOK())

	req := keyLimitRequest("key_ctx")
	req = req.WithContext(context.WithValue(req.Context(), ctxKey{}, "marker"))
	h.ServeHTTP(httptest.NewRecorder(), req)
	if !seen {
		t.Fatal("lookup did not receive the request context")
	}
}

func keyLimitRequest(keyID string) *http.Request {
	r := httptest.NewRequest("GET", "/x", nil)
	r = r.WithContext(WithAPIKeyID(r.Context(), keyID))
	return r
}
