// SPDX-License-Identifier: AGPL-3.0-only
//
// ratelimit_by_tenant.go — fixed-window limiter keyed on the
// resolved tenant id rather than the client IP. Closes the
// "cookie-session dashboard bypass" gap from the rate-limit audit:
// the existing IP-based RateLimit doesn't bound a single tenant's
// scripted dashboard caller, and the budgets middleware short-
// circuits when keyID == "" (cookie auth). Without per-tenant
// caps, expensive routes (AI compose, inbox-reality tests, voice
// generation, SMS test-send) burn unbounded external-service cost
// per tenant.
//
// Behaviour:
//
//   - Reads the tenant id from middleware.TenantFromContext. Pre-
//     tenant requests skip the gate (the route's auth middleware
//     decides).
//
//   - Fixed-window counter (matches RateLimit), default 60s.
//
//   - 429 + Retry-After + JSON envelope on exhaustion.
//
//   - Uses a deployment-wide FixedWindowStore when configured so the cap is
//     enforced across replicas. Store failures fail closed with 503. Local
//     development and tests use a bounded in-process LRU fallback.

package middleware

import (
	"context"
	"net/http"
	"time"
)

// TenantRateLimit is the per-tenant fixed-window limiter.
type TenantRateLimit struct {
	limit     int
	window    time.Duration
	store     FixedWindowStore
	namespace string
	buckets   *BoundedBuckets[*bucket]
}

// TenantRateLimitOptions configures distributed enforcement and the bounded
// local fallback. Namespace must be stable and distinct for budgets that have
// different limits.
type TenantRateLimitOptions struct {
	Store         FixedWindowStore
	Namespace     string
	LocalCapacity int
	LocalTTL      time.Duration
}

// NewTenantRateLimit returns a limiter that allows up to `limit`
// requests per `window` per resolved tenant id. limit<=0 disables
// the gate (handy for opt-out per-environment configs).
func NewTenantRateLimit(limit int, window time.Duration) *TenantRateLimit {
	return NewTenantRateLimitWithOptions(limit, window, TenantRateLimitOptions{})
}

// NewTenantRateLimitWithOptions constructs a tenant limiter with optional
// shared storage. A nil Store deliberately selects the bounded local fallback.
func NewTenantRateLimitWithOptions(limit int, window time.Duration, opts TenantRateLimitOptions) *TenantRateLimit {
	if window <= 0 {
		window = time.Minute
	}
	localTTL := opts.LocalTTL
	if localTTL <= 0 {
		localTTL = 2 * window
	}
	// A shorter TTL would evict an active bucket and silently reset its budget.
	if localTTL < window {
		localTTL = window
	}
	namespace := firstNonEmpty(opts.Namespace, "tenant")
	if opts.Store == nil && limit > 0 {
		MarkRedisFallback("tenant_rate_limit")
	}
	return &TenantRateLimit{
		limit:     limit,
		window:    window,
		store:     opts.Store,
		namespace: namespace,
		buckets:   NewBoundedBuckets[*bucket]("tenant_rate_limit", opts.LocalCapacity, localTTL),
	}
}

// Middleware is the chi-compatible middleware. Mount inside the
// authenticated tenant group (after TenantMiddleware).
func (rl *TenantRateLimit) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if rl.limit <= 0 {
			next.ServeHTTP(w, r)
			return
		}
		t, ok := TenantFromContext(r.Context())
		if !ok || t == nil || t.ID == "" {
			next.ServeHTTP(w, r)
			return
		}
		now := time.Now()
		count, resetAt, err := rl.reserve(r.Context(), t.ID, now)
		if err != nil {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":{"code":"tenant_rate_limit_unavailable","message":"tenant rate limit storage unavailable"}}`))
			return
		}
		over := count > rl.limit
		retryAfter := int(time.Until(resetAt).Seconds())
		if retryAfter < 1 {
			retryAfter = 1
		}
		if over {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Retry-After", itoa(retryAfter))
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":{"code":"tenant_rate_limited","message":"per-tenant rate limit exceeded; retry after the Retry-After window"}}`))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (rl *TenantRateLimit) reserve(ctx context.Context, tenantID string, now time.Time) (int, time.Time, error) {
	if rl.store != nil {
		return rl.store.Reserve(ctx, rl.namespace+":tenant:"+tenantID, rl.limit, rl.window, now)
	}
	var count int
	var resetAt time.Time
	rl.buckets.Update(tenantID, now, func(b *bucket, _ bool) *bucket {
		if b == nil || now.After(b.reset) {
			b = &bucket{reset: now.Add(rl.window)}
		}
		b.count++
		count = b.count
		resetAt = b.reset
		return b
	})
	return count, resetAt, nil
}
