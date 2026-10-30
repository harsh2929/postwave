package middleware

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"
)

// RateLimit is an in-process IP-based fixed-window limiter for the public
// route group (form submissions, opt-in confirms). When opts.Store is set
// this becomes a distributed fixed-window limiter shared across gateway
// replicas; otherwise it falls back to the local in-process map for tests and
// single-process dev.
//
// Default: 10 requests / 60s per (IP). Bypass by passing limit<=0.
type RateLimit struct {
	limit                  int
	window                 time.Duration
	trustForwardedIPHeader bool
	store                  FixedWindowStore
	namespace              string
	mu                     sync.Mutex
	buckets                map[string]*bucket
}

type bucket struct {
	count int
	reset time.Time
}

// NewRateLimit constructs a limiter. limit=10, window=time.Minute is the
// recommended default for public form submission endpoints.
func NewRateLimit(limit int, window time.Duration) *RateLimit {
	return NewRateLimitWithOptions(limit, window, RateLimitOptions{})
}

// RateLimitOptions controls how client identity is derived.
type RateLimitOptions struct {
	TrustForwardedIPHeaders bool
	Store                   FixedWindowStore
	Namespace               string
}

// NewRateLimitWithOptions constructs a limiter with explicit trust settings.
func NewRateLimitWithOptions(limit int, window time.Duration, opts RateLimitOptions) *RateLimit {
	return &RateLimit{
		limit:                  limit,
		window:                 window,
		trustForwardedIPHeader: opts.TrustForwardedIPHeaders,
		store:                  opts.Store,
		namespace:              firstNonEmpty(opts.Namespace, "ip"),
		buckets:                make(map[string]*bucket),
	}
}

// budgetCtxKey is the agreed-upon context key Backend A's budgets middleware
// stamps remaining counters on. We re-declare a typed const here so the
// limiter can read those values without importing the budgets package
// (avoids a circular import while Backend A is still in flight).
type budgetCtxKey int

const (
	// CtxKeyBudgetSendsRemaining is read as int64 — remaining sends in the
	// current period for the resolved API key, or -1 if unlimited.
	CtxKeyBudgetSendsRemaining budgetCtxKey = iota + 1
	// CtxKeyBudgetCostCentsRemaining is read as int64 — remaining cost-cents
	// budget in the current period, or -1 if unlimited.
	CtxKeyBudgetCostCentsRemaining
	// CtxKeyAPIKeyAuth signals the request is API-key authenticated, so the
	// limiter knows it should stamp X-RateLimit-* headers (cookie-auth
	// dashboard sessions skip these per the design).
	CtxKeyAPIKeyAuth
)

// WithAPIKeyAuth marks ctx as API-key authenticated. Callers (the apikey
// middleware) call this once they resolve a key.
func WithAPIKeyAuth(ctx context.Context) context.Context {
	return context.WithValue(ctx, CtxKeyAPIKeyAuth, true)
}

// IsAPIKeyAuth reports whether the request is API-key authenticated.
func IsAPIKeyAuth(ctx context.Context) bool {
	v, ok := ctx.Value(CtxKeyAPIKeyAuth).(bool)
	return ok && v
}

// Middleware returns a chi-compatible middleware. Strips the bucket map
// every `window` so the map can't grow unbounded under attack.
//
// Headers stamped on every response:
//
//   - X-RateLimit-Limit: requests permitted per window
//   - X-RateLimit-Remaining: count remaining in the current window
//   - X-RateLimit-Reset: unix-seconds when the window resets
//   - Retry-After: seconds until reset, ONLY on 429
//   - X-Postwave-Budget-Sends-Remaining / -Cost-Cents-Remaining: copied
//     from budget context values when present (set by the budgets
//     middleware running upstream of this one).
//
// Headers are skipped for non-API-key requests (cookie-auth dashboard).
func (rl *RateLimit) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if rl.limit <= 0 {
			next.ServeHTTP(w, r)
			return
		}
		ip := clientIPHeader(r, rl.trustForwardedIPHeader)
		now := time.Now()

		count, resetAt, limitedByStore, storeErr := rl.reserve(r.Context(), ip, now)
		if storeErr != nil {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":{"code":"rate_limit_unavailable","message":"rate limit storage unavailable"}}`))
			return
		}
		over := count > rl.limit
		remaining := rl.limit - count
		if remaining < 0 {
			remaining = 0
		}
		resetUnix := resetAt.Unix()
		retryAfter := int(time.Until(resetAt).Seconds())
		if retryAfter < 1 && over {
			retryAfter = 1
		}
		_ = limitedByStore

		// X-RateLimit-* describe the IP-based limit and are useful to every
		// authenticated caller — including in-app / cookie-auth agents that
		// self-throttle — so stamp them regardless of auth method. Budget
		// headers self-gate on the presence of a per-key budget in ctx
		// (stampBudgetHeaders is a no-op for cookie auth, which has none).
		w.Header().Set("X-RateLimit-Limit", itoa(rl.limit))
		w.Header().Set("X-RateLimit-Remaining", itoa(remaining))
		w.Header().Set("X-RateLimit-Reset", itoa64(resetUnix))
		stampBudgetHeaders(w, r.Context())

		if over {
			// Retry-After is informational and useful regardless of auth.
			w.Header().Set("Retry-After", itoa(retryAfter))
			// Use JSON Content-Type, not http.Error's text/plain default —
			// otherwise nosniff makes browsers refuse to parse the JSON body.
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":{"code":"rate_limited","message":"too many requests"}}`))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (rl *RateLimit) reserve(ctx context.Context, ip string, now time.Time) (count int, resetAt time.Time, store bool, err error) {
	if rl.store != nil {
		count, resetAt, err = rl.store.Reserve(ctx, rl.namespace+":ip:"+ip, rl.limit, rl.window, now)
		return count, resetAt, true, err
	}
	rl.mu.Lock()
	defer rl.mu.Unlock()
	b, ok := rl.buckets[ip]
	if !ok || now.After(b.reset) {
		b = &bucket{count: 0, reset: now.Add(rl.window)}
		rl.buckets[ip] = b
	}
	b.count++
	// Periodic GC: when the map gets large drop entries with reset in
	// the past. Cheap, runs once per ~1024 requests.
	if len(rl.buckets) > 1024 {
		for k, v := range rl.buckets {
			if now.After(v.reset) {
				delete(rl.buckets, k)
			}
		}
	}
	return b.count, b.reset, false, nil
}

// stampBudgetHeaders copies budget-remaining counters from ctx into the
// response. Both reads are nil-checked because the budgets middleware
// (Backend A) may not yet be wired.
func stampBudgetHeaders(w http.ResponseWriter, ctx context.Context) {
	if v := ctx.Value(CtxKeyBudgetSendsRemaining); v != nil {
		if n, ok := v.(int64); ok && n >= 0 {
			w.Header().Set("X-Postwave-Budget-Sends-Remaining", itoa64(n))
		}
	}
	if v := ctx.Value(CtxKeyBudgetCostCentsRemaining); v != nil {
		if n, ok := v.(int64); ok && n >= 0 {
			w.Header().Set("X-Postwave-Budget-Cost-Cents-Remaining", itoa64(n))
		}
	}
}

func clientIPHeader(r *http.Request, trustForwardedIPHeaders bool) string {
	return ResolveClientIPString(r, trustForwardedIPHeaders)
}

func itoa(n int) string {
	if n < 0 {
		n = 0
	}
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

func itoa64(n int64) string {
	if n < 0 {
		n = 0
	}
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
