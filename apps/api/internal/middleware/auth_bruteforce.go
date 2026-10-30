// SPDX-License-Identifier: AGPL-3.0-only
//
// auth_bruteforce.go — per-origin/account rate limit + temporary lockout on
// the auth surface (/login, /signup, /password-reset, /magic-link).
//
// The existing failed_attempts column on users protects against
// targeted attacks on one account. This middleware protects
// against credential stuffing — an attacker rotating usernames
// against a single IP. Two independent defences are intentional:
//
//   per-user lockout    → "alice's account got hammered, lock it"
//   per-IP rate limit   → "203.0.113.7 is trying 100 usernames/sec,
//                          block them at the edge"
//
// Production supplies a Redis-backed FixedWindowStore, so IP, normalized
// pre-auth account, and authenticated-user budgets are shared by every API
// replica. Local development falls back to bounded in-process buckets with a
// cooldown. Account identifiers are SHA-256 hashed before entering limiter
// keys; the store never receives raw email addresses.

package middleware

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

// Defaults — operators can override per-deployment via env vars
// wired in main.go.
const (
	DefaultAuthMaxAttempts      = 10
	DefaultAuthWindow           = time.Minute
	DefaultAuthCooldown         = 5 * time.Minute
	DefaultBruteforceCleanupTTL = 30 * time.Minute
)

// AuthBruteforceLimiter is the auth rate-limit + lockout gate. Safe for
// concurrent use; local-bucket cleanup runs lazily inside the middleware.
type AuthBruteforceLimiter struct {
	MaxAttempts int
	Window      time.Duration
	Cooldown    time.Duration
	// Forwarded headers are used only through ResolveClientIPString, which
	// additionally requires the untouched TCP peer to match a trusted CIDR.
	TrustForwardedIPHeaders bool
	// Store makes budgets shared across gateway replicas. Production wires the
	// Redis FixedWindowStore; nil retains the local-development fallback.
	Store FixedWindowStore

	namespace string
	buckets   *BoundedBuckets[*authBucket]
}

type authBucket struct {
	count       int
	windowStart time.Time
	lockedUntil time.Time
}

// AuthBruteforceOptions configures the auth limiter. Store should be the
// deployment-wide FixedWindowStore in multi-replica environments. When Store
// is nil the limiter uses a bounded in-process LRU suitable for tests and
// single-process development.
type AuthBruteforceOptions struct {
	MaxAttempts             int
	Window                  time.Duration
	Cooldown                time.Duration
	TrustForwardedIPHeaders bool
	Store                   FixedWindowStore
	Namespace               string
	LocalCapacity           int
	LocalTTL                time.Duration
}

// NewAuthBruteforceLimiter constructs the limiter with production-safe
// defaults. Use NewAuthBruteforceLimiterWithOptions when wiring a shared
// store or overriding a budget.
func NewAuthBruteforceLimiter() *AuthBruteforceLimiter {
	return NewAuthBruteforceLimiterWithOptions(AuthBruteforceOptions{})
}

// NewAuthBruteforceLimiterWithOptions constructs an explicitly configured
// limiter. Zero-value budgets use the package defaults.
func NewAuthBruteforceLimiterWithOptions(opts AuthBruteforceOptions) *AuthBruteforceLimiter {
	maxAttempts := opts.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = DefaultAuthMaxAttempts
	}
	window := opts.Window
	if window <= 0 {
		window = DefaultAuthWindow
	}
	cooldown := opts.Cooldown
	if cooldown <= 0 {
		cooldown = DefaultAuthCooldown
	}
	localTTL := opts.LocalTTL
	if localTTL <= 0 {
		localTTL = DefaultBruteforceCleanupTTL
	}
	// Never allow an explicit local TTL to expire an active window or lockout.
	if cooldown > localTTL {
		localTTL = cooldown
	}
	if window > localTTL {
		localTTL = window
	}
	namespace := firstNonEmpty(opts.Namespace, "auth")
	if opts.Store == nil {
		MarkRedisFallback("auth_bruteforce")
	}
	return &AuthBruteforceLimiter{
		MaxAttempts:             maxAttempts,
		Window:                  window,
		Cooldown:                cooldown,
		TrustForwardedIPHeaders: opts.TrustForwardedIPHeaders,
		Store:                   opts.Store,
		namespace:               namespace,
		buckets:                 NewBoundedBuckets[*authBucket]("auth_bruteforce", opts.LocalCapacity, localTTL),
	}
}

// Middleware returns the chi-style middleware. Wrap each auth
// endpoint with it; the response body for blocked attempts carries
// a Retry-After header so SDKs back off correctly.
func (l *AuthBruteforceLimiter) Middleware(next http.Handler) http.Handler {
	if l.MaxAttempts <= 0 {
		l.MaxAttempts = DefaultAuthMaxAttempts
	}
	if l.Window <= 0 {
		l.Window = DefaultAuthWindow
	}
	if l.Cooldown <= 0 {
		l.Cooldown = DefaultAuthCooldown
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIPForAuth(r, l.TrustForwardedIPHeaders)
		keys := make([]string, 0, 3)
		if ip != "" {
			keys = append(keys, "ip:"+ip)
		}
		if user, ok := UserFromContext(r.Context()); ok && user.ID != "" {
			// A user budget is independent from IP, so rotating XFF values or
			// source networks cannot grind TOTP for one account indefinitely.
			keys = append(keys, "user:"+user.ID)
		}
		if session := authSessionKey(r); session != "" {
			// A session budget prevents an attacker who has one pre-MFA cookie
			// from multiplying guesses by rotating both source networks and
			// account aliases. Hash the opaque cookie so Redis/logging never sees
			// a live session credential.
			keys = append(keys, "session:"+session)
		}
		if account := authAccountKey(r); account != "" {
			// Login happens before a User exists in context. Hash the normalized
			// email so a rotating-IP attacker still consumes one account budget
			// without retaining PII in limiter keys.
			keys = append(keys, "account:"+account)
		}
		if len(keys) == 0 {
			// Fail open when we can't resolve an IP (e.g. local
			// tests). The downstream auth still applies its own
			// per-user lockout, so this is the safe default.
			next.ServeHTTP(w, r)
			return
		}
		allowed := true
		storeUnavailable := false
		for _, key := range keys {
			if l.Store != nil {
				count, _, err := l.Store.Reserve(r.Context(), l.namespace+":"+key, l.MaxAttempts, l.Window, time.Now())
				if err != nil {
					storeUnavailable = true
					continue
				}
				if count > l.MaxAttempts {
					allowed = false
				}
				continue
			}
			if !l.checkAndBump(key) {
				allowed = false
			}
		}
		if storeUnavailable {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{"code": "auth_rate_limit_unavailable", "message": "authentication rate limiting unavailable"},
			})
			return
		}
		if allowed {
			next.ServeHTTP(w, r)
			return
		}
		// Locked out. Emit Retry-After to help legitimate clients
		// back off + return 429.
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Retry-After", "300")
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"code":    "too_many_auth_attempts",
				"message": "too many authentication attempts; try again in a few minutes",
			},
		})
	})
}

func authSessionKey(r *http.Request) string {
	if r == nil {
		return ""
	}
	cookie, err := r.Cookie("pw_session")
	if err != nil || cookie == nil {
		return ""
	}
	value := strings.TrimSpace(cookie.Value)
	if value == "" || len(value) > 4096 {
		return ""
	}
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

const authLimiterBodyMax = 32 << 10

func authAccountKey(r *http.Request) string {
	if r == nil || r.Body == nil || r.Method != http.MethodPost {
		return ""
	}
	raw, err := httpbody.PeekAtMost(&r.Body, authLimiterBodyMax)
	if err != nil || len(raw) == 0 {
		return ""
	}
	var in struct {
		Email string `json:"email"`
	}
	if json.Unmarshal(raw, &in) != nil {
		return ""
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	if email == "" || len(email) > 320 {
		return ""
	}
	sum := sha256.Sum256([]byte(email))
	return hex.EncodeToString(sum[:])
}

// checkAndBump consults the bucket for ip. Returns true when the
// request is admitted; false when the IP is locked out.
//
// Side-effects:
//   - Bumps the counter on every call (admitted or not).
//   - Transitions count → lockout when the budget is exhausted
//     within the current window.
//   - Resets the bucket when the window has rolled over.
func (l *AuthBruteforceLimiter) checkAndBump(ip string) bool {
	now := time.Now()
	allowed := true
	l.buckets.Update(ip, now, func(b *authBucket, _ bool) *authBucket {
		if b == nil {
			b = &authBucket{windowStart: now}
		}
		// Active lockout — refuse.
		if now.Before(b.lockedUntil) {
			allowed = false
			return b
		}
		// Window rollover — reset.
		if now.Sub(b.windowStart) > l.Window {
			b.windowStart = now
			b.count = 0
		}
		b.count++
		if b.count > l.MaxAttempts {
			b.lockedUntil = now.Add(l.Cooldown)
			allowed = false
		}
		return b
	})
	return allowed
}

// RecordSuccess clears the local IP fallback bucket on a successful login.
// Distributed windows deliberately count all auth requests; the hook cannot
// weaken the cross-replica account/user budgets.
func (l *AuthBruteforceLimiter) RecordSuccess(ip string) {
	if ip == "" {
		return
	}
	l.buckets.Delete("ip:" + ip)
}

// clientIPForAuth resolves the canonical request source using the shared
// trusted-proxy boundary.
func clientIPForAuth(r *http.Request, trustForwarded bool) string {
	return ResolveClientIPString(r, trustForwarded)
}
