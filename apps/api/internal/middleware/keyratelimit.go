// SPDX-License-Identifier: AGPL-3.0-only

package middleware

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// KeyRateLimit is a per-API-key fixed-window limiter.
// Mounted AFTER the apikeys middleware so the API key id is on the
// context. Falls back to a no-op for unauthenticated requests
// (public form-submit etc. still go through the IP rate limiter).
//
// Storage: Redis when configured in main.go, otherwise an in-process map
// keyed by API key id for tests and single-process dev.
//
// Per-key limits come from a lookup function the caller supplies
// (typically apikeys.Repo.Get → key.RateLimitPerMin/PerDay/Burst).
// Lookups are memoised per-key for 60s to keep the per-request hot
// path off Postgres.
type KeyRateLimit struct {
	// LookupLimits returns the per-key limits. All-zero values mean "no
	// limit" — the middleware passes through. A non-nil error means the
	// limits are UNKNOWN, which is not the same thing: the middleware then
	// refuses the request with 503 and caches nothing, so a database outage
	// cannot silently unmeter every rate-limited key for a cache lifetime.
	// Resolve "key absent" to (0, 0, 0, nil) if that should pass through.
	LookupLimits func(ctx context.Context, keyID string) (perMin, perDay, burst int, err error)
	Store        FixedWindowStore
	Namespace    string

	mu      sync.Mutex
	minute  map[string]*kBucket
	day     map[string]*kBucket
	limits  map[string]kCachedLimits
	cacheAt map[string]time.Time
}

type kBucket struct {
	count   int
	resetAt time.Time
}

type kCachedLimits struct {
	perMin, perDay, burst int
}

// NewKeyRateLimit constructs a limiter. Pass a LookupLimits that
// reads from apikeys.Repo (in main.go) so cold paths don't burn a
// closure import on this package.
func NewKeyRateLimit(lookup func(ctx context.Context, keyID string) (perMin, perDay, burst int, err error)) *KeyRateLimit {
	return NewKeyRateLimitWithOptions(lookup, KeyRateLimitOptions{})
}

type KeyRateLimitOptions struct {
	Store     FixedWindowStore
	Namespace string
}

func NewKeyRateLimitWithOptions(lookup func(ctx context.Context, keyID string) (perMin, perDay, burst int, err error), opts KeyRateLimitOptions) *KeyRateLimit {
	return &KeyRateLimit{
		LookupLimits: lookup,
		Store:        opts.Store,
		Namespace:    firstNonEmpty(opts.Namespace, "api-key"),
		minute:       map[string]*kBucket{},
		day:          map[string]*kBucket{},
		limits:       map[string]kCachedLimits{},
		cacheAt:      map[string]time.Time{},
	}
}

// Middleware enforces the per-key limits. Pass-through when:
//   - no API key id on the context (request was authed by tenant
//     middleware some other way, e.g. native session for the web admin);
//   - LookupLimits returns all-zero values (no per-key limits set).
//
// A LookupLimits error is NOT a pass-through: the limits are unknown, so the
// request is refused with 503 rate_limit_unavailable exactly like a store
// failure. Failing open here would let a caller who can exhaust the connection
// pool also remove their own rate limit.
func (k *KeyRateLimit) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		keyID := APIKeyIDFromContext(r.Context())
		if keyID == "" {
			next.ServeHTTP(w, r)
			return
		}
		perMin, perDay, burst, err := k.fetchLimits(r.Context(), keyID)
		if err != nil {
			writeRateLimitUnavailable(w)
			return
		}
		if perMin <= 0 && perDay <= 0 {
			next.ServeHTTP(w, r)
			return
		}

		now := time.Now().UTC()
		if k.Store != nil {
			if !k.reserveDistributed(w, r, keyID, perMin, perDay, burst, now) {
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		k.mu.Lock()
		// Per-minute bucket. Burst extends the cap by `burst` for one
		// window — a tenant can spike 30 over the 60/min cap once in
		// a window, then drops back. (This matches Stripe's leaky-
		// bucket semantics in spirit if not in math.)
		if perMin > 0 {
			b := k.minute[keyID]
			if b == nil || now.After(b.resetAt) {
				b = &kBucket{resetAt: now.Add(60 * time.Second)}
				k.minute[keyID] = b
			}
			b.count++
			if b.count > perMin+burst {
				retryIn := int(time.Until(b.resetAt).Seconds())
				if retryIn < 1 {
					retryIn = 1
				}
				k.mu.Unlock()
				w.Header().Set("Retry-After", fmt.Sprintf("%d", retryIn))
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.WriteHeader(http.StatusTooManyRequests)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]any{
						"code":                "rate_limited",
						"message":             fmt.Sprintf("API key exceeded %d requests/min (burst +%d)", perMin, burst),
						"retry_after_seconds": retryIn,
					},
				})
				return
			}
		}
		// Per-day bucket. Same shape, longer window.
		if perDay > 0 {
			b := k.day[keyID]
			if b == nil || now.After(b.resetAt) {
				// Reset at next UTC midnight so daily caps align with
				// the same window every tenant sees regardless of
				// when their first request landed.
				next := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).Add(24 * time.Hour)
				b = &kBucket{resetAt: next}
				k.day[keyID] = b
			}
			b.count++
			if b.count > perDay {
				retryIn := int(time.Until(b.resetAt).Seconds())
				if retryIn < 1 {
					retryIn = 1
				}
				k.mu.Unlock()
				w.Header().Set("Retry-After", fmt.Sprintf("%d", retryIn))
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.WriteHeader(http.StatusTooManyRequests)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]any{
						"code":                "rate_limited_daily",
						"message":             fmt.Sprintf("API key exceeded %d requests/day", perDay),
						"retry_after_seconds": retryIn,
					},
				})
				return
			}
		}
		k.mu.Unlock()
		next.ServeHTTP(w, r)
	})
}

func (k *KeyRateLimit) reserveDistributed(w http.ResponseWriter, r *http.Request, keyID string, perMin, perDay, burst int, now time.Time) bool {
	if perMin > 0 {
		count, resetAt, err := k.Store.Reserve(r.Context(), k.Namespace+":minute:"+keyID, perMin+burst, time.Minute, now)
		if err != nil {
			writeRateLimitUnavailable(w)
			return false
		}
		if count > perMin+burst {
			writeKeyRateLimit(w, "rate_limited", fmt.Sprintf("API key exceeded %d requests/min (burst +%d)", perMin, burst), resetAt)
			return false
		}
	}
	if perDay > 0 {
		next := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).Add(24 * time.Hour)
		count, resetAt, err := k.Store.Reserve(r.Context(), k.Namespace+":day:"+keyID, perDay, time.Until(next), now)
		if err != nil {
			writeRateLimitUnavailable(w)
			return false
		}
		if count > perDay {
			writeKeyRateLimit(w, "rate_limited_daily", fmt.Sprintf("API key exceeded %d requests/day", perDay), resetAt)
			return false
		}
	}
	return true
}

func writeRateLimitUnavailable(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"code":    "rate_limit_unavailable",
			"message": "rate limit storage unavailable",
		},
	})
}

func writeKeyRateLimit(w http.ResponseWriter, code, message string, resetAt time.Time) {
	retryIn := int(time.Until(resetAt).Seconds())
	if retryIn < 1 {
		retryIn = 1
	}
	w.Header().Set("Retry-After", fmt.Sprintf("%d", retryIn))
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusTooManyRequests)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"code":                code,
			"message":             message,
			"retry_after_seconds": retryIn,
		},
	})
}

// fetchLimits returns cached limits or refreshes from the lookup
// function. 60s cache is enough that a key-rotation or limit-change
// shows up within a minute — long enough to keep Postgres off the
// hot path, short enough that operators can react.
func (k *KeyRateLimit) fetchLimits(ctx context.Context, keyID string) (perMin, perDay, burst int, err error) {
	k.mu.Lock()
	cached, ok := k.limits[keyID]
	cachedAt := k.cacheAt[keyID]
	k.mu.Unlock()
	if ok && time.Since(cachedAt) < 60*time.Second {
		return cached.perMin, cached.perDay, cached.burst, nil
	}
	if k.LookupLimits == nil {
		return 0, 0, 0, nil
	}
	perMin, perDay, burst, err = k.LookupLimits(ctx, keyID)
	if err != nil {
		// Deliberately not cached. Caching a failed lookup served the
		// resulting "no limit" answer for a full cache lifetime AFTER the
		// database recovered, and every further burst that kept the pool
		// saturated renewed it — a self-sustaining bypass that arrived
		// exactly when the system could least absorb it.
		return 0, 0, 0, err
	}
	k.mu.Lock()
	k.limits[keyID] = kCachedLimits{perMin, perDay, burst}
	k.cacheAt[keyID] = time.Now()
	k.mu.Unlock()
	return perMin, perDay, burst, nil
}
