package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newOK() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`ok`))
	})
}

func TestRateLimit_Headers_OnAPIKeyAuth(t *testing.T) {
	rl := NewRateLimit(5, time.Minute)
	h := rl.Middleware(newOK())

	r := httptest.NewRequest("GET", "/x", nil)
	r.RemoteAddr = "10.0.0.1:1234"
	r = r.WithContext(WithAPIKeyAuth(r.Context()))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if got := w.Header().Get("X-RateLimit-Limit"); got != "5" {
		t.Errorf("X-RateLimit-Limit: want 5 got %q", got)
	}
	if got := w.Header().Get("X-RateLimit-Remaining"); got != "4" {
		t.Errorf("X-RateLimit-Remaining: want 4 got %q", got)
	}
	if got := w.Header().Get("X-RateLimit-Reset"); got == "" {
		t.Errorf("X-RateLimit-Reset missing")
	}
	if got := w.Header().Get("Retry-After"); got != "" {
		t.Errorf("Retry-After should be absent on 200, got %q", got)
	}
}

func TestRateLimit_Headers_OnCookieAuth(t *testing.T) {
	// Rate-limit headers are now stamped for every authenticated caller
	// (including cookie-auth in-app agents that self-throttle), not just
	// API keys. Budget headers stay absent without a per-key budget.
	rl := NewRateLimit(5, time.Minute)
	h := rl.Middleware(newOK())

	r := httptest.NewRequest("GET", "/x", nil)
	r.RemoteAddr = "10.0.0.2:1234"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if got := w.Header().Get("X-RateLimit-Limit"); got != "5" {
		t.Errorf("X-RateLimit-Limit: want 5 got %q", got)
	}
	if got := w.Header().Get("X-RateLimit-Remaining"); got != "4" {
		t.Errorf("X-RateLimit-Remaining: want 4 got %q", got)
	}
	if got := w.Header().Get("X-RateLimit-Reset"); got == "" {
		t.Errorf("X-RateLimit-Reset missing")
	}
	// No per-key budget on a cookie-auth request → budget headers absent.
	if got := w.Header().Get("X-Postwave-Budget-Sends-Remaining"); got != "" {
		t.Errorf("budget header should be absent without a budget, got %q", got)
	}
}

func TestRateLimit_RetryAfter_On429(t *testing.T) {
	rl := NewRateLimit(2, time.Minute)
	h := rl.Middleware(newOK())

	for i := 0; i < 2; i++ {
		r := httptest.NewRequest("GET", "/x", nil)
		r.RemoteAddr = "10.0.0.3:1234"
		r = r.WithContext(WithAPIKeyAuth(r.Context()))
		h.ServeHTTP(httptest.NewRecorder(), r)
	}
	r := httptest.NewRequest("GET", "/x", nil)
	r.RemoteAddr = "10.0.0.3:1234"
	r = r.WithContext(WithAPIKeyAuth(r.Context()))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("want 429 got %d", w.Code)
	}
	if got := w.Header().Get("Retry-After"); got == "" {
		t.Errorf("Retry-After missing on 429")
	}
}

func TestRateLimit_BudgetHeaders(t *testing.T) {
	rl := NewRateLimit(10, time.Minute)
	h := rl.Middleware(newOK())

	r := httptest.NewRequest("GET", "/x", nil)
	r.RemoteAddr = "10.0.0.4:1234"
	ctx := WithAPIKeyAuth(r.Context())
	// Inject the budget context values the budgets middleware would set.
	ctx = withBudgetSends(ctx, 42)
	ctx = withBudgetCost(ctx, 1234)
	r = r.WithContext(ctx)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if got := w.Header().Get("X-Postwave-Budget-Sends-Remaining"); got != "42" {
		t.Errorf("budget sends header: want 42 got %q", got)
	}
	if got := w.Header().Get("X-Postwave-Budget-Cost-Cents-Remaining"); got != "1234" {
		t.Errorf("budget cost header: want 1234 got %q", got)
	}
}

func TestRateLimit_BudgetHeadersAbsent_WhenNotSet(t *testing.T) {
	rl := NewRateLimit(10, time.Minute)
	h := rl.Middleware(newOK())

	r := httptest.NewRequest("GET", "/x", nil)
	r.RemoteAddr = "10.0.0.5:1234"
	r = r.WithContext(WithAPIKeyAuth(r.Context()))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Header().Get("X-Postwave-Budget-Sends-Remaining") != "" {
		t.Errorf("budget sends header should be absent when ctx unset")
	}
}

func TestRateLimit_IgnoresForwardedHeadersByDefault(t *testing.T) {
	rl := NewRateLimit(1, time.Minute)
	h := rl.Middleware(newOK())

	for i, xff := range []string{"203.0.113.1", "203.0.113.2"} {
		r := httptest.NewRequest("GET", "/x", nil)
		r.RemoteAddr = "10.0.0.9:1234"
		r.Header.Set("X-Forwarded-For", xff)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if i == 0 && w.Code != http.StatusOK {
			t.Fatalf("first status = %d, want 200", w.Code)
		}
		if i == 1 && w.Code != http.StatusTooManyRequests {
			t.Fatalf("second status = %d, want 429", w.Code)
		}
	}
}

func TestRateLimit_TrustsForwardedHeadersWhenEnabled(t *testing.T) {
	defer func() { _ = SetTrustedProxyCIDRs(nil) }()
	if err := SetTrustedProxyCIDRs([]string{"10.0.0.0/8"}); err != nil {
		t.Fatal(err)
	}
	rl := NewRateLimitWithOptions(1, time.Minute, RateLimitOptions{
		TrustForwardedIPHeaders: true,
	})
	h := rl.Middleware(newOK())

	for _, xff := range []string{"203.0.113.1", "203.0.113.2"} {
		r := httptest.NewRequest("GET", "/x", nil)
		r.RemoteAddr = "10.0.0.9:1234"
		r.Header.Set("X-Forwarded-For", xff)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("xff %s: status = %d, want 200", xff, w.Code)
		}
	}
}

// Test helpers — these mimic what the budgets middleware would do.
func withBudgetSends(ctx context.Context, n int64) context.Context {
	return context.WithValue(ctx, CtxKeyBudgetSendsRemaining, n)
}
func withBudgetCost(ctx context.Context, n int64) context.Context {
	return context.WithValue(ctx, CtxKeyBudgetCostCentsRemaining, n)
}
